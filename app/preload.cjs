// The only bridge between the sandboxed overlay and the main process (window.goat).
// CommonJS because sandboxed preloads can't be ES modules.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('goat', {
  ask: (question, extra) => ipcRenderer.invoke('goat:ask', { ...(extra || {}), question }),
  info: () => ipcRenderer.invoke('goat:info'),
  setClickThrough: (on) => ipcRenderer.send('goat:click-through', Boolean(on)),
  focus: () => ipcRenderer.send('goat:focus'),
  log: (...parts) => ipcRenderer.send('goat:log', parts.map(String).join(' ')),
  onEvent: (callback) => {
    const handler = (_event, message) => callback(message);
    ipcRenderer.on('goat:event', handler);
    return () => ipcRenderer.removeListener('goat:event', handler);
  },
});
