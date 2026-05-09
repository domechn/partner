export type VadPhase = "idle" | "speech";

export type VadDecision = "none" | "commit" | "discard";

export type VadConfig = {
  speechThreshold: number;
  speechStartFrames: number;
  speechEndFrames: number;
  minSpeechFrames: number;
};

export type VadState = {
  phase: VadPhase;
  consecutiveSpeechFrames: number;
  consecutiveSilenceFrames: number;
  utteranceFrames: number;
  voicedFrames: number;
  lastDecision: VadDecision;
};

export type VadEvent =
  | { type: "none" }
  | { type: "speech-started" }
  | {
      type: "speech-ended";
      decision: Extract<VadDecision, "commit" | "discard">;
    };

export type VadStep = {
  state: VadState;
  event: VadEvent;
};

export function createVadState(): VadState {
  return {
    phase: "idle",
    consecutiveSpeechFrames: 0,
    consecutiveSilenceFrames: 0,
    utteranceFrames: 0,
    voicedFrames: 0,
    lastDecision: "none",
  };
}

export function getDefaultVadConfig(): VadConfig {
  return {
    speechThreshold: 0.035,
    speechStartFrames: 3,
    speechEndFrames: 16,
    minSpeechFrames: 6,
  };
}

export function consumeVadLevel(
  state: VadState,
  rms: number,
  config: VadConfig = getDefaultVadConfig(),
): VadStep {
  const isVoiced = rms >= config.speechThreshold;

  if (state.phase === "idle") {
    const consecutiveSpeechFrames = isVoiced
      ? state.consecutiveSpeechFrames + 1
      : 0;

    if (consecutiveSpeechFrames < config.speechStartFrames) {
      return {
        state: {
          ...state,
          consecutiveSpeechFrames,
          lastDecision: "none",
        },
        event: { type: "none" },
      };
    }

    return {
      state: {
        phase: "speech",
        consecutiveSpeechFrames,
        consecutiveSilenceFrames: 0,
        utteranceFrames: consecutiveSpeechFrames,
        voicedFrames: consecutiveSpeechFrames,
        lastDecision: "none",
      },
      event: { type: "speech-started" },
    };
  }

  const consecutiveSilenceFrames = isVoiced
    ? 0
    : state.consecutiveSilenceFrames + 1;
  const consecutiveSpeechFrames = isVoiced
    ? state.consecutiveSpeechFrames + 1
    : 0;
  const nextState: VadState = {
    phase: "speech",
    consecutiveSpeechFrames,
    consecutiveSilenceFrames,
    utteranceFrames: state.utteranceFrames + 1,
    voicedFrames: isVoiced ? state.voicedFrames + 1 : state.voicedFrames,
    lastDecision: "none",
  };

  if (consecutiveSilenceFrames < config.speechEndFrames) {
    return {
      state: nextState,
      event: { type: "none" },
    };
  }

  const decision: Extract<VadDecision, "commit" | "discard"> =
    nextState.voicedFrames >= config.minSpeechFrames ? "commit" : "discard";

  return {
    state: {
      ...createVadState(),
      lastDecision: decision,
    },
    event: {
      type: "speech-ended",
      decision,
    },
  };
}
