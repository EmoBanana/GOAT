import assert from 'node:assert/strict';
import test from 'node:test';
import { bringUp, frontTab, HOW_TO, placeToOpen, SHOW_ME } from '../lib/open-place.js';

const ide = { app: 'Antigravity IDE', title: 'main.js — goat' };
const edge = (title, url = '') => ({ app: 'Microsoft Edge', title, url, pid: 7 });

test('asking to be shown counts wherever it comes in the question', () => {
  for (const q of [
    'show me how to search on google',
    'Can you show me how to search on Google?',
    'Okay, so can you show me how to search on Google?',
    'how do I search on google? show me',
    'I want to search on google, show me how',
    'could you please show us where the share button is',
    'Hey GOAT, show me how to export',
    'walk me through closing an issue',
    'take me to gmail',
    'point me to the export button',
    'I want a visual guide for sharing a google doc',
  ]) {
    assert.match(q, SHOW_ME, q);
    assert.match(q, HOW_TO, q);
  }
  // Plain how-to and where-is questions can still be guided on the app in front, but open nothing.
  for (const q of ['how do I search on google', 'where is the share button in google docs', "where's the filter", 'where to find the export button']) {
    assert.doesNotMatch(q, SHOW_ME, q);
    assert.match(q, HOW_TO, q);
  }
  for (const q of ['why do issues need a photo?', 'what is google', 'I showed my manager the deck', 'what does this show?']) {
    assert.doesNotMatch(q, SHOW_ME, q);
    assert.doesNotMatch(q, HOW_TO, q);
  }
});

test('GOAT opens the app or website a show-me question names, unless it is already in front', () => {
  const open = (q, ctx = ide) => placeToOpen(q, ctx)?.name ?? null;
  assert.equal(open('show me how to search on google'), 'Google');
  assert.equal(placeToOpen('show me how to search on google', ide).url, 'https://www.google.com/');
  assert.equal(open('how do I search on google? show me'), 'Google');
  assert.equal(open('show me how to search on google', {}), 'Google', 'even when GOAT could not tell what is in front');
  assert.equal(open('show me how to search on google', edge('Google - Microsoft Edge')), null);
  assert.equal(open('show me how to search on google', edge('gamuda - Google Search - Microsoft Edge')), null);
  assert.equal(open('show me how to search on google', edge('', 'https://www.google.com/')), null);
  assert.equal(open('show me how to search on google', edge('Issues - Autodesk Build')), 'Google', 'another page in the browser');
  assert.equal(open('how do I search on google'), null, 'only when asked to be shown');
  assert.equal(open('where is the excel file from yesterday'), null, 'a where-is question opens nothing');
  assert.equal(open('show me how to search'), null, 'nothing named: the app in front');
  assert.equal(open('show me how to share a google doc'), 'Google Docs');
  assert.equal(open('show me how to ask google gemini to summarise a report'), 'Gemini');
  assert.equal(open('show me how to add an event in google calendar'), 'Google Calendar');
  assert.equal(open('show me how to clear the cache in google chrome'), 'Google Chrome');
  assert.equal(open('show me where the edge of the slab is'), null, '"edge" alone is not the browser');
  assert.equal(open('show me how to perform search on Edge'), 'Microsoft Edge');
  assert.equal(open('show me how to perform search on Edge', edge('New tab - Microsoft Edge')), null, 'already in front: guided where it is');
  assert.equal(open('show me how to freeze the top row in excel'), 'Excel');
  assert.equal(placeToOpen('show me how to freeze the top row in excel', ide).app, 'Microsoft Excel');
  assert.equal(open('show me how to freeze the top row in excel', { app: 'Microsoft Excel', title: 'Schedule.xlsx' }), null);
  assert.equal(open('show me how to log an issue in forma', edge('Issues - Autodesk Build')), null);
  assert.equal(open('show me how to log an issue in forma'), 'Autodesk Build');
  assert.equal(open('show me how to turn on dark mode in system settings'), 'System Settings');
});

test('bringUp opens it, waits until it is in front, and gives it a moment to draw', async () => {
  const opened = [];
  const fronts = [ide, edge('Untitled - Microsoft Edge'), edge('Google - Microsoft Edge')];
  const slept = [];
  const front = await bringUp(placeToOpen('show me how to search on google', ide), {
    open: async (p) => opened.push(p.url),
    sample: async () => fronts.shift() || null,
    sleep: async (ms) => slept.push(ms),
  });
  assert.deepEqual(opened, ['https://www.google.com/']);
  assert.equal(front.title, 'Google - Microsoft Edge');
  assert.deepEqual(slept, [250, 250, 250, 700]);
});

test('a website is also up when the browser says its front tab shows it, whatever macOS names in front', async () => {
  const place = placeToOpen('show me how to search on google', ide);
  // After a typed ask GOAT's own overlay stays the app in front, so the window sample never shows the browser.
  const goat = { app: 'Electron', title: 'GOAT', pid: 1 };
  const tabs = [
    null, // the browser hasn't answered yet
    { app: 'Microsoft Edge', title: '', url: 'https://www.google.com/', loading: true, pid: 0 }, // no title yet: not drawn
    { app: 'Microsoft Edge', title: 'Google', url: 'https://www.google.com/', loading: true, pid: 0 }, // still loading: wait a little
    { app: 'Microsoft Edge', title: 'Google', url: 'https://www.google.com/', loading: false, pid: 0 },
  ];
  const brought = [];
  const front = await bringUp(place, { open: async () => {}, sample: async () => goat, tab: async () => tabs.shift(), activate: async (name) => brought.push(name), sleep: async () => {} });
  assert.deepEqual(front, { app: 'Microsoft Edge', title: 'Google', url: 'https://www.google.com/', pid: 0 });
  assert.deepEqual(brought, ['Microsoft Edge'], 'and the browser is brought forward');
  assert.equal(tabs.length, 0);

  // Already in front (its title just doesn't say so): nothing to bring forward.
  const again = [];
  const titled = await bringUp(place, {
    open: async () => {},
    sample: async () => edge('Sign in - Microsoft Edge'),
    tab: async () => ({ app: 'Microsoft Edge', title: 'Google', url: 'https://www.google.com/', loading: false, pid: 0 }),
    activate: async (name) => again.push(name),
    sleep: async () => {},
  });
  assert.equal(titled.app, 'Microsoft Edge');
  assert.deepEqual(again, []);

  // A page that never stops loading is taken once it has a title and a couple of seconds have gone.
  let asked = 0;
  const slow = await bringUp(place, {
    open: async () => {},
    sample: async () => goat,
    tab: async () => (asked++, { app: 'Microsoft Edge', title: 'Google', url: 'https://www.google.com/', loading: true, pid: 0 }),
    sleep: async () => {},
  });
  assert.equal(slow.title, 'Google');
  assert.equal(asked, 9);

  // Another page in the browser's front tab is not it; an app is never asked of the browser.
  const other = await bringUp(place, { open: async () => {}, sample: async () => goat, tab: async () => ({ app: 'Microsoft Edge', title: 'Inbox', url: 'https://mail.example.com/', loading: false, pid: 0 }), tries: 3, sleep: async () => {} });
  assert.equal(other, null);
  let tabReads = 0;
  const excel = await bringUp(placeToOpen('show me how to freeze the top row in excel', ide), { open: async () => {}, sample: async () => ide, tab: async () => (tabReads++, null), tries: 3, sleep: async () => {} });
  assert.equal(excel, null);
  assert.equal(tabReads, 0);
});

test('bringUp gives up when it never comes up, or cannot be opened', async () => {
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
  const flaky = await bringUp(placeToOpen('show me how to search on google', ide), {
    open: async () => {},
    sample: () => {
      throw new Error('osascript timed out');
    },
    tab: () => {
      throw new Error('not allowed');
    },
    tries: 2,
    sleep: async () => {},
  });
  assert.equal(flaky, null);
});

test("the browser's front tab comes back without its query, and tests read nothing real", async () => {
  const run = async () => JSON.stringify({ app: 'Microsoft Edge', url: 'https://www.google.com/search?q=secret#top', title: 'secret - Google Search', loading: false });
  assert.deepEqual(await frontTab({ env: {}, platform: 'darwin', run }), { app: 'Microsoft Edge', title: 'secret - Google Search', url: 'https://www.google.com/search', loading: false, pid: 0 });
  assert.equal(await frontTab({ env: {}, platform: 'darwin', run: async () => JSON.stringify({ app: 'Firefox', url: '', title: '' }) }), null, 'a browser GOAT cannot ask');
  assert.equal(await frontTab({ env: {}, platform: 'darwin', run: async () => '{}' }), null);
  assert.equal(await frontTab({ env: {}, platform: 'darwin', run: async () => Promise.reject(new Error('timed out')) }), null);
  const never = () => assert.fail('nothing real is read');
  assert.equal(await frontTab({ env: { GOAT_FAKE_OPENS: '' }, platform: 'darwin', run: never }), null);
  assert.equal(await frontTab({ env: { GOAT_FAKE_WINDOW: 'Revit|x' }, platform: 'darwin', run: never }), null);
  assert.equal(await frontTab({ env: {}, platform: 'win32', run: never }), null);
});
