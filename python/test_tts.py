import os
import unittest

import tts


class TTSRoutingTests(unittest.TestCase):
    def test_detects_chinese_text(self):
        self.assertTrue(tts.contains_chinese_text("你好，我是 Partner。"))
        self.assertFalse(tts.contains_chinese_text("Hello, I am Partner."))

    def test_selects_macos_chinese_voice_from_env(self):
        env = {"PARTNER_TTS_ZH_VOICE": "Meijia"}

        self.assertEqual(tts.resolve_macos_voice("你好", env), "Meijia")

    def test_selects_default_macos_chinese_voice(self):
        env = {}

        self.assertEqual(tts.resolve_macos_voice("你好", env), "Tingting")


if __name__ == "__main__":
    unittest.main()