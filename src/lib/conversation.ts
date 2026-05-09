import type { AutomationPlanStep, AutomationRequest } from "./intent.ts";

export type ConversationPhase =
  | "idle"
  | "listening"
  | "user-speaking"
  | "transcribing"
  | "thinking"
  | "speaking";

export type ConversationTurnRole = "user" | "assistant";

export type ConversationTurnStatus = "streaming" | "complete" | "interrupted";

export type ConversationTurn = {
  id: string;
  role: ConversationTurnRole;
  text: string;
  status: ConversationTurnStatus;
  imageBase64?: string;
  screenImageBase64?: string;
};

export type PendingConversationConfirmation = {
  request: AutomationRequest;
  message: string;
  plan?: AutomationPlanStep[];
};

export type ConversationUpdate = {
  event: ConversationEvent;
  snapshot: ConversationSnapshot;
};

export type RendererConversationEvent = Extract<
  ConversationEvent,
  | { type: "user.speech.started" }
  | { type: "user.transcription.started" }
  | { type: "user.turn.discarded" }
>;

export type ConversationSnapshot = {
  isActive: boolean;
  phase: ConversationPhase;
  turns: ConversationTurn[];
  pendingConfirmation: PendingConversationConfirmation | null;
  draftAssistantText: string;
  lastError: string | null;
  lastInterruptionReason: string | null;
};

export type ConversationEvent =
  | { type: "session.started" }
  | { type: "session.stopped"; reason?: string }
  | { type: "user.speech.started" }
  | { type: "user.transcription.started" }
  | { type: "user.turn.discarded"; reason?: string }
  | {
      type: "user.turn.committed";
      text: string;
      imageBase64?: string;
      screenImageBase64?: string;
    }
  | { type: "assistant.turn.started" }
  | { type: "assistant.turn.delta"; delta: string }
  | { type: "assistant.turn.completed" }
  | { type: "assistant.turn.interrupted"; reason: string }
  | { type: "assistant.turn.failed"; message: string }
  | {
      type: "confirmation.requested";
      request: AutomationRequest;
      message: string;
      plan?: AutomationPlanStep[];
    }
  | { type: "confirmation.cleared" };

export function createConversationSnapshot(): ConversationSnapshot {
  return {
    isActive: false,
    phase: "idle",
    turns: [],
    pendingConfirmation: null,
    draftAssistantText: "",
    lastError: null,
    lastInterruptionReason: null,
  };
}

export function reduceConversationSnapshot(
  snapshot: ConversationSnapshot,
  event: ConversationEvent,
): ConversationSnapshot {
  switch (event.type) {
    case "session.started":
      return {
        ...snapshot,
        isActive: true,
        phase: "listening",
        pendingConfirmation: null,
        draftAssistantText: "",
        lastError: null,
        lastInterruptionReason: null,
      };
    case "session.stopped":
      return {
        ...snapshot,
        isActive: false,
        phase: "idle",
        pendingConfirmation: null,
        draftAssistantText: "",
        lastError: event.reason ?? null,
      };
    case "user.speech.started":
      return {
        ...snapshot,
        phase: snapshot.isActive ? "user-speaking" : snapshot.phase,
        lastError: null,
      };
    case "user.transcription.started":
      return {
        ...snapshot,
        phase: snapshot.isActive ? "transcribing" : snapshot.phase,
        lastError: null,
      };
    case "user.turn.discarded":
      return {
        ...snapshot,
        phase: snapshot.isActive ? "listening" : snapshot.phase,
        lastError: event.reason ?? null,
      };
    case "user.turn.committed": {
      const text = event.text.trim();
      if (!text) {
        return {
          ...snapshot,
          phase: snapshot.isActive ? "listening" : snapshot.phase,
        };
      }

      return {
        ...snapshot,
        isActive: true,
        phase: "thinking",
        turns: [
          ...removeEmptyStreamingAssistantTurn(snapshot.turns),
          createTurn(
            "user",
            text,
            "complete",
            event.imageBase64,
            event.screenImageBase64,
          ),
        ],
        lastError: null,
      };
    }
    case "assistant.turn.started": {
      return {
        ...snapshot,
        isActive: true,
        phase: "speaking",
        turns: [...snapshot.turns, createTurn("assistant", "", "streaming")],
        draftAssistantText: "",
        lastError: null,
      };
    }
    case "assistant.turn.delta": {
      const delta = event.delta;
      if (!delta) {
        return snapshot;
      }

      const turns = ensureStreamingAssistantTurn(snapshot.turns);
      const lastTurn = turns[turns.length - 1];
      if (!lastTurn || lastTurn.role !== "assistant") {
        return snapshot;
      }

      const updatedTurn: ConversationTurn = {
        ...lastTurn,
        text: lastTurn.text + delta,
        status: "streaming",
      };

      return {
        ...snapshot,
        phase: "speaking",
        turns: [...turns.slice(0, -1), updatedTurn],
        draftAssistantText: updatedTurn.text,
      };
    }
    case "assistant.turn.completed": {
      return finalizeAssistantTurn(snapshot, "complete");
    }
    case "assistant.turn.interrupted": {
      const finalized = finalizeAssistantTurn(snapshot, "interrupted");
      return {
        ...finalized,
        isActive: true,
        phase: "listening",
        lastInterruptionReason: event.reason,
      };
    }
    case "assistant.turn.failed":
      return {
        ...finalizeAssistantTurn(snapshot, "interrupted", event.message),
        isActive: true,
        phase: "listening",
        lastError: event.message,
      };
    case "confirmation.requested":
      return {
        ...snapshot,
        pendingConfirmation: {
          request: event.request,
          message: event.message,
          plan: event.plan,
        },
      };
    case "confirmation.cleared":
      return {
        ...snapshot,
        pendingConfirmation: null,
      };
    default:
      return snapshot;
  }
}

function createTurn(
  role: ConversationTurnRole,
  text: string,
  status: ConversationTurnStatus,
  imageBase64?: string,
  screenImageBase64?: string,
): ConversationTurn {
  const turn: ConversationTurn = {
    id: `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role,
    text,
    status,
  };

  if (imageBase64) {
    turn.imageBase64 = imageBase64;
  }

  if (screenImageBase64) {
    turn.screenImageBase64 = screenImageBase64;
  }

  return turn;
}

function removeEmptyStreamingAssistantTurn(
  turns: ConversationTurn[],
): ConversationTurn[] {
  const lastTurn = turns[turns.length - 1];
  if (
    lastTurn?.role === "assistant" &&
    lastTurn.status === "streaming" &&
    !lastTurn.text.trim()
  ) {
    return turns.slice(0, -1);
  }

  return turns;
}

function ensureStreamingAssistantTurn(
  turns: ConversationTurn[],
): ConversationTurn[] {
  const lastTurn = turns[turns.length - 1];
  if (lastTurn?.role === "assistant" && lastTurn.status === "streaming") {
    return turns;
  }

  return [...turns, createTurn("assistant", "", "streaming")];
}

function finalizeAssistantTurn(
  snapshot: ConversationSnapshot,
  status: Extract<ConversationTurnStatus, "complete" | "interrupted">,
  fallbackText = "",
): ConversationSnapshot {
  const turns = ensureStreamingAssistantTurn(snapshot.turns);
  const lastTurn = turns[turns.length - 1];
  if (!lastTurn || lastTurn.role !== "assistant") {
    return {
      ...snapshot,
      phase: snapshot.isActive ? "listening" : snapshot.phase,
      draftAssistantText: "",
    };
  }

  return {
    ...snapshot,
    phase: snapshot.isActive ? "listening" : snapshot.phase,
    turns: [
      ...turns.slice(0, -1),
      {
        ...lastTurn,
        text: lastTurn.text || fallbackText,
        status,
      },
    ],
    draftAssistantText: "",
  };
}
