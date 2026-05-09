import test from "node:test";
import assert from "node:assert/strict";

import { consumeVadLevel, createVadState, type VadConfig } from "./vad.ts";

const testConfig: VadConfig = {
  speechThreshold: 0.1,
  speechStartFrames: 2,
  speechEndFrames: 2,
  minSpeechFrames: 3,
};

test("starts speech after consecutive voiced frames exceed the threshold", () => {
  let state = createVadState();

  let step = consumeVadLevel(state, 0.08, testConfig);
  state = step.state;
  assert.equal(step.event.type, "none");
  assert.equal(state.phase, "idle");

  step = consumeVadLevel(state, 0.12, testConfig);
  state = step.state;
  assert.equal(step.event.type, "none");
  assert.equal(state.phase, "idle");

  step = consumeVadLevel(state, 0.18, testConfig);
  state = step.state;
  assert.equal(step.event.type, "speech-started");
  assert.equal(state.phase, "speech");
});

test("ends speech after sustained silence and keeps the utterance when long enough", () => {
  let state = createVadState();
  const events: string[] = [];

  for (const level of [0.14, 0.15, 0.16, 0.13, 0.02, 0.01]) {
    const step = consumeVadLevel(state, level, testConfig);
    state = step.state;
    events.push(step.event.type);
  }

  assert.deepEqual(events, [
    "none",
    "speech-started",
    "none",
    "none",
    "none",
    "speech-ended",
  ]);
  assert.equal(state.phase, "idle");
  assert.equal(state.lastDecision, "commit");
});

test("discards a short burst that does not meet the minimum speech frames", () => {
  let state = createVadState();

  for (const level of [0.18, 0.19, 0.02, 0.01]) {
    state = consumeVadLevel(state, level, testConfig).state;
  }

  assert.equal(state.phase, "idle");
  assert.equal(state.lastDecision, "discard");
});
