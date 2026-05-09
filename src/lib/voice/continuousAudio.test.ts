import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSpeechAudioBlob,
  measureRmsLevel,
  selectAudioChunksForSpeech,
  trimRecordedAudioChunks,
  type RecordedAudioChunk,
} from "./continuousAudio.ts";

test("measureRmsLevel returns the root-mean-square amplitude of a frame", () => {
  assert.equal(measureRmsLevel(new Float32Array([0, 0, 0, 0])), 0);

  const rms = measureRmsLevel(new Float32Array([0.5, -0.5, 0.5, -0.5]));
  assert.equal(rms, 0.5);
});

test("selectAudioChunksForSpeech includes chunks captured before speech start", () => {
  const chunks: RecordedAudioChunk[] = [
    { blob: new Blob(["too-old"]), receivedAtMs: 450 },
    { blob: new Blob(["pre-roll"]), receivedAtMs: 760 },
    { blob: new Blob(["speech-start"]), receivedAtMs: 1010 },
    { blob: new Blob(["speech-end"]), receivedAtMs: 1420 },
  ];

  const selected = selectAudioChunksForSpeech(chunks, {
    speechStartMs: 1000,
    speechEndMs: 1500,
    preSpeechMs: 300,
  });

  assert.deepEqual(
    selected.map((chunk) => chunk.receivedAtMs),
    [760, 1010, 1420],
  );
});

test("trimRecordedAudioChunks keeps only the rolling pre-speech buffer", () => {
  const chunks: RecordedAudioChunk[] = [
    { blob: new Blob(["old"]), receivedAtMs: 100 },
    { blob: new Blob(["keep-1"]), receivedAtMs: 650 },
    { blob: new Blob(["keep-2"]), receivedAtMs: 900 },
  ];

  assert.deepEqual(
    trimRecordedAudioChunks(chunks, { nowMs: 1000, preSpeechMs: 400 }).map(
      (chunk) => chunk.receivedAtMs,
    ),
    [650, 900],
  );
});

test("buildSpeechAudioBlob prepends the recorder header when chunks were trimmed", async () => {
  const headerChunk: RecordedAudioChunk = {
    blob: new Blob(["header"], { type: "audio/webm" }),
    receivedAtMs: 100,
  };
  const speechChunk: RecordedAudioChunk = {
    blob: new Blob(["speech"], { type: "audio/webm" }),
    receivedAtMs: 1200,
  };

  const blob = buildSpeechAudioBlob([speechChunk], {
    headerChunk,
    mimeType: "audio/webm;codecs=opus",
  });

  assert.equal(blob.type, "audio/webm;codecs=opus");
  assert.equal(await blob.text(), "headerspeech");
});

test("buildSpeechAudioBlob does not duplicate the header chunk", async () => {
  const headerChunk: RecordedAudioChunk = {
    blob: new Blob(["header"], { type: "audio/webm" }),
    receivedAtMs: 100,
  };

  const blob = buildSpeechAudioBlob([headerChunk], { headerChunk });

  assert.equal(await blob.text(), "header");
});
