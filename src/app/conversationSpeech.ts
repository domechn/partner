import type { ConversationSnapshot } from "../lib/conversation.ts";
import { getDefaultVadConfig, type VadConfig } from "../lib/voice/vad.ts";

export type SpeechStartDecision = {
  accepted: boolean;
  shouldInterruptAssistant: boolean;
};

export function getSpeechStartDecision(
  phase: ConversationSnapshot["phase"],
): SpeechStartDecision {
  if (phase === "listening") {
    return {
      accepted: true,
      shouldInterruptAssistant: false,
    };
  }

  if (phase === "speaking") {
    return {
      accepted: true,
      shouldInterruptAssistant: true,
    };
  }

  return {
    accepted: false,
    shouldInterruptAssistant: false,
  };
}

export function getConversationVadConfig(
  phase: ConversationSnapshot["phase"],
): VadConfig {
  const base = getDefaultVadConfig();

  if (phase !== "speaking") {
    return base;
  }

  return {
    ...base,
    speechThreshold: 0.075,
    speechStartFrames: 8,
    minSpeechFrames: 14,
  };
}
