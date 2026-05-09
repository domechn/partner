import test from "node:test";
import assert from "node:assert/strict";

import { createConversationSnapshot } from "../../src/lib/conversation.ts";
import {
  buildOllamaChatRequest,
  streamOllamaChatReply,
} from "./ollamaClient.ts";

function createJsonLineStream(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

async function collectReplyDeltas(
  snapshot: ReturnType<typeof createConversationSnapshot>,
  options: Parameters<typeof streamOllamaChatReply>[1],
): Promise<string[]> {
  const deltas: string[] = [];
  for await (const delta of streamOllamaChatReply(snapshot, options)) {
    deltas.push(delta);
  }

  return deltas;
}

test("builds an Ollama chat request from conversation turns", () => {
  const snapshot = createConversationSnapshot();
  snapshot.turns.push(
    {
      id: "user-1",
      role: "user",
      text: "你好",
      status: "complete",
    },
    {
      id: "assistant-1",
      role: "assistant",
      text: "你好，我在。",
      status: "complete",
    },
  );

  const request = buildOllamaChatRequest(snapshot, {
    model: "qwen2.5:7b",
    systemPrompt: "请始终用中文回答。",
  });

  assert.equal(request.model, "qwen2.5:7b");
  assert.deepEqual(request.messages, [
    { role: "system", content: "请始终用中文回答。" },
    { role: "user", content: "你好" },
    { role: "assistant", content: "你好，我在。" },
  ]);
  assert.equal(request.stream, true);
});

test("builds multimodal Ollama chat messages with user camera images", () => {
  const snapshot = createConversationSnapshot();
  snapshot.turns.push({
    id: "user-1",
    role: "user",
    text: "这张画面里有什么",
    status: "complete",
    imageBase64: "base64-frame",
  });

  const request = buildOllamaChatRequest(snapshot, {
    model: "qwen3-vl:4b",
  });

  assert.deepEqual(request.messages, [
    {
      role: "user",
      content: "这张画面里有什么",
      images: ["base64-frame"],
    },
  ]);
});

test("builds multimodal Ollama chat messages with camera and screen images", () => {
  const snapshot = createConversationSnapshot();
  snapshot.turns.push({
    id: "user-1",
    role: "user",
    text: "打开我正在看的这个软件",
    status: "complete",
    imageBase64: "camera-frame",
    screenImageBase64: "screen-frame",
  });

  const request = buildOllamaChatRequest(snapshot, {
    model: "qwen3-vl:4b",
  });

  assert.deepEqual(request.messages, [
    {
      role: "user",
      content: "打开我正在看的这个软件",
      images: ["camera-frame", "screen-frame"],
    },
  ]);
});

test("only includes the latest user camera image in multimodal chat history", () => {
  const snapshot = createConversationSnapshot();
  snapshot.turns.push(
    {
      id: "user-1",
      role: "user",
      text: "第一张画面里有什么",
      status: "complete",
      imageBase64: "old-frame",
    },
    {
      id: "assistant-1",
      role: "assistant",
      text: "我看到了桌面。",
      status: "complete",
    },
    {
      id: "user-2",
      role: "user",
      text: "现在画面里有什么",
      status: "complete",
      imageBase64: "latest-frame",
    },
  );

  const request = buildOllamaChatRequest(snapshot, {
    model: "qwen3-vl:4b",
  });

  assert.deepEqual(request.messages, [
    { role: "user", content: "第一张画面里有什么" },
    { role: "assistant", content: "我看到了桌面。" },
    {
      role: "user",
      content: "现在画面里有什么",
      images: ["latest-frame"],
    },
  ]);
});

test("streams text deltas from an Ollama NDJSON response", async () => {
  const snapshot = createConversationSnapshot();
  snapshot.turns.push({
    id: "user-1",
    role: "user",
    text: "介绍一下自己",
    status: "complete",
  });

  const fetchCalls: Array<{ url: string; body: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    fetchCalls.push({
      url: String(input),
      body: String(init?.body ?? ""),
    });

    return new Response(
      createJsonLineStream([
        '{"message":{"content":"你好"}}\n',
        '{"message":{"content":"，我是"}}',
        '\n{"message":{"content":"本地助手。"},"done":true}\n',
      ]),
      {
        status: 200,
        headers: { "content-type": "application/x-ndjson" },
      },
    );
  };

  const deltas = await collectReplyDeltas(snapshot, {
    model: "qwen2.5:7b",
    baseUrl: "http://127.0.0.1:11434",
    fetchImpl,
  });

  assert.deepEqual(deltas, ["你好", "，我是", "本地助手。"]);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0]?.url, "http://127.0.0.1:11434/api/chat");
});

test("surfaces the Ollama error body for a missing model 404", async () => {
  const snapshot = createConversationSnapshot();
  snapshot.turns.push({
    id: "user-1",
    role: "user",
    text: "你好",
    status: "complete",
  });

  const fetchCalls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    fetchCalls.push(String(input));
    return new Response(
      JSON.stringify({ error: "model 'qwen2.5:7b' not found" }),
      {
        status: 404,
        headers: { "content-type": "application/json" },
      },
    );
  };

  await assert.rejects(
    collectReplyDeltas(snapshot, {
      model: "qwen2.5:7b",
      baseUrl: "http://127.0.0.1:11434",
      fetchImpl,
    }),
    /model 'qwen2\.5:7b' not found/,
  );

  assert.deepEqual(fetchCalls, ["http://127.0.0.1:11434/api/chat"]);
});

test("falls back to the generate endpoint when chat is unavailable", async () => {
  const snapshot = createConversationSnapshot();
  snapshot.turns.push({
    id: "user-1",
    role: "user",
    text: "你好",
    status: "complete",
  });

  const fetchCalls: Array<{ url: string; body: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    fetchCalls.push({
      url,
      body: String(init?.body ?? ""),
    });

    if (url.endsWith("/api/chat")) {
      return new Response("404 page not found", {
        status: 404,
        headers: { "content-type": "text/plain" },
      });
    }

    return new Response(
      createJsonLineStream([
        '{"response":"你好"}\n',
        '{"response":"，我是本地助手。","done":true}\n',
      ]),
      {
        status: 200,
        headers: { "content-type": "application/x-ndjson" },
      },
    );
  };

  const deltas = await collectReplyDeltas(snapshot, {
    model: "qwen2.5:7b",
    baseUrl: "http://127.0.0.1:11434",
    systemPrompt: "请始终用中文回答。",
    fetchImpl,
  });

  assert.deepEqual(deltas, ["你好", "，我是本地助手。"]);
  assert.deepEqual(
    fetchCalls.map((call) => call.url),
    ["http://127.0.0.1:11434/api/chat", "http://127.0.0.1:11434/api/generate"],
  );

  const fallbackBody = JSON.parse(fetchCalls[1]?.body ?? "{}");
  assert.equal(fallbackBody.model, "qwen2.5:7b");
  assert.equal(fallbackBody.system, "请始终用中文回答。");
  assert.match(fallbackBody.prompt, /user: 你好/);
});

test("retries with the only installed Ollama model when the configured one is missing", async () => {
  const snapshot = createConversationSnapshot();
  snapshot.turns.push({
    id: "user-1",
    role: "user",
    text: "你好",
    status: "complete",
  });

  const fetchCalls: Array<{ url: string; body?: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? init.body : undefined;
    fetchCalls.push({ url, body });

    if (url.endsWith("/api/tags")) {
      return new Response(
        JSON.stringify({ models: [{ name: "qwen3-vl:2b" }] }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }

    const model = body ? JSON.parse(body).model : undefined;
    if (model === "qwen2.5:7b") {
      return new Response(
        JSON.stringify({ error: "model 'qwen2.5:7b' not found" }),
        {
          status: 404,
          headers: { "content-type": "application/json" },
        },
      );
    }

    return new Response(
      createJsonLineStream([
        '{"message":{"content":"你好，我在。"},"done":true}\n',
      ]),
      {
        status: 200,
        headers: { "content-type": "application/x-ndjson" },
      },
    );
  };

  const deltas = await collectReplyDeltas(snapshot, {
    model: "qwen2.5:7b",
    baseUrl: "http://127.0.0.1:11434",
    fetchImpl,
    allowInstalledModelFallback: true,
  } as Parameters<typeof streamOllamaChatReply>[1]);

  assert.deepEqual(deltas, ["你好，我在。"]);
  assert.deepEqual(
    fetchCalls.map((call) => call.url),
    [
      "http://127.0.0.1:11434/api/chat",
      "http://127.0.0.1:11434/api/tags",
      "http://127.0.0.1:11434/api/chat",
    ],
  );

  const retriedBody = JSON.parse(fetchCalls[2]?.body ?? "{}");
  assert.equal(retriedBody.model, "qwen3-vl:2b");
});

test("yields a visible local fallback reply when Ollama cannot be reached", async () => {
  const snapshot = createConversationSnapshot();
  snapshot.turns.push({
    id: "user-1",
    role: "user",
    text: "你好，能听到我吗",
    status: "complete",
  });

  const fetchImpl: typeof fetch = async () => {
    throw new TypeError("fetch failed");
  };

  const deltas = await collectReplyDeltas(snapshot, {
    model: "qwen2.5:7b",
    baseUrl: "http://127.0.0.1:11434",
    fetchImpl,
    allowLocalReplyFallback: true,
  });

  assert.match(deltas.join(""), /我听到了.*你好，能听到我吗/);
  assert.match(deltas.join(""), /Ollama/);
});
