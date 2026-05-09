import test from "node:test";
import assert from "node:assert/strict";

import { createConversationSnapshot } from "../../src/lib/conversation.ts";
import {
  parseAutomationProposalResponse,
  resolveOllamaAutomationRequest,
} from "./automationProposal.ts";

test("parseAutomationProposalResponse extracts a request from fenced JSON", () => {
  const proposal = parseAutomationProposalResponse(
    '```json\n{"request":{"kind":"open_app","appName":"Safari"}}\n```',
  );

  assert.deepEqual(proposal, {
    kind: "open_app",
    appName: "Safari",
  });
});

test("resolveOllamaAutomationRequest returns null when the model declines automation", async () => {
  const snapshot = createConversationSnapshot();
  snapshot.turns.push({
    id: "user-1",
    role: "user",
    text: "你觉得这个想法怎么样",
    status: "complete",
  });

  const request = await resolveOllamaAutomationRequest(snapshot, {
    model: "qwen2.5:7b",
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          message: {
            content: '{"request":null}',
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
  });

  assert.equal(request, null);
});

test("resolveOllamaAutomationRequest validates and returns a supported request", async () => {
  const snapshot = createConversationSnapshot();
  snapshot.turns.push(
    {
      id: "user-1",
      role: "user",
      text: "帮我输入 hello@example.com",
      status: "complete",
    },
    {
      id: "assistant-1",
      role: "assistant",
      text: "我可以帮你输入，但会先等你确认。",
      status: "complete",
    },
  );

  const request = await resolveOllamaAutomationRequest(snapshot, {
    model: "qwen2.5:7b",
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          message: {
            content:
              '{"request":{"kind":"type_text","text":"hello@example.com"}}',
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
  });

  assert.deepEqual(request, {
    kind: "type_text",
    text: "hello@example.com",
  });
});
