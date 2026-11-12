/** Puente seguro entre el panel (renderer) y el proceso principal. */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('senales', {
  ready: () => ipcRenderer.send('ready'),
  setIgnore: (ignore) => ipcRenderer.send('set-ignore', ignore),
  setRegion: (rect) => ipcRenderer.send('set-region', rect),
  toggleAuto: () => ipcRenderer.send('toggle-auto'),
  setPayout: (value) => ipcRenderer.send('set-payout', value),
  setCycle: (seconds) => ipcRenderer.send('set-cycle', seconds),
  setPause: (seconds) => ipcRenderer.send('set-pause', seconds),
  setAlways: (value) => ipcRenderer.send('set-always', value),
  predict: () => ipcRenderer.send('predict'),
  setManual: (value) => ipcRenderer.send('set-manual', value),
  setInstant: (value) => ipcRenderer.send('set-instant', value),
  setAsset: (value) => ipcRenderer.send('set-asset', value),
  // provider: 'openai' (ChatGPT), 'gemini' o 'claude'
  aiSetKey: (key, provider) => ipcRenderer.send('ai-set-key', key, provider),
  aiClear: (provider) => ipcRenderer.send('ai-clear', provider),
  aiSetModel: (id, provider) => ipcRenderer.send('ai-set-model', id, provider),
  aiOpenKeysPage: (provider) => ipcRenderer.send('ai-open-keys-page', provider),
  reset: () => ipcRenderer.send('reset'),
  saveDebug: () => ipcRenderer.send('save-debug'),
  quit: () => ipcRenderer.send('quit'),
  onState: (callback) => ipcRenderer.on('state', (_event, state) => callback(state)),
});
