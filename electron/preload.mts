import { contextBridge, ipcRenderer } from 'electron'
import type { AutomationRequest, AutomationResult, GazePoint } from '../src/lib/intent.js'

const api = {
  updateGaze(point: GazePoint) {
    return ipcRenderer.invoke('gaze:update', point)
  },
  requestAutomation(request: AutomationRequest): Promise<AutomationResult> {
    return ipcRenderer.invoke('automation:request', request)
  },
}

contextBridge.exposeInMainWorld('partner', api)
