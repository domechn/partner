import test from "node:test";
import assert from "node:assert/strict";

import { getSpeechStartDecision } from "./conversationSpeech.ts";

test("accepts speech only while the conversation is listening", () => {
  assert.deepEqual(getSpeechStartDecision("listening"), {
    accepted: true,
    shouldInterruptAssistant: false,
  });

  assert.deepEqual(getSpeechStartDecision("speaking"), {
    accepted: false,
    shouldInterruptAssistant: false,
  });

  assert.deepEqual(getSpeechStartDecision("thinking"), {
    accepted: false,
    shouldInterruptAssistant: false,
  });
});