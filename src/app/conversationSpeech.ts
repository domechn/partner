import type { ConversationSnapshot } from "../lib/conversation.ts";

export type SpeechStartDecision = {
  accepted: boolean;
  shouldInterruptAssistant: boolean;
};

export function getSpeechStartDecision(
  phase: ConversationSnapshot["phase"],
): SpeechStartDecision {
  return {
    accepted: phase === "listening",
    shouldInterruptAssistant: false,
  };
}
