import unittest

from request_content import build_user_content


class BuildUserContentTests(unittest.TestCase):
    def test_keeps_user_question_when_text_and_image_are_both_present(self):
        content = build_user_content({"text": "我手上拿着什么？", "image": "camera-base64"})

        self.assertEqual(content[0], {"type": "image", "blob": "camera-base64"})
        text_part = next(item["text"] for item in content if item["type"] == "text")
        self.assertIn("我手上拿着什么？", text_part)

    def test_keeps_user_question_when_camera_and_screen_images_are_both_present(self):
        content = build_user_content(
            {
                "text": "屏幕右上角和我手里各是什么？",
                "image": "camera-base64",
                "screen_image": "screen-base64",
            }
        )

        image_parts = [item for item in content if item["type"] == "image"]
        self.assertEqual(
            image_parts,
            [
                {"type": "image", "blob": "camera-base64"},
                {"type": "image", "blob": "screen-base64"},
            ],
        )
        text_part = next(item["text"] for item in content if item["type"] == "text")
        self.assertIn("屏幕右上角和我手里各是什么？", text_part)
        self.assertIn("摄像头", text_part)
        self.assertIn("屏幕", text_part)
        self.assertIn("第一张", text_part)
        self.assertIn("第二张", text_part)

    def test_audio_image_prompt_resolves_visual_references_directly(self):
        content = build_user_content(
            {
                "audio": "wav-base64",
                "image": "camera-base64",
                "gaze": {"x": 0.25, "y": 0.75},
            }
        )

        self.assertEqual(content[0], {"type": "audio", "blob": "wav-base64"})
        self.assertEqual(content[1], {"type": "image", "blob": "camera-base64"})
        text_part = next(item["text"] for item in content if item["type"] == "text")
        self.assertIn("这个/那个", text_part)
        self.assertIn("具体物体", text_part)
        self.assertIn("不要反问", text_part)
        self.assertIn("(0.25, 0.75)", text_part)

    def test_falls_back_to_generic_image_prompt_when_only_image_is_present(self):
        content = build_user_content({"image": "camera-base64"})

        self.assertEqual(content[0], {"type": "image", "blob": "camera-base64"})
        text_part = next(item["text"] for item in content if item["type"] == "text")
        self.assertIn("main visible objects", text_part.lower())
        self.assertIn("可见特征", text_part)

    def test_falls_back_to_generic_screen_prompt_when_only_screen_image_is_present(self):
        content = build_user_content({"screen_image": "screen-base64"})

        self.assertEqual(content[0], {"type": "image", "blob": "screen-base64"})
        text_part = next(item["text"] for item in content if item["type"] == "text")
        self.assertIn("screen", text_part.lower())


if __name__ == "__main__":
    unittest.main()