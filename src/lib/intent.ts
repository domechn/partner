export type GazePoint = {
  x: number
  y: number
}

export type AutomationAction =
  | { type: 'click'; point?: GazePoint }
  | { type: 'type'; text: string }
  | { type: 'hotkey'; keys: string[] }
  | { type: 'open'; target: string }
  | { type: 'wait'; ms: number }
  | { type: 'finished'; reason: string }

export type AutomationPlanStep = {
  action: AutomationAction
  description: string
  risk: 'low' | 'high'
}

export type AutomationRequest =
  | { kind: 'click_here'; confirmed?: boolean }
  | { kind: 'switch_tab'; confirmed?: boolean }
  | { kind: 'type_text'; text: string; confirmed?: boolean }
  | { kind: 'open_app'; appName: string; confirmed?: boolean }
  | { kind: 'agent_task'; goal: string; confirmed?: boolean }
  | { kind: 'confirm_pending'; confirmed?: true }

export type AutomationResult = {
  ok: boolean
  message: string
  requiresConfirmation?: boolean
  pendingAction?: AutomationRequest
  plan?: AutomationPlanStep[]
}

export function parseVoiceCommand(raw: string): AutomationRequest | null {
  const text = raw.trim().toLowerCase()

  if (!text) {
    return null
  }

  if (/(确认执行|确定执行|confirm)/.test(text)) {
    return { kind: 'confirm_pending', confirmed: true }
  }

  if (/(点击这里|click here|点这里)/.test(text)) {
    return { kind: 'click_here' }
  }

  if (/(切到这个tab|切换tab|switch tab|next tab)/.test(text)) {
    return { kind: 'switch_tab' }
  }

  const typeMatch = text.match(/(?:输入|type)\s+(.+)/)
  if (typeMatch?.[1]) {
    return { kind: 'type_text', text: typeMatch[1].trim() }
  }

  const openMatch = text.match(/(?:打开|open)\s+(.+)/)
  if (openMatch?.[1]) {
    return { kind: 'open_app', appName: openMatch[1].trim() }
  }

  if (text.length >= 4) {
    return { kind: 'agent_task', goal: raw.trim() }
  }

  return null
}
