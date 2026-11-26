"""Installs the natural voice (Kokoro) for the paragraph-speaker mod, once: a
Python environment with kokoro-onnx, and the two voice model files, each one
checked against its known SHA-256 before it is used. Everything goes into one
folder (see install_dir), about 500 MB; delete that folder to remove it.

It starts only when the disk has --need-mb free (1 GB: what it uses, plus room
so the disk is never left full), and a run that fails deletes what it made.

Run it from Claude Code by typing   /speak setup
or by hand, with any Python 3:      python3 -I setup_voice.py [--install-dir DIR]
(on Windows:                        py -3 -I setup_voice.py)

Lines it writes, which the mod shows:   step <n>/4 <what>,   error <why>,   done <folder>
Standard library only, so it runs before anything is installed.
"""

from __future__ import annotations

import argparse
import errno
import glob
import hashlib
import os
import shutil
import subprocess
import sys
import urllib.request
from typing import Callable, Mapping, Optional

PACKAGE = "kokoro-onnx==0.6.1"  # installs on Python 3.10 to 3.13
WANTED = ("3.12", "3.13", "3.11", "3.10")
RELEASE = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"
# The small file first: a failed download then throws away as little as it can.
MODELS = (
    ("voices-v1.0.bin", "bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d"),
    ("kokoro-v1.0.onnx", "7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5"),
)
NEED_MB = 1024


def step(n: int, what: str) -> None:
    print(f"step {n}/4 {what}", flush=True)


def fail(why: str) -> int:
    print(f"error {why}", flush=True)
    return 1


def free_mb(path: str) -> Optional[int]:
    """Free space, in MB, on the disk `path` is or would be on; None when it cannot be measured."""
    probe = os.path.abspath(path)
    while not os.path.exists(probe):
        parent = os.path.dirname(probe)
        if parent == probe:
            return None
        probe = parent
    try:
        return shutil.disk_usage(probe).free // (1024 * 1024)
    except OSError:
        return None


class Made:
    """What this run creates, deleted again if it fails, so a failed setup leaves nothing behind."""

    def __init__(self) -> None:
        self.paths: list[str] = []

    def folder(self, path: str) -> None:
        if not os.path.isdir(path):
            os.makedirs(path)
            self.paths.append(path)

    def add(self, path: str) -> None:
        """A path this run is about to create."""
        self.paths.append(path)

    def undo(self) -> None:
        for path in reversed(self.paths):
            if os.path.isdir(path):
                shutil.rmtree(path, ignore_errors=True)
            elif os.path.exists(path):
                try:
                    os.remove(path)
                except OSError:
                    pass


def install_dir(platform: str, env: Mapping[str, str], home: str) -> str:
    """Where the voice goes: the system's own place for an app's data."""
    if platform == "win32":
        return os.path.join(env.get("LOCALAPPDATA") or os.path.join(home, "AppData", "Local"), "paragraph-speaker")
    if platform == "darwin":
        return os.path.join(home, "Library", "Application Support", "paragraph-speaker")
    data = env.get("XDG_DATA_HOME", "")
    # XDG says a relative XDG_DATA_HOME is to be ignored.
    return os.path.join(data if os.path.isabs(data) else os.path.join(home, ".local", "share"), "paragraph-speaker")


def venv_python(platform: str, venv: str) -> str:
    return os.path.join(venv, "Scripts", "python.exe") if platform == "win32" else os.path.join(venv, "bin", "python")


def candidates(platform: str, env: Mapping[str, str], which: Callable[[str], Optional[str]] = shutil.which) -> list[list[str]]:
    """Pythons to try, as argument lists, best first."""
    found: list[list[str]] = []
    if platform == "win32":
        if which("py"):
            found += [["py", f"-{v}"] for v in WANTED]
        for folder in (os.path.join(env.get("LOCALAPPDATA", ""), "Programs", "Python"), env.get("ProgramFiles", "")):
            if folder:
                found += [[exe] for exe in sorted(glob.glob(os.path.join(folder, "Python31*", "python.exe")))]
        names = ["python"]
    else:
        names = [f"python{v}" for v in WANTED] + ["python3"]
    for name in names:
        exe = which(name)
        if exe:
            found.append([exe])
    if platform == "darwin":
        # An app started from the Dock has no Homebrew on its PATH.
        for v in WANTED:
            for exe in (
                f"/opt/homebrew/bin/python{v}",
                f"/usr/local/bin/python{v}",
                f"/Library/Frameworks/Python.framework/Versions/{v}/bin/python3",
            ):
                if os.path.isfile(exe):
                    found.append([exe])
    found.append([sys.executable])
    return found


def version_of(python: list[str]) -> Optional[str]:
    """The Python's "major.minor", or None when it does not run."""
    try:
        ran = subprocess.run(
            [*python, "-c", "import sys; print('%d.%d' % sys.version_info[:2])"],
            capture_output=True,
            text=True,
            timeout=60,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return ran.stdout.strip() if ran.returncode == 0 else None


def find_python(platform: str, env: Mapping[str, str]) -> Optional[list[str]]:
    """A Python that kokoro-onnx installs on: 3.12 first, then 3.13, 3.11, 3.10."""
    by_version: dict[str, list[str]] = {}
    for python in candidates(platform, env):
        version = version_of(python)
        if version in WANTED and version not in by_version:
            by_version[version] = python
    return next((by_version[v] for v in WANTED if v in by_version), None)


def sha256(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def is_model(path: str, expected: str) -> bool:
    return os.path.isfile(path) and sha256(path) == expected


def last_line(text: str) -> str:
    lines = [line for line in text.strip().splitlines() if line.strip()]
    return lines[-1] if lines else ""


def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--install-dir", default=install_dir(sys.platform, os.environ, os.path.expanduser("~")))
    ap.add_argument("--need-mb", type=int, default=NEED_MB, help="free space to start with, in MB")
    args = ap.parse_args(argv)
    target = args.install_dir

    # Room on the disk first: when the system disk runs full, the system and its apps start failing.
    free = free_mb(target)
    if free is not None and free < args.need_mb:
        return fail(
            f"Not enough free space: the disk for {target} has {free:,} MB free, and the setup needs "
            f"{args.need_mb:,} MB (the voice uses about 500 MB; the rest keeps the disk from running full). "
            "Free up space and run /speak setup again."
        )

    made = Made()
    try:
        why = install(target, made)
    except Exception as error:  # anything unforeseen still cleans up after itself
        why = f"The setup stopped: {error}"
    if why is not None:
        made.undo()
        return fail(why)
    print(f"done {target}", flush=True)
    return 0


def install(target: str, made: Made) -> Optional[str]:
    """Runs the four steps; what went wrong, or None when the voice is installed."""
    step(1, "Finding Python")
    python = find_python(sys.platform, os.environ)
    if python is None:
        return (
            "Python 3.10 to 3.13 was not found. Install Python 3.12 from https://www.python.org/downloads/ "
            "and run /speak setup again."
        )

    # Its own environment, so nothing is installed into the system Python.
    step(2, "Creating the Python environment")
    venv = os.path.join(target, "venv")
    own = venv_python(sys.platform, venv)
    made.folder(target)
    if not os.path.isfile(own):
        if not os.path.exists(venv):
            made.add(venv)
        ran = subprocess.run([*python, "-m", "venv", venv], capture_output=True, text=True)
        if ran.returncode != 0 or not os.path.isfile(own):
            hint = " (on Debian or Ubuntu, install python3-venv)" if sys.platform.startswith("linux") else ""
            return f"Could not create the Python environment{hint}: {last_line(ran.stderr + ran.stdout)}"

    step(3, f"Installing the voice engine ({PACKAGE.split('==')[0]})")
    # --no-cache-dir: no second copy of the downloads in pip's own cache folder.
    ran = subprocess.run(
        [own, "-m", "pip", "install", "--disable-pip-version-check", "--quiet", "--no-cache-dir", PACKAGE],
        capture_output=True,
        text=True,
    )
    if ran.returncode != 0:
        return f"pip could not install {PACKAGE}: {last_line(ran.stderr + ran.stdout)}"

    step(4, "Downloading the voice model (about 340 MB)")
    models = os.path.join(target, "models")
    made.folder(models)
    for name, expected in MODELS:
        path = os.path.join(models, name)
        if is_model(path, expected):
            continue
        part = path + ".part"
        try:
            with urllib.request.urlopen(f"{RELEASE}/{name}", timeout=60) as response, open(part, "wb") as out:
                shutil.copyfileobj(response, out, 1 << 20)
        except OSError as error:
            if os.path.exists(part):
                os.remove(part)
            if error.errno == errno.ENOSPC:
                return f"The disk ran full while downloading {name}. Free up space and run /speak setup again."
            return f"Could not download {name}. Check the internet connection and run /speak setup again."
        if not is_model(part, expected):
            os.remove(part)
            return f"{name} did not match its known checksum, so it was deleted. Run /speak setup again."
        os.replace(part, path)
        made.add(path)

    ran = subprocess.run([own, "-I", "-c", "import kokoro_onnx"], capture_output=True, text=True)
    if ran.returncode != 0:
        return f"The voice engine did not load: {last_line(ran.stderr + ran.stdout)}"
    return None


if __name__ == "__main__":
    sys.exit(main())
