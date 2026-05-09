import test from "node:test";
import assert from "node:assert/strict";

import {
  buildConversationSystemPrompt,
  formatGazeContextForPrompt,
} from "./gazeContext.ts";

test("formatGazeContextForPrompt describes the clamped desktop gaze area", () => {
  const context = formatGazeContextForPrompt({ x: 1.2, y: -0.2 });

  assert.match(context, /右上/);
  assert.match(context, /x=100%/);
  assert.match(context, /y=0%/);
  assert.match(context, /这里|这个|那里/);
});

test("buildConversationSystemPrompt appends gaze context to the base prompt", () => {
  const prompt = buildConversationSystemPrompt("你是 Partner。", {
    x: 0.5,
    y: 0.5,
  });

  assert.match(prompt, /^你是 Partner。/);
  assert.match(prompt, /当前用户注视点/);
  assert.match(prompt, /屏幕中央/);
});
