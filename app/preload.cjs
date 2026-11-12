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
  speak: (text) => ipcRenderer.invoke('goat:speak', text),
  clipFor: (question) => ipcRenderer.invoke('goat:clip-for', question),
  clipEnded: (how) => ipcRenderer.send('goat:clip-ended', String(how)),
  talking: (on) => ipcRenderer.send('goat:talking', on === true),
  account: () => ipcRenderer.invoke('goat:account'),
  signIn: (mode) => ipcRenderer.invoke('goat:sign-in', mode),
  signInOffline: () => ipcRenderer.invoke('goat:sign-in-offline'),
  signOut: () => ipcRenderer.invoke('goat:sign-out'),
  chats: () => ipcRenderer.invoke('goat:chats'),
  chat: (id) => ipcRenderer.invoke('goat:chat', id),
  deleteChat: (id) => ipcRenderer.invoke('goat:delete-chat', id),
  clearChats: () => ipcRenderer.invoke('goat:clear-chats'),
  permissions: () => ipcRenderer.invoke('goat:permissions'),
  allowPermissions: (id) => ipcRenderer.invoke('goat:allow-permissions', typeof id === 'string' ? id : null),
  permissionSettings: (id) => ipcRenderer.invoke('goat:permission-settings', String(id)),
  locate: (target) => ipcRenderer.invoke('goat:locate', target),
  watchClicks: (on) => ipcRenderer.invoke('goat:watch-clicks', on === true),
  setClickThrough: (on) => ipcRenderer.send('goat:click-through', Boolean(on)),
  focus: () => ipcRenderer.send('goat:focus'),
  log: (...parts) => ipcRenderer.send('goat:log', parts.map(String).join(' ')),
  onEvent: (callback) => {
    const handler = (_event, message) => callback(message);
    ipcRenderer.on('goat:event', handler);
    return () => ipcRenderer.removeListener('goat:event', handler);
  },
});
