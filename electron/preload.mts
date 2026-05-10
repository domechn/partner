import { contextBridge, ipcRenderer } from "electron";
import type {
  ConversationSnapshot,
  RendererConversationEvent,
  ConversationUpdate,
} from "../src/lib/conversation.js";
import type {
  AutomationRequest,
  AutomationResult,
  GazePoint,
} from "../src/lib/intent.js";

const api = {
  updateGaze(point: GazePoint) {
    return ipcRenderer.invoke("gaze:update", point);
  },
  requestAutomation(request: AutomationRequest): Promise<AutomationResult> {
    return ipcRenderer.invoke("automation:request", request);
  },
  getConversationSnapshot(): Promise<ConversationSnapshot> {
    return ipcRenderer.invoke("conversation:get-snapshot");
  },
  startConversation(): Promise<ConversationSnapshot> {
    return ipcRenderer.invoke("conversation:start");
  },
  stopConversation(reason?: string): Promise<ConversationSnapshot> {
    return ipcRenderer.invoke("conversation:stop", reason);
  },
  submitConversationTurn(
    text: string,
    imageBase64?: string,
  ): Promise<ConversationSnapshot> {
    return ipcRenderer.invoke("conversation:submit-turn", text, imageBase64);
  },
  interruptConversation(reason?: string): Promise<ConversationSnapshot> {
    return ipcRenderer.invoke("conversation:interrupt", reason);
  },
  confirmConversationAction(): Promise<AutomationResult> {
    return ipcRenderer.invoke("conversation:confirm-action");
  },
  clearConversationConfirmation(): Promise<ConversationSnapshot> {
    return ipcRenderer.invoke("conversation:clear-confirmation");
  },
  dispatchConversationEvent(
    event: RendererConversationEvent,
  ): Promise<ConversationSnapshot> {
    return ipcRenderer.invoke("conversation:dispatch-event", event);
  },
  submitPartnerResponse(
    transcript: string,
    response: string,
    imageBase64?: string,
    screenImageBase64?: string,
  ): Promise<ConversationSnapshot> {
    return ipcRenderer.invoke(
      "conversation:partner-response",
      transcript,
      response,
      imageBase64,
      screenImageBase64,
    );
  },
  captureScreenImage(): Promise<string | undefined> {
    return ipcRenderer.invoke("partner:capture-screen-image");
  },
  partnerTtsCompleted(): Promise<ConversationSnapshot> {
    return ipcRenderer.invoke("partner:tts-completed");
  },
  partnerGetServerPort(): Promise<number | null> {
    return ipcRenderer.invoke("partner:get-server-port");
  },
  onConversationUpdate(listener: (update: ConversationUpdate) => void) {
    const wrapped = (
      _event: Electron.IpcRendererEvent,
      update: ConversationUpdate,
    ) => {
      listener(update);
    };

    ipcRenderer.on("conversation:update", wrapped);

    return () => {
      ipcRenderer.removeListener("conversation:update", wrapped);
    };
  },
};

contextBridge.exposeInMainWorld("partner", api);
