"""Speak the UTF-8 text on stdin with the Kokoro voice, and say on stdout which
word is being spoken, as it is spoken. Sound goes out through winsound on
Windows, afplay on macOS, and pw-play, paplay or aplay on Linux.

The text's words are its pieces between single spaces (the mod sends text whose
whitespace is already collapsed to single spaces), numbered from 0. Lines out:

    pid <n>            first, before the model loads: the process to kill to stop
    sentence <a> <b>   a sentence, words a..b, starts playing
    word <i>           word i starts being spoken

Sentence by sentence: the next sentence is made while the current one plays.
The model reports no timings, so each word's start inside its sentence is
estimated from how many sounds it has (and the pause its punctuation makes);
each sentence's own start is exact. Killing the process stops the sound at once:
on macOS and Linux it leads its own process group, so killing the group ends
the player too.

    python -I kokoro_speak.py --model M.onnx --voices V.bin [--voice af_heart]
    python -I kokoro_speak.py ... --out test.wav   # write a WAV and the schedule
    python -I kokoro_speak.py --which-player      # print the player this system uses
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

TMP_PREFIX = "paragraph-speaker-"
# Tried in order on Linux: PipeWire, PulseAudio, then ALSA.
LINUX_PLAYERS = (["pw-play"], ["paplay"], ["aplay", "-q"])
SENTENCE_END = re.compile(r"[.!?;:][\"'”’)\]]*$")
# How long a word's trailing mark makes the voice pause, in sounds' worth.
PAUSE_WEIGHT = {",": 2.0, ";": 3.0, ":": 3.0, ".": 3.0, "!": 3.0, "?": 3.0}


def emit(line: str) -> None:
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


def sentences(words: list[str]) -> list[tuple[int, int]]:
    """Groups words into sentences (first, last index) of 40 characters or more."""
    out: list[tuple[int, int]] = []
    start, length = 0, 0
    for i, word in enumerate(words):
        length += len(word) + 1
        if SENTENCE_END.search(word) and length >= 40:
            out.append((start, i))
            start, length = i + 1, 0
    if start < len(words):
        out.append((start, len(words) - 1))
    return out


def word_starts(kokoro: Kokoro, words: list[str], lang: str, seconds: float) -> list[float]:
    """When each word starts inside its sentence's audio, in seconds (estimated)."""
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

    def wait(self) -> None:
        if self.child is not None:
            self.child.wait()

    def stop(self) -> None:
        if not self.command:
            import winsound

            winsound.PlaySound(None, 0)
            return
        if self.child is not None and self.child.poll() is None:
            self.child.terminate()


def player(jobs: "queue.Queue[tuple | None]", sound: Sound) -> None:
    """Plays each sentence as it comes, saying each word as its time arrives."""
    while (job := jobs.get()) is not None:
        path, seconds, first, last, starts = job
        emit(f"sentence {first} {last}")
        began = time.monotonic()
        sound.play(path)
        for k, start in enumerate(starts):
            wait = began + start - time.monotonic()
            if wait > 0:
                time.sleep(wait)
            emit(f"word {first + k}")
        wait = began + seconds - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        sound.wait()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model")
    ap.add_argument("--voices")
    ap.add_argument("--voice", default="af_heart")
    ap.add_argument("--speed", type=float, default=1.0)
    ap.add_argument("--out", help="write one WAV here and print the schedule, playing nothing")
    ap.add_argument("--list-voices", action="store_true")
    ap.add_argument("--which-player", action="store_true", help="print the player this system uses")
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
            # Its own process group, so the mod's stop ends the player with it.
            try:
                os.setsid()
            except OSError:
                pass
        # The mod reads this to stop the sound at once when asked.
        emit(f"pid {os.getpid()}")

    import numpy as np
    from kokoro_onnx import Kokoro

    kokoro = Kokoro(args.model, args.voices)
    if args.list_voices:
        print("\n".join(sorted(kokoro.get_voices())))
        return 0
    if args.voice not in kokoro.get_voices():
        print(f"unknown voice: {args.voice}", file=sys.stderr)
        return 2

    text = sys.stdin.buffer.read().decode("utf-8", errors="replace").strip()
    words = [w for w in text.split(" ") if w != ""]
    if not words:
        return 0
    lang = lang_for(args.voice)

    def make(first: int, last: int) -> tuple[np.ndarray, int, list[float]]:
        part = words[first : last + 1]
        samples, rate = kokoro.create(" ".join(part), voice=args.voice, speed=args.speed, lang=lang)
        return samples, rate, word_starts(kokoro, part, lang, len(samples) / rate)

    if args.out:
        chunks, rate, offset = [], 24000, 0.0
        for first, last in sentences(words):
            samples, rate, starts = make(first, last)
            for k, start in enumerate(starts):
                print(f"word {first + k} {offset + start:.2f}s {words[first + k]}")
            chunks.append(samples)
            offset += len(samples) / rate
        write_wav(args.out, np.concatenate(chunks), rate)
        return 0

    # A killed run cannot clean up after itself: clear what earlier runs left.
    for old in glob.glob(os.path.join(tempfile.gettempdir(), TMP_PREFIX + "*")):
        shutil.rmtree(old, ignore_errors=True)
    tmp = tempfile.mkdtemp(prefix=TMP_PREFIX)
    sound = Sound(command)

    def end(_signum: int, _frame: object) -> None:
        sound.stop()
        shutil.rmtree(tmp, ignore_errors=True)
        os._exit(0)

    if sys.platform != "win32":
        signal.signal(signal.SIGTERM, end)
    jobs: "queue.Queue[tuple | None]" = queue.Queue()
    thread = threading.Thread(target=player, args=(jobs, sound), daemon=True)
    thread.start()
    try:
        for i, (first, last) in enumerate(sentences(words)):
            samples, rate, starts = make(first, last)
            path = os.path.join(tmp, f"{i}.wav")
            write_wav(path, samples, rate)
            jobs.put((path, len(samples) / rate, first, last, starts))
        jobs.put(None)
        thread.join()
    finally:
        sound.stop()
        shutil.rmtree(tmp, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
