// The only bridge between the sandboxed overlay and the main process (window.goat).
// CommonJS because sandboxed preloads can't be ES modules.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('goat', {
  ask: (question, extra) => ipcRenderer.invoke('goat:ask', { ...(extra || {}), question }),
  info: () => ipcRenderer.invoke('goat:info'),
  saveGuide: (guide) => ipcRenderer.invoke('goat:save-guide', guide),
  draftGuide: (text) => ipcRenderer.invoke('goat:draft-guide', text),
  startRecording: () => ipcRenderer.send('goat:start-recording'),
  getTimesheet: (date) => ipcRenderer.invoke('goat:timesheet', date),
  approveTimesheet: (date) => ipcRenderer.invoke('goat:approve-timesheet', date),
  exportTimesheetCsv: (date) => ipcRenderer.invoke('goat:export-csv', date),
  wallet: () => ipcRenderer.invoke('goat:wallet'),
  topup: (myr) => ipcRenderer.invoke('goat:topup', myr),
  upgradePro: () => ipcRenderer.invoke('goat:upgrade'),
  openLink: (url) => ipcRenderer.send('goat:open-link', url),
  transcribe: (audio) => ipcRenderer.invoke('goat:transcribe', audio),
  setClickThrough: (on) => ipcRenderer.send('goat:click-through', Boolean(on)),
  focus: () => ipcRenderer.send('goat:focus'),
  log: (...parts) => ipcRenderer.send('goat:log', parts.map(String).join(' ')),
  onEvent: (callback) => {
    const handler = (_event, message) => callback(message);
    ipcRenderer.on('goat:event', handler);
    return () => ipcRenderer.removeListener('goat:event', handler);
  },
});
