import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { AUTOMATED_APPS, createPermissions, SETTINGS_URLS } from '../lib/permissions.js';

// A Mac (or Windows PC) that answers like Electron's systemPreferences, and records what GOAT did.
function fakeMac({ trusted = false, mic = 'not-determined', screen = 'denied', automation = { 'System Events': 'granted' } } = {}) {
  const calls = [];
  const state = { trusted, mic, screen };
  const prefs = {
    isTrustedAccessibilityClient: (prompt) => {
      if (prompt) calls.push(`accessibility:${prompt}`);
      return state.trusted;
    },
    getMediaAccessStatus: (kind) => (kind === 'microphone' ? state.mic : state.screen),
    askForMediaAccess: async (kind) => {
      calls.push(`ask:${kind}`);
      state.mic = 'granted';
      return true;
    },
  };
  const capturer = {
    getSources: async (opts) => {
      calls.push(`capture:${opts.types.join()}`);
      return [];
    },
  };
  const shell = { openExternal: (url) => calls.push(`open:${url}`) };
  const run = async (script, args) => {
    calls.push(`jxa:${args.join('|')}`);
    return JSON.stringify(automation);
  };
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'goat-perms-')), 'permissions.json');
  return { calls, state, prefs, capturer, shell, run, file: () => file, path: file };
}

test('a new Mac: every permission can be asked for, and the card is wanted in a downloaded app', () => {
  const mac = fakeMac();
  const p = createPermissions({ platform: 'darwin', ...mac, enabled: true });
  const s = p.status();
  assert.equal(s.ask, true);
  assert.equal(s.needed, true);
  assert.deepEqual(s.items.map((i) => [i.id, i.state]), [
    ['accessibility', 'ask'],
    ['screen', 'ask'],
    ['microphone', 'ask'],
    ['automation', 'ask'],
  ]);
  assert.match(s.note, /Allow JavaScript from Apple Events/);
  assert.equal(createPermissions({ platform: 'darwin', ...mac }).status().ask, false, 'not in a dev run unless asked for');
});

test('Allow all brings up each prompt once, in order, and remembers what it asked', async () => {
  const mac = fakeMac();
  const p = createPermissions({ platform: 'darwin', ...mac, enabled: true });
  const after = await p.request();
  assert.deepEqual(mac.calls, ['ask:microphone', 'capture:screen', `jxa:${AUTOMATED_APPS.join('|')}`, 'accessibility:true']);
  const byId = Object.fromEntries(after.items.map((i) => [i.id, i.state]));
  assert.equal(byId.microphone, 'granted');
  assert.equal(byId.automation, 'granted', 'System Events said yes');
  // macOS asks only once: what's still off now needs System Settings.
  assert.equal(byId.screen, 'settings');
  assert.equal(byId.accessibility, 'settings');
  const saved = JSON.parse(fs.readFileSync(mac.path, 'utf8'));
  assert.ok(saved.asked.screen && saved.asked.accessibility && saved.asked.microphone);
  assert.equal(saved.automation['System Events'], 'granted');
  assert.ok(!mac.calls.some((c) => c.startsWith('open:')), "it doesn't open Settings on top of the prompts it just showed");
});

test('asking again opens System Settings at the top row still off; one row opens its own page', async () => {
  const mac = fakeMac();
  const p = createPermissions({ platform: 'darwin', ...mac, enabled: true });
  await p.request();
  mac.calls.length = 0;
  await p.request();
  assert.deepEqual(mac.calls, [`open:${SETTINGS_URLS.darwin.accessibility}`], "the top row that is still off");
  mac.calls.length = 0;
  assert.deepEqual(p.openSettings("screen"), { ok: true });
  assert.deepEqual(mac.calls, [`open:${SETTINGS_URLS.darwin.screen}`]);
  assert.equal(p.openSettings('camera').error, 'unknown_permission');
});

test('once everything is on, nothing is needed and no card shows', async () => {
  const mac = fakeMac({ trusted: true, mic: 'granted', screen: 'granted' });
  const p = createPermissions({ platform: 'darwin', ...mac, enabled: true });
  await p.request('automation');
  const s = p.status();
  assert.equal(s.needed, false);
  assert.ok(s.items.every((i) => i.state === 'granted'));
});

test('a refused microphone or System Events needs System Settings', async () => {
  const mac = fakeMac({ mic: 'denied', automation: { 'System Events': 'denied' } });
  const p = createPermissions({ platform: 'darwin', ...mac, enabled: true });
  assert.equal(p.status().items.find((i) => i.id === 'microphone').state, 'settings');
  await p.request('automation');
  assert.equal(p.status().items.find((i) => i.id === 'automation').state, 'settings');
});

test('Windows: only the microphone, and only Settings can switch it on', async () => {
  const pc = fakeMac({ mic: 'granted' });
  const p = createPermissions({ platform: 'win32', ...pc, enabled: true });
  assert.deepEqual(p.status().items.map((i) => [i.id, i.state]), [['microphone', 'granted']]);
  assert.equal(p.status().needed, false);
  pc.state.mic = 'denied';
  assert.equal(p.status().needed, true);
  await p.request();
  assert.deepEqual(pc.calls, [`open:${SETTINGS_URLS.win32.microphone}`], 'no prompt exists, so it opens Settings');
  assert.match(p.status().items[0].why, /Ctrl\+Alt\+V/);
});
