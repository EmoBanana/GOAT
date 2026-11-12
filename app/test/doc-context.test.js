import assert from 'node:assert/strict';
import test from 'node:test';
import { deckDocument, deckText, documentHint, documentKind, MAX_TEXT, pageDocument, readDocument } from '../lib/doc-context.js';

test('GOAT reads decks in Keynote and pages in the browsers', () => {
  assert.equal(documentKind('Keynote'), 'deck');
  for (const app of ['Google Chrome', 'Microsoft Edge', 'Brave Browser', 'Arc', 'Safari']) assert.equal(documentKind(app), 'page', app);
  for (const app of ['Revit', 'Terminal', 'Microsoft PowerPoint', '']) assert.equal(documentKind(app), null, app);
});

test('a deck becomes text slide by slide: titles, text, notes, and the slide on screen', () => {
  const doc = deckDocument(
    {
      title: 'GOAT pitch',
      current: 2,
      total: 3,
      slides: [
        { title: 'GOAT', body: 'An on-screen guide', texts: ['GOAT', 'An on-screen guide', 'Gamuda'], notes: 'Say hello', skipped: false },
        { title: 'Problem', body: 'Engineers  waste hours', texts: [], notes: '', skipped: false },
        { title: 'Old slide', body: '', texts: [], notes: '', skipped: true },
      ],
    },
    'Keynote',
  );
  assert.deepEqual({ ...doc, text: null }, { kind: 'deck', app: 'Keynote', title: 'GOAT pitch', slides: 3, current: 2, text: null });
  assert.equal(
    doc.text,
    'Slide 1: GOAT\nAn on-screen guide\nGamuda\nNotes: Say hello\n\nSlide 2 (on screen): Problem\nEngineers waste hours\n\nSlide 3 (skipped): Old slide',
  );
});

test('a long deck keeps the slides nearest the one on screen, in order', () => {
  const slides = Array.from({ length: 40 }, (_, i) => ({ title: `S${i + 1}`, body: 'x'.repeat(400) }));
  const text = deckText(slides, 30, 3000);
  assert.ok(text.length <= 3000);
  assert.match(text, /Slide 30 \(on screen\): S30/);
  assert.doesNotMatch(text, /Slide 1: S1\n/);
  const order = [...text.matchAll(/Slide (\d+)/g)].map((m) => Number(m[1]));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
});

test('a page keeps its text tidy and its URL without the query', () => {
  const doc = pageDocument(
    { title: 'Issues - Autodesk Build', url: 'https://acc.autodesk.com/build/issues?projectId=secret#top', text: 'Issues\n\n\n\nRaised by   Pat\t\tOpen' },
    'Google Chrome',
  );
  assert.deepEqual(doc, { kind: 'page', app: 'Google Chrome', title: 'Issues - Autodesk Build', url: 'https://acc.autodesk.com/build/issues', text: 'Issues\n\nRaised by Pat Open' });
  assert.equal(pageDocument({ text: 'y'.repeat(MAX_TEXT * 2) }, 'Safari').text.length, MAX_TEXT);
});

test('reading asks the app in front, and says how to fix a refusal', async () => {
  const seen = [];
  const run = async (script, args) => {
    seen.push([/Keynote/.test(script) ? 'keynote' : 'browser', args]);
    return JSON.stringify({ title: 'Issues', url: 'https://x.test/a?b=1', text: 'Body text' });
  };
  const page = await readDocument({ app: 'Google Chrome', env: {}, run });
  assert.deepEqual(seen, [['browser', ['Google Chrome']]]);
  assert.equal(page.text, 'Body text');
  assert.equal(page.url, 'https://x.test/a');
  assert.equal(await readDocument({ app: 'Revit', env: {}, run }), null, 'only decks and pages');

  const off = await readDocument({ app: 'Google Chrome', env: {}, run: async () => JSON.stringify({ title: 't', url: 'u', error: 'js_off' }) });
  assert.deepEqual(off, { kind: 'page', app: 'Google Chrome', error: 'js_off' });
  assert.match(documentHint(off), /View › Developer › Allow JavaScript from Apple Events/);
  assert.match(documentHint({ kind: 'page', app: 'Safari', error: 'js_off' }), /Develop › Allow JavaScript from Apple Events/);

  const denied = await readDocument({
    app: 'Keynote',
    env: {},
    run: async () => {
      throw new Error('execution error: Not authorized to send Apple events to Keynote. (-1743)');
    },
  });
  assert.deepEqual(denied, { kind: 'deck', app: 'Keynote', error: 'not_allowed' });
  assert.match(documentHint(denied), /Privacy & Security › Automation/);
});

test('tests never read real apps: GOAT_FAKE_DOC stands in, and a faked window reads nothing', async () => {
  const run = async () => {
    throw new Error('a real app was asked');
  };
  const fake = JSON.stringify({ kind: 'page', title: 'Fake', url: 'https://fake.test/', text: 'Fake page' });
  assert.equal((await readDocument({ app: 'Google Chrome', env: { GOAT_FAKE_DOC: fake }, run })).text, 'Fake page');
  assert.equal(await readDocument({ app: 'Google Chrome', env: { GOAT_FAKE_DOC: '' }, run }), null);
  assert.equal(await readDocument({ app: 'Google Chrome', env: { GOAT_FAKE_WINDOW: 'Google Chrome|x' }, run }), null);
});
