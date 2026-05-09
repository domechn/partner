import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export type SplitTextForSpeechOptions = {
  softLimit?: number;
  hardLimit?: number;
};

export type SplitTextForSpeechResult = {
  chunks: string[];
  remainder: string;
};

export type SpeakText = (text: string, signal: AbortSignal) => Promise<void>;

export type LocalTtsPlayerOptions = {
  speakText?: SpeakText;
  onError?: (error: unknown) => void;
};

export type LocalTtsPlayer = {
  enqueue: (text: string) => void;
  stop: (reason?: string) => Promise<void>;
  whenIdle: () => Promise<void>;
  isSpeaking: () => boolean;
};

type TtsLanguage = "zh" | "en" | "unknown";

export const QWEN3_TTS_LIGHTWEIGHT_MODEL = "Qwen/Qwen3-TTS-12Hz-0.6B-Base";

export type HuggingFaceTtsRequest = {
  model: string;
  url: string;
  headers: Record<string, string>;
  body: string;
};

export type BuildHuggingFaceTtsRequestOptions = {
  model?: string;
  endpoint?: string;
  token?: string;
};

export type PlayAudioBuffer = (
  audio: Uint8Array,
  mimeType: string,
  signal: AbortSignal,
) => Promise<void>;

export type HuggingFaceTtsSpeakerOptions = BuildHuggingFaceTtsRequestOptions & {
  fetchImpl?: typeof fetch;
  playAudioBuffer?: PlayAudioBuffer;
  fallbackSpeaker?: SpeakText;
  disableFallback?: boolean;
};

const STRONG_BREAKS = new Set(["。", "！", "？", "!", "?", ";", "；"]);
const SOFT_BREAKS = new Set(["，", ",", "：", ":"]);
export const STREAMING_TTS_SPLIT_OPTIONS = {
  softLimit: 8,
  hardLimit: 9,
} as const satisfies SplitTextForSpeechOptions;
const DEFAULT_VOICE_BY_LANGUAGE: Record<
  Exclude<TtsLanguage, "unknown">,
  string
> = {
  zh: "Tingting",
  en: "Samantha",
};

export function splitTextForSpeech(
  text: string,
  options: SplitTextForSpeechOptions = {},
): SplitTextForSpeechResult {
  const softLimit = options.softLimit ?? 36;
  const hardLimit = options.hardLimit ?? 48;
  const chunks: string[] = [];
  let buffer = "";

  for (const char of text) {
    buffer += char;

    if (STRONG_BREAKS.has(char)) {
      const chunk = buffer.trim();
      if (chunk) {
        chunks.push(chunk);
      }
      buffer = "";
      continue;
    }

    if (buffer.length >= softLimit && SOFT_BREAKS.has(char)) {
      const chunk = buffer.trim();
      if (chunk) {
        chunks.push(chunk);
      }
      buffer = "";
      continue;
    }

    if (buffer.length >= hardLimit) {
      const chunk = buffer.trim();
      if (chunk) {
        chunks.push(chunk);
      }
      buffer = "";
    }
  }

  return {
    chunks,
    remainder: buffer.trim(),
  };
}

export function splitStreamingTextForSpeech(
  text: string,
): SplitTextForSpeechResult {
  return splitTextForSpeech(text, STREAMING_TTS_SPLIT_OPTIONS);
}

export function createLocalTtsPlayer(
  options: LocalTtsPlayerOptions = {},
): LocalTtsPlayer {
  const speakText =
    options.speakText ??
    createHuggingFaceTtsSpeaker({ fallbackSpeaker: createSystemSaySpeaker() });

  let queue: string[] = [];
  let activeController: AbortController | null = null;
  let drainPromise: Promise<void> | null = null;

  const runDrain = (): void => {
    if (drainPromise) {
      return;
    }

    drainPromise = (async () => {
      while (queue.length > 0) {
        const nextText = queue.shift();
        if (!nextText) {
          continue;
        }

        const controller = new AbortController();
        activeController = controller;

        try {
          await speakText(nextText, controller.signal);
        } catch (error) {
          if (!controller.signal.aborted) {
            options.onError?.(error);
          }
        } finally {
          activeController = null;
        }
      }
    })().finally(() => {
      drainPromise = null;
      if (queue.length > 0) {
        runDrain();
      }
    });
  };

  return {
    enqueue(text: string) {
      const normalized = text.trim();
      if (!normalized) {
        return;
      }

      queue.push(normalized);
      runDrain();
    },
    async stop(reason = "manual") {
      queue = [];
      activeController?.abort(reason);
      await (drainPromise ?? Promise.resolve());
    },
    whenIdle() {
      return drainPromise ?? Promise.resolve();
    },
    isSpeaking() {
      return activeController !== null || queue.length > 0;
    },
  };
}

export function buildHuggingFaceTtsRequest(
  text: string,
  options: BuildHuggingFaceTtsRequestOptions = {},
): HuggingFaceTtsRequest {
  const model =
    options.model?.trim() ||
    process.env.PARTNER_QWEN_TTS_MODEL?.trim() ||
    QWEN3_TTS_LIGHTWEIGHT_MODEL;
  const url =
    options.endpoint?.trim() ||
    process.env.PARTNER_QWEN_TTS_ENDPOINT?.trim() ||
    `https://api-inference.huggingface.co/models/${model}`;
  const token =
    options.token?.trim() ||
    process.env.PARTNER_HF_TOKEN?.trim() ||
    process.env.HF_TOKEN?.trim();
  const headers: Record<string, string> = {
    accept: "audio/wav",
    "content-type": "application/json",
  };

  if (token) {
    headers.authorization = `Bearer ${token}`;
  }

  return {
    model,
    url,
    headers,
    body: JSON.stringify({ inputs: text.trim() }),
  };
}

export function createHuggingFaceTtsSpeaker(
  options: HuggingFaceTtsSpeakerOptions = {},
): SpeakText {
  const fetchImpl = options.fetchImpl ?? fetch;
  const playAudioBuffer = options.playAudioBuffer ?? playAudioWithAfplay;
  const fallbackSpeaker = options.fallbackSpeaker;

  return async (text, signal) => {
    const normalized = text.trim();
    if (!normalized) {
      return;
    }

    try {
      const request = buildHuggingFaceTtsRequest(normalized, options);
      const response = await fetchImpl(request.url, {
        method: "POST",
        headers: request.headers,
        body: request.body,
        signal,
      });

      if (!response.ok) {
        throw new Error(
          `Qwen3 TTS request failed (${response.status}): ${await response.text()}`,
        );
      }

      const mimeType = response.headers.get("content-type") ?? "audio/wav";
      if (/json/i.test(mimeType)) {
        throw new Error(
          `Qwen3 TTS returned non-audio response: ${await response.text()}`,
        );
      }

      await playAudioBuffer(
        new Uint8Array(await response.arrayBuffer()),
        mimeType,
        signal,
      );
    } catch (error) {
      if (signal.aborted || options.disableFallback || !fallbackSpeaker) {
        throw error;
      }

      await fallbackSpeaker(normalized, signal);
    }
  };
}

export function buildSystemSayArgs(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const normalized = text.trim();
  const args: string[] = [];
  const explicitVoice = env.PARTNER_TTS_VOICE?.trim();
  const language = detectTtsLanguage(normalized);
  const languageVoice = getLanguageVoice(language, env);
  const voice = explicitVoice || languageVoice;
  const rate = env.PARTNER_TTS_RATE?.trim();

  if (voice) {
    args.push("-v", voice);
  }

  if (rate) {
    args.push("-r", rate);
  }

  args.push(normalized);
  return args;
}

function createSystemSaySpeaker(): SpeakText {
  return (text, signal) => {
    const normalized = text.trim();
    if (!normalized) {
      return Promise.resolve();
    }

    if (process.platform !== "darwin") {
      return Promise.resolve();
    }

    const args = buildSystemSayArgs(normalized);
    return runSay(args, signal).catch((error) => {
      if (signal.aborted || hasExplicitVoiceOverride(process.env)) {
        throw error;
      }

      const fallbackArgs = removeVoiceArgs(args);
      if (fallbackArgs.length === args.length) {
        throw error;
      }

      return runSay(fallbackArgs, signal);
    });
  };
}

async function playAudioWithAfplay(
  audio: Uint8Array,
  mimeType: string,
  signal: AbortSignal,
): Promise<void> {
  if (process.platform !== "darwin" || audio.length === 0) {
    return;
  }

  const filePath = path.join(
    tmpdir(),
    `partner-qwen-tts-${randomUUID()}.${getAudioExtension(mimeType)}`,
  );

  await writeFile(filePath, audio);
  try {
    await runAudioPlayer("afplay", [filePath], signal);
  } finally {
    await rm(filePath, { force: true });
  }
}

function runAudioPlayer(
  command: string,
  args: string[],
  signal: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args);
    let settled = false;

    const finish = (error?: Error): void => {
      if (settled) {
        return;
      }

      settled = true;
      signal.removeEventListener("abort", onAbort);
      if (error) {
        reject(error);
        return;
      }

      resolve();
    };

    const onAbort = (): void => {
      child.kill("SIGTERM");
      finish();
    };

    signal.addEventListener("abort", onAbort, { once: true });
    child.on("error", (error) => finish(error));
    child.on("exit", (code, exitSignal) => {
      if (signal.aborted || exitSignal === "SIGTERM" || code === 0) {
        finish();
        return;
      }

      finish(new Error(`${command} exited with code ${String(code)}`));
    });
  });
}

function getAudioExtension(mimeType: string): string {
  if (/mpeg|mp3/i.test(mimeType)) {
    return "mp3";
  }

  if (/ogg/i.test(mimeType)) {
    return "ogg";
  }

  if (/webm/i.test(mimeType)) {
    return "webm";
  }

  return "wav";
}

function runSay(args: string[], signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn("say", args);
    let settled = false;

    const finish = (error?: Error): void => {
      if (settled) {
        return;
      }

      settled = true;
      signal.removeEventListener("abort", onAbort);
      if (error) {
        reject(error);
        return;
      }

      resolve();
    };

    const onAbort = (): void => {
      child.kill("SIGTERM");
      finish();
    };

    signal.addEventListener("abort", onAbort, { once: true });

    child.on("error", (error) => {
      finish(error);
    });

    child.on("exit", (code, exitSignal) => {
      if (signal.aborted || exitSignal === "SIGTERM") {
        finish();
        return;
      }

      if (code === 0) {
        finish();
        return;
      }

      finish(new Error(`say exited with code ${String(code)}`));
    });
  });
}

function detectTtsLanguage(text: string): TtsLanguage {
  if (/\p{Script=Han}/u.test(text)) {
    return "zh";
  }

  if (/[A-Za-z]/.test(text)) {
    return "en";
  }

  return "unknown";
}

function getLanguageVoice(
  language: TtsLanguage,
  env: NodeJS.ProcessEnv,
): string | undefined {
  switch (language) {
    case "zh":
      return env.PARTNER_TTS_ZH_VOICE?.trim() || DEFAULT_VOICE_BY_LANGUAGE.zh;
    case "en":
      return env.PARTNER_TTS_EN_VOICE?.trim() || DEFAULT_VOICE_BY_LANGUAGE.en;
    default:
      return undefined;
  }
}

function hasExplicitVoiceOverride(env: NodeJS.ProcessEnv): boolean {
  return !!(
    env.PARTNER_TTS_VOICE?.trim() ||
    env.PARTNER_TTS_ZH_VOICE?.trim() ||
    env.PARTNER_TTS_EN_VOICE?.trim()
  );
}

function removeVoiceArgs(args: string[]): string[] {
  const voiceIndex = args.indexOf("-v");
  if (voiceIndex === -1) {
    return args;
  }

  return [...args.slice(0, voiceIndex), ...args.slice(voiceIndex + 2)];
}
