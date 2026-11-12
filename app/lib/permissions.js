import { execFile } from 'node:child_process';
import fs from 'node:fs';

// The permissions GOAT needs, asked for when the downloaded app starts instead of on the first
// question (the user's ask on 13 Nov: "ask and enable all permission for downloads before they
// start using"). macOS: Accessibility (the controls GOAT points at, window titles), Screen
// Recording (the part of the screen you ask about), Microphone (voice) and Automation (System
// Events for window titles; open browsers and Keynote for the page or deck). Windows asks desktop
// apps nothing: only the microphone can be switched off there, in Settings.
//
// Each item's state: 'granted'; 'ask' (GOAT can bring up the system prompt); or 'settings' (only
// System Settings can switch it on: macOS asks once, and for Accessibility and Screen Recording it
// reports a refusal and a question never asked the same way, so GOAT remembers what it asked in
// permissions.json).
// Electron's systemPreferences, desktopCapturer and shell come in as arguments, so tests run
// without Electron.

const MAC = 'x-apple.systempreferences:com.apple.preference.security?';
export const SETTINGS_URLS = {
  darwin: {
    accessibility: `${MAC}Privacy_Accessibility`,
    screen: `${MAC}Privacy_ScreenCapture`,
    microphone: `${MAC}Privacy_Microphone`,
    automation: `${MAC}Privacy_Automation`,
  },
  win32: { microphone: 'ms-settings:privacy-microphone' },
};

const ITEMS = {
  darwin: [
    { id: 'accessibility', label: 'Accessibility', why: 'Find the buttons GOAT points at, and read window titles.' },
    { id: 'screen', label: 'Screen Recording', why: 'See the part of the screen you ask about. Never stored.' },
    { id: 'microphone', label: 'Microphone', why: 'Hear you only while you hold Option+Cmd.' },
    { id: 'automation', label: 'Automation', why: 'Read the window, page or deck in front when you ask.' },
  ],
  win32: [{ id: 'microphone', label: 'Microphone', why: 'Hear you only after you press Ctrl+Alt+V.' }],
};

// Asked in this order: the prompts that wait for an answer first, Accessibility last because its
// dialog sends you to System Settings.
const ORDER = ['microphone', 'screen', 'automation', 'accessibility'];

// Apps GOAT reads with Apple Events. System Events always; the others only when they're open
// (asking one that isn't would launch it).
export const AUTOMATED_APPS = ['Google Chrome', 'Microsoft Edge', 'Brave Browser', 'Arc', 'Safari', 'Keynote'];

// One harmless Apple event to each app, so macOS asks once whether GOAT may control it.
// Prints { "<app>": "granted" | "denied" | "error" } for the apps it reached.
const AUTOMATION_JXA = `
function run(argv) {
  const out = {};
  for (const name of ['System Events'].concat(argv)) {
    try {
      const app = Application(name);
      if (name === 'System Events') app.processes.length;
      else if (app.running()) app.windows.length;
      else continue;
      out[name] = 'granted';
    } catch (e) {
      out[name] = /-1743|not allowed|not authori[sz]ed/i.test(String(e)) ? 'denied' : 'error';
    }
  }
  return JSON.stringify(out);
}`;

function runJxa(script, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile('osascript', ['-l', 'JavaScript', '-e', script, ...args], { timeout: timeoutMs }, (err, stdout) => resolve(err ? null : stdout));
  });
}

export function createPermissions({ platform = process.platform, prefs, capturer, shell, file, run = runJxa, enabled = false } = {}) {
  const items = ITEMS[platform] || [];

  function load() {
    try {
      return JSON.parse(fs.readFileSync(file(), 'utf8'));
    } catch {
      return {};
    }
  }
  function save(data) {
    try {
      fs.writeFileSync(file(), `${JSON.stringify(data, null, 2)}\n`);
    } catch {
      // asked again next time
    }
  }
  function markAsked(id, extra = {}) {
    const data = load();
    save({ ...data, ...extra, asked: { ...(data.asked || {}), [id]: new Date().toISOString() } });
  }

  function stateOf(id, data) {
    const asked = Boolean(data.asked && data.asked[id]);
    if (platform === 'win32') {
      // Desktop apps may use the microphone unless Settings switches it off for all of them.
      return prefs.getMediaAccessStatus('microphone') === 'denied' ? 'settings' : 'granted';
    }
    if (id === 'accessibility') return prefs.isTrustedAccessibilityClient(false) ? 'granted' : asked ? 'settings' : 'ask';
    if (id === 'microphone') {
      const s = prefs.getMediaAccessStatus('microphone');
      return s === 'granted' ? 'granted' : s === 'denied' || s === 'restricted' ? 'settings' : 'ask';
    }
    if (id === 'screen') return prefs.getMediaAccessStatus('screen') === 'granted' ? 'granted' : asked ? 'settings' : 'ask';
    if (id === 'automation') {
      const s = (data.automation || {})['System Events'];
      return s === 'granted' ? 'granted' : s === 'denied' ? 'settings' : 'ask';
    }
    return 'granted';
  }

  function status() {
    const data = load();
    const list = items.map((item) => ({ ...item, state: stateOf(item.id, data) }));
    return {
      platform,
      ask: Boolean(enabled) && list.length > 0,
      needed: list.some((i) => i.state !== 'granted'),
      items: list,
      note: platform === 'darwin' ? 'In Chrome, Edge, Brave or Arc, also turn on View › Developer › Allow JavaScript from Apple Events, so GOAT can read the page.' : '',
    };
  }

  function openSettings(id) {
    const url = (SETTINGS_URLS[platform] || {})[id];
    if (!url) return { error: 'unknown_permission', message: 'No such permission.' };
    shell.openExternal(url);
    return { ok: true };
  }

  async function askOne(id) {
    if (id === 'microphone') {
      markAsked(id);
      if (platform === 'darwin') await prefs.askForMediaAccess('microphone');
    } else if (id === 'screen') {
      markAsked(id);
      // The first capture brings up macOS's Screen Recording prompt; the picture is thrown away.
      try {
        await capturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } });
      } catch {
        // the prompt still showed, or Settings is the way
      }
    } else if (id === 'automation') {
      const out = await run(AUTOMATION_JXA, AUTOMATED_APPS, 150_000);
      let got = {};
      try {
        got = JSON.parse(String(out || '').trim() || '{}');
      } catch {
        got = {};
      }
      const data = load();
      markAsked(id, { automation: { ...(data.automation || {}), ...got } });
    } else if (id === 'accessibility') {
      markAsked(id);
      prefs.isTrustedAccessibilityClient(true); // macOS's own dialog, which leads to System Settings
    }
  }

  // Brings up every prompt GOAT can (or just `only`); a permission that only System Settings can
  // switch on opens its page there instead (the first one, when asking for all).
  async function request(only = null) {
    const now = status();
    const wanted = now.items.filter((i) => i.state !== 'granted' && (!only || i.id === only));
    wanted.sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));
    for (const item of wanted.filter((i) => i.state === 'ask')) await askOne(item.id);
    const after = status();
    const toSettings = after.items.find((i) => i.state === 'settings' && (!only || i.id === only) && wanted.some((w) => w.id === i.id && w.state === 'settings'));
    if (toSettings) openSettings(toSettings.id);
    return after;
  }

  return { status, request, openSettings };
}
