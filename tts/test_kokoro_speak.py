"""Tests for how kokoro_speak.py cuts text into pieces. Needs only Python:

    python -I -m unittest discover -s tts -p "test_*.py"
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from kokoro_speak import FIRST, GROWTH, LONG, LONGEST_FIRST, RAMP, pieces  # noqa: E402


def words_of(text: str) -> list[str]:
    return text.split(" ")


SAMPLES = [
    "Hi.",
    "Three words here",
    "However, the plan we chose, which costs less, is slower than the other one we looked at today.",
    " ".join(f"word{i}" for i in range(120)),
    " ".join(f"This is sentence {i}, with a comma and a stop." for i in range(12)),
    "The setup script, which runs once on your computer, installs the voice and checks every file it downloads.",
    "Note: " + " ".join(f"part {i}," for i in range(40)) + " end.",
]


class Pieces(unittest.TestCase):
    def test_every_word_once_in_order(self) -> None:
        for text in SAMPLES:
            words = words_of(text)
            got = pieces(words)
            self.assertEqual(got[0][0], 0, text)
            self.assertEqual(got[-1][1], len(words) - 1, text)
            for (a, b), (c, _) in zip(got, got[1:]):
                self.assertLessEqual(a, b, text)
                self.assertEqual(c, b + 1, text)

    def test_nothing_to_read(self) -> None:
        self.assertEqual(pieces([]), [])

    def test_short_text_is_one_piece(self) -> None:
        self.assertEqual(pieces(words_of("Three words here")), [(0, 2)])

    def test_first_piece_ends_at_the_first_comma_with_enough_words(self) -> None:
        words = words_of("However, the plan we chose, which costs less, is slower than the other one.")
        self.assertEqual(pieces(words)[0], (0, 4))  # "However, the plan we chose,"

    def test_first_piece_without_punctuation_is_short(self) -> None:
        words = words_of(" ".join(f"word{i}" for i in range(120)))
        self.assertEqual(pieces(words)[0], (0, FIRST - 1))

    def test_first_piece_takes_a_later_comma_over_a_cut_mid_phrase(self) -> None:
        words = words_of("The setup script, which runs once on your computer, installs the voice.")
        first = pieces(words)[0]
        self.assertEqual(words[first[1]], "computer,")
        self.assertLessEqual(first[1] + 1, LONGEST_FIRST)

    def test_each_early_piece_at_most_twice_the_one_before(self) -> None:
        for text in SAMPLES:
            got = pieces(words_of(text))
            sizes = [b - a + 1 for a, b in got]
            for before, after in list(zip(sizes, sizes[1:]))[:RAMP]:
                if before * GROWTH >= LONG:
                    break  # from here on, whole sentences
                self.assertLessEqual(after, before * GROWTH, (text, sizes))
                if after < len(words_of(text)):
                    self.assertGreaterEqual(after, min(before, 1), (text, sizes))

    def test_later_pieces_are_whole_sentences(self) -> None:
        words = words_of(" ".join(f"This is sentence {i}, with a comma and a stop." for i in range(12)))
        got = pieces(words)
        for a, b in got[-5:]:
            self.assertTrue(words[b].endswith("."), (words[a : b + 1]))


if __name__ == "__main__":
    unittest.main()
