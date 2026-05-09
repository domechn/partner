import test from "node:test";
import assert from "node:assert/strict";

import {
  createConversationSnapshot,
  reduceConversationSnapshot,
  type ConversationSnapshot,
} from "./conversation.ts";

function applyEvents(
  events: Parameters<typeof reduceConversationSnapshot>[1][],
): ConversationSnapshot {
  return events.reduce(
    reduceConversationSnapshot,
    createConversationSnapshot(),
  );
}

test("starts a conversation session in listening state", () => {
  const next = reduceConversationSnapshot(createConversationSnapshot(), {
    type: "session.started",
  });

  assert.equal(next.isActive, true);
  assert.equal(next.phase, "listening");
  assert.equal(next.turns.length, 0);
});

test("commits a user turn and moves into thinking", () => {
  const next = applyEvents([
    { type: "session.started" },
    { type: "user.speech.started" },
    { type: "user.turn.committed", text: "帮我总结今天的会议" },
  ]);

  assert.equal(next.phase, "thinking");
  assert.equal(next.turns.length, 1);
  assert.equal(next.turns[0]?.role, "user");
  assert.equal(next.turns[0]?.status, "complete");
  assert.equal(next.turns[0]?.text, "帮我总结今天的会议");
});

test("streams assistant deltas into a single speaking turn", () => {
  const next = applyEvents([
    { type: "session.started" },
    { type: "user.turn.committed", text: "你好" },
    { type: "assistant.turn.started" },
    { type: "assistant.turn.delta", delta: "你" },
    { type: "assistant.turn.delta", delta: "好，我在。" },
    { type: "assistant.turn.completed" },
  ]);

  assert.equal(next.phase, "listening");
  assert.equal(next.turns.length, 2);
  assert.equal(next.turns[1]?.role, "assistant");
  assert.equal(next.turns[1]?.status, "complete");
  assert.equal(next.turns[1]?.text, "你好，我在。");
});

test("interrupts an active assistant turn and returns to listening", () => {
  const next = applyEvents([
    { type: "session.started" },
    { type: "user.turn.committed", text: "继续" },
    { type: "assistant.turn.started" },
    { type: "assistant.turn.delta", delta: "我正在" },
    { type: "assistant.turn.interrupted", reason: "barge-in" },
  ]);

  assert.equal(next.phase, "listening");
  assert.equal(next.turns.length, 2);
  assert.equal(next.turns[1]?.role, "assistant");
  assert.equal(next.turns[1]?.status, "interrupted");
  assert.equal(next.turns[1]?.text, "我正在");
  assert.equal(next.lastInterruptionReason, "barge-in");
});

test("stores and clears a pending confirmation request", () => {
  const pendingAction = { kind: "open_app", appName: "Safari" } as const;

  const requested = applyEvents([
    { type: "session.started" },
    {
      type: "confirmation.requested",
      request: pendingAction,
      message: "请确认是否打开 Safari",
    },
  ]);

  assert.deepEqual(requested.pendingConfirmation, {
    request: pendingAction,
    message: "请确认是否打开 Safari",
    plan: undefined,
  });
  assert.equal(requested.phase, "listening");

  const cleared = reduceConversationSnapshot(requested, {
    type: "confirmation.cleared",
  });

  assert.equal(cleared.pendingConfirmation, null);
});

test("returns to listening when a user utterance is discarded", () => {
  const next = applyEvents([
    { type: "session.started" },
    { type: "user.speech.started" },
    { type: "user.transcription.started" },
    { type: "user.turn.discarded", reason: "没有识别到清晰语音" },
  ]);

  assert.equal(next.phase, "listening");
  assert.equal(next.turns.length, 0);
  assert.equal(next.lastError, "没有识别到清晰语音");
});
