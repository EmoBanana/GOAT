import { execFile } from 'node:child_process';

// The frontmost app and its focused window title. The ask hotkey samples once, before GOAT takes
// focus (never stored); timesheet tracking samples every interval, passing its allowlist so the
// titles of other apps are never even read.
// macOS: app and pid from NSWorkspace (no permission needed); the title from System Events,
// which needs Accessibility (and asks once to control System Events).
const JXA = `
function run(argv) {
  ObjC.import('AppKit');
  const front = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  const pid = front.processIdentifier;
  const app = ObjC.unwrap(front.localizedName) || '';
  const allow = argv.length ? JSON.parse(argv[0]) : null;
  if (allow && !allow.some(function (a) { return String(a).toLowerCase() === app.toLowerCase(); })) {
    return JSON.stringify({ app: app, title: '', pid: pid, allowed: false });
  }
  let title = '';
  try {
    const proc = Application('System Events').processes.whose({ unixId: pid })[0];
    try { title = proc.attributes.byName('AXFocusedWindow').value().name() || ''; } catch (e) {}
    if (!title) { try { title = proc.windows[0].name() || ''; } catch (e) {} }
  } catch (e) {}
  return JSON.stringify({ app: app, title: title || '', pid: pid });
}
`;

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

const allowed = (app, allow) => !allow || allow.some((a) => String(a).toLowerCase() === String(app).toLowerCase());

function runCommand(command, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => resolve(err ? null : stdout));
  });
}

// Resolves to { app, title, pid } or null; never rejects. allow: app names whose titles may be
// read (null = any, for the ask hotkey). GOAT_FAKE_WINDOW="App|Title" overrides it for tests.
export async function sampleActiveWindow({ env = process.env, platform = process.platform, run = runCommand, timeoutMs = 1500, allow = null } = {}) {
  let sample;
  if (env.GOAT_FAKE_WINDOW) {
    sample = parseFakeWindow(env.GOAT_FAKE_WINDOW);
  } else if (platform === 'darwin') {
    const stdout = await run('osascript', ['-l', 'JavaScript', '-e', JXA, ...(allow ? [JSON.stringify(allow)] : [])], timeoutMs);
    sample = stdout ? parseSample(stdout) : null;
  } else if (platform === 'win32') {
    const stdout = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', POWERSHELL], timeoutMs);
    sample = stdout ? parseSample(stdout) : null;
  } else {
    return null;
  }
  if (sample && !allowed(sample.app, allow)) sample.title = ''; // belt and braces
  return sample;
}
