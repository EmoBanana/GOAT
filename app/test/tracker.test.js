import assert from 'node:assert/strict';
import test from 'node:test';
import { createTracker } from '../lib/tracker.js';

function harness() {
  const sent = [];
  const allowSeen = [];
  let timerFn = null;
  let window = { app: 'Revit', title: 'ALP-GAM-ZZ-XX-M3-S-0001.rvt', pid: 42 };
  let idle = 0;
  let down = false;
  const tracker = createTracker({
    sample: async (allow) => {
      allowSeen.push(allow);
      return window;
    },
    send: async (samples) => {
      if (down) return { error: 'server_unreachable', message: 'down' };
      sent.push(samples);
      return { stored: samples.length };
    },
    getConfig: async () => ({ trackedApps: ['Revit', 'Google Chrome'] }),
    intervalMs: 10_000,
    idleSec: 300,
    idleSeconds: () => idle,
    batchSize: 6,
    selfPid: 99,
    now: () => Date.parse('2026-11-12T03:00:00Z'),
    setTimer: (fn) => {
      timerFn = fn;
      return 1;
    },
    clearTimer: () => {
      timerFn = null;
    },
    logger: { warn() {} },
  });
  return {
    tracker,
    sent,
    allowSeen,
    tick: async () => {
      timerFn();
      await tracker.tick();
    },
    show: (w) => {
      window = w;
    },
    setIdle: (s) => {
      idle = s;
    },
    setDown: (d) => {
      down = d;
    },
    hasTimer: () => timerFn !== null,
  };
}

test('tracking is off until started; start samples right away with the allowlist', async () => {
  const h = harness();
  assert.equal(h.tracker.tracking, false);
  assert.equal(await h.tracker.start(), true);
  assert.equal(await h.tracker.start(), false);
  assert.equal(h.tracker.tracking, true);
  assert.equal(h.tracker.queued, 1);
  assert.deepEqual(h.allowSeen[0], ['Revit', 'Google Chrome'], 'the sampler only reads titles of these apps');
});

test('samples go to the server in batches of 6', async () => {
  const h = harness();
  await h.tracker.start();
  for (let i = 0; i < 5; i += 1) await h.tick();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].length, 6);
  assert.deepEqual(h.sent[0][0], { ts: '2026-11-12T03:00:00.000Z', app: 'Revit', title: 'ALP-GAM-ZZ-XX-M3-S-0001.rvt', idle: false, sec: 10 });
  assert.equal(h.tracker.queued, 0);
});

test("GOAT's own window and apps off the allowlist are skipped; idle time is flagged", async () => {
  const h = harness();
  await h.tracker.start();
  h.show({ app: 'Electron', title: 'GOAT', pid: 99 });
  await h.tick();
  h.show({ app: 'Spotify', title: 'Song', pid: 7 });
  await h.tick();
  h.show({ app: 'google chrome', title: 'BRAVO - Forma', pid: 8 });
  h.setIdle(301);
  await h.tick();
  assert.equal(h.tracker.queued, 2);
  await h.tracker.stop();
  assert.deepEqual(
    h.sent[0].map((s) => [s.app, s.idle]),
    [['Revit', false], ['google chrome', true]],
  );
});

test('stop flushes what is queued; failed sends are kept and retried', async () => {
  const h = harness();
  await h.tracker.start();
  await h.tick();
  h.setDown(true);
  const reply = await h.tracker.stop();
  assert.equal(reply.error, 'server_unreachable');
  assert.equal(h.tracker.tracking, false);
  assert.equal(h.hasTimer(), false);
  assert.equal(h.tracker.queued, 2, 'nothing is lost when the server is down');
  h.setDown(false);
  await h.tracker.flush();
  assert.equal(h.sent.flat().length, 2);
  assert.equal(h.tracker.queued, 0);
});

test('a browser sample carries its site name, never the address', async () => {
  const h = harness();
  await h.tracker.start();
  h.show({ app: 'Google Chrome', title: 'GOAT pitch - Presentation', site: 'canva.com', url: 'https://www.canva.com/design/x/edit?y=1', pid: 8 });
  await h.tick();
  await h.tracker.stop();
  const sample = h.sent.flat().at(-1);
  assert.equal(sample.site, 'canva.com');
  assert.equal('url' in sample, false);
});

test('note() adds a GOAT guide used while tracking, and nothing when tracking is off', async () => {
  const h = harness();
  assert.equal(h.tracker.note({ guide: 'Create a form', app: 'Google Chrome' }), false, 'not tracking');
  await h.tracker.start();
  assert.equal(h.tracker.note({ guide: '  ' }), false);
  assert.equal(h.tracker.note({ guide: 'Create a form', app: 'Google Chrome' }), true);
  await h.tracker.stop();
  assert.deepEqual(h.sent.flat().filter((s) => s.kind), [{ ts: '2026-11-12T03:00:00.000Z', kind: 'guide', guide: 'Create a form', app: 'Google Chrome' }]);
  assert.equal(h.tracker.note({ guide: 'Later' }), false, 'off again');
});
