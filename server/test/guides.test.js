import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { slugify, toList } from '../src/guides/store.js';
import { startMockOllama } from './helpers/mock-ollama.js';
import { startTestServer } from './helpers/test-server.js';

const recorded = {
  title: 'Export a PDF in Bluebeam',
  triggers: 'export a pdf, save as pdf',
  intro: 'Two clicks. Follow the blue cursor.',
  apps: ['Bluebeam Revu'],
  steps: [
    { x: 40.4, y: 22, label: 'File', say: 'Open the File menu.' },
    { x: '120', y: '300', label: 'Export' },
  ],
};

describe('guides API', () => {
  let ollama;
  let srv;
  before(async () => {
    ollama = await startMockOllama();
    srv = await startTestServer({ ollamaUrl: ollama.url });
  });
  after(async () => {
    await srv.close();
    await ollama.close();
  });

  test('GET /api/guides lists the shipped guides', async () => {
    const r = await srv.request('GET', '/api/guides');
    assert.equal(r.status, 200);
    const ids = r.body.guides.map((g) => g.id);
    assert.ok(ids.includes('forma-log-issue'));
    assert.ok(ids.includes('pitch-deck-tour'));
    assert.equal(r.body.guides.find((g) => g.id === 'pitch-deck-tour').steps, 4);
  });

  test('GET /api/guides/:id returns the guide, or a JSON 404', async () => {
    const ok = await srv.request('GET', '/api/guides/pitch-deck-tour');
    assert.equal(ok.status, 200);
    assert.equal(ok.body.steps.length, 4);
    assert.ok(ok.body.steps.every((s) => s.waitMs >= 5000 && s.waitMs <= 6500));
    const missing = await srv.request('GET', '/api/guides/nope');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error, 'not_found');
  });

  test('a posted guide is saved to guides/<id>.json and is matchable straight away', async () => {
    const r = await srv.request('POST', '/api/guides', { body: recorded });
    assert.equal(r.status, 201);
    assert.equal(r.body.id, 'export-a-pdf-in-bluebeam');
    assert.deepEqual(r.body.triggers, ['export a pdf', 'save as pdf']);
    assert.deepEqual(r.body.steps[0], { x: 40, y: 22, label: 'File', say: 'Open the File menu.' });
    assert.deepEqual(r.body.steps[1], { x: 120, y: 300, label: 'Export', say: 'Export.' });

    const file = path.join(srv.guidesDir, 'export-a-pdf-in-bluebeam.json');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(saved.title, 'Export a PDF in Bluebeam');
    assert.equal(typeof saved.createdAt, 'number');

    const ask = await srv.request('POST', '/api/assist', { body: { question: 'How do I save as PDF?' } });
    assert.equal(ask.body.source, 'guide');
    assert.equal(ask.body.guide.id, 'export-a-pdf-in-bluebeam');
    assert.equal(ollama.chats().length, 0);
  });

  test('triggers can be an array; saving the same title replaces the guide', async () => {
    const r = await srv.request('POST', '/api/guides', {
      body: { ...recorded, triggers: ['export a pdf', ' print to pdf '], steps: [{ x: 1, y: 2, say: 'Only step.' }] },
    });
    assert.equal(r.status, 201);
    assert.deepEqual(r.body.triggers, ['export a pdf', 'print to pdf']);
    const g = await srv.request('GET', '/api/guides/export-a-pdf-in-bluebeam');
    assert.equal(g.body.steps.length, 1);
    assert.equal(g.body.steps[0].label, 'Step 1');
  });

  test('an invalid guide gets a 400 that says what is missing', async () => {
    const cases = [
      [{ ...recorded, title: '  ' }, /a title/],
      [{ ...recorded, triggers: ' , ' }, /trigger/],
      [{ ...recorded, steps: [] }, /at least one step/],
      [{ ...recorded, steps: [{ x: 'left', y: 10 }] }, /numeric x and y on step 1/],
      [{ ...recorded, steps: [{ x: 10 }] }, /numeric x and y on step 1/],
      [[1, 2], /JSON object/],
    ];
    for (const [body, pattern] of cases) {
      const r = await srv.request('POST', '/api/guides', { body });
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.body.error, 'invalid_guide');
      assert.match(r.body.message, pattern);
    }
  });
});

test('a broken guide file is skipped with a warning', async () => {
  const warnings = [];
  const logger = { log() {}, error() {}, warn: (m) => warnings.push(m) };
  const srv = await startTestServer({
    logger,
    setupGuides: (dir) => {
      fs.writeFileSync(path.join(dir, 'broken.json'), '{ "title": "half a guide", ');
      fs.writeFileSync(path.join(dir, 'no-steps.json'), JSON.stringify({ title: 'No steps', triggers: ['x'] }));
    },
  });
  try {
    const r = await srv.request('GET', '/api/guides');
    const ids = r.body.guides.map((g) => g.id);
    assert.ok(ids.includes('forma-log-issue'));
    assert.ok(!ids.includes('broken') && !ids.includes('no-steps'));
    assert.equal(warnings.length, 2);
    assert.match(warnings.join('\n'), /Skipped broken\.json/);
    assert.match(warnings.join('\n'), /Skipped no-steps\.json/);
  } finally {
    await srv.close();
  }
});

test('slugs and lists', () => {
  assert.equal(slugify('Log an Issue — in Forma Build!'), 'log-an-issue-in-forma-build');
  assert.equal(slugify('Café déjà vu'), 'cafe-deja-vu');
  assert.equal(slugify('***'), 'guide');
  assert.deepEqual(toList('a, b ,,c'), ['a', 'b', 'c']);
  assert.deepEqual(toList(['a', '', ' b ']), ['a', 'b']);
  assert.deepEqual(toList(undefined), []);
});
