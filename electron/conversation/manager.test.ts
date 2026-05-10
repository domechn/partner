import test from "node:test";
import assert from "node:assert/strict";

import { createConversationManager } from "./manager.ts";

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });

  return { promise, resolve };
}

test("broadcasts snapshot updates when the session starts and a user turn is submitted", () => {
  const manager = createConversationManager();
  const updates: string[] = [];

  const unsubscribe = manager.onUpdate((update) => {
    updates.push(update.snapshot.phase);
  });

  const started = manager.startSession();
  const submitted = manager.submitUserTurn("你好，介绍一下你自己");

  unsubscribe();

  assert.equal(started.phase, "listening");
  assert.equal(submitted.phase, "thinking");
  assert.deepEqual(updates, ["listening", "thinking"]);
  assert.equal(manager.getSnapshot().turns.length, 1);
});

test("interruptConversation marks an active assistant turn as interrupted", () => {
  const manager = createConversationManager();
  const updateTypes: string[] = [];

  manager.onUpdate((update) => {
    updateTypes.push(update.event.type);
  });

  manager.startSession();
  manager.submitUserTurn("继续");
  manager.dispatch({ type: "assistant.turn.started" });
  manager.dispatch({ type: "assistant.turn.delta", delta: "我正在回答" });

  const interrupted = manager.interruptConversation("barge-in");

  assert.equal(interrupted.phase, "listening");
  assert.equal(interrupted.turns[1]?.status, "interrupted");
  assert.equal(interrupted.lastInterruptionReason, "barge-in");
  assert.ok(updateTypes.includes("assistant.turn.interrupted"));
});

test("submitting a new user turn removes an empty stale assistant stream", () => {
  const manager = createConversationManager();

  manager.startSession();
  manager.submitUserTurn("第一句");
  manager.dispatch({ type: "assistant.turn.started" });

  const snapshot = manager.submitUserTurn("第二句");

  assert.deepEqual(
    snapshot.turns.map((turn) => [turn.role, turn.text, turn.status]),
    [
      ["user", "第一句", "complete"],
      ["user", "第二句", "complete"],
    ],
  );
  assert.equal(snapshot.phase, "thinking");
});

test("streams assistant reply deltas through the manager", async () => {
  const manager = createConversationManager({
    createReplyStream: async function* () {
      yield "你好";
      yield "，我是本地助手。";
    },
  });

  manager.startSession();
  manager.submitUserTurn("介绍一下你自己");

  const finalSnapshot = await manager.streamAssistantReply();

  // Phase remains "speaking" until the TTS player finishes and dispatches
  // assistant.tts.completed — that transition is handled in main.mts.
  assert.equal(finalSnapshot.phase, "speaking");
  assert.equal(finalSnapshot.turns.length, 2);
  assert.equal(finalSnapshot.turns[1]?.role, "assistant");
  assert.equal(finalSnapshot.turns[1]?.status, "complete");
  assert.equal(finalSnapshot.turns[1]?.text, "你好，我是本地助手。");
});

test("interrupting an in-flight reply aborts the stream and keeps later deltas out", async () => {
  const gate = createDeferred<void>();
  const firstDeltaSeen = createDeferred<void>();

  const manager = createConversationManager({
    createReplyStream: async function* (_context, signal) {
      yield "第一句";
      await gate.promise;
      if (signal.aborted) {
        return;
      }
      yield "第二句";
    },
  });

  manager.onUpdate((update) => {
    if (
      update.event.type === "assistant.turn.delta" &&
      update.snapshot.turns[1]?.text === "第一句"
    ) {
      firstDeltaSeen.resolve();
    }
  });

  manager.startSession();
  manager.submitUserTurn("继续说");

  const streamingPromise = manager.streamAssistantReply();
  await firstDeltaSeen.promise;

  const interrupted = manager.interruptConversation("barge-in");
  gate.resolve();
  const finalSnapshot = await streamingPromise;

  assert.equal(interrupted.phase, "listening");
  assert.equal(finalSnapshot.turns[1]?.status, "interrupted");
  assert.equal(finalSnapshot.turns[1]?.text, "第一句");
});

test("requests a confirmation after the assistant reply produces an automation proposal", async () => {
  const manager = createConversationManager({
    createReplyStream: async function* () {
      yield "我可以帮你打开 Safari。";
    },
    createAutomationProposal: async () => ({
      request: { kind: "open_app", appName: "Safari" },
      message: "准备打开 Safari，需要你的确认。",
    }),
  });

  manager.startSession();
  manager.submitUserTurn("帮我打开 Safari");

  const finalSnapshot = await manager.streamAssistantReply();

  assert.deepEqual(finalSnapshot.pendingConfirmation, {
    request: { kind: "open_app", appName: "Safari" },
    message: "准备打开 Safari，需要你的确认。",
    plan: undefined,
  });
});

test("clearConfirmation removes the pending automation proposal", async () => {
  const manager = createConversationManager({
    createReplyStream: async function* () {
      yield "我可以帮你输入邮箱地址。";
    },
    createAutomationProposal: async () => ({
      request: { kind: "type_text", text: "hi@example.com" },
      message: "准备输入文本，需要确认。",
    }),
  });

  manager.startSession();
  manager.submitUserTurn("帮我输入 hi@example.com");
  await manager.streamAssistantReply();

  const cleared = manager.clearConfirmation();

  assert.equal(cleared.pendingConfirmation, null);
});

test("keeps the assistant reply complete when automation proposal generation fails", async () => {
  const manager = createConversationManager({
    createReplyStream: async function* () {
      yield "我先解释一下，再决定要不要操作。";
    },
    createAutomationProposal: async () => {
      throw new Error("proposal failed");
    },
  });

  manager.startSession();
  manager.submitUserTurn("继续");

  const finalSnapshot = await manager.streamAssistantReply();

  assert.equal(finalSnapshot.turns.length, 2);
  assert.equal(finalSnapshot.turns[1]?.status, "complete");
  assert.equal(finalSnapshot.pendingConfirmation, null);
});

test("turns an empty assistant stream into a visible failed reply", async () => {
  const manager = createConversationManager({
    createReplyStream: async function* () {
      yield* [];
    },
  });

  manager.startSession();
  manager.submitUserTurn("继续");

  const finalSnapshot = await manager.streamAssistantReply();

  assert.equal(finalSnapshot.phase, "listening");
  assert.equal(finalSnapshot.lastError, "助手没有返回内容，请重试。");
  assert.equal(finalSnapshot.turns[1]?.text, "助手没有返回内容，请重试。");
});
