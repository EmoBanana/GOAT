import { execFile } from 'node:child_process';

// The frontmost app and its focused window title. The ask hotkey calls this once, before GOAT
// takes focus; the sample is only sent with that question and never stored.
// macOS: app and pid from NSWorkspace (no permission needed); the title from System Events,
// which needs Accessibility (and asks once for Automation of System Events).
const JXA = `
ObjC.import('AppKit');
const front = $.NSWorkspace.sharedWorkspace.frontmostApplication;
const pid = front.processIdentifier;
const app = ObjC.unwrap(front.localizedName) || '';
let title = '';
try {
  const proc = Application('System Events').processes.whose({ unixId: pid })[0];
  try { title = proc.attributes.byName('AXFocusedWindow').value().name() || ''; } catch (e) {}
  if (!title) { try { title = proc.windows[0].name() || ''; } catch (e) {} }
} catch (e) {}
JSON.stringify({ app: app, title: title || '', pid: pid });
`;

export function parseFakeWindow(value) {
  const [app = '', title = '', url = ''] = String(value).split('|');
  return { app: app.trim(), title: title.trim(), url: url.trim(), pid: 0 };
}

export function parseSample(stdout) {
  try {
    const raw = JSON.parse(String(stdout).trim());
    return {
      app: typeof raw.app === 'string' ? raw.app : '',
      title: typeof raw.title === 'string' ? raw.title : '',
      pid: Number.isInteger(raw.pid) ? raw.pid : 0,
    };
  } catch {
    return null;
  }
}

function runOsascript(script, timeoutMs) {
  return new Promise((resolve) => {
    execFile('osascript', ['-l', 'JavaScript', '-e', script], { timeout: timeoutMs }, (err, stdout) => {
      resolve(err ? null : stdout);
    });
  });
}

// Resolves to { app, title, pid } or null; never rejects. GOAT_FAKE_WINDOW="App|Title" for tests.
export async function sampleActiveWindow({ env = process.env, platform = process.platform, run = runOsascript, timeoutMs = 1500 } = {}) {
  if (env.GOAT_FAKE_WINDOW) return parseFakeWindow(env.GOAT_FAKE_WINDOW);
  if (platform !== 'darwin') return null; // Windows sampler comes with timesheet tracking.
  const stdout = await run(JXA, timeoutMs);
  return stdout ? parseSample(stdout) : null;
}
