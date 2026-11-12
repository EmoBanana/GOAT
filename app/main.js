import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, powerMonitor, screen, shell, Tray } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sampleActiveWindow } from './lib/active-window.js';
import { captureRegion } from './lib/capture.js';
import { validRegion } from './lib/region.js';
import { createApi } from './lib/api.js';
import { getUserId } from './lib/identity.js';
import { buildGuide, createRecorder } from './lib/recorder.js';
import { createPayer } from './lib/wallet.js';
import { createTracker } from './lib/tracker.js';

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
// Replaced by a paying client once the wallet is ready (see setUpWallet).
let api = createApi({ baseUrl: serverUrl, userId });
let payer = { kind: 'none', address: null };
const recorder = createRecorder();
let lastRecording = null;
// Timesheet tracking: off until Ctrl+Option+T, after every launch.
const tracker = createTracker({
  sample: (allow) => sampleActiveWindow({ timeoutMs: 2500, allow }),
  send: (samples) => api.postActivity(samples),
  getConfig: () => api.timesheetConfig(),
  intervalMs: Math.max(0.1, Number(process.env.GOAT_TRACK_INTERVAL_SEC) || 10) * 1000,
  idleSec: Number(process.env.GOAT_IDLE_SEC) || 300,
  idleSeconds: () => powerMonitor.getSystemIdleTime(),
});
const DATE = /^\d{4}-\d{2}-\d{2}$/;
function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
const dateOrToday = (d) => (typeof d === 'string' && DATE.test(d) ? d : localDate());

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

const isSelf = (sample) => Boolean(sample) && (sample.pid === process.pid || /^(GOAT|Electron)$/i.test(sample.app));

// Ask hotkey: read the frontmost window first, then take focus and open the ask panel.
async function openAsk(source = 'hotkey') {
  if (!win || askOpening) return;
  askOpening = true;
  try {
    const sample = await sampleActiveWindow({ timeoutMs: 700 });
    if (sample && !isSelf(sample)) askContext = { app: sample.app, title: sample.title, url: sample.url || '' };
    focusOverlay();
    send({ type: 'open-ask', context: askContext, source });
  } finally {
    askOpening = false;
  }
}

// Ctrl+Option+R: start recording (Ctrl+Option+C captures while it runs), press again to stop
// and open the save form. The overlay stays click-through while recording.
async function toggleRecording() {
  if (!win) return;
  if (!recorder.recording) {
    const sample = await sampleActiveWindow({ timeoutMs: 700 });
    recorder.start({ app: sample && !isSelf(sample) ? sample.app : '' });
    if (!globalShortcut.register(accelerator('C'), () => captureStep())) {
      console.warn(`[goat] ${hotkey('C')} is taken by another app; capture from the tray menu instead.`);
    }
    send({ type: 'record:start', app: recorder.app });
    log(`Recording a guide${recorder.app ? ` in ${recorder.app}` : ''}`);
  } else {
    globalShortcut.unregister(accelerator('C'));
    lastRecording = recorder.stop();
    if (lastRecording.steps.length) focusOverlay(); // the save form needs the keyboard
    send({ type: 'record:stop', app: lastRecording.app, steps: lastRecording.steps });
    log(`Recording stopped with ${lastRecording.steps.length} steps`);
  }
  refreshTray();
}

// Ctrl+Option+T: start tracking; press again to stop and see today's timesheet.
async function toggleTracking() {
  if (!tracker.tracking) {
    send({ type: 'tracking', on: true }); // the red dot shows at once
    await tracker.start();
    log('Tracking on');
  } else {
    await tracker.stop();
    send({ type: 'tracking', on: false });
    log('Tracking off');
    await openTimesheet();
  }
  refreshTray();
}

function openWallet() {
  focusOverlay();
  send({ type: 'open-wallet' });
}

async function openTimesheet() {
  const timesheet = await api.timesheet(localDate());
  focusOverlay();
  send({ type: 'open-timesheet', timesheet });
}

function captureStep(point) {
  if (!recorder.recording) return;
  const step = recorder.capture(point || screen.getCursorScreenPoint());
  if (step) send({ type: 'record:step', step, count: recorder.steps.length });
}

// The wallet abstraction: only main holds the key; the server only sees the address.
async function setUpWallet() {
  try {
    payer = await createPayer({
      mode: process.env.GOAT_WALLET || 'auto',
      dir: app.getPath('userData'),
      env: process.env,
      network: process.env.X402_NETWORK || 'eip155:84532',
    });
  } catch (err) {
    console.warn(`[goat] No wallet: ${err.message}`);
    payer = { kind: 'none', address: null, fetch: globalThis.fetch };
  }
  api = createApi({ baseUrl: serverUrl, userId, walletAddress: payer.address, fetchImpl: payer.fetch });
  const wallet = await api.wallet();
  log(`Wallet: ${payer.kind}${wallet.balanceMyr != null ? `, RM ${wallet.balanceMyr.toFixed(2)}` : ''}${wallet.mode ? ` (${wallet.mode})` : ''}`);
}

function registerIpc() {
  ipcMain.handle('goat:info', () => ({
    serverUrl,
    userId,
    platform: process.platform,
    hotkeys: { ask: hotkey('G'), record: hotkey('R'), capture: hotkey('C'), track: hotkey('T'), voice: hotkey('V') },
  }));
  ipcMain.handle('goat:timesheet', (event, date) => (fromOverlay(event) ? api.timesheet(dateOrToday(date)) : { error: 'forbidden' }));
  ipcMain.handle('goat:approve-timesheet', (event, date) => (fromOverlay(event) ? api.approveTimesheet(dateOrToday(date)) : { error: 'forbidden' }));
  ipcMain.handle('goat:export-csv', async (event, date) => {
    if (!fromOverlay(event)) return { error: 'forbidden' };
    const url = `${serverUrl}/api/timesheet.csv?date=${dateOrToday(date)}&user=${encodeURIComponent(userId)}`;
    if (process.env.GOAT_TEST_HOOKS !== '1') await shell.openExternal(url);
    return { ok: true, url };
  });
  ipcMain.handle('goat:wallet', (event) => (fromOverlay(event) ? api.wallet() : { error: 'forbidden' }));
  ipcMain.handle('goat:topup', (event, myr) => (fromOverlay(event) ? api.topup(Number(myr) || 10) : { error: 'forbidden' }));
  ipcMain.handle('goat:upgrade', (event) => (fromOverlay(event) ? api.upgradePro() : { error: 'forbidden' }));
  ipcMain.on('goat:open-link', (event, url) => {
    // Only transaction links on the Base Sepolia explorer.
    if (fromOverlay(event) && /^https:\/\/sepolia\.basescan\.org\/tx\/0x[0-9a-fA-F]+$/.test(String(url)) && process.env.GOAT_TEST_HOOKS !== '1') {
      shell.openExternal(url);
    }
  });
  ipcMain.handle('goat:save-guide', async (event, form) => {
    if (!fromOverlay(event)) return { error: 'forbidden', message: 'Unknown sender.' };
    const { width, height } = screen.getPrimaryDisplay().size;
    const guide = buildGuide(form || {}, { app: lastRecording?.app || '', recordedOn: `${width}x${height}` });
    const reply = await api.saveGuide(guide);
    log(reply.error ? `save guide failed: ${reply.error}` : `saved guide ${reply.id}`);
    return reply;
  });
  ipcMain.handle('goat:ask', async (event, payload) => {
    if (!fromOverlay(event)) return { error: 'forbidden', message: 'Unknown sender.' };
    const question = typeof payload?.question === 'string' ? payload.question.slice(0, 1000) : '';
    // A highlighted region: read just that part of the screen, only now, and never store it.
    const region = validRegion(payload?.region);
    let image;
    if (region) {
      try {
        image = await captureRegion(region, { win, fake: process.env.GOAT_FAKE_CAPTURE === '1' });
      } catch (err) {
        return { error: err.code || 'capture_failed', message: err.message };
      }
    }
    const reply = await api.assist({ question, context: region ? { ...askContext, region } : askContext, image });
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
  const keys = { G: () => openAsk('hotkey'), R: () => toggleRecording(), T: () => toggleTracking() };
  for (const [key, run] of Object.entries(keys)) {
    if (!globalShortcut.register(accelerator(key), run)) console.warn(`[goat] ${hotkey(key)} is already taken by another app.`);
  }
}

function trayMenu() {
  return Menu.buildFromTemplate([
    { label: `Ask GOAT (${hotkey('G')})`, click: () => openAsk('tray') },
    recorder.recording
      ? { label: `Stop recording (${hotkey('R')})`, click: () => toggleRecording() }
      : { label: `Record a guide (${hotkey('R')})`, click: () => toggleRecording() },
    ...(recorder.recording ? [{ label: `Capture step at the mouse (${hotkey('C')})`, click: () => captureStep() }] : []),
    tracker.tracking
      ? { label: `Stop tracking (${hotkey('T')})`, click: () => toggleTracking() }
      : { label: `Start tracking (${hotkey('T')})`, click: () => toggleTracking() },
    { label: "Today's timesheet", click: () => openTimesheet() },
    { label: 'Wallet and Pro…', click: () => openWallet() },
    { type: 'separator' },
    { label: `Server: ${serverUrl}`, enabled: false },
    { label: `User: ${userId}`, enabled: false },
    { type: 'separator' },
    { label: 'Quit GOAT', click: () => app.quit() },
  ]);
}

function refreshTray() {
  if (tray) tray.setContextMenu(trayMenu());
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(here, 'assets', 'trayTemplate.png'));
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip('GOAT');
  refreshTray();
}

if (!app.requestSingleInstanceLock()) {
  console.warn('[goat] GOAT is already running.');
  app.quit();
} else {
  app.whenReady().then(async () => {
    if (isMac) app.dock?.hide();
    await setUpWallet();
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
        toggleRecording: () => toggleRecording(),
        captureStep: (point) => captureStep(point),
        recording: () => ({ recording: recorder.recording, steps: recorder.steps, app: recorder.app }),
        toggleTracking: () => toggleTracking(),
        tracking: () => ({ tracking: tracker.tracking, queued: tracker.queued }),
        wallet: () => api.wallet(),
        payer: () => ({ kind: payer.kind, address: payer.address }),
        setFakeWindow: (value) => {
          process.env.GOAT_FAKE_WINDOW = value;
        },
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
  // Send any queued timesheet samples before quitting.
  let flushedOnQuit = false;
  app.on('before-quit', (event) => {
    if (flushedOnQuit || !tracker.tracking) return;
    event.preventDefault();
    flushedOnQuit = true;
    tracker.stop().finally(() => app.quit());
  });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('window-all-closed', () => app.quit());
}
