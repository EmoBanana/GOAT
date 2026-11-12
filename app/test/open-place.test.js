import assert from 'node:assert/strict';
import test from 'node:test';
import { bringUp, placeToOpen, SHOW_ME } from '../lib/open-place.js';

const ide = { app: 'Antigravity IDE', title: 'main.js — goat' };
const edge = (title, url = '') => ({ app: 'Microsoft Edge', title, url, pid: 7 });

test('show-me questions are the ones that ask to see it on screen', () => {
  for (const q of [
    'show me how to search on google',
    'Can you show me how to search on Google?',
    'please show me where the share button is',
    'Hey GOAT, show me how to export',
    'where is the share button in google docs',
    "where's the filter",
    'walk me through closing an issue',
    'take me to gmail',
    'point me to the export button',
  ]) {
    assert.match(q, SHOW_ME, q);
  }
  for (const q of ['how do I search on google', 'why do issues need a photo?', 'what is google', 'I want to show my manager the deck']) assert.doesNotMatch(q, SHOW_ME, q);
});

test('GOAT opens the app or website a show-me question names, unless it is already in front', () => {
  const open = (q, ctx = ide) => placeToOpen(q, ctx)?.name ?? null;
  assert.equal(open('show me how to search on google'), 'Google');
  assert.equal(placeToOpen('show me how to search on google', ide).url, 'https://www.google.com/');
  assert.equal(open('show me how to search on google', edge('Google')), null);
  assert.equal(open('show me how to search on google', edge('gamuda - Google Search')), null);
  assert.equal(open('show me how to search on google', edge('', 'https://www.google.com/')), null);
  assert.equal(open('show me how to search on google', edge('Issues - Autodesk Build')), 'Google', 'another page in the browser');
  assert.equal(open('how do I search on google'), null, 'only when asked to be shown');
  assert.equal(open('show me how to search'), null, 'nothing named: the app in front');
  assert.equal(open('show me how to share a google doc'), 'Google Docs');
  assert.equal(open('show me how to clear the cache in google chrome'), 'Google Chrome');
  assert.equal(open('show me where the edge of the slab is'), null, '"edge" alone is not the browser');
  assert.equal(open('show me how to freeze the top row in excel'), 'Excel');
  assert.equal(placeToOpen('show me how to freeze the top row in excel', ide).app, 'Microsoft Excel');
  assert.equal(open('show me how to freeze the top row in excel', { app: 'Microsoft Excel', title: 'Schedule.xlsx' }), null);
  assert.equal(open('show me how to log an issue in forma', edge('Issues - Autodesk Build')), null);
  assert.equal(open('show me how to log an issue in forma'), 'Autodesk Build');
  assert.equal(open('show me how to turn on dark mode in system settings'), 'System Settings');
  assert.equal(open('Can you show me how to search on Google?'), 'Google');
});

test('bringUp opens it, waits until it is in front, and gives it a moment to draw', async () => {
  const opened = [];
  const fronts = [ide, edge('New Tab'), edge('Google')];
  const slept = [];
  const front = await bringUp(placeToOpen('show me how to search on google', ide), {
    open: async (p) => opened.push(p.url),
    sample: async () => fronts.shift() || null,
    sleep: async (ms) => slept.push(ms),
  });
  assert.deepEqual(opened, ['https://www.google.com/']);
  assert.equal(front.title, 'Google');
  assert.deepEqual(slept, [250, 250, 250, 700]);
});

test('bringUp gives up when it never comes to the front, or cannot be opened', async () => {
  const place = placeToOpen('show me how to freeze the top row in excel', ide);
  let samples = 0;
  const never = await bringUp(place, { open: async () => {}, sample: async () => (samples++, ide), tries: 5, sleep: async () => {} });
  assert.equal(never, null);
  assert.equal(samples, 5);
  samples = 0;
  const missing = await bringUp(place, {
    open: async () => {
      throw new Error('Unable to find application named Microsoft Excel');
    },
    sample: async () => (samples++, ide),
    sleep: async () => {},
  });
  assert.equal(missing, null);
  assert.equal(samples, 0, 'no waiting for an app that did not open');
  const flaky = await bringUp(place, {
    open: async () => {},
    sample: () => {
      throw new Error('osascript timed out');
    },
    tries: 2,
    sleep: async () => {},
  });
  assert.equal(flaky, null);
});
