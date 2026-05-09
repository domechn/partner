import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSystemSayArgs,
  createLocalTtsPlayer,
  splitTextForSpeech,
} from "./localTts.ts";

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });

  return { promise, resolve };
}

test("splitTextForSpeech flushes finished sentences and keeps the unfinished tail", () => {
  const result = splitTextForSpeech("你好。今天过得怎么样？我还在听", {
    softLimit: 10,
  });

  assert.deepEqual(result.chunks, ["你好。", "今天过得怎么样？"]);
  assert.equal(result.remainder, "我还在听");
});

test("buildSystemSayArgs chooses a Chinese or English voice from the text", () => {
  assert.deepEqual(
    buildSystemSayArgs("你好，我在。", {
      PARTNER_TTS_ZH_VOICE: "Tingting",
      PARTNER_TTS_EN_VOICE: "Samantha",
    }),
    ["-v", "Tingting", "你好，我在。"],
  );

  assert.deepEqual(
    buildSystemSayArgs("Hello, I am here.", {
      PARTNER_TTS_ZH_VOICE: "Tingting",
      PARTNER_TTS_EN_VOICE: "Samantha",
    }),
    ["-v", "Samantha", "Hello, I am here."],
  );
});

test("buildSystemSayArgs keeps the explicit TTS voice override", () => {
  assert.deepEqual(
    buildSystemSayArgs("你好", {
      PARTNER_TTS_VOICE: "Mei-Jia",
      PARTNER_TTS_ZH_VOICE: "Tingting",
    }),
    ["-v", "Mei-Jia", "你好"],
  );
});

test("local TTS player speaks queued chunks in order", async () => {
  const calls: string[] = [];
  const player = createLocalTtsPlayer({
    speakText: async (text) => {
      calls.push(`start:${text}`);
      await Promise.resolve();
      calls.push(`done:${text}`);
    },
  });

  player.enqueue("第一句");
  player.enqueue("第二句");
  await player.whenIdle();

  assert.deepEqual(calls, [
    "start:第一句",
    "done:第一句",
    "start:第二句",
    "done:第二句",
  ]);
  assert.equal(player.isSpeaking(), false);
});

test("stop aborts the active chunk and clears the rest of the queue", async () => {
  const firstChunk = createDeferred<void>();
  const calls: string[] = [];
  const player = createLocalTtsPlayer({
    speakText: (text, signal) => {
      calls.push(`start:${text}`);

      return new Promise<void>((resolve) => {
        let settled = false;

        const finish = (label: string) => {
          if (settled) {
            return;
          }

          settled = true;
          calls.push(label);
          resolve();
        };

        const onAbort = () => {
          finish(`abort:${text}`);
        };

        signal.addEventListener("abort", onAbort, { once: true });
        firstChunk.promise.then(() => {
          signal.removeEventListener("abort", onAbort);
          finish(`done:${text}`);
        });
      });
    },
  });

  player.enqueue("第一句");
  player.enqueue("第二句");
  await Promise.resolve();

  await player.stop("barge-in");
  firstChunk.resolve();
  await player.whenIdle();

  assert.deepEqual(calls, ["start:第一句", "abort:第一句"]);
  assert.equal(player.isSpeaking(), false);
});
