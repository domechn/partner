import test from "node:test";
import assert from "node:assert/strict";

import {
  getConversationVadConfig,
  getSpeechStartDecision,
} from "./conversationSpeech.ts";

test("accepts speech while listening and treats speaking-phase speech as barge-in", () => {
  assert.deepEqual(getSpeechStartDecision("listening"), {
    accepted: true,
    shouldInterruptAssistant: false,
  });

  assert.deepEqual(getSpeechStartDecision("speaking"), {
    accepted: true,
    shouldInterruptAssistant: true,
  });

  assert.deepEqual(getSpeechStartDecision("thinking"), {
    accepted: false,
    shouldInterruptAssistant: false,
  });
});

test("uses a stricter VAD gate while assistant audio is playing", () => {
  const listening = getConversationVadConfig("listening");
  const speaking = getConversationVadConfig("speaking");

  assert.ok(speaking.speechThreshold > listening.speechThreshold);
  assert.ok(speaking.speechStartFrames > listening.speechStartFrames);
  assert.ok(speaking.minSpeechFrames > listening.minSpeechFrames);
});
