import { spawn } from 'node:child_process';
import { createLineReader } from './hold-keys.js';

// Clicks for guide steps: a step that says "Click Filters" waits for the user to click it. The
// overlay lets clicks through to the app below, so it never sees them; a small JXA helper polls
// the system-wide mouse-button state instead (CoreGraphics' CGEventSourceButtonState: whether the
// left button is down, no event tap, no permission, never keystrokes) and prints "down" on each
// left press. Main reads the pointer then. It runs only while a guide waits for a click. A
// heartbeat line every 2 s makes it exit if GOAT goes away (broken pipe).
export const CLICK_SCRIPT = `
ObjC.import('CoreGraphics');
// kCGEventSourceStateCombinedSessionState (0), kCGMouseButtonLeft (0)
const left = () => Boolean($.CGEventSourceButtonState(0, 0));
let was = left(), n = 0;
console.log('ready');
while (true) {
  const down = left();
  if (down && !was) console.log('down');
  was = down;
  if (++n % 130 === 0) console.log('tick');
  delay(0.015);
}
`;

// { stop() }: onClick() runs on each left press while it's running. Off macOS it never starts.
export function watchClicks({ onClick, spawnImpl = spawn, platform = process.platform, logger = console } = {}) {
  if (platform !== 'darwin') return null;
  let stopped = false;
  const child = spawnImpl('osascript', ['-l', 'JavaScript', '-e', CLICK_SCRIPT], { stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr.on(
    'data',
    createLineReader((line) => {
      if (line === 'down') onClick();
      else if (line !== 'tick' && line !== 'ready') logger.warn(`[clicks] ${line.slice(0, 200)}`);
    }),
  );
  child.on('error', (err) => logger.warn(`[clicks] couldn't start the click helper: ${err.message}`));
  child.on('exit', (code) => {
    if (!stopped) logger.warn(`[clicks] the click helper stopped (${code})`);
  });
  return {
    stop() {
      stopped = true;
      child.kill();
    },
  };
}
