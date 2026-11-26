"""The setup's care for the disk: it starts only with room to spare, and a run that
fails deletes what it made. Run: python3 -m unittest discover -s tts"""

import io
import os
import shutil
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest import mock

import setup_voice


def run_setup(*args: str) -> tuple[int, str]:
    out = io.StringIO()
    with redirect_stdout(out):
        code = setup_voice.main(list(args))
    return code, out.getvalue()


class FreeSpace(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def test_a_folder_not_made_yet_is_measured_where_it_would_go(self):
        missing = os.path.join(self.tmp, "not", "made", "yet")
        self.assertEqual(setup_voice.free_mb(missing), shutil.disk_usage(self.tmp).free // (1024 * 1024))

    def test_too_little_room_stops_before_anything_is_made(self):
        target = os.path.join(self.tmp, "voice")
        code, out = run_setup("--install-dir", target, "--need-mb", str(10**12))
        self.assertEqual(code, 1)
        self.assertRegex(out, r"^error Not enough free space: .* MB free, and the setup needs .* MB")
        self.assertNotIn("step", out)
        self.assertFalse(os.path.exists(target))


class CleanUpOnFailure(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def fail_at_the_environment(self, target: str) -> str:
        # A Python that cannot run: creating the environment fails.
        with mock.patch.object(setup_voice, "find_python", return_value=[os.path.join(self.tmp, "no-python")]):
            code, out = run_setup("--install-dir", target, "--need-mb", "0")
        self.assertEqual(code, 1)
        self.assertIn("error ", out)
        return out

    def test_a_new_folder_is_deleted_again(self):
        target = os.path.join(self.tmp, "voice")
        self.fail_at_the_environment(target)
        self.assertFalse(os.path.exists(target))

    def test_a_folder_that_was_there_keeps_what_it_had(self):
        target = os.path.join(self.tmp, "voice")
        os.makedirs(target)
        with open(os.path.join(target, "keep.txt"), "w") as f:
            f.write("mine")
        self.fail_at_the_environment(target)
        self.assertEqual(os.listdir(target), ["keep.txt"])

    def test_a_failed_download_deletes_the_new_models_folder_and_keeps_the_environment(self):
        target = os.path.join(self.tmp, "voice")
        venv_python = setup_voice.venv_python(sys.platform, os.path.join(target, "venv"))
        os.makedirs(os.path.dirname(venv_python))
        open(venv_python, "w").close()
        ok = mock.Mock(returncode=0, stdout="", stderr="")

        def no_internet(*_args, **_kwargs):
            raise OSError("no internet")

        with (
            mock.patch.object(setup_voice, "find_python", return_value=[sys.executable]),
            mock.patch.object(setup_voice.subprocess, "run", return_value=ok),
            mock.patch.object(setup_voice.urllib.request, "urlopen", side_effect=no_internet),
        ):
            code, out = run_setup("--install-dir", target, "--need-mb", "0")
        self.assertEqual(code, 1)
        self.assertIn("error Could not download", out)
        self.assertFalse(os.path.exists(os.path.join(target, "models")))
        self.assertTrue(os.path.isfile(venv_python))

    def test_pip_keeps_no_second_copy_in_its_cache(self):
        target = os.path.join(self.tmp, "voice")
        venv_python = setup_voice.venv_python(sys.platform, os.path.join(target, "venv"))
        os.makedirs(os.path.dirname(venv_python))
        open(venv_python, "w").close()
        failed = mock.Mock(returncode=1, stdout="", stderr="no network")
        with (
            mock.patch.object(setup_voice, "find_python", return_value=[sys.executable]),
            mock.patch.object(setup_voice.subprocess, "run", return_value=failed) as ran,
        ):
            run_setup("--install-dir", target, "--need-mb", "0")
        pip = [call.args[0] for call in ran.call_args_list if "pip" in call.args[0]]
        self.assertEqual(len(pip), 1)
        self.assertIn("--no-cache-dir", pip[0])


class ModelOrder(unittest.TestCase):
    def test_the_small_file_comes_first(self):
        # A failed download then throws away as little as it can.
        self.assertEqual([name for name, _ in setup_voice.MODELS], ["voices-v1.0.bin", "kokoro-v1.0.onnx"])


if __name__ == "__main__":
    unittest.main()
