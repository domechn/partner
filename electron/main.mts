import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AutomationRequest, AutomationResult, GazePoint } from '../src/lib/intent.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

let mainWindow: BrowserWindow | null = null
let latestGaze: GazePoint = { x: 0.5, y: 0.5 }
let pendingConfirmation: AutomationRequest | null = null

const isDev = !!process.env.VITE_DEV_SERVER_URL

const riskyActions = new Set<AutomationRequest['kind']>(['open_app'])

const createWindow = async () => {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 980,
    minHeight: 700,
    title: 'Partner MVP',
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  if (isDev && process.env.VITE_DEV_SERVER_URL) {
    await mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
    mainWindow.webContents.openDevTools({ mode: 'detach' })
    return
  }

  const indexPath = path.join(__dirname, '../dist/index.html')
  if (existsSync(indexPath)) {
    await mainWindow.loadFile(indexPath)
  }
}

app.whenReady().then(async () => {
  await createWindow()

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

ipcMain.handle('gaze:update', (_event, point: GazePoint) => {
  latestGaze = {
    x: Math.min(1, Math.max(0, point.x)),
    y: Math.min(1, Math.max(0, point.y)),
  }
})

ipcMain.handle('automation:request', async (_event, request: AutomationRequest): Promise<AutomationResult> => {
  if (riskyActions.has(request.kind) && !request.confirmed) {
    pendingConfirmation = request
    return {
      ok: false,
      requiresConfirmation: true,
      message: '该操作风险较高，请说“确认执行”或点击确认。',
      pendingAction: request,
    }
  }

  const activeWindow = mainWindow
  if (!activeWindow) {
    return { ok: false, message: '应用窗口不可用。' }
  }

  try {
    if (request.kind === 'confirm_pending') {
      if (!pendingConfirmation) {
        return { ok: false, message: '当前没有待确认操作。' }
      }
      const toRun = { ...pendingConfirmation, confirmed: true } as AutomationRequest
      pendingConfirmation = null
      return runAutomation(activeWindow, toRun)
    }
    return runAutomation(activeWindow, request)
  } catch (error) {
    const message = error instanceof Error ? error.message : '执行失败'
    return { ok: false, message }
  }
})

async function runAutomation(activeWindow: BrowserWindow, request: AutomationRequest): Promise<AutomationResult> {
  switch (request.kind) {
    case 'click_here': {
      const [width, height] = activeWindow.getContentSize()
      const x = Math.round(latestGaze.x * width)
      const y = Math.round(latestGaze.y * height)

      activeWindow.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
      activeWindow.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })

      return { ok: true, message: `已在窗口内注视点附近点击 (${x}, ${y})。` }
    }
    case 'type_text': {
      const text = request.text.slice(0, 200)
      if (!text.trim()) {
        return { ok: false, message: '没有可输入的文本。' }
      }
      activeWindow.webContents.insertText(text)
      return { ok: true, message: `已输入: ${text}` }
    }
    case 'switch_tab': {
      activeWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Control' })
      activeWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' })
      activeWindow.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' })
      activeWindow.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Control' })
      return { ok: true, message: '已发送切换 tab 指令（Ctrl+Tab）。' }
    }
    case 'open_app': {
      const appName = request.appName.trim()
      if (appName.startsWith('http://') || appName.startsWith('https://')) {
        await shell.openExternal(appName)
        return { ok: true, message: `已打开链接: ${appName}` }
      }

      if (!/^[\w\s.-]{1,60}$/.test(appName)) {
        return { ok: false, message: '应用名称包含不安全字符，已拒绝执行。' }
      }

      if (process.platform === 'darwin') {
        spawn('open', ['-a', appName], { detached: true, stdio: 'ignore' }).unref()
      } else if (process.platform === 'win32') {
        spawn('cmd', ['/c', 'start', '', appName], { detached: true, stdio: 'ignore' }).unref()
      } else {
        spawn(appName, [], { detached: true, stdio: 'ignore', shell: true }).unref()
      }

      return { ok: true, message: `已尝试打开: ${appName}` }
    }
    case 'confirm_pending':
      return { ok: false, message: '没有待执行确认动作。' }
    default:
      return { ok: false, message: '未识别动作。' }
  }
}
