import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, screen, shell, Tray } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sampleActiveWindow } from './lib/active-window.js';
import { createApi } from './lib/api.js';
import { getUserId } from './lib/identity.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const isMac = process.platform === 'darwin';
const hotkey = (key) => `${isMac ? 'Ctrl+Option' : 'Ctrl+Alt'}+${key}`;
const accelerator = (key) => `Control+Alt+${key}`;
// 'modal-panel' sits above every app window (fullscreen ones too) but below the menu bar and
// system UI such as the Screenshot tool (layer 24). 'screen-saver' covers everything, but it
// sits on top of the screenshot UI and breaks snipping.
const LEVELS = ['floating', 'torn-off-menu', 'modal-panel', 'main-menu', 'status', 'pop-up-menu', 'screen-saver'];
const windowLevel = LEVELS.includes(process.env.GOAT_WINDOW_LEVEL) ? process.env.GOAT_WINDOW_LEVEL : 'modal-panel';

if (process.env.GOAT_USER_DATA) app.setPath('userData', process.env.GOAT_USER_DATA);

const serverUrl = process.env.GOAT_SERVER_URL || 'http://127.0.0.1:8402';
const userId = getUserId();
const api = createApi({ baseUrl: serverUrl, userId });

let win = null;
let tray = null;
let cursorTimer = null;
let lastCursor = null;
let askContext = {};
let askOpening = false;
let streamPaused = false; // test hooks drive the cursor instead

const log = (...args) => console.log('[goat]', ...args);

function send(message) {
  if (win && !win.isDestroyed()) win.webContents.send('goat:event', message);
}

const fromOverlay = (event) => Boolean(win) && event.sender === win.webContents;

// The overlay covers the primary display; the renderer works in window coordinates.
function fitToPrimary() {
  if (!win) return;
  win.setBounds(screen.getPrimaryDisplay().bounds);
  const b = win.getBounds();
  send({ type: 'origin', x: b.x, y: b.y, width: b.width, height: b.height });
}

function createWindow() {
  const { bounds } = screen.getPrimaryDisplay();
  win = new BrowserWindow({
    ...bounds,
    title: 'GOAT',
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    roundedCorners: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    enableLargerThanScreen: true,
    acceptFirstMouse: true, // bubble buttons work on the first click while another app is active
    show: false,
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  win.setAlwaysOnTop(true, windowLevel);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true, { forward: true });

  win.webContents.on('did-finish-load', () => {
    fitToPrimary();
    lastCursor = null;
    win.showInactive();
    startCursorStream();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.on('closed', () => {
    win = null;
    clearInterval(cursorTimer);
  });
  win.loadFile(path.join(here, 'renderer', 'index.html'));
}

// Stream the system cursor to the renderer (window coordinates) every 33 ms when it moves.
function startCursorStream() {
  clearInterval(cursorTimer);
  cursorTimer = setInterval(() => {
    if (!win || win.isDestroyed() || streamPaused) return;
    const p = screen.getCursorScreenPoint();
    const b = win.getBounds();
    const point = { x: p.x - b.x, y: p.y - b.y };
    if (lastCursor && lastCursor.x === point.x && lastCursor.y === point.y) return;
    lastCursor = point;
    send({ type: 'cursor', ...point });
  }, 33);
}

function focusOverlay() {
  if (!win) return;
  win.setIgnoreMouseEvents(false);
  if (isMac) app.focus({ steal: true });
  win.focus();
}

// Ask hotkey: read the frontmost window first, then take focus and open the ask panel.
async function openAsk(source = 'hotkey') {
  if (!win || askOpening) return;
  askOpening = true;
  try {
    const sample = await sampleActiveWindow({ timeoutMs: 700 });
    const isSelf = sample && (sample.pid === process.pid || /^(GOAT|Electron)$/i.test(sample.app));
    if (sample && !isSelf) askContext = { app: sample.app, title: sample.title, url: sample.url || '' };
    focusOverlay();
    send({ type: 'open-ask', context: askContext, source });
  } finally {
    askOpening = false;
  }
}

function registerIpc() {
  ipcMain.handle('goat:info', () => ({
    serverUrl,
    userId,
    platform: process.platform,
    hotkeys: { ask: hotkey('G') },
  }));
  ipcMain.handle('goat:ask', async (event, payload) => {
    if (!fromOverlay(event)) return { error: 'forbidden', message: 'Unknown sender.' };
    const question = typeof payload?.question === 'string' ? payload.question.slice(0, 1000) : '';
    const reply = await api.assist({ question, context: askContext });
    log(reply.error ? `ask failed: ${reply.error}` : `ask -> ${reply.source}${reply.guide ? ` (${reply.guide.id})` : ''} in ${reply.latencyMs} ms`);
    return reply;
  });
  ipcMain.on('goat:click-through', (event, on) => {
    if (!fromOverlay(event)) return;
    if (on) win.setIgnoreMouseEvents(true, { forward: true });
    else win.setIgnoreMouseEvents(false);
  });
  ipcMain.on('goat:focus', (event) => {
    if (fromOverlay(event)) focusOverlay();
  });
  ipcMain.on('goat:log', (event, line) => {
    if (fromOverlay(event)) console.log('[overlay]', String(line).slice(0, 500));
  });
}

function registerHotkeys() {
  if (!globalShortcut.register(accelerator('G'), () => openAsk('hotkey'))) {
    console.warn(`[goat] ${hotkey('G')} is already taken by another app.`);
  }
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(here, 'assets', 'trayTemplate.png'));
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip('GOAT');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Ask GOAT (${hotkey('G')})`, click: () => openAsk('tray') },
      { type: 'separator' },
      { label: `Server: ${serverUrl}`, enabled: false },
      { label: `User: ${userId}`, enabled: false },
      { type: 'separator' },
      { label: 'Quit GOAT', click: () => app.quit() },
    ]),
  );
}

if (!app.requestSingleInstanceLock()) {
  console.warn('[goat] GOAT is already running.');
  app.quit();
} else {
  app.whenReady().then(() => {
    if (isMac) app.dock?.hide();
    registerIpc();
    createWindow();
    createTray();
    registerHotkeys();
    for (const e of ['display-metrics-changed', 'display-added', 'display-removed']) screen.on(e, fitToPrimary);
    log(`Overlay ready. ${hotkey('G')} to ask. Server ${serverUrl}, user ${userId}.`);

    if (process.env.GOAT_TEST_HOOKS === '1') {
      // Lets the Electron e2e test press "hotkeys" without the keyboard.
      globalThis.__goatTest = {
        openAsk: () => openAsk('test'),
        askContext: () => askContext,
        windowState: () => ({ visible: win.isVisible(), onTop: win.isAlwaysOnTop(), bounds: win.getBounds(), level: windowLevel }),
        // Stop streaming the real mouse and send a fake system cursor position instead.
        sendCursor: (x, y) => {
          streamPaused = true;
          send({ type: 'cursor', x, y });
        },
      };
    }
  });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('window-all-closed', () => app.quit());
}
