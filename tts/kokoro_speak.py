"""Speak text with the Kokoro voice, and say on stdout which word is being spoken,
as it is spoken. Sound goes out through winsound on Windows, afplay on macOS,
and pw-play, paplay or aplay on Linux.

The text's words are its pieces between single spaces (the mod sends text whose
whitespace is already collapsed to single spaces), numbered from 0. Lines out:

    pid <n>            first, before the model loads: the process to kill to stop
    sentence <a> <b>   a piece, words a..b, starts playing
    word <i>           word i starts being spoken

Piece by piece: the first piece is short, to its first comma or stop, so the
voice starts quickly; each next one may be twice as long as the one before, as
it is made while that one plays; after those, whole sentences. At most AHEAD
pieces are made ahead of the one playing, and only the one playing is on disk,
so a long selection fills neither the memory nor the disk. The model reports no
timings, so each word's start inside its piece is estimated from how many sounds
it has (and the pause its punctuation makes); each piece's own start is exact.
Killing the process stops the sound at once: on macOS and Linux it leads its
own process group, so killing the group ends the player too.

    python -I kokoro_speak.py --model M.onnx --voices V.bin [--voice af_heart] < text
    python -I kokoro_speak.py ... --out test.wav   # write a WAV and the schedule
    python -I kokoro_speak.py --which-player      # print the player this system uses

A voice that stays loaded, so later readings skip the 2 seconds Python and the
310 MB model take to load:

    python -I kokoro_speak.py --serve --model M.onnx --voices V.bin [--idle 600]

It loads the model, writes "ready <address> <key>", then reads aloud for each
voice_client.py that connects to that address with that key, one at a time. The
address is a named pipe on Windows and a socket in a folder only this user can
open elsewhere; nothing listens on the network. The client passes the lines
above on, and ending the client stops its reading. After --idle seconds without
a reading it writes "idle" and exits, giving its memory back.
"""

from __future__ import annotations

import argparse
import glob
import os
import queue
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import wave
from typing import TYPE_CHECKING, Callable, Optional

if TYPE_CHECKING:
    import numpy as np
    from kokoro_onnx import Kokoro

DEFAULT_VOICE = "af_heart"
TMP_PREFIX = "paragraph-speaker-"
# The loaded voice's socket folder (not on Windows). A different prefix, so
# clear_leftovers never takes it from a voice that has been up a long time.
SOCKET_PREFIX = "paragraph-speaker.voice-"
# A temp folder untouched this long was left by a run that was killed.
STALE_SECONDS = 600
# Pieces made ahead of the one playing: enough that the next is always ready.
AHEAD = 2
# The first piece ends at its first comma or stop that gives it SHORTEST words,
# looking up to LONGEST_FIRST words in; with none there, after FIRST words.
SHORTEST, FIRST, LONGEST_FIRST = 4, 8, 14
# Each of the next RAMP pieces may be GROWTH times as long as the one before
# (so it is made while that one plays), until a piece may hold LONG words; from
# then on, whole sentences.
GROWTH, LONG, RAMP = 2, 32, 4
# Tried in order on Linux: PipeWire, PulseAudio, then ALSA.
LINUX_PLAYERS = (["pw-play"], ["paplay"], ["aplay", "-q"])
SENTENCE_END = re.compile(r"[.!?;:][\"'”’)\]]*$")
CLAUSE_END = re.compile(r"[,.!?;:][\"'”’)\]]*$")
# How long a word's trailing mark makes the voice pause, in sounds' worth.
PAUSE_WEIGHT = {",": 2.0, ";": 3.0, ":": 3.0, ".": 3.0, "!": 3.0, "?": 3.0}


def emit(line: str) -> None:
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


def sentences(words: list[str], start: int = 0) -> list[tuple[int, int]]:
    """Groups the words from `start` into sentences (first, last index) of 40 characters or more."""
    out: list[tuple[int, int]] = []
    length = 0
    for i in range(start, len(words)):
        length += len(words[i]) + 1
        if SENTENCE_END.search(words[i]) and length >= 40:
            out.append((start, i))
            start, length = i + 1, 0
    if start < len(words):
        out.append((start, len(words) - 1))
    return out


def first_piece_end(words: list[str]) -> int:
    """The last word of the first piece: short, so the voice starts quickly, and
    ended at a comma or stop where it can be, so it still sounds natural."""
    stops = [i for i in range(1, min(LONGEST_FIRST, len(words))) if CLAUSE_END.search(words[i])]
    for i in stops:
        if i + 1 >= SHORTEST:
            return i
    if stops:
        return stops[-1]
    return min(FIRST, len(words)) - 1


def pieces(words: list[str]) -> list[tuple[int, int]]:
    """Groups the words into the pieces made one at a time (first, last index)."""
    if not words:
        return []
    end = first_piece_end(words)
    out = [(0, end)]
    start, size = end + 1, end + 1
    while start < len(words) and len(out) <= RAMP and size * GROWTH < LONG:
        limit = size * GROWTH
        reach = min(start + limit, len(words))
        if reach == len(words):
            end = reach - 1
        else:
            # The last comma or stop that keeps the piece at least as long as the one before.
            stops = [i for i in range(start + size - 1, reach) if CLAUSE_END.search(words[i])]
            end = stops[-1] if stops else reach - 1
        out.append((start, end))
        start, size = end + 1, end - start + 1
    return out + sentences(words, start)


def word_starts(kokoro: Kokoro, words: list[str], lang: str, seconds: float) -> list[float]:
    """When each word starts inside its piece's audio, in seconds (estimated)."""
    weights = []
    for word in words:
        core = re.sub(r"[^\w'’-]+", " ", word).strip()
        try:
            sounds = len(kokoro.tokenizer.known(kokoro.tokenizer.phonemize(core, lang)).replace(" ", "")) if core else 0
        except Exception:
            sounds = len(core)
        mark = word.rstrip("\"'”’)]")[-1:]
        weights.append(max(sounds, 1) + PAUSE_WEIGHT.get(mark, 0.0))
    total = sum(weights)
    starts, before = [], 0.0
    for weight in weights:
        starts.append(seconds * before / total)
        before += weight
    return starts


def write_wav(path: str, samples: np.ndarray, rate: int) -> None:
    import numpy as np

    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm.tobytes())


def lang_for(voice: str) -> str:
    # Kokoro's voice names start with a language letter: a = American, b = British.
    return "en-gb" if voice.startswith("b") else "en-us"


def make(kokoro: Kokoro, words: list[str], first: int, last: int, voice: str, speed: float) -> tuple[np.ndarray, int, list[float]]:
    """One piece's audio, its sample rate, and when each of its words starts."""
    part = words[first : last + 1]
    lang = lang_for(voice)
    samples, rate = kokoro.create(" ".join(part), voice=voice, speed=speed, lang=lang)
    return samples, rate, word_starts(kokoro, part, lang, len(samples) / rate)


def player_command(platform: str, which: Callable[[str], Optional[str]] = shutil.which) -> Optional[list[str]]:
    """The program that plays a WAV file here, as an argument list before the path.

    [] on Windows, where winsound plays it in this process; None when there is none.
    """
    if platform == "win32":
        return []
    if platform == "darwin":
        return ["afplay"] if which("afplay") else None
    for command in LINUX_PLAYERS:
        if which(command[0]):
            return list(command)
    return None


# What a SIGTERM (a stop, on macOS and Linux) must not leave behind.
LIVE_SOUNDS: set["Sound"] = set()
OWN_PATHS: set[str] = set()


def end_now(_signum: object = None, _frame: object = None) -> None:
    """Silences every sound, deletes this process's folders, and exits at once."""
    for sound in list(LIVE_SOUNDS):
        sound.stop()
    for path in list(OWN_PATHS):
        shutil.rmtree(path, ignore_errors=True)
    os._exit(0)


class Sound:
    """Plays one file at a time with the system's player, and stops it."""

    def __init__(self, command: list[str]) -> None:
        self.command = command
        self.child: Optional[subprocess.Popen] = None

    def play(self, path: str) -> None:
        if not self.command:
            import winsound

            winsound.PlaySound(path, winsound.SND_FILENAME | winsound.SND_ASYNC)
            return
        self.child = subprocess.Popen(
            [*self.command, path], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )

    def wait(self, stop: threading.Event) -> bool:
        """Waits for an outside player, which may run a little past the estimate; True if stopped."""
        while self.child is not None and self.child.poll() is None:
            if stop.wait(0.02):
                return True
        return stop.is_set()

    def stop(self) -> None:
        if not self.command:
            import winsound

            winsound.PlaySound(None, 0)
            return
        if self.child is not None and self.child.poll() is None:
            self.child.terminate()


def clear_leftovers() -> None:
    """Deletes the temp folders of runs that were killed before they could."""
    now = time.time()
    for old in glob.glob(os.path.join(tempfile.gettempdir(), TMP_PREFIX + "*")):
        try:
            if now - os.path.getmtime(old) > STALE_SECONDS:
                shutil.rmtree(old, ignore_errors=True)
        except OSError:
            pass


def player(jobs: "queue.Queue[tuple | None]", tmp: str, say: Callable[[str], None], stop: threading.Event, sound: Sound) -> None:
    """Plays each piece as it comes, saying each word as its time arrives, until
    the pieces end or `stop` is set, which silences it at once. A piece's WAV is
    written as it starts, and the one before it deleted then."""
    previous = None
    try:
        while not stop.is_set():
            try:
                job = jobs.get(timeout=0.2)
            except queue.Empty:
                continue
            if job is None:
                return
            i, samples, rate, first, last, starts = job
            path = os.path.join(tmp, f"{i}.wav")
            write_wav(path, samples, rate)
            seconds = len(samples) / rate
            say(f"sentence {first} {last}")
            began = time.monotonic()
            sound.play(path)
            if previous is not None:
                try:
                    os.remove(previous)
                except OSError:
                    pass  # still held: the whole folder goes when the reading ends
            previous = path
            for k, start in enumerate(starts):
                if stop.wait(max(0.0, began + start - time.monotonic())):
                    return
                say(f"word {first + k}")
            if stop.wait(max(0.0, began + seconds - time.monotonic())):
                return
            if sound.wait(stop):
                return
    finally:
        if stop.is_set():
            sound.stop()


def read_aloud(
    kokoro: Kokoro, words: list[str], voice: str, speed: float, say: Callable[[str], None], stop: threading.Event, command: list[str]
) -> None:
    """Reads the words aloud with the player `command`, piece by piece, saying
    each piece and word as it starts, until the end or until `stop` is set;
    raises what went wrong."""
    clear_leftovers()
    tmp = tempfile.mkdtemp(prefix=TMP_PREFIX)
    OWN_PATHS.add(tmp)
    sound = Sound(command)
    LIVE_SOUNDS.add(sound)
    jobs: "queue.Queue[tuple | None]" = queue.Queue(maxsize=AHEAD)
    problem: list[BaseException] = []

    def play() -> None:
        try:
            player(jobs, tmp, say, stop, sound)
        except BaseException as error:  # raised again below, so the caller hears why
            problem.append(error)
            stop.set()

    thread = threading.Thread(target=play, daemon=True)
    thread.start()

    def hand(job: "tuple | None") -> bool:
        """Waits for room in the queue; False once the reading has stopped."""
        while thread.is_alive() and not stop.is_set():
            try:
                jobs.put(job, timeout=0.2)
                return True
            except queue.Full:
                pass
        return False

    try:
        for i, (first, last) in enumerate(pieces(words)):
            if stop.is_set():
                break
            samples, rate, starts = make(kokoro, words, first, last, voice, speed)
            if not hand((i, samples, rate, first, last, starts)):
                break
        hand(None)
        thread.join()
    finally:
        stop.set()
        thread.join(timeout=2)
        sound.stop()
        LIVE_SOUNDS.discard(sound)
        shutil.rmtree(tmp, ignore_errors=True)
        OWN_PATHS.discard(tmp)
    if problem:
        raise problem[0]


def serve_one(kokoro: Kokoro, conn, command: list[str]) -> None:
    """One client's reading: its request in, the lines out, until the end or
    until the client ends, which stops the reading."""
    request = conn.recv()
    text = str(request.get("text", "")).strip()
    voice = str(request.get("voice", DEFAULT_VOICE))
    speed = float(request.get("speed", 1.0))
    if voice not in kokoro.get_voices():
        conn.send(f"error unknown voice: {voice}")
        return
    words = [w for w in text.split(" ") if w != ""]
    stop = threading.Event()

    def watch() -> None:
        # The client sends nothing more: its end (a Stop) closes the connection.
        try:
            while not stop.is_set():
                if conn.poll(0.1):
                    conn.recv()
        except (EOFError, OSError):
            stop.set()

    def say(line: str) -> None:
        try:
            conn.send(line)
        except OSError:
            stop.set()

    watcher = threading.Thread(target=watch, daemon=True)
    watcher.start()
    failed = None
    try:
        read_aloud(kokoro, words, voice, speed, say, stop, command)
    except Exception as error:
        failed = f"{type(error).__name__}: {error}"
    finally:
        stop.set()
        watcher.join(timeout=1)
    say("end" if failed is None else f"error {failed}")


def listen_address(platform: str) -> tuple[str, str]:
    """Where the loaded voice listens, and that address's family: a named pipe on
    Windows, else a socket in a new folder only this user can open."""
    import secrets

    if platform == "win32":
        return rf"\\.\pipe\{TMP_PREFIX}{secrets.token_hex(8)}", "AF_PIPE"
    folder = tempfile.mkdtemp(prefix=SOCKET_PREFIX)  # made with mode 0700
    OWN_PATHS.add(folder)
    return os.path.join(folder, "s"), "AF_UNIX"


def serve(kokoro: Kokoro, idle: float, command: list[str]) -> int:
    """Keeps the voice loaded and reads for each client in turn; exits when idle."""
    import secrets
    from multiprocessing.connection import Listener

    key = secrets.token_hex(16)
    address, family = listen_address(sys.platform)
    listener = Listener(address, family=family, authkey=key.encode("ascii"))
    emit(f"ready {address} {key}")
    busy = threading.Event()
    last_used = [time.monotonic()]

    def watchdog() -> None:
        while True:
            time.sleep(1)
            if not busy.is_set() and time.monotonic() - last_used[0] > idle:
                emit("idle")
                end_now()

    threading.Thread(target=watchdog, daemon=True).start()
    while True:
        try:
            conn = listener.accept()
        except Exception:  # a caller without the key, or one that left at once
            continue
        busy.set()
        try:
            serve_one(kokoro, conn, command)
        except Exception as error:
            print(f"a reading failed: {error!r}", file=sys.stderr, flush=True)
        finally:
            conn.close()
            last_used[0] = time.monotonic()
            busy.clear()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model")
    ap.add_argument("--voices")
    ap.add_argument("--voice", default=DEFAULT_VOICE)
    ap.add_argument("--speed", type=float, default=1.0)
    ap.add_argument("--out", help="write one WAV here and print the schedule, playing nothing")
    ap.add_argument("--list-voices", action="store_true")
    ap.add_argument("--which-player", action="store_true", help="print the player this system uses")
    ap.add_argument("--serve", action="store_true", help="stay loaded and read for voice_client.py")
    ap.add_argument("--idle", type=float, default=600.0, help="with --serve: exit after this many seconds unused")
    args = ap.parse_args()

    command = player_command(sys.platform)
    if args.which_player:
        print("winsound" if command == [] else " ".join(command) if command else "none")
        return 0 if command is not None else 3
    if not (args.model and args.voices):
        ap.error("--model and --voices are required")

    playing = not (args.out or args.list_voices)
    if playing:
        if command is None:
            print("no audio player found: install PipeWire (pw-play), PulseAudio (paplay) or ALSA (aplay)", file=sys.stderr)
            return 3
        if sys.platform != "win32":
            signal.signal(signal.SIGTERM, end_now)
        if not args.serve:
            if sys.platform != "win32":
                # Its own process group, so the mod's stop ends the player with it.
                try:
                    os.setsid()
                except OSError:
                    pass
            # The mod reads this to stop the sound at once when asked.
            emit(f"pid {os.getpid()}")

    from kokoro_onnx import Kokoro

    kokoro = Kokoro(args.model, args.voices)
    if args.list_voices:
        print("\n".join(sorted(kokoro.get_voices())))
        return 0
    if args.serve:
        return serve(kokoro, args.idle, command)
    if args.voice not in kokoro.get_voices():
        print(f"unknown voice: {args.voice}", file=sys.stderr)
        return 2

    text = sys.stdin.buffer.read().decode("utf-8", errors="replace").strip()
    words = [w for w in text.split(" ") if w != ""]
    if not words:
        return 0

    if args.out:
        import numpy as np

        chunks, rate, offset = [], 24000, 0.0
        for first, last in pieces(words):
            samples, rate, starts = make(kokoro, words, first, last, args.voice, args.speed)
            for k, start in enumerate(starts):
                print(f"word {first + k} {offset + start:.2f}s {words[first + k]}")
            chunks.append(samples)
            offset += len(samples) / rate
        write_wav(args.out, np.concatenate(chunks), rate)
        return 0

    read_aloud(kokoro, words, args.voice, args.speed, emit, threading.Event(), command)
    return 0


if __name__ == "__main__":
    sys.exit(main())
