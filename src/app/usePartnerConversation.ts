import { useCallback, useEffect, useRef, useState } from "react";

import {
  createConversationSnapshot,
  type ConversationSnapshot,
  type RendererConversationEvent,
} from "../lib/conversation";
import { parseConversationControl } from "../lib/conversationControl";
import { type AutomationResult } from "../lib/intent";
import { transcribeAudioBlob } from "../lib/localSpeech";
import {
  canUseLocalSpeechRecognition,
  getLocalSpeechRecognitionErrorMessage,
} from "../lib/speech";
import {
  startContinuousAudioSession,
  type ContinuousAudioSession,
} from "../lib/voice/continuousAudio";
import { getDefaultVadConfig } from "../lib/voice/vad";

export type UsePartnerConversationOptions = {
  onStatusChange: (status: string) => void;
};

export type UsePartnerConversationResult = {
  canStreamConversation: boolean;
  clearConversationConfirmation: () => Promise<ConversationSnapshot | null>;
  confirmConversationAction: () => Promise<AutomationResult | null>;
  conversationInput: string;
  conversationSnapshot: ConversationSnapshot;
  interruptConversation: () => Promise<void>;
  isStartingConversation: boolean;
  isTranscribing: boolean;
  lastAutomationResult: AutomationResult | null;
  setConversationInput: (value: string) => void;
  startConversation: () => Promise<void>;
  stopConversation: () => Promise<void>;
  submitConversationInput: () => Promise<void>;
  transcript: string;
};

export function usePartnerConversation(
  options: UsePartnerConversationOptions,
): UsePartnerConversationResult {
  const { onStatusChange } = options;
  const conversationAudioSessionRef = useRef<ContinuousAudioSession | null>(
    null,
  );
  const conversationPhaseRef = useRef<ConversationSnapshot["phase"]>("idle");
  const conversationUtteranceAcceptedRef = useRef(true);

  const [isStartingConversation, setIsStartingConversation] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [conversationInput, setConversationInput] = useState("");
  const [conversationSnapshot, setConversationSnapshot] =
    useState<ConversationSnapshot>(createConversationSnapshot);
  const [lastAutomationResult, setLastAutomationResult] =
    useState<AutomationResult | null>(null);

  const hasMediaRecorderApi = typeof MediaRecorder !== "undefined";
  const hasUserMediaApi = !!navigator.mediaDevices?.getUserMedia;
  const isDesktopShell = !!window.partner;
  const canStreamConversation = canUseLocalSpeechRecognition({
    hasMediaRecorderApi,
    hasUserMediaApi,
    isDesktopShell,
  });

  useEffect(() => {
    conversationPhaseRef.current = conversationSnapshot.phase;
  }, [conversationSnapshot.phase]);

  useEffect(() => {
    if (!window.partner?.getConversationSnapshot) {
      return;
    }

    let disposed = false;

    void window.partner.getConversationSnapshot().then((snapshot) => {
      if (!disposed) {
        setConversationSnapshot(snapshot);
      }
    });

    const unsubscribe = window.partner.onConversationUpdate((update) => {
      if (!disposed) {
        setConversationSnapshot(update.snapshot);
      }
    });

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    return () => {
      const session = conversationAudioSessionRef.current;
      conversationAudioSessionRef.current = null;
      if (session) {
        void session.stop();
      }
    };
  }, []);

  const dispatchConversationEvent = useCallback(
    async (event: RendererConversationEvent) => {
      if (!window.partner?.dispatchConversationEvent) {
        return null;
      }

      const snapshot = await window.partner.dispatchConversationEvent(event);
      setConversationSnapshot(snapshot);
      return snapshot;
    },
    [],
  );

  const stopConversationAudioSession = useCallback(async () => {
    const session = conversationAudioSessionRef.current;
    conversationAudioSessionRef.current = null;

    if (session) {
      await session.stop();
    }
  }, []);

  const confirmConversationAction = useCallback(async () => {
    if (!window.partner?.confirmConversationAction) {
      onStatusChange("当前环境不支持会话确认执行，请使用桌面端。");
      return null;
    }

    try {
      const result = await window.partner.confirmConversationAction();
      setLastAutomationResult(result);
      onStatusChange(result.message);

      if (window.partner.getConversationSnapshot) {
        const snapshot = await window.partner.getConversationSnapshot();
        setConversationSnapshot(snapshot);
      }

      return result;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "确认执行失败。";
      onStatusChange(message);
      return null;
    }
  }, [onStatusChange]);

  const clearConversationConfirmation = useCallback(async () => {
    if (!window.partner?.clearConversationConfirmation) {
      onStatusChange("当前环境不支持会话确认清除，请使用桌面端。");
      return null;
    }

    try {
      const snapshot = await window.partner.clearConversationConfirmation();
      setConversationSnapshot(snapshot);
      setLastAutomationResult(null);
      onStatusChange("已取消本轮会话中的电脑操作提议。");
      return snapshot;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "取消待确认操作失败。";
      onStatusChange(message);
      return null;
    }
  }, [onStatusChange]);

  const handleConversationUtterance = useCallback(
    async (rawText: string) => {
      const text = rawText.trim();
      if (!text) {
        return false;
      }

      setTranscript(text);

      if (conversationSnapshot.pendingConfirmation) {
        const control = parseConversationControl(text);
        if (control?.kind === "confirm") {
          await confirmConversationAction();
          return true;
        }

        if (control?.kind === "cancel") {
          await clearConversationConfirmation();
          return true;
        }
      }

      if (!window.partner?.submitConversationTurn) {
        throw new Error("当前环境不支持会话桥接，请使用桌面端。");
      }

      const snapshot = await window.partner.submitConversationTurn(text);
      setConversationSnapshot(snapshot);
      setLastAutomationResult(null);
      onStatusChange(`已提交当前语音：${text}`);
      return true;
    },
    [
      clearConversationConfirmation,
      confirmConversationAction,
      conversationSnapshot.pendingConfirmation,
      onStatusChange,
    ],
  );

  const startConversation = useCallback(async () => {
    if (isStartingConversation) {
      return;
    }

    if (conversationSnapshot.isActive) {
      onStatusChange("对话已经在进行中。");
      return;
    }

    if (!window.partner?.startConversation) {
      onStatusChange("当前环境不支持会话桥接，请使用桌面端。");
      return;
    }

    setIsStartingConversation(true);
    setLastAutomationResult(null);

    try {
      const snapshot = await window.partner.startConversation();
      setConversationSnapshot(snapshot);

      if (canStreamConversation) {
        await stopConversationAudioSession();

        try {
          conversationAudioSessionRef.current =
            await startContinuousAudioSession({
              vadConfig: getDefaultVadConfig(),
              onSpeechStart: () => {
                const phase = conversationPhaseRef.current;
                const accepted = phase === "listening" || phase === "speaking";
                conversationUtteranceAcceptedRef.current = accepted;

                if (phase === "speaking") {
                  void window.partner?.interruptConversation("barge-in");
                }

                if (!accepted) {
                  onStatusChange("当前上一轮仍在处理中，新的短句会被忽略。");
                  return;
                }

                void dispatchConversationEvent({ type: "user.speech.started" });
                onStatusChange("检测到语音，正在持续收音。");
              },
              onSpeechEnd: ({ audioBlob, decision }) => {
                if (
                  !conversationUtteranceAcceptedRef.current ||
                  decision === "discard"
                ) {
                  void dispatchConversationEvent({
                    type: "user.turn.discarded",
                    reason:
                      decision === "discard"
                        ? "检测到过短语音片段，已忽略。"
                        : "当前上一轮仍在处理中，已忽略本次语音。",
                  });
                  return;
                }

                void (async () => {
                  await dispatchConversationEvent({
                    type: "user.transcription.started",
                  });
                  setIsTranscribing(true);
                  onStatusChange("正在本地转写当前一句语音。");

                  try {
                    const text = await transcribeAudioBlob(audioBlob);
                    setIsTranscribing(false);

                    if (!text) {
                      await dispatchConversationEvent({
                        type: "user.turn.discarded",
                        reason: "没有识别到清晰语音，继续监听。",
                      });
                      onStatusChange("没有识别到清晰语音，继续监听。");
                      return;
                    }

                    await handleConversationUtterance(text);
                  } catch (error) {
                    setIsTranscribing(false);
                    const message = getLocalSpeechRecognitionErrorMessage(error);
                    await dispatchConversationEvent({
                      type: "user.turn.discarded",
                      reason: message,
                    });
                    onStatusChange(message);
                  }
                })();
              },
              onError: (error) => {
                onStatusChange(getLocalSpeechRecognitionErrorMessage(error));
              },
            });

          onStatusChange("会话已启动，持续监听中。说一句停一下即可自动分句。");
          return;
        } catch (error) {
          await window.partner.stopConversation?.("audio-init-failed");
          onStatusChange(getLocalSpeechRecognitionErrorMessage(error));
          return;
        }
      }

      onStatusChange(
        snapshot.isActive
          ? "会话已启动，但当前环境没有持续收音能力，可先用文本输入。"
          : "会话未启动。",
      );
    } catch (error) {
      onStatusChange(error instanceof Error ? error.message : "开启对话失败。");
    } finally {
      setIsStartingConversation(false);
    }
  }, [
    canStreamConversation,
    conversationSnapshot.isActive,
    dispatchConversationEvent,
    handleConversationUtterance,
    isStartingConversation,
    onStatusChange,
    stopConversationAudioSession,
  ]);

  const stopConversation = useCallback(async () => {
    if (!window.partner?.stopConversation) {
      onStatusChange("当前环境不支持会话桥接，请使用桌面端。");
      return;
    }

    try {
      await stopConversationAudioSession();
      const snapshot = await window.partner.stopConversation("manual-stop");
      setConversationSnapshot(snapshot);
      setIsTranscribing(false);
      setTranscript("");
      setLastAutomationResult(null);
      onStatusChange("会话已停止。");
    } catch (error) {
      onStatusChange(error instanceof Error ? error.message : "停止会话失败。");
    }
  }, [onStatusChange, stopConversationAudioSession]);

  const interruptConversation = useCallback(async () => {
    if (!window.partner?.interruptConversation) {
      onStatusChange("当前环境不支持会话桥接，请使用桌面端。");
      return;
    }

    try {
      const snapshot = await window.partner.interruptConversation("manual");
      setConversationSnapshot(snapshot);
      onStatusChange("已发送打断指令。");
    } catch (error) {
      onStatusChange(error instanceof Error ? error.message : "打断失败。");
    }
  }, [onStatusChange]);

  const submitConversationInput = useCallback(async () => {
    const text = conversationInput.trim();
    if (!text) {
      onStatusChange("请先输入一段对话文本。");
      return;
    }

    if (!conversationSnapshot.isActive) {
      onStatusChange("请先开启对话，再提交文本内容。");
      return;
    }

    try {
      await handleConversationUtterance(text);
      setConversationInput("");
    } catch (error) {
      onStatusChange(error instanceof Error ? error.message : "提交对话失败。");
    }
  }, [conversationInput, conversationSnapshot.isActive, handleConversationUtterance, onStatusChange]);

  return {
    canStreamConversation,
    clearConversationConfirmation,
    confirmConversationAction,
    conversationInput,
    conversationSnapshot,
    interruptConversation,
    isStartingConversation,
    isTranscribing,
    lastAutomationResult,
    setConversationInput,
    startConversation,
    stopConversation,
    submitConversationInput,
    transcript,
  };
}