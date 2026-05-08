import { contextBridge, ipcRenderer } from 'electron';
const api = {
    updateGaze(point) {
        return ipcRenderer.invoke('gaze:update', point);
    },
    requestAutomation(request) {
        return ipcRenderer.invoke('automation:request', request);
    },
};
contextBridge.exposeInMainWorld('partner', api);
//# sourceMappingURL=preload.mjs.map