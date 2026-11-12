import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createLineReader, HOLD_SCRIPT, startHoldKeys } from '../lib/hold-keys.js';

test('helper output is read line by line, across chunk boundaries', () => {
  const lines = [];
  const read = createLineReader((l) => lines.push(l));
  read('rea');
  read('dy\ndo');
  read('wn\n\ntick\nup\n');
  assert.deepEqual(lines, ['ready', 'down', 'tick', 'up']);
});

test('Option+Cmd held and let go become onDown and onUp; other lines are ignored', () => {
  const events = [];
  const warnings = [];
  let args = null;
  const child = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), kill: () => events.push('killed') });
  const keys = startHoldKeys({
    platform: 'darwin',
    spawnImpl: (cmd, a) => {
      args = [cmd, ...a];
      return child;
    },
    onDown: () => events.push('down'),
    onUp: () => events.push('up'),
    logger: { warn: (m) => warnings.push(m) },
  });
  assert.equal(args[0], 'osascript');
  assert.deepEqual(args.slice(1, 4), ['-l', 'JavaScript', '-e']);
  child.stderr.emit('data', 'ready\ntick\ndown\n');
  child.stderr.emit('data', 'up\n');
  assert.deepEqual(events, ['down', 'up']);
  keys.stop();
  child.emit('exit', 0);
  assert.deepEqual(events, ['down', 'up', 'killed']);
  assert.deepEqual(warnings, [], 'stopping on purpose is not a warning');
});

test('the helper only looks at modifier flags, and needs a 150 ms hold', () => {
  assert.match(HOLD_SCRIPT, /NSEvent\.modifierFlags/);
  assert.doesNotMatch(HOLD_SCRIPT, /keyDown|CGEventTap|addGlobalMonitor/);
  assert.match(HOLD_SCRIPT, />= 150/);
  assert.deepEqual(startHoldKeys({ platform: 'win32', spawnImpl: () => assert.fail('no helper off macOS') }).stop(), undefined);
});
