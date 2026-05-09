import test from "node:test";
import assert from "node:assert/strict";

import {
  captureScreenImageBase64,
  selectScreenCaptureSource,
  stripImageDataUrl,
  type ScreenCaptureSource,
} from "./screenCapture.ts";

function createSource(
  displayId: string,
  dataUrl: string,
  empty = false,
): ScreenCaptureSource {
  return {
    id: `screen:${displayId}`,
    name: `Display ${displayId}`,
    display_id: displayId,
    thumbnail: {
      isEmpty: () => empty,
      toDataURL: () => dataUrl,
    },
  };
}

test("selectScreenCaptureSource prefers the primary display thumbnail", () => {
  const sources = [
    createSource("2", "data:image/png;base64,secondary"),
    createSource("1", "data:image/png;base64,primary"),
  ];

  assert.equal(selectScreenCaptureSource(sources, 1)?.display_id, "1");
});

test("selectScreenCaptureSource falls back to the first non-empty screen", () => {
  const sources = [
    createSource("1", "data:image/png;base64,empty", true),
    createSource("2", "data:image/png;base64,secondary"),
  ];

  assert.equal(selectScreenCaptureSource(sources, 1)?.display_id, "2");
});

test("stripImageDataUrl returns only the base64 payload", () => {
  assert.equal(stripImageDataUrl("data:image/jpeg;base64,abc123"), "abc123");
  assert.equal(stripImageDataUrl("raw-base64"), "raw-base64");
});

test("captureScreenImageBase64 captures a selected screen thumbnail", async () => {
  const image = await captureScreenImageBase64({
    primaryDisplayId: 42,
    getSources: async () => [
      createSource("42", "data:image/png;base64,screen"),
    ],
  });

  assert.equal(image, "screen");
});
