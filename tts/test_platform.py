"""Which player, folder and Python each system gets. Run: python3 -m unittest discover -s tts"""

import os
import unittest

import kokoro_speak
import setup_voice


def which_of(*present: str):
    return lambda name: f"/usr/bin/{name}" if name in present else None


class PlayerChoice(unittest.TestCase):
    def test_windows_plays_in_process(self):
        self.assertEqual(kokoro_speak.player_command("win32", which_of()), [])

    def test_macos_uses_afplay(self):
        self.assertEqual(kokoro_speak.player_command("darwin", which_of("afplay")), ["afplay"])
        self.assertIsNone(kokoro_speak.player_command("darwin", which_of()))

    def test_linux_prefers_pipewire_then_pulse_then_alsa(self):
        self.assertEqual(kokoro_speak.player_command("linux", which_of("pw-play", "paplay", "aplay")), ["pw-play"])
        self.assertEqual(kokoro_speak.player_command("linux", which_of("paplay", "aplay")), ["paplay"])
        self.assertEqual(kokoro_speak.player_command("linux", which_of("aplay")), ["aplay", "-q"])
        self.assertIsNone(kokoro_speak.player_command("linux", which_of()))


class InstallFolder(unittest.TestCase):
    def test_windows_local_app_data(self):
        got = setup_voice.install_dir("win32", {"LOCALAPPDATA": "C:/L"}, "C:/Users/u")
        self.assertEqual(got, os.path.join("C:/L", "paragraph-speaker"))

    def test_macos_application_support(self):
        got = setup_voice.install_dir("darwin", {}, "/Users/u")
        self.assertEqual(got, os.path.join("/Users/u", "Library", "Application Support", "paragraph-speaker"))

    def test_linux_xdg_data_home_or_local_share(self):
        local_share = os.path.join("/home/u", ".local", "share", "paragraph-speaker")
        self.assertEqual(setup_voice.install_dir("linux", {"XDG_DATA_HOME": "/data/u"}, "/home/u"), os.path.join("/data/u", "paragraph-speaker"))
        self.assertEqual(setup_voice.install_dir("linux", {}, "/home/u"), local_share)
        self.assertEqual(setup_voice.install_dir("linux", {"XDG_DATA_HOME": "rel"}, "/home/u"), local_share)

    def test_venv_python(self):
        self.assertEqual(setup_voice.venv_python("win32", "v"), os.path.join("v", "Scripts", "python.exe"))
        self.assertEqual(setup_voice.venv_python("linux", "v"), os.path.join("v", "bin", "python"))


class PythonChoice(unittest.TestCase):
    def test_windows_tries_the_launcher_first(self):
        found = setup_voice.candidates("win32", {}, which_of("py"))
        self.assertEqual(found[:4], [["py", "-3.12"], ["py", "-3.13"], ["py", "-3.11"], ["py", "-3.10"]])

    def test_posix_tries_versioned_pythons_first(self):
        found = setup_voice.candidates("linux", {}, which_of("python3.12", "python3"))
        self.assertEqual(found[:2], [["/usr/bin/python3.12"], ["/usr/bin/python3"]])

    def test_a_python_that_does_not_run_is_skipped(self):
        self.assertIsNone(setup_voice.version_of(["/no/such/python"]))

    def test_model_checksums_are_the_known_ones(self):
        self.assertEqual(
            dict(setup_voice.MODELS),
            {
                "kokoro-v1.0.onnx": "7D5DF8ECF7D4B1878015A32686053FD0EEBE2BC377234608764CC0EF3636A6C5".lower(),
                "voices-v1.0.bin": "BCA610B8308E8D99F32E6FE4197E7EC01679264EFED0CAC9140FE9C29F1FBF7D".lower(),
            },
        )
        self.assertEqual(setup_voice.PACKAGE, "kokoro-onnx==0.6.1")


if __name__ == "__main__":
    unittest.main()
