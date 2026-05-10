"""Helpers for building multimodal Partner model requests."""

from typing import Any


def build_user_content(msg: dict[str, Any]) -> list[dict[str, str]]:
    content: list[dict[str, str]] = []
    has_audio = bool(msg.get("audio"))
    has_camera_image = bool(msg.get("image"))
    has_screen_image = bool(msg.get("screen_image"))
    has_any_image = has_camera_image or has_screen_image
    user_text = str(msg.get("text", "")).strip()
    has_text = bool(user_text)
    gaze_hint = _build_gaze_hint(msg.get("gaze"))

    if has_audio:
        content.append({"type": "audio", "blob": msg["audio"]})
    if has_camera_image:
        content.append({"type": "image", "blob": msg["image"]})
    if has_screen_image:
        content.append({"type": "image", "blob": msg["screen_image"]})

    visual_order_zh = _describe_visual_order(has_camera_image, has_screen_image, "zh")
    visual_order_en = _describe_visual_order(has_camera_image, has_screen_image, "en")

    if has_audio and has_any_image:
        text = (
            f"用户刚刚通过语音向你说话（audio），同时提供了视觉画面。{visual_order_zh}"
            f"{gaze_hint}请先理解语音里的视觉指代词（这个/那个/我指的/它），"
            "再结合画面直接回答。"
            "如果用户问某个物体是什么或有什么特征，必须给出你看到的具体物体名称、"
            "大致位置、颜色、形状或材质等可见特征；不要只说“墙上的一个物体”或“这个东西”，"
            "不要反问“你想让我做些什么”。看不清时直接说明看不清，并请用户靠近或继续指着它。"
            " / "
            f"The user just spoke (audio) and also provided visual inputs. {visual_order_en}"
            f"{gaze_hint} First resolve visual references such as this/that/what I am pointing at/it, "
            "then answer directly using the images. If the user asks what an object is or what its features are, "
            "name the specific visible object and describe visible position, color, shape, or material. "
            "Do not answer with only a generic phrase such as an object on the wall or this thing, "
            "and do not ask what the user wants. If it is unclear, say so and ask the user to move closer or keep pointing."
        )
    elif has_audio:
        text = (
            "用户刚刚通过语音向你说话，请回应。"
            " / The user just spoke to you. Respond to what they said."
        )
    elif has_any_image and has_text:
        text = (
            f"用户的问题是：{user_text}。{visual_order_zh}请结合画面和注视点直接回答。{gaze_hint}"
            "如果问题里有这个/那个/我指的/它，请定位到具体对象并说明可见特征，不要泛泛反问。"
            " / "
            f"The user's request is: {user_text}. {visual_order_en}Use the images and gaze point to answer directly."
            f"{gaze_hint} If the request uses this/that/what I am pointing at/it, identify the specific object and visible features; do not ask a generic follow-up."
        )
    elif has_any_image:
        text = (
            f"用户向你展示了视觉画面。{visual_order_zh}请描述你看到的主要对象和可见特征。"
            f" / The user is showing you visual inputs. {visual_order_en}Describe the main visible objects and features."
        )
    else:
        text = user_text or "你好！ / Hello!"

    content.append({"type": "text", "text": text})
    return content


def _build_gaze_hint(gaze: Any) -> str:
    if not isinstance(gaze, dict):
        return ""

    try:
        x = float(gaze.get("x", 0.5))
        y = float(gaze.get("y", 0.5))
    except (TypeError, ValueError):
        return ""

    return (
        f" 用户大约正看向屏幕坐标 ({x:.2f}, {y:.2f})。"
        f" / The user is looking at approximately ({x:.2f}, {y:.2f}) on screen."
    )


def _describe_visual_order(
    has_camera_image: bool,
    has_screen_image: bool,
    language: str,
) -> str:
    if language == "zh":
        if has_camera_image and has_screen_image:
            return "图像顺序：第一张是摄像头画面，第二张是电脑屏幕截图。"
        if has_camera_image:
            return "图像是摄像头画面。"
        if has_screen_image:
            return "图像是电脑屏幕截图。"
        return ""

    if has_camera_image and has_screen_image:
        return "Image order: first is the camera image; second is the screen capture. "
    if has_camera_image:
        return "The image is the camera image. "
    if has_screen_image:
        return "The image is the screen capture. "
    return ""