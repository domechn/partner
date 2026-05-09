import { app, BrowserWindow, ipcMain, shell, screen } from "electron";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createConversationManager } from "./conversation/manager.js";
import {
  createLocalTtsPlayer,
  splitTextForSpeech,
} from "./conversation/localTts.js";
import { resolveOllamaAutomationRequest } from "./conversation/automationProposal.js";
import { buildConversationSystemPrompt } from "./conversation/gazeContext.js";
import { streamOllamaChatReply } from "./conversation/ollamaClient.js";
import {
  buildGazeOverlayHtml,
  resolveGazeOverlayPoint,
} from "./gazeOverlay.js";
import type {
  ConversationUpdate,
  RendererConversationEvent,
} from "../src/lib/conversation.js";
import type {
  AutomationAction,
  AutomationPlanStep,
  AutomationRequest,
  AutomationResult,
  GazePoint,
} from "../src/lib/intent.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow: BrowserWindow | null = null;
let gazeOverlayWindow: BrowserWindow | null = null;
let latestGaze: GazePoint = { x: 0.5, y: 0.5 };
let pendingConfirmation: AutomationRequest | null = null;
let ttsRemainder = "";

const conversationConfig = {
  baseUrl: process.env.PARTNER_OLLAMA_BASE_URL || "http://127.0.0.1:11434",
  model: process.env.PARTNER_OLLAMA_MODEL || "qwen2.5:7b",
  allowInstalledModelFallback: !process.env.PARTNER_OLLAMA_MODEL,
  systemPrompt:
    process.env.PARTNER_SYSTEM_PROMPT ||
    [
      "你是 Partner 的本地语音助手。",
      "默认使用简洁中文回答。",
      "当前版本先专注于实时对话；涉及电脑操作时先解释意图，不要假装已经执行。",
      "如果上下文不足，就先追问一个最小澄清问题。",
    ].join(""),
};

const conversationManager = createConversationManager({
  createReplyStream: ({ snapshot }, signal) =>
    streamOllamaChatReply(snapshot, {
      ...conversationConfig,
      systemPrompt: buildConversationSystemPrompt(
        conversationConfig.systemPrompt,
        latestGaze,
      ),
      signal,
      allowLocalReplyFallback: true,
    }),
  createAutomationProposal: async ({ snapshot }) => {
    const request = await resolveOllamaAutomationRequest(snapshot, {
      model: conversationConfig.model,
      baseUrl: conversationConfig.baseUrl,
      gaze: latestGaze,
    });

    return buildConversationConfirmation(request);
  },
});

const ttsPlayer = createLocalTtsPlayer({
  onError: (error) => {
    console.error("Partner local TTS failed:", error);
  },
});

const isDev = !!process.env.VITE_DEV_SERVER_URL;

const riskyActions = new Set<AutomationRequest["kind"]>(["open_app"]);

conversationManager.onUpdate((update) => {
  mainWindow?.webContents.send("conversation:update", update);
  handleConversationTts(update);
});

const verifyPartnerBridge = async (window: BrowserWindow) => {
  const hasPartnerBridge = await window.webContents.executeJavaScript(
    'typeof window.partner === "object" && window.partner !== null',
    true,
  );

  if (!hasPartnerBridge) {
    console.error("Partner preload API is unavailable in renderer.");
  }
};

const createWindow = async () => {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 980,
    minHeight: 700,
    title: "Partner MVP",
    webPreferences: {
      preload: path.join(__dirname, "preload.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
    closeGazeOverlayWindow();
  });

  if (isDev && process.env.VITE_DEV_SERVER_URL) {
    await mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
    await verifyPartnerBridge(mainWindow);
    mainWindow.webContents.openDevTools({ mode: "detach" });
    return;
  }

  const indexPath = path.join(__dirname, "../../dist/index.html");
  if (existsSync(indexPath)) {
    await mainWindow.loadFile(indexPath);
    await verifyPartnerBridge(mainWindow);
  }
};

const createGazeOverlayWindow = async () => {
  if (process.env.PARTNER_GAZE_OVERLAY === "0") {
    return;
  }

  if (gazeOverlayWindow && !gazeOverlayWindow.isDestroyed()) {
    return;
  }

  const bounds = screen.getPrimaryDisplay().bounds;
  gazeOverlayWindow = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    title: "Partner Gaze Overlay",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  gazeOverlayWindow.setIgnoreMouseEvents(true, { forward: true });
  gazeOverlayWindow.setAlwaysOnTop(true, "screen-saver");
  gazeOverlayWindow.on("closed", () => {
    gazeOverlayWindow = null;
  });

  await gazeOverlayWindow.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(buildGazeOverlayHtml())}`,
  );
  updateGazeOverlayWindow(latestGaze);
};

app.whenReady().then(async () => {
  await createWindow();
  await createGazeOverlayWindow();

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
      await createGazeOverlayWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

ipcMain.handle("gaze:update", (_event, point: GazePoint) => {
  latestGaze = normalizeGazePoint(point);
  updateGazeOverlayWindow(latestGaze);
});

ipcMain.handle("conversation:get-snapshot", () => {
  return conversationManager.getSnapshot();
});

ipcMain.handle("conversation:start", () => {
  return conversationManager.startSession();
});

ipcMain.handle("conversation:stop", (_event, reason?: string) => {
  ttsRemainder = "";
  void ttsPlayer.stop(reason);
  return conversationManager.stopSession(reason);
});

ipcMain.handle("conversation:submit-turn", (_event, text: string) => {
  const snapshot = conversationManager.submitUserTurn(text);
  void conversationManager.streamAssistantReply();
  return snapshot;
});

ipcMain.handle("conversation:interrupt", (_event, reason?: string) => {
  ttsRemainder = "";
  void ttsPlayer.stop(reason);
  return conversationManager.interruptConversation(reason);
});

ipcMain.handle(
  "conversation:confirm-action",
  async (): Promise<AutomationResult> => {
    const activeWindow = mainWindow;
    if (!activeWindow) {
      return { ok: false, message: "应用窗口不可用。" };
    }

    const pendingConfirmation =
      conversationManager.getSnapshot().pendingConfirmation;
    if (!pendingConfirmation) {
      return { ok: false, message: "当前没有待确认的会话动作。" };
    }

    conversationManager.clearConfirmation();

    try {
      return await runAutomation(activeWindow, {
        ...pendingConfirmation.request,
        confirmed: true,
      } as AutomationRequest);
    } catch (error) {
      const message = error instanceof Error ? error.message : "执行失败";
      return { ok: false, message };
    }
  },
);

ipcMain.handle("conversation:clear-confirmation", () => {
  return conversationManager.clearConfirmation();
});

ipcMain.handle(
  "conversation:dispatch-event",
  (_event, event: RendererConversationEvent) => {
    if (
      event.type !== "user.speech.started" &&
      event.type !== "user.transcription.started" &&
      event.type !== "user.turn.discarded"
    ) {
      throw new Error("Renderer conversation event is not allowed.");
    }

    return conversationManager.dispatch(event);
  },
);

ipcMain.handle(
  "automation:request",
  async (_event, request: AutomationRequest): Promise<AutomationResult> => {
    const activeWindow = mainWindow;
    if (!activeWindow) {
      return { ok: false, message: "应用窗口不可用。" };
    }

    try {
      if (request.kind === "agent_task") {
        const plan = createAgentPlan(request.goal);
        if (plan.some((step) => step.risk === "high") && !request.confirmed) {
          pendingConfirmation = request;
          return {
            ok: false,
            requiresConfirmation: true,
            message:
              "我已按目标拆解出执行计划，其中包含打开应用或链接等高风险动作，请确认后继续。",
            pendingAction: request,
            plan,
          };
        }
      }

      if (riskyActions.has(request.kind) && !request.confirmed) {
        pendingConfirmation = request;
        return {
          ok: false,
          requiresConfirmation: true,
          message: "该操作风险较高，请说“确认执行”或点击确认。",
          pendingAction: request,
        };
      }

      if (request.kind === "confirm_pending") {
        if (!pendingConfirmation) {
          return { ok: false, message: "当前没有待确认操作。" };
        }
        const toRun = {
          ...pendingConfirmation,
          confirmed: true,
        } as AutomationRequest;
        pendingConfirmation = null;
        return runAutomation(activeWindow, toRun);
      }
      return runAutomation(activeWindow, request);
    } catch (error) {
      const message = error instanceof Error ? error.message : "执行失败";
      return { ok: false, message };
    }
  },
);

async function runAutomation(
  activeWindow: BrowserWindow,
  request: AutomationRequest,
): Promise<AutomationResult> {
  const operator = new LocalComputerOperator(activeWindow, () => latestGaze);

  switch (request.kind) {
    case "click_here": {
      await operator.executeAction({ type: "click" });
      const { x, y } = operator.resolvePoint();
      return { ok: true, message: `已在窗口内注视点附近点击 (${x}, ${y})。` };
    }
    case "type_text": {
      const text = sanitizeTypedText(request.text);
      if (!text.trim()) {
        return { ok: false, message: "没有可输入的文本。" };
      }
      await operator.executeAction({ type: "type", text });
      return { ok: true, message: `已输入: ${text}` };
    }
    case "switch_tab": {
      await operator.executeAction({
        type: "hotkey",
        keys: [platformShortcutKey(), "Tab"],
      });
      return { ok: true, message: "已发送切换 tab 指令（Ctrl+Tab）。" };
    }
    case "open_app": {
      const target = request.appName.trim();
      if (!isSafeOpenTarget(target)) {
        return {
          ok: false,
          message: "应用名称或链接包含不安全字符，已拒绝执行。",
        };
      }
      await operator.executeAction({ type: "open", target });
      return { ok: true, message: `已尝试打开: ${target}` };
    }
    case "agent_task": {
      const plan = createAgentPlan(request.goal);
      if (plan.length === 0) {
        return {
          ok: false,
          message: "我还不能可靠拆解这个目标，请换一种更明确的说法。",
        };
      }

      await operator.executePlan(plan);
      return {
        ok: true,
        message: `已按“${request.goal}”执行 ${plan.length} 个步骤。`,
        plan,
      };
    }
    case "confirm_pending":
      return { ok: false, message: "没有待执行确认动作。" };
    default:
      return { ok: false, message: "未识别动作。" };
  }
}

class LocalComputerOperator {
  constructor(
    private readonly activeWindow: BrowserWindow,
    private readonly getGaze: () => GazePoint,
  ) {}

  resolvePoint(point = this.getGaze()): { x: number; y: number } {
    const [width, height] = this.activeWindow.getContentSize();
    return {
      x: Math.round(Math.min(1, Math.max(0, point.x)) * width),
      y: Math.round(Math.min(1, Math.max(0, point.y)) * height),
    };
  }

  async executePlan(plan: AutomationPlanStep[]): Promise<void> {
    for (const step of plan) {
      await this.executeAction(step.action);
    }
  }

  async executeAction(action: AutomationAction): Promise<void> {
    switch (action.type) {
      case "click": {
        const { x, y } = this.resolvePoint(action.point);
        this.activeWindow.webContents.sendInputEvent({
          type: "mouseDown",
          x,
          y,
          button: "left",
          clickCount: 1,
        });
        this.activeWindow.webContents.sendInputEvent({
          type: "mouseUp",
          x,
          y,
          button: "left",
          clickCount: 1,
        });
        break;
      }
      case "type":
        this.activeWindow.webContents.insertText(
          sanitizeTypedText(action.text),
        );
        break;
      case "hotkey":
        sendHotkey(this.activeWindow, action.keys);
        break;
      case "open":
        await openTarget(action.target);
        break;
      case "wait":
        await sleep(action.ms);
        break;
      case "finished":
        break;
    }
  }
}

function createAgentPlan(goal: string): AutomationPlanStep[] {
  const trimmedGoal = goal.trim();
  const normalized = trimmedGoal.toLowerCase();
  if (!trimmedGoal) {
    return [];
  }

  if (/(切换|下一个|next).*(tab|标签)|switch tab/.test(normalized)) {
    return [
      {
        action: { type: "hotkey", keys: [platformShortcutKey(), "Tab"] },
        description: "根据目标切换到下一个标签页。",
        risk: "low",
      },
      {
        action: { type: "finished", reason: "已完成标签页切换。" },
        description: "结束任务。",
        risk: "low",
      },
    ];
  }

  const typeMatch = trimmedGoal.match(
    /(?:输入|写下|填写|type)\s*[:：]?\s*(.+)/i,
  );
  if (typeMatch?.[1]) {
    return [
      {
        action: { type: "type", text: typeMatch[1].trim() },
        description: "把用户给出的内容输入到当前焦点位置。",
        risk: "low",
      },
      {
        action: { type: "finished", reason: "已完成文本输入。" },
        description: "结束任务。",
        risk: "low",
      },
    ];
  }

  const openTargetMatch = trimmedGoal.match(
    /(?:打开|启动|open|launch)\s+(.+)/i,
  );
  if (openTargetMatch?.[1]) {
    return [
      {
        action: { type: "open", target: openTargetMatch[1].trim() },
        description: "打开用户目标中提到的应用或链接。",
        risk: "high",
      },
      {
        action: { type: "wait", ms: 800 },
        description: "等待应用或链接响应。",
        risk: "low",
      },
      {
        action: { type: "finished", reason: "已尝试打开目标。" },
        description: "结束任务。",
        risk: "low",
      },
    ];
  }

  if (/(查|找|搜|搜索|search|天气|weather|资料|信息)/.test(normalized)) {
    const target = `https://www.google.com/search?q=${encodeURIComponent(trimmedGoal)}`;
    return [
      {
        action: { type: "open", target },
        description: "把模糊查询目标转成浏览器搜索。",
        risk: "high",
      },
      {
        action: { type: "wait", ms: 1000 },
        description: "等待浏览器打开搜索结果。",
        risk: "low",
      },
      {
        action: { type: "finished", reason: "已打开搜索结果。" },
        description: "结束任务。",
        risk: "low",
      },
    ];
  }

  return [
    {
      action: { type: "click" },
      description: "需求不明确时，先按当前注视点执行一次低风险点击。",
      risk: "low",
    },
    {
      action: { type: "finished", reason: "已执行基于注视点的默认动作。" },
      description: "结束任务。",
      risk: "low",
    },
  ];
}

function sendHotkey(activeWindow: BrowserWindow, keys: string[]): void {
  const normalizedKeys = keys.map(normalizeKey).filter((key) => key.length > 0);
  if (normalizedKeys.length === 0) {
    return;
  }

  const modifiers = normalizedKeys.slice(0, -1);
  const finalKey = normalizedKeys[normalizedKeys.length - 1];
  for (const key of modifiers) {
    activeWindow.webContents.sendInputEvent({ type: "keyDown", keyCode: key });
  }
  activeWindow.webContents.sendInputEvent({
    type: "keyDown",
    keyCode: finalKey,
  });
  activeWindow.webContents.sendInputEvent({ type: "keyUp", keyCode: finalKey });
  for (const key of modifiers.reverse()) {
    activeWindow.webContents.sendInputEvent({ type: "keyUp", keyCode: key });
  }
}

function normalizeKey(key: string): string {
  const lower = key.toLowerCase();
  const keyMap: Record<string, string> = {
    command: "Meta",
    cmd: "Meta",
    meta: "Meta",
    control: "Control",
    ctrl: "Control",
    tab: "Tab",
    enter: "Enter",
    return: "Enter",
    shift: "Shift",
    alt: "Alt",
  };
  return keyMap[lower] ?? key;
}

function platformShortcutKey(): string {
  return process.platform === "darwin" ? "Meta" : "Control";
}

async function openTarget(target: string): Promise<void> {
  if (!isSafeOpenTarget(target)) {
    throw new Error("应用名称或链接包含不安全字符，已拒绝执行。");
  }

  if (target.startsWith("http://") || target.startsWith("https://")) {
    await shell.openExternal(target);
    return;
  }

  if (process.platform === "darwin") {
    spawn("open", ["-a", target], { detached: true, stdio: "ignore" }).unref();
  } else if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", target], {
      detached: true,
      stdio: "ignore",
    }).unref();
  } else {
    spawn(target, [], { detached: true, stdio: "ignore" }).unref();
  }
}

function isSafeOpenTarget(target: string): boolean {
  if (target.startsWith("http://") || target.startsWith("https://")) {
    try {
      const parsed = new URL(target);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }
  return /^[\w\s.-]{1,60}$/.test(target);
}

function sanitizeTypedText(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .slice(0, 200);
}

function buildConversationConfirmation(request: AutomationRequest | null) {
  if (!request) {
    return null;
  }

  switch (request.kind) {
    case "click_here":
      return {
        request,
        message: "我理解为要在当前注视点附近点击；确认后才会执行。",
      };
    case "switch_tab":
      return {
        request,
        message: "我理解为要切换到下一个标签页；确认后才会执行。",
      };
    case "type_text":
      return {
        request,
        message: `我理解为要输入文本“${request.text}”；确认后才会执行。`,
      };
    case "open_app":
      return {
        request,
        message: `我理解为要打开“${request.appName}”；确认后才会执行。`,
      };
    case "agent_task":
      return {
        request,
        message: `我理解为要执行“${request.goal}”；确认后才会开始操作。`,
        plan: createAgentPlan(request.goal),
      };
    case "confirm_pending":
      return null;
    default:
      return null;
  }
}

function handleConversationTts(update: ConversationUpdate): void {
  switch (update.event.type) {
    case "assistant.turn.delta": {
      const next = splitTextForSpeech(`${ttsRemainder}${update.event.delta}`);
      ttsRemainder = next.remainder;
      for (const chunk of next.chunks) {
        ttsPlayer.enqueue(chunk);
      }
      break;
    }
    case "assistant.turn.completed": {
      if (ttsRemainder.trim()) {
        ttsPlayer.enqueue(ttsRemainder);
      }
      ttsRemainder = "";
      break;
    }
    case "assistant.turn.failed":
    case "assistant.turn.interrupted":
    case "session.started":
    case "session.stopped":
    case "user.speech.started": {
      ttsRemainder = "";
      void ttsPlayer.stop(update.event.type);
      break;
    }
    default:
      break;
  }
}

function normalizeGazePoint(point: GazePoint): GazePoint {
  return {
    x: Math.min(1, Math.max(0, point.x)),
    y: Math.min(1, Math.max(0, point.y)),
  };
}

function updateGazeOverlayWindow(gaze: GazePoint): void {
  const overlayWindow = gazeOverlayWindow;
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    return;
  }

  const point = resolveGazeOverlayPoint(gaze, overlayWindow.getBounds());
  const script = `window.partnerSetGaze(${JSON.stringify(point)})`;
  void overlayWindow.webContents.executeJavaScript(script, true).catch(() => {
    // The overlay may still be loading or already closing; the next gaze tick will retry.
  });
}

function closeGazeOverlayWindow(): void {
  const overlayWindow = gazeOverlayWindow;
  gazeOverlayWindow = null;

  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.close();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.min(Math.max(ms, 0), 5000));
  });
}
