import type {
  ConversationSnapshot,
  RendererConversationEvent,
  ConversationUpdate,
} from "../lib/conversation";
import type {
  AutomationRequest,
  AutomationResult,
  GazePoint,
} from "../lib/intent";

declare global {
  interface Window {
    partner?: {
      updateGaze: (point: GazePoint) => Promise<void>;
      requestAutomation: (
        request: AutomationRequest,
      ) => Promise<AutomationResult>;
      getConversationSnapshot: () => Promise<ConversationSnapshot>;
      startConversation: () => Promise<ConversationSnapshot>;
      stopConversation: (reason?: string) => Promise<ConversationSnapshot>;
      submitConversationTurn: (
        text: string,
        imageBase64?: string,
      ) => Promise<ConversationSnapshot>;
      interruptConversation: (reason?: string) => Promise<ConversationSnapshot>;
      confirmConversationAction: () => Promise<AutomationResult>;
      clearConversationConfirmation: () => Promise<ConversationSnapshot>;
      dispatchConversationEvent: (
        event: RendererConversationEvent,
      ) => Promise<ConversationSnapshot>;
      submitPartnerResponse: (
        transcript: string,
        response: string,
        imageBase64?: string,
        screenImageBase64?: string,
      ) => Promise<ConversationSnapshot>;
      captureScreenImage: () => Promise<string | undefined>;
      partnerTtsCompleted: () => Promise<ConversationSnapshot>;
      partnerGetServerPort: () => Promise<number | null>;
      onConversationUpdate: (
        listener: (update: ConversationUpdate) => void,
      ) => () => void;
    };
  }
}

export {};
