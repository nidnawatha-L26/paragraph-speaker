"""The loaded voice's address and its player's stop. Run: python3 -m unittest discover -s tts"""

import fnmatch
import os
import shutil
import sys
import threading
import time
import unittest

import kokoro_speak
import voice_client


class Address(unittest.TestCase):
    def test_windows_listens_on_a_named_pipe(self):
        address, family = kokoro_speak.listen_address("win32")
        self.assertEqual(family, "AF_PIPE")
        self.assertTrue(address.startswith("\\\\.\\pipe\\paragraph-speaker-"))
        self.assertEqual(voice_client.family_of(address), "AF_PIPE")

    def test_elsewhere_a_socket_in_a_folder_of_its_own(self):
        address, family = kokoro_speak.listen_address("linux")
        folder = os.path.dirname(address)
        self.addCleanup(shutil.rmtree, folder, True)
        self.addCleanup(kokoro_speak.OWN_PATHS.discard, folder)
        self.assertEqual(family, "AF_UNIX")
        self.assertTrue(os.path.isdir(folder))
        self.assertIn(folder, kokoro_speak.OWN_PATHS)  # deleted when the voice ends
        self.assertEqual(voice_client.family_of(address), "AF_UNIX")
        if sys.platform != "win32":
            self.assertEqual(os.stat(folder).st_mode & 0o777, 0o700)

    def test_the_socket_folder_is_never_taken_for_a_leftover(self):
        # clear_leftovers deletes old TMP_PREFIX folders; a voice loaded for hours keeps its socket.
        name = kokoro_speak.SOCKET_PREFIX + "abc123"
        self.assertFalse(fnmatch.fnmatch(name, kokoro_speak.TMP_PREFIX + "*"))


class OutsidePlayer(unittest.TestCase):
    def test_waiting_for_the_player_ends_at_a_stop(self):
        sound = kokoro_speak.Sound([sys.executable, "-c", "import time; time.sleep(30)", "--"])
        sound.play("piece.wav")
        stop = threading.Event()
        threading.Timer(0.2, stop.set).start()
        began = time.monotonic()
        self.assertTrue(sound.wait(stop))
        sound.stop()
        self.assertLess(time.monotonic() - began, 5)
        sound.child.wait(timeout=5)
        self.assertIsNotNone(sound.child.poll())

    def test_waiting_ends_when_the_player_does(self):
        sound = kokoro_speak.Sound([sys.executable, "-c", "pass", "--"])
        sound.play("piece.wav")
        self.assertFalse(sound.wait(threading.Event()))


if __name__ == "__main__":
    unittest.main()
