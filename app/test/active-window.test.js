import assert from 'node:assert/strict';
import test from 'node:test';
import { parseFakeWindow, parseSample, sampleActiveWindow, siteOf } from '../lib/active-window.js';

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

test('an ask still learns which app is in front when the title read is too slow', async () => {
  const scripts = [];
  const run = async (_command, args) => {
    scripts.push(args[3]);
    return scripts.length === 1 ? null : '{"app":"Antigravity IDE","title":"","pid":42}';
  };
  assert.deepEqual(await sampleActiveWindow({ env: {}, platform: 'darwin', run }), { app: 'Antigravity IDE', title: '', pid: 42 });
  assert.equal(scripts.length, 2);
  assert.doesNotMatch(scripts[1], /System Events/, 'the second read is NSWorkspace only');
  // Tracking keeps to its allowlist: no second read, the sample is simply missed.
  let calls = 0;
  assert.equal(await sampleActiveWindow({ env: {}, platform: 'darwin', run: async () => (calls++, null), allow: ['Revit'] }), null);
  assert.equal(calls, 1);
});

test('with an allowlist, titles of other apps are blanked and the list reaches the sampler', async () => {
  let argsSeen = null;
  const run = async (_cmd, args) => {
    argsSeen = args;
    return '{"app":"Spotify","title":"Song name","pid":3}';
  };
  const s = await sampleActiveWindow({ env: {}, platform: 'darwin', run, allow: ['Revit'] });
  assert.deepEqual(s, { app: 'Spotify', title: '', pid: 3 });
  assert.equal(argsSeen.at(-1), '["Revit"]');
  const fake = await sampleActiveWindow({ env: { GOAT_FAKE_WINDOW: 'Spotify|Song' }, allow: ['Revit'] });
  assert.equal(fake.title, '');
});

test('tracking asks for the site: a browser address comes back as its site name only', async () => {
  let argsSeen = null;
  const run = async (_cmd, args) => {
    argsSeen = args;
    return '{"app":"Google Chrome","title":"GOAT pitch","pid":5,"url":"https://www.canva.com/design/x/edit?y=1"}';
  };
  const s = await sampleActiveWindow({ env: {}, platform: 'darwin', run, allow: ['Google Chrome'], site: true });
  assert.deepEqual(s, { app: 'Google Chrome', title: 'GOAT pitch', pid: 5, site: 'canva.com' });
  assert.deepEqual(argsSeen.slice(-2), ['["Google Chrome"]', 'site']);
  await sampleActiveWindow({ env: {}, platform: 'darwin', run, allow: ['Google Chrome'] });
  assert.equal(argsSeen.at(-1), '["Google Chrome"]', 'the ask never reads the address');

  const other = await sampleActiveWindow({ env: {}, platform: 'darwin', run: async () => '{"app":"Spotify","title":"Song","pid":3,"url":"https://open.spotify.com/x"}', allow: ['Revit'], site: true });
  assert.deepEqual(other, { app: 'Spotify', title: '', pid: 3 }, 'nothing from apps off the list');
  const fake = await sampleActiveWindow({ env: { GOAT_FAKE_WINDOW: 'Google Chrome|Forms|https://acc.autodesk.com/build/forms?x=1' }, site: true });
  assert.equal(fake.site, 'acc.autodesk.com');

  assert.equal(siteOf('chrome://newtab/'), '');
  assert.equal(siteOf('file:///Users/me/x.pdf'), '');
  assert.equal(siteOf('not a url'), '');
  assert.equal(siteOf('http://127.0.0.1:8402/account/?code=1'), '127.0.0.1');
});
