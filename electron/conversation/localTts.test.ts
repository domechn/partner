import test from "node:test";
import assert from "node:assert/strict";

import {
  QWEN3_TTS_LIGHTWEIGHT_MODEL,
  buildHuggingFaceTtsRequest,
  createHuggingFaceTtsSpeaker,
  buildSystemSayArgs,
  createLocalTtsPlayer,
  splitStreamingTextForSpeech,
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

test("splitTextForSpeech flushes long streaming token fragments before final punctuation", () => {
  const result = splitTextForSpeech("这是模型正在实时返回的一段较长内容", {
    hardLimit: 9,
  });

  assert.deepEqual(result.chunks, ["这是模型正在实时返"]);
  assert.equal(result.remainder, "回的一段较长内容");
});

test("splitStreamingTextForSpeech starts speaking before a long reply finishes", () => {
  const result = splitStreamingTextForSpeech("我看到画面里有一个窗口和");

  assert.deepEqual(result.chunks, ["我看到画面里有一个"]);
  assert.equal(result.remainder, "窗口和");
});

test("buildHuggingFaceTtsRequest targets the smallest Qwen3 TTS model by default", () => {
  const request = buildHuggingFaceTtsRequest("你好，我在。", {
    token: "hf_test",
  });

  assert.equal(QWEN3_TTS_LIGHTWEIGHT_MODEL, "Qwen/Qwen3-TTS-12Hz-0.6B-Base");
  assert.equal(
    request.url,
    "https://api-inference.huggingface.co/models/Qwen/Qwen3-TTS-12Hz-0.6B-Base",
  );
  assert.equal(request.headers.authorization, "Bearer hf_test");
  assert.deepEqual(JSON.parse(request.body), { inputs: "你好，我在。" });
});

test("Hugging Face TTS speaker sends text to Qwen3 TTS and plays returned audio", async () => {
  const played: Array<{ audio: Uint8Array; mimeType: string }> = [];
  const fetchCalls: Array<{ url: string; body?: string }> = [];
  const speaker = createHuggingFaceTtsSpeaker({
    token: "hf_test",
    fetchImpl: async (input, init) => {
      fetchCalls.push({
        url: String(input),
        body: typeof init?.body === "string" ? init.body : undefined,
      });

      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "audio/wav" },
      });
    },
    playAudioBuffer: async (audio, mimeType) => {
      played.push({ audio, mimeType });
    },
  });

  await speaker("你好", new AbortController().signal);

  assert.equal(fetchCalls.length, 1);
  assert.match(fetchCalls[0]?.url ?? "", /Qwen3-TTS-12Hz-0\.6B-Base$/);
  assert.deepEqual(JSON.parse(fetchCalls[0]?.body ?? "{}"), { inputs: "你好" });
  assert.deepEqual(played, [
    { audio: new Uint8Array([1, 2, 3]), mimeType: "audio/wav" },
  ]);
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
