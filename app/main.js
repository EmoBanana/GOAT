import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, powerMonitor, screen, shell, systemPreferences, Tray } from 'electron';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sampleActiveWindow } from './lib/active-window.js';
import { captureRegion } from './lib/capture.js';
import { documentHint, documentKind, readDocument } from './lib/doc-context.js';
import { findTarget, readTargets, targetAt } from './lib/screen-targets.js';
import { bringUp, frontTab, HOW_TO, placeToOpen, SHOW_ME } from './lib/open-place.js';
import { startHoldKeys } from './lib/hold-keys.js';
import { validRegion } from './lib/region.js';
import { createApi } from './lib/api.js';
import { readBuildInfo, resolveServerUrl, SERVER_OFFLINE, whereItRuns } from './lib/build-info.js';
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

// A packaged GOAT talks to the server it was built for (scripts/package.js); GOAT_SERVER_URL wins.
const build = readBuildInfo(app.getAppPath());
const serverUrl = resolveServerUrl({ env: process.env, build });
const unreachableMessage = app.isPackaged ? SERVER_OFFLINE : null;
const userId = getUserId();
// Replaced by a paying client once the wallet is ready (see setUpWallet).
let api = createApi({ baseUrl: serverUrl, userId, unreachableMessage });
let payer = { kind: 'none', address: null };
const recorder = createRecorder();
let lastRecording = null;
// Timesheet tracking: off until Ctrl+Option+T, after every launch.
const tracker = createTracker({
  sample: (allow) => sampleActiveWindow({ timeoutMs: 2500, allow, site: true }),
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
let askPid = 0; // the app asked about, for reading its controls (macOS Accessibility)
let askOpening = false;
let holdKeys = null;
let streamPaused = false; // test hooks drive the cursor instead

const log = (...args) => console.log('[goat]', ...args);
// What each ask did, step by step, also kept in userData/goat.log: when a guide doesn't come, the
// line says where it stopped. App names, counts and timings only: no questions, window titles,
// addresses or control names.
function note(line) {
  log(line);
  try {
    const file = path.join(app.getPath('userData'), 'goat.log');
    if (fs.existsSync(file) && fs.statSync(file).size > 256 * 1024) fs.renameSync(file, `${file}.1`);
    fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // the terminal still has it
  }
}

function send(message) {
  if (win && !win.isDestroyed()) win.webContents.send('goat:event', message);
}

const fromOverlay = (event) => Boolean(win) && event.sender === win.webContents;

// Test runs keep out of the user's way (GOAT_TEST_QUIET=0 brings the old behaviour back): the
// overlay sits past the bottom-right corner of the screen, with one pixel still on it so macOS
// keeps drawing it, and it never takes the keyboard. An on-screen test overlay swallowed the
// user's clicks while a panel was open, and their clicks closed the test's forms. Positions don't
// change: everything is still measured from the display's corner.
const quietTests = process.env.GOAT_TEST_HOOKS === '1' && process.env.GOAT_TEST_QUIET !== '0';
// Where the overlay is, for the renderer's window coordinates.
const overlayBounds = () => (quietTests ? screen.getPrimaryDisplay().bounds : win.getBounds());

// The overlay covers the primary display; the renderer works in window coordinates. The insets say
// how far the menu bar and the Dock reach in (both draw above the overlay), so docked cards sit
// clear of them.
function fitToPrimary() {
  if (!win) return;
  const { bounds: display, workArea: work } = screen.getPrimaryDisplay();
  win.setBounds(quietTests ? { ...display, x: display.x + display.width - 1, y: display.y + display.height - 1 } : display);
  const b = overlayBounds();
  const insets = {
    top: work.y - display.y,
    right: display.x + display.width - (work.x + work.width),
    bottom: display.y + display.height - (work.y + work.height),
    left: work.x - display.x,
  };
  send({ type: 'origin', x: b.x, y: b.y, width: b.width, height: b.height, insets });
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
  // The overlay may use the microphone (voice mode), and nothing else.
  win.webContents.session.setPermissionRequestHandler((wc, permission, callback, details) => {
    callback(permission === 'media' && wc === win?.webContents && (details.mediaTypes || ['audio']).every((t) => t === 'audio'));
  });
  win.webContents.session.setPermissionCheckHandler((wc, permission) => permission === 'media' && wc === win?.webContents);
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
    const b = overlayBounds();
    const point = { x: p.x - b.x, y: p.y - b.y };
    if (lastCursor && lastCursor.x === point.x && lastCursor.y === point.y) return;
    lastCursor = point;
    send({ type: 'cursor', ...point });
  }, 33);
}

function focusOverlay() {
  if (!win) return;
  win.setIgnoreMouseEvents(false);
  if (quietTests) return; // a test drives the page itself; the keyboard stays with the user
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
    if (sample && !isSelf(sample)) {
      askContext = { app: sample.app, title: sample.title, url: sample.url || '' };
      askPid = Number(sample.pid) || 0;
    }
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
    recordPid = sample && !isSelf(sample) ? Number(sample.pid) || 0 : 0;
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

// GOAT-compatible: paste vendor docs, Gemma drafts the steps, the recorder adds the positions.
function openDraft() {
  focusOverlay();
  send({ type: 'open-draft' });
}

function openWallet() {
  focusOverlay();
  send({ type: 'open-wallet' });
}

// The panel opens at once and fills in when the day's activity lines are written.
async function openTimesheet() {
  focusOverlay();
  send({ type: 'open-timesheet', loading: true });
  const timesheet = await api.timesheet(localDate());
  send({ type: 'open-timesheet', timesheet });
}

// Ctrl+Option+V: start listening; press again to send (Pro). The renderer records; main
// checks the microphone permission and reads the frontmost window for the ask context.
// Voice (Pro): hold Option+Cmd to talk and let go to send (Ctrl+Option+V toggles the same).
// Letting go also reads the screen around the pointer, so "what's this?" has context. That
// picture goes with this one question and is never stored. It's skipped unless Screen
// Recording is already allowed (voice never asks for it) or when GOAT_VOICE_SCREEN=off.
let voiceDown = false;
let voiceScreen = null; // Promise<{ image, region } | null> for the question being asked

async function captureVoiceScreen() {
  const fake = process.env.GOAT_FAKE_CAPTURE === '1';
  if (process.env.GOAT_VOICE_SCREEN === 'off') return null;
  if (!fake && isMac && systemPreferences.getMediaAccessStatus('screen') !== 'granted') return null;
  const p = screen.getCursorScreenPoint();
  const d = screen.getDisplayNearestPoint(p).bounds;
  const width = Math.min(1280, d.width);
  const height = Math.min(800, d.height);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const region = { x: clamp(Math.round(p.x - width / 2), d.x, d.x + d.width - width), y: clamp(Math.round(p.y - height / 2), d.y, d.y + d.height - height), width, height };
  try {
    return { image: await captureRegion(region, { win, fake }), region };
  } catch (err) {
    log(`voice screen skipped: ${err.message}`);
    return null;
  }
}

async function voiceHold(down) {
  if (!win || down === voiceDown) return;
  voiceDown = down;
  if (down) {
    if (isMac && process.env.GOAT_FAKE_MEDIA !== '1' && systemPreferences.getMediaAccessStatus('microphone') !== 'granted') {
      const allowed = await systemPreferences.askForMediaAccess('microphone');
      if (!allowed) {
        voiceDown = false;
        send({ type: 'voice-error', message: 'GOAT needs the microphone for voice mode. Allow it in System Settings > Privacy & Security > Microphone.' });
        return;
      }
    }
    voiceScreen = null;
    send({ type: 'voice-hold', down: true });
    const sample = await sampleActiveWindow({ timeoutMs: 700 });
    if (sample && !isSelf(sample)) {
      askContext = { app: sample.app, title: sample.title, url: sample.url || '' };
      askPid = Number(sample.pid) || 0;
    }
  } else {
    send({ type: 'voice-hold', down: false }); // stop recording first, then look at the screen
    voiceScreen = captureVoiceScreen();
  }
}

const toggleVoice = () => voiceHold(!voiceDown);

let recordPid = 0;
function captureStep(point) {
  if (!recorder.recording) return;
  const step = recorder.capture(point || screen.getCursorScreenPoint());
  if (!step) return;
  send({ type: 'record:step', step, count: recorder.steps.length });
  // Also note which control is under the pointer, so the guide can find it again at any
  // resolution or window size (the points stay as the fallback).
  targetAt({ app: recorder.app, pid: recordPid, x: step.x, y: step.y }).then((target) => {
    if (!target) return;
    recorder.setTarget(step.n, target);
    send({ type: 'record:target', n: step.n, target });
  });
}

// ---------- what GOAT reads when you ask ----------
// The whole deck or page in front (lib/doc-context.js), read now for this one question and never
// stored. GOAT_DOC_CONTEXT=off switches it off. A one-time hint says how to allow it.
const docHints = new Set();
// `quiet` for a show-me question: the controls' hint below covers the same switch.
async function readFrontDocument({ quiet = false } = {}) {
  const kind = documentKind(askContext.app);
  if (!kind || process.env.GOAT_DOC_CONTEXT === 'off') return null;
  const doc = await readDocument({ app: askContext.app });
  if (doc && doc.error) {
    const hint = documentHint(doc);
    if (hint && !quiet && !docHints.has(`${doc.app}:${doc.error}`)) {
      docHints.add(`${doc.app}:${doc.error}`);
      send({ type: 'notice', text: hint });
    }
    log(`couldn't read the ${kind} in ${doc.app}: ${doc.error}`);
    return null;
  }
  return doc;
}

// The controls on screen in the app asked about (lib/screen-targets.js). A how-to question takes
// them along so GOAT can plan a guide; during a guide, each step's control is found again live.
// (HOW_TO, the how-to questions, lives in lib/open-place.js; the server has the same pattern.)
let guideApp = { app: '', pid: 0 };
// Resolves to { targets, why }: the controls, or null and why there are none (in a browser, the
// toolbar alone and why the page gave none). A show-me question wants the cursor, so when
// controls can't be read it says so every time (what to switch on, when GOAT knows); other how-to
// questions get the hint once.
async function readFrontTargets({ showMe = false } = {}) {
  guideApp = { app: askContext.app || '', pid: askPid };
  const read = await readTargets(guideApp);
  const targets = read?.elements?.length ? read.elements : null;
  const failed = read?.error || read?.pageError || '';
  const why = targets ? (failed ? `the page gave none: ${failed}` : '') : !guideApp.app ? 'no app in front' : failed || (read ? 'none found' : 'not readable');
  const hint = failed ? documentHint({ kind: 'page', app: guideApp.app, error: failed }, { purpose: 'point' }) : '';
  const key = `${guideApp.app}:${failed}:point`;
  if (hint && (showMe || !docHints.has(key))) {
    docHints.add(key);
    send({ type: 'notice', text: hint });
  } else if (showMe && !targets) {
    send({ type: 'notice', text: guideApp.app ? `GOAT can't see the buttons in ${guideApp.app} right now, so it answered in words.` : "GOAT couldn't tell which app is in front, so it answered in words." });
  }
  return { targets, why };
}

// "Show me … on Google / in Excel" with something else in front: GOAT opens it first (a website in
// the default browser, an app by name) so the cursor can show the steps there (lib/open-place.js).
const openedPlaces = []; // tests: what GOAT would have opened
const runOpen = (args) => new Promise((resolve, reject) => execFile('open', args, { timeout: 10_000 }, (err) => (err ? reject(err) : resolve())));
function openPlace(place) {
  // Tests open nothing: the stand-in window (GOAT_FAKE_OPENS, "App|Title|URL") comes to the front.
  if ('GOAT_FAKE_OPENS' in process.env) {
    openedPlaces.push(place.url || place.app);
    if (process.env.GOAT_FAKE_OPENS) process.env.GOAT_FAKE_WINDOW = process.env.GOAT_FAKE_OPENS;
    return Promise.resolve();
  }
  // macOS: `open` brings the browser or app forward whichever app is active (after a voice ask
  // GOAT itself is in the background).
  if (isMac) return runOpen(place.url ? [place.url] : ['-a', place.app]);
  return place.url ? shell.openExternal(place.url) : Promise.reject(new Error('Apps open by name on macOS only.'));
}
const bringForward = (name) => (isMac && !('GOAT_FAKE_OPENS' in process.env) ? runOpen(['-a', name]) : Promise.resolve());

// ---------- account ----------
// GOAT starts by asking you to sign in: create an account (email or social) or connect a wallet
// with Reown AppKit in the browser, or continue offline. The account decides the user id the
// server sees and which spending wallet pays for assists (lib/account.js).
let accounts = null; // lib/account.js, loaded when the app is ready
let account = null;
let activeUser = userId;
let signInPoll = null;
const CHAT_ID = /^[a-f0-9]{16}$/;
const userData = () => app.getPath('userData');
const signedIn = () => Boolean(account) || process.env.GOAT_SKIP_SIGNIN === '1';
const chatIdFrom = (id) => (id === null ? null : CHAT_ID.test(String(id)) ? id : undefined);

async function loadSignedInAccount() {
  accounts = await import('./lib/account.js');
  account = accounts.loadAccount(userData());
  activeUser = accounts.userIdFor(account, { fallback: userId });
}

function accountInfo() {
  return { signedIn: signedIn(), account: accounts ? accounts.describeAccount(account) : null, userId: activeUser };
}

async function useAccount(next) {
  account = next;
  activeUser = accounts.userIdFor(account, { fallback: userId });
  await setUpWallet();
  send({ type: 'account', ...accountInfo() });
  refreshTray();
  log(account ? `Signed in (${account.method}) as ${activeUser}` : 'Signed out');
}

function stopSignInPoll() {
  clearInterval(signInPoll);
  signInPoll = null;
}

// Opens the sign-in page in the browser, then waits for the account to come back.
async function startSignIn(mode) {
  stopSignInPoll();
  const r = await api.startSignIn();
  if (r.error) return r;
  const url = `${serverUrl}${r.path}&mode=${mode === 'connect' ? 'connect' : 'create'}`;
  if (process.env.GOAT_TEST_HOOKS !== '1') await shell.openExternal(url);
  const until = Date.now() + (r.expiresInMs || 15 * 60_000);
  signInPoll = setInterval(async () => {
    const got = Date.now() > until ? { expired: true } : await api.signInResult(r.code);
    if (got.expired) {
      stopSignInPoll();
      send({ type: 'sign-in-expired' });
    } else if (got.linked) {
      stopSignInPoll();
      await useAccount(accounts.saveAccount(userData(), got.account));
    }
  }, Number(process.env.GOAT_SIGN_IN_POLL_MS) || 1500);
  return { ok: true, url, code: r.code };
}

async function continueOffline() {
  stopSignInPoll();
  const { loadLocalWallet } = await import('./lib/wallet.js');
  await useAccount(accounts.saveAccount(userData(), { address: loadLocalWallet(userData()).address, method: 'local' }));
  return accountInfo();
}

async function signOut() {
  stopSignInPoll();
  accounts.clearAccount(userData());
  await useAccount(null);
  return accountInfo();
}

// Ctrl+Option+A: your account, balance and chats (or sign-in, before there's an account).
function openAccount() {
  focusOverlay();
  send({ type: signedIn() ? 'open-account' : 'open-welcome', ...accountInfo() });
}

// Asking and talking need an account first.
const needsAccount =
  (run) =>
  (...args) =>
    signedIn() ? run(...args) : openAccount();

// The wallet abstraction: only main holds the key; the server only sees the address.
async function setUpWallet() {
  try {
    payer = await createPayer({
      mode: process.env.GOAT_WALLET || 'auto',
      dir: accounts ? accounts.walletDirFor(account, userData()) : userData(),
      env: process.env,
      network: process.env.X402_NETWORK || 'eip155:84532',
    });
  } catch (err) {
    console.warn(`[goat] No wallet: ${err.message}`);
    payer = { kind: 'none', address: null, fetch: globalThis.fetch };
  }
  api = createApi({ baseUrl: serverUrl, userId: activeUser, walletAddress: payer.address, fetchImpl: payer.fetch, unreachableMessage });
  const wallet = await api.wallet();
  log(`Wallet: ${payer.kind}${wallet.balanceMyr != null ? `, RM ${wallet.balanceMyr.toFixed(2)}` : ''}${wallet.mode ? ` (${wallet.mode})` : ''}`);
}

function registerIpc() {
  ipcMain.handle('goat:info', () => ({
    serverUrl,
    userId,
    platform: process.platform,
    hotkeys: { ask: hotkey('G'), record: hotkey('R'), capture: hotkey('C'), track: hotkey('T'), voice: hotkey('V'), talk: isMac ? 'Option+Cmd' : hotkey('V') },
  }));
  ipcMain.handle('goat:timesheet', (event, date) => (fromOverlay(event) ? api.timesheet(dateOrToday(date)) : { error: 'forbidden' }));
  ipcMain.handle('goat:approve-timesheet', (event, date) => (fromOverlay(event) ? api.approveTimesheet(dateOrToday(date)) : { error: 'forbidden' }));
  ipcMain.handle('goat:export-csv', async (event, date) => {
    if (!fromOverlay(event)) return { error: 'forbidden' };
    const url = `${serverUrl}/api/timesheet.csv?date=${dateOrToday(date)}&user=${encodeURIComponent(activeUser)}`;
    if (process.env.GOAT_TEST_HOOKS !== '1') await shell.openExternal(url);
    return { ok: true, url };
  });
  ipcMain.handle('goat:wallet', (event) => (fromOverlay(event) ? api.wallet() : { error: 'forbidden' }));
  ipcMain.handle('goat:transcribe', (event, audio) => (fromOverlay(event) && typeof audio === 'string' ? api.transcribe(audio) : { error: 'forbidden' }));
  ipcMain.handle('goat:speak', (event, text) => (fromOverlay(event) && typeof text === 'string' ? api.speak(text) : { error: 'forbidden' }));
  ipcMain.handle('goat:topup', (event, myr) => (fromOverlay(event) ? api.topup(Number(myr) || 10) : { error: 'forbidden' }));
  ipcMain.handle('goat:upgrade', (event) => (fromOverlay(event) ? api.upgradePro() : { error: 'forbidden' }));
  ipcMain.on('goat:open-link', (event, url) => {
    // Only transaction links on the Base Sepolia explorer.
    if (fromOverlay(event) && /^https:\/\/sepolia\.basescan\.org\/tx\/0x[0-9a-fA-F]+$/.test(String(url)) && process.env.GOAT_TEST_HOOKS !== '1') {
      shell.openExternal(url);
    }
  });
  ipcMain.handle('goat:draft-guide', (event, text) => (fromOverlay(event) && typeof text === 'string' ? api.draftGuide(text) : { error: 'forbidden' }));
  ipcMain.on('goat:start-recording', (event) => {
    if (fromOverlay(event) && !recorder.recording) toggleRecording();
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
    // A voice question carries the screen around the pointer, read when the user let go.
    let screenShot = null;
    if (payload?.voice === true && voiceScreen) {
      screenShot = await voiceScreen;
      voiceScreen = null;
    }
    // "Show me how to search on Google" with the IDE in front: open Google first, then plan the
    // steps there. The screen read before that shows the old app, so it goes.
    const showMe = SHOW_ME.test(question);
    const howTo = HOW_TO.test(question);
    const trail = [`${payload?.voice === true ? 'voice ask' : 'ask'}${showMe ? ' (show me)' : howTo ? ' (how-to)' : ''} with ${askContext.app || 'no app'} in front`];
    const place = region ? null : placeToOpen(question, askContext);
    if (place) {
      const began = Date.now();
      const front = await bringUp(place, { open: openPlace, sample: () => sampleActiveWindow({ timeoutMs: 700 }), tab: frontTab, activate: bringForward });
      if (front && !isSelf(front)) {
        askContext = { app: front.app, title: front.title, url: front.url || '' };
        askPid = Number(front.pid) || 0;
        screenShot = null;
        trail.push(`opened ${place.name}: up in ${front.app} after ${Date.now() - began} ms`);
      } else {
        trail.push(`opened ${place.name}: it never came up (${Date.now() - began} ms)`);
        send({ type: 'notice', text: `${place.name} didn't come up, so GOAT answered in words.` });
      }
    }
    const context = region ? { ...askContext, region } : screenShot ? { ...askContext, region: screenShot.region } : askContext;
    // A how-to question also takes the controls on screen, so GOAT can plan a guide around them.
    const [document, controls] = await Promise.all([readFrontDocument({ quiet: showMe }), howTo && !region ? readFrontTargets({ showMe }) : null]);
    const targets = controls?.targets || null;
    if (howTo && !region) trail.push(targets ? `${targets.length} controls${controls.why ? ` (${controls.why})` : ''}` : `no controls (${controls?.why})`);
    if (document) trail.push(`${document.kind} read`);
    const reply = await api.assist({ question, context, image, screen: screenShot?.image, voice: payload?.voice === true, chatId: chatIdFrom(payload?.chatId), document, targets });
    trail.push(reply.error ? `failed: ${reply.error}` : reply.source === 'guide' ? `guide ${reply.planned ? 'planned' : reply.guide?.id}, ${reply.guide?.steps?.length} steps, ${reply.latencyMs} ms` : `answered in words, ${reply.latencyMs} ms`);
    note(trail.join(' | '));
    // Asked to be shown, the controls were there, and still no guide: say so rather than only answering.
    if (showMe && targets && !reply.error && reply.source !== 'guide') send({ type: 'notice', text: "GOAT couldn't work out the clicks on this screen, so it answered in words." });
    // While tracking, a guide GOAT plays goes into the timesheet line for that stretch.
    if (!reply.error && reply.source === 'guide' && reply.guide) tracker.note({ guide: reply.guide.title || reply.guide.id, app: context.app });
    if (!reply.error) reply.where = whereItRuns(serverUrl); // "running on this laptop" only when it does
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
  // A guide step's control, found on screen right now: { x, y, w, h } in screen points, or null.
  ipcMain.handle('goat:locate', async (event, target) => {
    if (!fromOverlay(event) || typeof target?.label !== 'string') return null;
    const app = guideApp.app || askContext.app || '';
    const read = await readTargets({ app, pid: guideApp.pid || askPid });
    const hit = read && !read.error ? findTarget(read.elements, target.label.slice(0, 80), String(target.role || '')) : null;
    if (!hit) note(`guide step: its control wasn't found in ${app || 'no app'} (${read?.error || `${read?.elements?.length ?? 0} controls read`})`);
    return hit ? { x: hit.x, y: hit.y, w: hit.w, h: hit.h, label: hit.label } : null;
  });
  // Account and chats.
  const overlayOnly = (run) => (event, ...args) => (fromOverlay(event) ? run(...args) : { error: 'forbidden', message: 'Unknown sender.' });
  ipcMain.handle('goat:account', overlayOnly(() => accountInfo()));
  ipcMain.handle('goat:sign-in', overlayOnly((mode) => startSignIn(mode)));
  ipcMain.handle('goat:sign-in-offline', overlayOnly(() => continueOffline()));
  ipcMain.handle('goat:sign-out', overlayOnly(() => signOut()));
  ipcMain.handle('goat:chats', overlayOnly(() => api.chats()));
  ipcMain.handle('goat:chat', overlayOnly((id) => (CHAT_ID.test(String(id)) ? api.chat(id) : { error: 'not_found', message: 'No such chat.' })));
  ipcMain.handle('goat:delete-chat', overlayOnly((id) => (CHAT_ID.test(String(id)) ? api.deleteChat(id) : { error: 'not_found', message: 'No such chat.' })));
  ipcMain.handle('goat:clear-chats', overlayOnly(() => api.clearChats()));
}

function registerHotkeys() {
  const keys = {
    G: needsAccount(() => openAsk('hotkey')),
    R: () => toggleRecording(),
    T: () => toggleTracking(),
    V: needsAccount(() => toggleVoice()),
    A: () => openAccount(),
  };
  for (const [key, run] of Object.entries(keys)) {
    if (!globalShortcut.register(accelerator(key), run)) console.warn(`[goat] ${hotkey(key)} is already taken by another app.`);
  }
}

function trayMenu() {
  return Menu.buildFromTemplate([
    { label: `Ask GOAT (${hotkey('G')})`, click: () => openAsk('tray') },
    { label: `Voice question, Pro (hold ${isMac ? 'Option+Cmd' : hotkey('V')})`, click: () => toggleVoice() },
    recorder.recording
      ? { label: `Stop recording (${hotkey('R')})`, click: () => toggleRecording() }
      : { label: `Record a guide (${hotkey('R')})`, click: () => toggleRecording() },
    ...(recorder.recording ? [{ label: `Capture step at the mouse (${hotkey('C')})`, click: () => captureStep() }] : []),
    { label: 'Draft a guide from docs…', click: () => openDraft() },
    tracker.tracking
      ? { label: `Stop tracking (${hotkey('T')})`, click: () => toggleTracking() }
      : { label: `Start tracking (${hotkey('T')})`, click: () => toggleTracking() },
    { label: "Today's timesheet", click: () => openTimesheet() },
    { label: 'Wallet and Pro…', click: () => openWallet() },
    { label: signedIn() ? `Account and chats (${hotkey('A')})` : `Sign in… (${hotkey('A')})`, click: () => openAccount() },
    { type: 'separator' },
    { label: `Server: ${serverUrl}`, enabled: false },
    { label: `Account: ${accounts?.describeAccount(account)?.label || (signedIn() ? activeUser : 'not signed in')}`, enabled: false },
    { type: 'separator' },
    { label: 'Quit GOAT', click: () => app.quit() },
  ]);
}

function refreshTray() {
  if (tray) tray.setContextMenu(trayMenu());
}

function createTray() {
  // macOS tints a one-colour cup (a template icon) for its menu bar; Windows shows the cup in colour.
  const icon = nativeImage.createFromPath(path.join(here, 'assets', isMac ? 'trayTemplate.png' : 'tray.png'));
  if (isMac) icon.setTemplateImage(true);
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
    await loadSignedInAccount();
    await setUpWallet();
    // Hold Option+Cmd to talk (GOAT_PTT=off turns the helper off; Ctrl+Option+V still works).
    if (isMac && process.env.GOAT_PTT !== 'off') holdKeys = startHoldKeys({ onDown: needsAccount(() => voiceHold(true)), onUp: () => voiceHold(false) });
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
        toggleVoice: () => toggleVoice(),
        voiceHold: (down) => voiceHold(down),
        openDraft: () => openDraft(),
        tracking: () => ({ tracking: tracker.tracking, queued: tracker.queued }),
        wallet: () => api.wallet(),
        payer: () => ({ kind: payer.kind, address: payer.address }),
        account: () => accountInfo(),
        setFakeDoc: (value) => {
          process.env.GOAT_FAKE_DOC = value;
        },
        setFakeTargets: (value) => {
          process.env.GOAT_FAKE_TARGETS = value;
        },
        openAccount: () => openAccount(),
        startSignIn: (mode) => startSignIn(mode),
        continueOffline: () => continueOffline(),
        signOut: () => signOut(),
        info: () => ({ serverUrl, packaged: app.isPackaged, version: app.getVersion(), build }),
        setFakeWindow: (value) => {
          process.env.GOAT_FAKE_WINDOW = value;
        },
        // The window that comes to the front when GOAT opens an app or website ("App|Title|URL").
        setFakeOpen: (value) => {
          process.env.GOAT_FAKE_OPENS = value;
        },
        opened: () => openedPlaces.slice(),
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
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    holdKeys?.stop();
  });
  app.on('window-all-closed', () => app.quit());
}
