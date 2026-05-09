import test from "node:test";
import assert from "node:assert/strict";

import { parseConversationControl } from "./conversationControl.ts";

test("recognizes explicit confirmation phrases", () => {
  assert.deepEqual(parseConversationControl("确认执行"), { kind: "confirm" });
  assert.deepEqual(parseConversationControl("可以执行"), { kind: "confirm" });
  assert.deepEqual(parseConversationControl("确定，执行吧"), {
    kind: "confirm",
  });
});

test("recognizes explicit cancellation phrases", () => {
  assert.deepEqual(parseConversationControl("取消"), { kind: "cancel" });
  assert.deepEqual(parseConversationControl("别执行"), { kind: "cancel" });
  assert.deepEqual(parseConversationControl("不用了，取消这次操作"), {
    kind: "cancel",
  });
});

test("ignores regular conversational content", () => {
  assert.equal(parseConversationControl("你觉得这个方案怎么样"), null);
  assert.equal(parseConversationControl("帮我打开 Safari"), null);
  assert.equal(parseConversationControl(""), null);
});