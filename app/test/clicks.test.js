import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { CLICK_SCRIPT, watchClicks } from '../lib/clicks.js';

test('each left press the helper reports becomes onClick; stopping it is quiet', () => {
  const events = [];
  const warnings = [];
  let args = null;
  const child = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), kill: () => events.push('killed') });
  const watch = watchClicks({
    platform: 'darwin',
    spawnImpl: (cmd, a) => {
      args = [cmd, ...a];
      return child;
    },
    onClick: () => events.push('click'),
    logger: { warn: (m) => warnings.push(m) },
  });
  assert.deepEqual(args.slice(0, 4), ['osascript', '-l', 'JavaScript', '-e']);
  child.stderr.emit('data', 'ready\ndo');
  child.stderr.emit('data', 'wn\ntick\ndown\n');
  assert.deepEqual(events, ['click', 'click']);
  watch.stop();
  child.emit('exit', 0);
  assert.deepEqual(events, ['click', 'click', 'killed']);
  assert.deepEqual(warnings, [], 'stopping on purpose is not a warning');
});

test('the helper only reads whether the left button is down: no event tap, no keys; nothing off macOS', () => {
  assert.match(CLICK_SCRIPT, /CGEventSourceButtonState\(0, 0\)/);
  assert.doesNotMatch(CLICK_SCRIPT, /CGEventTap|addGlobalMonitor|keyDown|modifierFlags/);
  assert.match(CLICK_SCRIPT, /let was = left\(\)/, 'a button already down when it starts is not a click');
  assert.equal(watchClicks({ platform: 'win32', spawnImpl: () => assert.fail('no helper off macOS') }), null);
});
