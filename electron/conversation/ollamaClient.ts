import type { ConversationSnapshot } from "../../src/lib/conversation.ts";

export type OllamaChatRole = "system" | "user" | "assistant";

export type OllamaChatMessage = {
  role: OllamaChatRole;
  content: string;
};

export type OllamaChatRequest = {
  model: string;
  stream: true;
  messages: OllamaChatMessage[];
};

type OllamaGenerateRequest = {
  model: string;
  stream: true;
  prompt: string;
  system?: string;
};

export type BuildOllamaChatRequestOptions = {
  model: string;
  systemPrompt?: string;
};

export type StreamOllamaChatReplyOptions = BuildOllamaChatRequestOptions & {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  allowInstalledModelFallback?: boolean;
  allowLocalReplyFallback?: boolean;
};

type OllamaStreamChunk = {
  message?: {
    content?: string;
  };
  response?: string;
  done?: boolean;
  error?: string;
};

const DEFAULT_BASE_URL = "http://127.0.0.1:11434";

export function buildOllamaChatRequest(
  snapshot: ConversationSnapshot,
  options: BuildOllamaChatRequestOptions,
): OllamaChatRequest {
  const messages: OllamaChatMessage[] = [];

  if (options.systemPrompt?.trim()) {
    messages.push({
      role: "system",
      content: options.systemPrompt.trim(),
    });
  }

  for (const turn of snapshot.turns) {
    if (turn.status === "interrupted") {
      continue;
    }

    const text = turn.text.trim();
    if (!text) {
      continue;
    }

    messages.push({
      role: turn.role,
      content: text,
    });
  }

  return {
    model: options.model,
    stream: true,
    messages,
  };
}

function buildOllamaGenerateRequest(
  snapshot: ConversationSnapshot,
  options: BuildOllamaChatRequestOptions,
): OllamaGenerateRequest {
  const promptLines: string[] = [];

  for (const turn of snapshot.turns) {
    if (turn.status === "interrupted") {
      continue;
    }

    const text = turn.text.trim();
    if (!text) {
      continue;
    }

    promptLines.push(`${turn.role}: ${text}`);
  }

  const request: OllamaGenerateRequest = {
    model: options.model,
    stream: true,
    prompt: promptLines.join("\n\n"),
  };

  if (options.systemPrompt?.trim()) {
    request.system = options.systemPrompt.trim();
  }

  return request;
}

export async function* streamOllamaChatReply(
  snapshot: ConversationSnapshot,
  options: StreamOllamaChatReplyOptions,
): AsyncIterable<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;

  try {
    response = await requestOllamaResponse(snapshot, options, fetchImpl);
  } catch (error) {
    if (options.allowLocalReplyFallback && !options.signal?.aborted) {
      yield buildLocalFallbackReply(snapshot, error);
      return;
    }

    throw error;
  }

  if (!response.body) {
    throw new Error("Ollama 没有返回可读取的数据流");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      buffer += decoder.decode();
      yield* parseBuffer(buffer);
      return;
    }

    buffer += decoder.decode(value, { stream: true });
    const segments = buffer.split("\n");
    buffer = segments.pop() ?? "";

    for (const segment of segments) {
      const chunk = parseChunk(segment);
      if (!chunk) {
        continue;
      }

      if (chunk.error) {
        throw new Error(chunk.error);
      }

      const content = getChunkContent(chunk);
      if (content) {
        yield content;
      }

      if (chunk.done) {
        return;
      }
    }
  }
}

async function requestOllamaResponse(
  snapshot: ConversationSnapshot,
  options: StreamOllamaChatReplyOptions,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  return requestOllamaResponseForModel(
    snapshot,
    options,
    fetchImpl,
    baseUrl,
    options.model,
    options.allowInstalledModelFallback ?? false,
  );
}

async function requestOllamaResponseForModel(
  snapshot: ConversationSnapshot,
  options: StreamOllamaChatReplyOptions,
  fetchImpl: typeof fetch,
  baseUrl: string,
  model: string,
  allowInstalledModelFallback: boolean,
): Promise<Response> {
  const response = await fetchImpl(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(
      buildOllamaChatRequest(snapshot, { ...options, model }),
    ),
    signal: options.signal,
  });

  if (response.ok) {
    return response;
  }

  const errorDetail = await readOllamaError(response);
  if (allowInstalledModelFallback && looksLikeMissingModelError(errorDetail)) {
    const installedModel = await resolveInstalledModelFallback(
      baseUrl,
      fetchImpl,
      options.signal,
      model,
    );

    if (installedModel) {
      return requestOllamaResponseForModel(
        snapshot,
        options,
        fetchImpl,
        baseUrl,
        installedModel,
        false,
      );
    }
  }

  if (shouldFallbackToGenerate(response.status, errorDetail)) {
    const fallbackResponse = await fetchImpl(`${baseUrl}/api/generate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(
        buildOllamaGenerateRequest(snapshot, { ...options, model }),
      ),
      signal: options.signal,
    });

    if (fallbackResponse.ok) {
      return fallbackResponse;
    }

    throw new Error(
      formatOllamaError(
        fallbackResponse.status,
        await readOllamaError(fallbackResponse),
      ),
    );
  }

  throw new Error(formatOllamaError(response.status, errorDetail));
}

async function resolveInstalledModelFallback(
  baseUrl: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal | undefined,
  currentModel: string,
): Promise<string | null> {
  try {
    const response = await fetchImpl(`${baseUrl}/api/tags`, {
      method: "GET",
      signal,
    });

    if (!response.ok) {
      return null;
    }

    const body = (await response.text()).trim();
    if (!body) {
      return null;
    }

    const parsed = JSON.parse(body) as {
      models?: Array<{ name?: unknown }>;
    };

    const installedModels = (parsed.models ?? [])
      .map((entry) => (typeof entry.name === "string" ? entry.name.trim() : ""))
      .filter(Boolean)
      .filter((name, index, names) => names.indexOf(name) === index);

    if (installedModels.length !== 1) {
      return null;
    }

    return installedModels[0] === currentModel ? null : installedModels[0];
  } catch {
    return null;
  }
}

function* parseBuffer(buffer: string): Iterable<string> {
  const chunk = parseChunk(buffer);
  if (!chunk) {
    return;
  }

  if (chunk.error) {
    throw new Error(chunk.error);
  }

  const content = getChunkContent(chunk);
  if (content) {
    yield content;
  }
}

function parseChunk(line: string): OllamaStreamChunk | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  return JSON.parse(trimmed) as OllamaStreamChunk;
}

function getChunkContent(chunk: OllamaStreamChunk): string | undefined {
  return chunk.message?.content ?? chunk.response;
}

function buildLocalFallbackReply(
  snapshot: ConversationSnapshot,
  error: unknown,
): string {
  const lastUserText = findLastUserText(snapshot);
  const reason = error instanceof Error ? error.message : String(error ?? "");
  const isEnglishOnly =
    /[A-Za-z]/.test(lastUserText) && !/\p{Script=Han}/u.test(lastUserText);

  if (isEnglishOnly) {
    return [
      lastUserText ? `I heard: “${lastUserText}”.` : "I am listening.",
      "I cannot reach the local Ollama model right now, so this is a local fallback reply.",
      reason
        ? `Details: ${reason}.`
        : "Please confirm Ollama is running and the model is installed.",
    ].join(" ");
  }

  return [
    lastUserText ? `我听到了：“${lastUserText}”。` : "我正在监听。",
    "本地 Ollama 模型暂时连接不上，所以我先用本地兜底回复让对话不断掉。",
    reason ? `细节：${reason}。` : "请确认 Ollama 已运行并已下载模型。",
  ].join("");
}

function findLastUserText(snapshot: ConversationSnapshot): string {
  for (let index = snapshot.turns.length - 1; index >= 0; index -= 1) {
    const turn = snapshot.turns[index];
    if (turn?.role === "user" && turn.text.trim()) {
      return turn.text.trim();
    }
  }

  return "";
}

async function readOllamaError(response: Response): Promise<string> {
  const body = (await response.text()).trim();
  if (!body) {
    return "";
  }

  try {
    const parsed = JSON.parse(body) as { error?: unknown; message?: unknown };
    if (typeof parsed.error === "string" && parsed.error.trim()) {
      return parsed.error.trim();
    }

    if (typeof parsed.message === "string" && parsed.message.trim()) {
      return parsed.message.trim();
    }
  } catch {
    return body;
  }

  return body;
}

function shouldFallbackToGenerate(
  status: number,
  errorDetail: string,
): boolean {
  if (status !== 404) {
    return false;
  }

  if (looksLikeMissingModelError(errorDetail)) {
    return false;
  }

  return !errorDetail || /page not found|endpoint|route/i.test(errorDetail);
}

function looksLikeMissingModelError(errorDetail: string): boolean {
  return /model\b.*\bnot found\b/i.test(errorDetail);
}

function formatOllamaError(status: number, errorDetail: string): string {
  if (!errorDetail) {
    return `Ollama 请求失败 (${status})`;
  }

  return `Ollama 请求失败 (${status}): ${errorDetail}`;
}

function normalizeBaseUrl(baseUrl = DEFAULT_BASE_URL): string {
  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}
