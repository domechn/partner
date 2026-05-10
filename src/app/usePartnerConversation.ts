import { useCallback, useEffect, useRef, useState } from "react";

import {
  createConversationSnapshot,
  type ConversationSnapshot,
  type RendererConversationEvent,
} from "../lib/conversation";
import { parseConversationControl } from "../lib/conversationControl";
import { type AutomationResult, type GazePoint } from "../lib/intent";
import {
  getConversationVadConfig,
  getSpeechStartDecision,
} from "./conversationSpeech.ts";
import type { PartnerVisualContext } from "./usePartnerAI.ts";
import {
  canUseLocalSpeechRecognition,
  getLocalSpeechRecognitionErrorMessage,
} from "../lib/speech";
import {
  startContinuousAudioSession,
  type ContinuousAudioSession,
} from "../lib/voice/continuousAudio";
import { usePartnerAI } from "./usePartnerAI.ts";

export type UsePartnerConversationOptions = {
  captureImage?: () => string | undefined;
  gaze?: GazePoint;
  onStatusChange: (status: string) => void;
};

export type UsePartnerConversationResult = {
  canStreamConversation: boolean;
  clearConversationConfirmation: () => Promise<ConversationSnapshot | null>;
  confirmConversationAction: () => Promise<AutomationResult | null>;
  conversationInput: string;
  conversationSnapshot: ConversationSnapshot;
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
  const { captureImage, gaze, onStatusChange } = options;
  const conversationAudioSessionRef = useRef<ContinuousAudioSession | null>(
    null,
  );
  const conversationPhaseRef = useRef<ConversationSnapshot["phase"]>("idle");
  const conversationUtteranceAcceptedRef = useRef(true);
  const speechStartCameraImageRef = useRef<string | undefined>(undefined);

  const [partnerPort, setPartnerPort] = useState<number | null>(null);
  const partnerAI = usePartnerAI(partnerPort);
  const partnerAIRef = useRef(partnerAI);

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
    partnerAIRef.current = partnerAI;
  }, [partnerAI]);

  useEffect(() => {
    if (!window.partner?.partnerGetServerPort) return;
    window.partner
      .partnerGetServerPort()
      .then((port) => {
        if (port !== null) setPartnerPort(port);
      })
      .catch(() => {
        /* server not available */
      });
  }, []);

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

  const captureVisualContext = useCallback(
    async (
      preferredCameraImageBase64?: string,
    ): Promise<PartnerVisualContext> => {
      const cameraImageBase64 = preferredCameraImageBase64 ?? captureImage?.();
      const screenImageBase64 = await window.partner?.captureScreenImage?.();

      return {
        cameraImageBase64,
        screenImageBase64,
      };
    },
    [captureImage],
  );

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
      const message = error instanceof Error ? error.message : "确认执行失败。";
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

      if (!partnerAI.isConnected) {
        throw new Error(
          "Python Partner 服务尚未连接，请稍等模型加载完成后重试。",
        );
      }

      await dispatchConversationEvent({ type: "user.transcription.started" });
      const visualContext = await captureVisualContext();
      const sent = partnerAI.sendText(text, visualContext, gaze);
      if (!sent) {
        throw new Error("Python Partner 服务暂时不可用，请稍后重试。");
      }

      setLastAutomationResult(null);
      onStatusChange(`已发送给 Python Partner：${text}`);
      return true;
    },
    [
      clearConversationConfirmation,
      confirmConversationAction,
      conversationSnapshot.pendingConfirmation,
      captureVisualContext,
      dispatchConversationEvent,
      gaze,
      onStatusChange,
      partnerAI,
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
              vadConfig: () =>
                getConversationVadConfig(conversationPhaseRef.current),
              onSpeechStart: () => {
                const phase = conversationPhaseRef.current;
                const decision = getSpeechStartDecision(phase);
                conversationUtteranceAcceptedRef.current = decision.accepted;
                speechStartCameraImageRef.current = decision.accepted
                  ? captureImage?.()
                  : undefined;

                if (decision.shouldInterruptAssistant) {
                  const currentPartnerAI = partnerAIRef.current;
                  void (async () => {
                    if (currentPartnerAI.isConnected) {
                      currentPartnerAI.interrupt();
                    }

                    const snapshot =
                      await window.partner?.interruptConversation?.("barge-in");
                    if (snapshot) {
                      setConversationSnapshot(snapshot);
                    }

                    await dispatchConversationEvent({
                      type: "user.speech.started",
                    });
                  })();
                  onStatusChange("听到你说话，已暂停播报并开始收音。");
                  return;
                }

                if (!decision.accepted) {
                  onStatusChange(
                    phase === "speaking"
                      ? "助手正在播报，已忽略可能的扬声器回声。"
                      : "当前上一轮仍在处理中，新的短句会被忽略。",
                  );
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
                  speechStartCameraImageRef.current = undefined;
                  if (!conversationUtteranceAcceptedRef.current) {
                    return;
                  }

                  void dispatchConversationEvent({
                    type: "user.turn.discarded",
                    reason: "检测到过短语音片段，已忽略。",
                  });
                  return;
                }

                // Partner AI mode: send raw audio to Python (no local STT)
                void dispatchConversationEvent({
                  type: "user.transcription.started",
                });

                void (async () => {
                  const currentPartnerAI = partnerAIRef.current;
                  if (currentPartnerAI.isConnected) {
                    const speechStartCameraImageBase64 =
                      speechStartCameraImageRef.current;
                    speechStartCameraImageRef.current = undefined;
                    const visualContext = await captureVisualContext(
                      speechStartCameraImageBase64,
                    );
                    const sent = currentPartnerAI.sendTurn(
                      audioBlob,
                      visualContext,
                      gaze,
                    );
                    if (sent) {
                      onStatusChange(
                        "已发送语音、摄像头和屏幕内容至 Python Partner，等待响应。",
                      );
                      return;
                    }
                  }

                  await dispatchConversationEvent({
                    type: "user.turn.discarded",
                    reason:
                      "Python Partner 服务尚未连接，请稍等模型加载完成后重试。",
                  });
                  onStatusChange(
                    "Python Partner 服务尚未连接，请稍等模型加载完成后重试。",
                  );
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
    captureImage,
    captureVisualContext,
    conversationSnapshot.isActive,
    dispatchConversationEvent,
    gaze,
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
  }, [
    conversationInput,
    conversationSnapshot.isActive,
    handleConversationUtterance,
    onStatusChange,
  ]);

  return {
    canStreamConversation,
    clearConversationConfirmation,
    confirmConversationAction,
    conversationInput,
    conversationSnapshot,
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
