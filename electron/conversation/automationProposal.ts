import type { ConversationSnapshot } from "../../src/lib/conversation.ts";
import type { AutomationRequest, GazePoint } from "../../src/lib/intent.ts";
import { formatGazeContextForPrompt } from "./gazeContext.ts";
import { buildOllamaChatRequest } from "./ollamaClient.ts";

export type ResolveOllamaAutomationRequestOptions = {
  model: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  gaze?: GazePoint;
};

const DEFAULT_BASE_URL = "http://127.0.0.1:11434";

const AUTOMATION_SYSTEM_PROMPT = [
  "你是 Partner 的自动化请求分类器。",
  "请判断最近一轮对话是否明确要求电脑执行动作。",
  "只允许输出 JSON，不要输出解释、代码块以外的文字。",
  '如果不应该执行动作，输出 {"request":null}。',
  '如果应该执行动作，只能输出 {"request":AutomationRequest}。',
  "AutomationRequest 只允许以下形状：",
  '{"kind":"click_here"}',
  '{"kind":"switch_tab"}',
  '{"kind":"type_text","text":"..."}',
  '{"kind":"open_app","appName":"..."}',
  '{"kind":"agent_task","goal":"..."}',
  "只有在用户明确要求电脑执行时才返回 request；闲聊、解释、建议都返回 null。",
].join("");

type AutomationProposalEnvelope = {
  request?: unknown;
};

export async function resolveOllamaAutomationRequest(
  snapshot: ConversationSnapshot,
  options: ResolveOllamaAutomationRequestOptions,
): Promise<AutomationRequest | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const request = buildOllamaChatRequest(snapshot, {
    model: options.model,
    systemPrompt: buildAutomationSystemPrompt(options.gaze),
  });

  const response = await fetchImpl(
    `${normalizeBaseUrl(options.baseUrl)}/api/chat`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ...request,
        stream: false,
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`Ollama 自动化判断失败 (${response.status})`);
  }

  const payload = (await response.json()) as {
    message?: {
      content?: string;
    };
  };

  return parseAutomationProposalResponse(payload.message?.content ?? "");
}

export function parseAutomationProposalResponse(
  raw: string,
): AutomationRequest | null {
  const normalized = stripCodeFence(raw);
  if (!normalized) {
    return null;
  }

  const envelope = JSON.parse(
    extractJsonObject(normalized),
  ) as AutomationProposalEnvelope;
  return validateAutomationRequest(envelope.request);
}

function buildAutomationSystemPrompt(gaze: GazePoint | undefined): string {
  if (!gaze) {
    return AUTOMATION_SYSTEM_PROMPT;
  }

  return `${AUTOMATION_SYSTEM_PROMPT}\n${formatGazeContextForPrompt(gaze)}`;
}

function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("```")) {
    return trimmed;
  }

  return trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function extractJsonObject(raw: string): string {
  const firstBraceIndex = raw.indexOf("{");
  const lastBraceIndex = raw.lastIndexOf("}");
  if (
    firstBraceIndex === -1 ||
    lastBraceIndex === -1 ||
    lastBraceIndex < firstBraceIndex
  ) {
    throw new Error("Automation proposal did not contain JSON.");
  }

  return raw.slice(firstBraceIndex, lastBraceIndex + 1);
}

function validateAutomationRequest(value: unknown): AutomationRequest | null {
  if (value == null || typeof value !== "object") {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  switch (candidate.kind) {
    case "click_here":
    case "switch_tab":
      return { kind: candidate.kind };
    case "type_text":
      if (typeof candidate.text !== "string" || !candidate.text.trim()) {
        return null;
      }
      return { kind: "type_text", text: candidate.text.trim() };
    case "open_app":
      if (typeof candidate.appName !== "string" || !candidate.appName.trim()) {
        return null;
      }
      return { kind: "open_app", appName: candidate.appName.trim() };
    case "agent_task":
      if (typeof candidate.goal !== "string" || !candidate.goal.trim()) {
        return null;
      }
      return { kind: "agent_task", goal: candidate.goal.trim() };
    default:
      return null;
  }
}

function normalizeBaseUrl(baseUrl = DEFAULT_BASE_URL): string {
  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}
