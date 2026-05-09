import {
  createConversationSnapshot,
  reduceConversationSnapshot,
  type PendingConversationConfirmation,
  type ConversationEvent,
  type ConversationSnapshot,
  type ConversationTurn,
  type ConversationUpdate,
} from "../../src/lib/conversation.ts";

type ConversationListener = (update: ConversationUpdate) => void;

export type ConversationReplyContext = {
  snapshot: ConversationSnapshot;
  lastUserTurn: ConversationTurn | null;
};

export type CreateReplyStream = (
  context: ConversationReplyContext,
  signal: AbortSignal,
) => AsyncIterable<string> | Promise<AsyncIterable<string>>;

export type CreateAutomationProposal = (
  context: ConversationReplyContext & { assistantText: string },
) =>
  | Promise<PendingConversationConfirmation | null>
  | PendingConversationConfirmation
  | null;

export type ConversationManagerOptions = {
  createReplyStream?: CreateReplyStream;
  createAutomationProposal?: CreateAutomationProposal;
};

export type ConversationManager = {
  getSnapshot: () => ConversationSnapshot;
  onUpdate: (listener: ConversationListener) => () => void;
  dispatch: (event: ConversationEvent) => ConversationSnapshot;
  startSession: () => ConversationSnapshot;
  stopSession: (reason?: string) => ConversationSnapshot;
  submitUserTurn: (
    text: string,
    imageBase64?: string,
    screenImageBase64?: string,
  ) => ConversationSnapshot;
  interruptConversation: (reason?: string) => ConversationSnapshot;
  clearConfirmation: () => ConversationSnapshot;
  streamAssistantReply: () => Promise<ConversationSnapshot>;
};

export function createConversationManager(
  options: ConversationManagerOptions = {},
): ConversationManager {
  let snapshot = createConversationSnapshot();
  const listeners = new Set<ConversationListener>();
  let activeReplyController: AbortController | null = null;

  const notify = (update: ConversationUpdate): void => {
    for (const listener of listeners) {
      listener(update);
    }
  };

  const dispatch = (event: ConversationEvent): ConversationSnapshot => {
    snapshot = reduceConversationSnapshot(snapshot, event);
    notify({ event, snapshot });
    return snapshot;
  };

  return {
    getSnapshot: () => snapshot,
    onUpdate(listener: ConversationListener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispatch,
    startSession() {
      return dispatch({ type: "session.started" });
    },
    stopSession(reason?: string) {
      activeReplyController?.abort(reason);
      activeReplyController = null;
      return dispatch({ type: "session.stopped", reason });
    },
    submitUserTurn(
      text: string,
      imageBase64?: string,
      screenImageBase64?: string,
    ) {
      activeReplyController?.abort("new-user-turn");
      activeReplyController = null;

      const lastTurn = snapshot.turns[snapshot.turns.length - 1];
      if (
        snapshot.phase === "speaking" &&
        lastTurn?.role === "assistant" &&
        lastTurn.status === "streaming" &&
        lastTurn.text.trim()
      ) {
        dispatch({
          type: "assistant.turn.interrupted",
          reason: "new-user-turn",
        });
      }

      return dispatch({
        type: "user.turn.committed",
        text,
        imageBase64,
        screenImageBase64,
      });
    },
    interruptConversation(reason = "manual") {
      activeReplyController?.abort(reason);
      activeReplyController = null;

      if (snapshot.phase !== "speaking") {
        return snapshot;
      }

      return dispatch({ type: "assistant.turn.interrupted", reason });
    },
    clearConfirmation() {
      return dispatch({ type: "confirmation.cleared" });
    },
    async streamAssistantReply() {
      if (!options.createReplyStream) {
        return snapshot;
      }

      const replyController = new AbortController();
      activeReplyController?.abort("replaced");
      activeReplyController = replyController;

      dispatch({ type: "assistant.turn.started" });

      try {
        const stream = await options.createReplyStream(
          {
            snapshot,
            lastUserTurn: findLastUserTurn(snapshot),
          },
          replyController.signal,
        );

        for await (const delta of stream) {
          if (replyController.signal.aborted) {
            return snapshot;
          }

          dispatch({ type: "assistant.turn.delta", delta });
        }

        if (replyController.signal.aborted) {
          return snapshot;
        }

        if (!findLastAssistantTurn(snapshot)?.text.trim()) {
          return dispatch({
            type: "assistant.turn.failed",
            message: "助手没有返回内容，请重试。",
          });
        }

        const completedSnapshot = dispatch({
          type: "assistant.turn.completed",
        });

        if (!options.createAutomationProposal) {
          return completedSnapshot;
        }

        const assistantText =
          findLastAssistantTurn(completedSnapshot)?.text ?? "";
        let proposal: PendingConversationConfirmation | null = null;
        try {
          proposal = await options.createAutomationProposal({
            snapshot: completedSnapshot,
            lastUserTurn: findLastUserTurn(completedSnapshot),
            assistantText,
          });
        } catch {
          return completedSnapshot;
        }

        if (!proposal) {
          return completedSnapshot;
        }

        return dispatch({
          type: "confirmation.requested",
          request: proposal.request,
          message: proposal.message,
          plan: proposal.plan,
        });
      } catch (error) {
        if (replyController.signal.aborted) {
          return snapshot;
        }

        const message = error instanceof Error ? error.message : "助手回复失败";
        return dispatch({ type: "assistant.turn.failed", message });
      } finally {
        if (activeReplyController === replyController) {
          activeReplyController = null;
        }
      }
    },
  };
}

function findLastAssistantTurn(
  snapshot: ConversationSnapshot,
): ConversationTurn | null {
  for (let index = snapshot.turns.length - 1; index >= 0; index -= 1) {
    const turn = snapshot.turns[index];
    if (turn?.role === "assistant") {
      return turn;
    }
  }

  return null;
}

function findLastUserTurn(
  snapshot: ConversationSnapshot,
): ConversationTurn | null {
  for (let index = snapshot.turns.length - 1; index >= 0; index -= 1) {
    const turn = snapshot.turns[index];
    if (turn?.role === "user") {
      return turn;
    }
  }

  return null;
}
