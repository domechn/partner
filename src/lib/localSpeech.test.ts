import test from "node:test";
import assert from "node:assert/strict";

import { getLocalSpeechTranscriptionOptions } from "./localSpeech.ts";

test("prefers chinese transcription options for local speech recognition", () => {
  assert.deepEqual(getLocalSpeechTranscriptionOptions(), {
    chunk_length_s: 20,
    stride_length_s: 4,
    task: "transcribe",
    language: "zh",
  });
});
