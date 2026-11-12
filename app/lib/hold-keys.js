import { spawn } from 'node:child_process';

// Push-to-talk: hold Option+Cmd (no letter key) to talk, let go to send. Electron's
// globalShortcut needs a letter key, so a small JXA helper polls macOS's modifier state. It
// reads only which modifiers are down (Option, Cmd, Ctrl, Shift), never keystrokes, and prints
// "down" or "up". A heartbeat line every 2 s makes it exit if GOAT goes away (broken pipe).
// A 150 ms hold is needed, so Option+Cmd shortcuts like Option+Cmd+H rarely trigger it, and
// any that do record no speech and are dropped.
export const HOLD_SCRIPT = `
ObjC.import('AppKit');
const OPT = 1 << 19, CMD = 1 << 20, CTRL = 1 << 18, SHIFT = 1 << 17;
let held = false, since = 0, n = 0;
console.log('ready');
while (true) {
  const f = $.NSEvent.modifierFlags;
  const combo = (f & OPT) && (f & CMD) && !(f & CTRL) && !(f & SHIFT);
  if (combo && !held) { if (!since) since = Date.now(); if (Date.now() - since >= 150) { held = true; console.log('down'); } }
  if (!combo) { since = 0; if (held) { held = false; console.log('up'); } }
  if (++n % 50 === 0) console.log('tick');
  delay(0.04);
}
`;

// Lines from the helper -> 'down' | 'up' events (ready and tick lines are ignored).
export function createLineReader(onLine) {
  let buffer = '';
  return (chunk) => {
    buffer += String(chunk);
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) onLine(line);
    }
  };
}

export function startHoldKeys({ onDown, onUp, spawnImpl = spawn, platform = process.platform, logger = console } = {}) {
  if (platform !== 'darwin') return { stop() {} };
  let stopped = false;
  const child = spawnImpl('osascript', ['-l', 'JavaScript', '-e', HOLD_SCRIPT], { stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr.on(
    'data',
    createLineReader((line) => {
      if (line === 'down') onDown();
      else if (line === 'up') onUp();
      else if (line !== 'tick' && line !== 'ready') logger.warn(`[hold-keys] ${line.slice(0, 200)}`);
    }),
  );
  child.on('error', (err) => logger.warn(`[hold-keys] couldn't start the Option+Cmd helper: ${err.message}`));
  child.on('exit', (code) => {
    if (!stopped) logger.warn(`[hold-keys] the Option+Cmd helper stopped (${code}); Ctrl+Option+V still works.`);
  });
  return {
    stop() {
      stopped = true;
      child.kill();
    },
  };
}
