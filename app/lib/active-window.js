import { execFile } from 'node:child_process';

// The frontmost app and its focused window title. The ask hotkey samples once, before GOAT takes
// focus (never stored); timesheet tracking samples every interval, passing its allowlist so the
// titles of other apps are never even read.
// macOS: app and pid from NSWorkspace (no permission needed); the title from System Events,
// which needs Accessibility (and asks once to control System Events).
// Tracking also asks for the site: in a browser, the front tab's address, turned into its site
// name (canva.com) right here, so the address itself never leaves this module. That read is the
// same Apple Event the ask uses for the page (lib/doc-context.js): macOS asks once to let GOAT
// control the browser.
const JXA = `
function run(argv) {
  ObjC.import('AppKit');
  const front = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  const pid = front.processIdentifier;
  const app = ObjC.unwrap(front.localizedName) || '';
  const allow = argv.length && argv[0] ? JSON.parse(argv[0]) : null;
  if (allow && !allow.some(function (a) { return String(a).toLowerCase() === app.toLowerCase(); })) {
    return JSON.stringify({ app: app, title: '', pid: pid, allowed: false });
  }
  let title = '';
  try {
    const proc = Application('System Events').processes.whose({ unixId: pid })[0];
    try { title = proc.attributes.byName('AXFocusedWindow').value().name() || ''; } catch (e) {}
    if (!title) { try { title = proc.windows[0].name() || ''; } catch (e) {} }
  } catch (e) {}
  let url = '';
  if (argv[1] === 'site') {
    try {
      if (app === 'Safari') {
        const s = Application('Safari');
        if (s.documents.length) url = s.documents[0].url() || '';
      } else if (['Google Chrome', 'Microsoft Edge', 'Brave Browser', 'Arc', 'Chromium'].indexOf(app) >= 0) {
        const b = Application(app);
        if (b.windows.length) url = b.windows[0].activeTab().url() || '';
      }
    } catch (e) {}
  }
  return JSON.stringify({ app: app, title: title || '', pid: pid, url: url });
}
`;

// The app in front and its pid alone: NSWorkspace only, so no permission and no System Events.
const JXA_APP = `
function run() {
  ObjC.import('AppKit');
  const front = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  return JSON.stringify({ app: ObjC.unwrap(front.localizedName) || '', title: '', pid: front.processIdentifier });
}
`;

// A tab's site: the host name only ("https://www.canva.com/design/x?y=1" -> "canva.com").
export function siteOf(url) {
  try {
    const u = new URL(String(url || ''));
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname.toLowerCase().replace(/^www\./, '') : '';
  } catch {
    return '';
  }
}

// Windows (untested): user32 GetForegroundWindow / GetWindowText through PowerShell.
const POWERSHELL = `
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public class GoatWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
"@
$h = [GoatWin]::GetForegroundWindow(); $sb = New-Object System.Text.StringBuilder 512
[void][GoatWin]::GetWindowText($h, $sb, 512); $id = 0; [void][GoatWin]::GetWindowThreadProcessId($h, [ref]$id)
$p = Get-Process -Id $id -ErrorAction SilentlyContinue
@{ app = "$($p.ProcessName)"; title = $sb.ToString(); pid = [int]$id } | ConvertTo-Json -Compress
`;

export function parseFakeWindow(value) {
  const [app = '', title = '', url = ''] = String(value).split('|');
  return { app: app.trim(), title: title.trim(), url: url.trim(), pid: 0 };
}

// A browser's address comes back as its site name only.
export function parseSample(stdout) {
  try {
    const raw = JSON.parse(String(stdout).trim());
    const site = siteOf(raw.url);
    return {
      app: typeof raw.app === 'string' ? raw.app : '',
      title: typeof raw.title === 'string' ? raw.title : '',
      pid: Number.isInteger(raw.pid) ? raw.pid : 0,
      ...(site ? { site } : {}),
    };
  } catch {
    return null;
  }
}

const allowed = (app, allow) => !allow || allow.some((a) => String(a).toLowerCase() === String(app).toLowerCase());

function runCommand(command, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => resolve(err ? null : stdout));
  });
}

// Resolves to { app, title, pid, site? } or null; never rejects. allow: app names whose titles
// may be read (null = any, for the ask hotkey). site: also the browser tab's site name (tracking).
// GOAT_FAKE_WINDOW="App|Title|URL" overrides it for tests.
export async function sampleActiveWindow({ env = process.env, platform = process.platform, run = runCommand, timeoutMs = 1500, allow = null, site = false } = {}) {
  let sample;
  if (env.GOAT_FAKE_WINDOW) {
    sample = parseFakeWindow(env.GOAT_FAKE_WINDOW);
    if (site && siteOf(sample.url)) sample.site = siteOf(sample.url);
  } else if (platform === 'darwin') {
    const args = site ? [allow ? JSON.stringify(allow) : '', 'site'] : allow ? [JSON.stringify(allow)] : [];
    const stdout = await run('osascript', ['-l', 'JavaScript', '-e', JXA, ...args], timeoutMs);
    sample = stdout ? parseSample(stdout) : null;
    // System Events can take about a second when it has been idle (0.94 s measured, against the
    // ask's 0.7 s). For an ask, the app and pid alone still say what's in front, so a slow title
    // doesn't cost both: without them GOAT has no controls to read and answers in words.
    if (!sample && !allow && !site) {
      const quick = await run('osascript', ['-l', 'JavaScript', '-e', JXA_APP], 1500);
      sample = quick ? parseSample(quick) : null;
    }
  } else if (platform === 'win32') {
    const stdout = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', POWERSHELL], timeoutMs);
    sample = stdout ? parseSample(stdout) : null;
  } else {
    return null;
  }
  if (sample && !allowed(sample.app, allow)) {
    sample.title = ''; // belt and braces
    delete sample.site;
  }
  return sample;
}
