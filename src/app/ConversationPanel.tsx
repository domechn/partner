import { useEffect, useRef, type KeyboardEvent } from "react";

import type { ConversationSnapshot } from "../lib/conversation";
import type { AutomationResult } from "../lib/intent";

export type ConversationPanelProps = {
  calibrated: boolean;
  calibrationStep: number;
  cameraReady: boolean;
  canStreamConversation: boolean;
  clearConversationConfirmation: () => Promise<ConversationSnapshot | null>;
  confirmConversationAction: () => Promise<AutomationResult | null>;
  conversationInput: string;
  conversationSnapshot: ConversationSnapshot;
  isTranscribing: boolean;
  lastAutomationResult: AutomationResult | null;
  setConversationInput: (value: string) => void;
  submitConversationInput: () => Promise<void>;
  transcript: string;
};

function getConversationPhaseLabel(
  phase: ConversationSnapshot["phase"],
): string {
  switch (phase) {
    case "idle":
      return "未开始";
    case "listening":
      return "监听中";
    case "user-speaking":
      return "你在说话";
    case "transcribing":
      return "本地转写中";
    case "thinking":
      return "思考中";
    case "speaking":
      return "助手播报中";
    default:
      return phase;
  }
}

function getTurnStatusLabel(
  status: ConversationSnapshot["turns"][number]["status"],
): string {
  switch (status) {
    case "streaming":
      return "流式输出";
    case "complete":
      return "完成";
    case "interrupted":
      return "已打断";
    default:
      return status;
  }
}

export function ConversationPanel(props: ConversationPanelProps) {
  const {
    calibrated,
    calibrationStep,
    cameraReady,
    canStreamConversation,
    clearConversationConfirmation,
    confirmConversationAction,
    conversationInput,
    conversationSnapshot,
    isTranscribing,
    lastAutomationResult,
    setConversationInput,
    submitConversationInput,
    transcript,
  } = props;

  const conversationPhaseLabel = getConversationPhaseLabel(
    conversationSnapshot.phase,
  );
  const turnsRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const turnsElement = turnsRef.current;
    if (!turnsElement) {
      return;
    }

    turnsElement.scrollTop = turnsElement.scrollHeight;
  }, [conversationSnapshot.phase, conversationSnapshot.turns]);

  const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void submitConversationInput();
    }
  };

  return (
    <article className="panel conversation-panel">
      <div className="conversation-header">
        <h2>实时会话</h2>
        <span
          className={`conversation-phase phase-${conversationSnapshot.phase}`}
        >
          {conversationPhaseLabel}
        </span>
      </div>

      <ul className="stats">
        <li>摄像头：{cameraReady ? "已连接" : "未连接"}</li>
        <li>校准：{calibrated ? "完成" : `进行中 (${calibrationStep}/5)`}</li>
        <li>持续收音：{canStreamConversation ? "可用" : "不可用"}</li>
        <li>转写：{isTranscribing ? "进行中" : "空闲"}</li>
        <li>
          待确认动作：
          {conversationSnapshot.pendingConfirmation ? "有" : "无"}
        </li>
      </ul>

      <p className="transcript-banner">最近识别：{transcript || "（暂无）"}</p>

      <div className="conversation-turns" ref={turnsRef}>
        {conversationSnapshot.turns.length === 0 ? (
          <p className="conversation-empty">当前还没有会话内容。</p>
        ) : (
          conversationSnapshot.turns.map((turn) => (
            <article
              key={turn.id}
              className={`conversation-turn role-${turn.role}`}
            >
              <header>
                <strong>{turn.role === "assistant" ? "助手" : "用户"}</strong>
                <small>{getTurnStatusLabel(turn.status)}</small>
              </header>
              <p>{turn.text || "（流式内容尚未到达）"}</p>
            </article>
          ))
        )}
      </div>

      <div className="composer-row">
        <input
          type="text"
          value={conversationInput}
          onChange={(event) => setConversationInput(event.target.value)}
          onKeyDown={handleInputKeyDown}
          placeholder="输入对话或确认 / 取消"
        />
        <button
          type="button"
          className="button button-primary"
          onClick={() => void submitConversationInput()}
        >
          发送
        </button>
      </div>

      {conversationSnapshot.pendingConfirmation && (
        <div className="confirm-box">
          <strong>待确认会话动作</strong>
          <p>{conversationSnapshot.pendingConfirmation.message}</p>
          <code>
            {JSON.stringify(
              conversationSnapshot.pendingConfirmation.request,
              null,
              2,
            )}
          </code>
          {conversationSnapshot.pendingConfirmation.plan && (
            <ol className="plan-list">
              {conversationSnapshot.pendingConfirmation.plan.map(
                (step, index) => (
                  <li key={`${step.description}-${index}`}>
                    <span>{step.description}</span>
                    <small>{step.risk === "high" ? "需确认" : "低风险"}</small>
                  </li>
                ),
              )}
            </ol>
          )}
          <div className="actions-row">
            <button
              type="button"
              className="button button-primary"
              onClick={() => void confirmConversationAction()}
            >
              确认执行
            </button>
            <button
              type="button"
              className="button button-secondary"
              onClick={() => void clearConversationConfirmation()}
            >
              取消操作
            </button>
          </div>
        </div>
      )}

      {conversationSnapshot.lastInterruptionReason && (
        <p className="transcript-banner">
          最近打断原因：{conversationSnapshot.lastInterruptionReason}
        </p>
      )}

      {conversationSnapshot.lastError && (
        <p className="conversation-error">
          本地会话错误：{conversationSnapshot.lastError}
        </p>
      )}

      {lastAutomationResult && (
        <pre className={`result ${lastAutomationResult.ok ? "ok" : "fail"}`}>
          {JSON.stringify(lastAutomationResult, null, 2)}
        </pre>
      )}
    </article>
  );
}
