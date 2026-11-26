"""Reads the UTF-8 text on stdin aloud through a voice that stays loaded
(kokoro_speak.py --serve), and passes its lines on, so that ending this small
process stops the reading while the voice stays loaded for the next one.

    PARAGRAPH_SPEAKER_KEY=<key> in the environment
    python -I voice_client.py --address <address> [--voice af_heart] [--speed 1.0] < text

The address is the one the loaded voice wrote: a named pipe on Windows, a
socket path elsewhere.

Lines out: "pid <n>" first, then "sentence <a> <b>" and "word <i>" as
kokoro_speak.py writes them. Exit 0 when the reading ends, 1 when the voice
reports an error (its reason on stderr), 3 when the voice cannot be reached or
ends mid-reading: the mod then reads without it. The key comes in through the
environment, so it is never on a command line.
"""

import argparse
import os
import sys
from multiprocessing.connection import Client

UNREACHABLE = 3


def family_of(address: str) -> str:
    """A named pipe (\\\\.\\pipe\\...) on Windows, a socket path elsewhere."""
    return "AF_PIPE" if address.startswith("\\\\") else "AF_UNIX"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--address", required=True)
    ap.add_argument("--voice", default="af_heart")
    ap.add_argument("--speed", type=float, default=1.0)
    args = ap.parse_args()

    # The mod reads this to stop the reading at once when asked: ending this
    # process closes the connection, and the loaded voice then stops.
    print(f"pid {os.getpid()}", flush=True)
    key = os.environ.get("PARAGRAPH_SPEAKER_KEY", "").encode("ascii")
    text = sys.stdin.buffer.read().decode("utf-8", errors="replace").strip()
    try:
        conn = Client(args.address, family=family_of(args.address), authkey=key)
        conn.send({"text": text, "voice": args.voice, "speed": args.speed})
    except Exception as error:  # gone (idle, ended), or the wrong key
        print(f"the voice is not running: {error}", file=sys.stderr)
        return UNREACHABLE
    try:
        while True:
            line = conn.recv()
            if line == "end":
                return 0
            if line.startswith("error "):
                print(line[len("error ") :], file=sys.stderr)
                return 1
            print(line, flush=True)
    except (EOFError, OSError) as error:
        print(f"the voice ended mid-reading: {error!r}", file=sys.stderr)
        return UNREACHABLE


if __name__ == "__main__":
    sys.exit(main())
