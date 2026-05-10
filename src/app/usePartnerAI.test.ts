import assert from "node:assert/strict";
import test from "node:test";

import { buildTextTurnPayload } from "./usePartnerAI.ts";

test("includes the camera and screen frames in text turns when available", () => {
  assert.deepEqual(
    buildTextTurnPayload("看看我摄像头和屏幕里有什么", {
      cameraImageBase64: "camera-base64",
      screenImageBase64: "screen-base64",
    }),
    {
      text: "看看我摄像头和屏幕里有什么",
      image: "camera-base64",
      screen_image: "screen-base64",
    },
  );
});

test("includes gaze context in text turns when available", () => {
  assert.deepEqual(
    buildTextTurnPayload(
      "我指的那个是什么？",
      { cameraImageBase64: "camera-base64" },
      { x: 0.32, y: 0.67 },
    ),
    {
      text: "我指的那个是什么？",
      image: "camera-base64",
      gaze: { x: 0.32, y: 0.67 },
    },
  );
});

test("includes only the camera frame when no screen frame is available", () => {
  assert.deepEqual(
    buildTextTurnPayload("看看我摄像头里有什么", {
      cameraImageBase64: "camera-base64",
    }),
    {
      text: "看看我摄像头里有什么",
      image: "camera-base64",
    },
  );
});

test("omits the image field for plain text turns", () => {
  assert.deepEqual(buildTextTurnPayload("你好"), {
    text: "你好",
  });
});
