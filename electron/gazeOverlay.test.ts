import test from "node:test";
import assert from "node:assert/strict";

import {
  buildGazeOverlayHtml,
  resolveGazeOverlayPoint,
} from "./gazeOverlay.ts";

test("resolveGazeOverlayPoint maps normalized gaze into overlay pixels", () => {
  assert.deepEqual(
    resolveGazeOverlayPoint({ x: 0.25, y: 0.75 }, { width: 1200, height: 800 }),
    { x: 300, y: 600 },
  );
});

test("resolveGazeOverlayPoint clamps out-of-range gaze coordinates", () => {
  assert.deepEqual(
    resolveGazeOverlayPoint({ x: 1.4, y: -0.4 }, { width: 1200, height: 800 }),
    { x: 1200, y: 0 },
  );
});

test("buildGazeOverlayHtml exposes a gaze update function", () => {
  const html = buildGazeOverlayHtml();

  assert.match(html, /partnerSetGaze/);
  assert.match(html, /gaze-bubble/);
});
