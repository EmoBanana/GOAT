import assert from 'node:assert/strict';
import test from 'node:test';
import { parseFakeWindow, parseSample, sampleActiveWindow } from '../lib/active-window.js';

test('GOAT_FAKE_WINDOW="App|Title" overrides the sampler', async () => {
  assert.deepEqual(parseFakeWindow('Google Chrome|Forma Build - Issues'), { app: 'Google Chrome', title: 'Forma Build - Issues', url: '', pid: 0 });
  const sample = await sampleActiveWindow({ env: { GOAT_FAKE_WINDOW: 'Revit|ALP-GAM-ZZ-XX-M3-S-0001.rvt' }, run: () => assert.fail('should not run osascript') });
  assert.deepEqual(sample, { app: 'Revit', title: 'ALP-GAM-ZZ-XX-M3-S-0001.rvt', url: '', pid: 0 });
});

test('osascript output is parsed defensively', () => {
  assert.deepEqual(parseSample('{"app":"Keynote","title":"Pitch.key","pid":42}\n'), { app: 'Keynote', title: 'Pitch.key', pid: 42 });
  assert.deepEqual(parseSample('{"app":7}'), { app: '', title: '', pid: 0 });
  assert.equal(parseSample('execution error: not allowed'), null);
});

test('the sampler returns null when osascript fails or off macOS', async () => {
  assert.equal(await sampleActiveWindow({ env: {}, platform: 'darwin', run: async () => null }), null);
  assert.equal(await sampleActiveWindow({ env: {}, platform: 'linux', run: () => assert.fail('no osascript off macOS') }), null);
  const ok = await sampleActiveWindow({ env: {}, platform: 'darwin', run: async () => '{"app":"Safari","title":"Issues","pid":9}' });
  assert.deepEqual(ok, { app: 'Safari', title: 'Issues', pid: 9 });
});
