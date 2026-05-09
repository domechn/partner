import test from "node:test";
import assert from "node:assert/strict";

import { estimateGazeFromFaceLandmarks, type FaceLandmark } from "./gaze.ts";

function createLandmarks(): FaceLandmark[] {
  return Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5 }));
}

function setCenteredEyes(landmarks: FaceLandmark[]) {
  landmarks[33] = { x: 0.2, y: 0.5 };
  landmarks[133] = { x: 0.4, y: 0.5 };
  landmarks[159] = { x: 0.3, y: 0.44 };
  landmarks[145] = { x: 0.3, y: 0.56 };
  landmarks[468] = { x: 0.3, y: 0.5 };

  landmarks[362] = { x: 0.6, y: 0.5 };
  landmarks[263] = { x: 0.8, y: 0.5 };
  landmarks[386] = { x: 0.7, y: 0.44 };
  landmarks[374] = { x: 0.7, y: 0.56 };
  landmarks[473] = { x: 0.7, y: 0.5 };
}

test("estimateGazeFromFaceLandmarks maps centered irises near the screen center", () => {
  const landmarks = createLandmarks();
  setCenteredEyes(landmarks);

  const gaze = estimateGazeFromFaceLandmarks(landmarks);

  assert.ok(gaze);
  assert.ok(Math.abs(gaze.x - 0.5) < 0.01);
  assert.ok(Math.abs(gaze.y - 0.5) < 0.01);
});

test("estimateGazeFromFaceLandmarks follows iris movement", () => {
  const landmarks = createLandmarks();
  setCenteredEyes(landmarks);
  landmarks[468] = { x: 0.36, y: 0.54 };
  landmarks[473] = { x: 0.76, y: 0.54 };

  const gaze = estimateGazeFromFaceLandmarks(landmarks);

  assert.ok(gaze);
  assert.ok(gaze.x > 0.65);
  assert.ok(gaze.y > 0.65);
});
