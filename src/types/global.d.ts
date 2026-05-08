import type { AutomationRequest, AutomationResult, GazePoint } from '../lib/intent'

declare global {
  interface Window {
    partner?: {
      updateGaze: (point: GazePoint) => Promise<void>
      requestAutomation: (request: AutomationRequest) => Promise<AutomationResult>
    }
  }
}

export {}
