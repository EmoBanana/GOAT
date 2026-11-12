import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { cleanDraft } from '../src/guides/draft.js';
import { startMockOllama } from './helpers/mock-ollama.js';
import { startTestServer } from './helpers/test-server.js';

const DRAFT = {
  title: 'Export a PDF in Bluebeam',
  triggers: ['Export a PDF', 'save as pdf', 'export a pdf'],
  intro: 'Two clicks. Follow the blue cursor.',
  steps: [
    { label: 'File', say: 'Open the File menu.' },
    { label: 'Export', say: 'Choose Export, then PDF.' },
  ],
};

test('drafts are trimmed, deduplicated and capped', () => {
  const d = cleanDraft({ ...DRAFT, title: `  ${'x'.repeat(100)} `, steps: [...DRAFT.steps, { label: '', say: '' }, ...Array(20).fill({ label: 'More', say: 'Again.' })] });
  assert.equal(d.title.length, 80);
  assert.deepEqual(d.triggers, ['export a pdf', 'save as pdf']);
  assert.equal(d.steps.length, 12);
  assert.deepEqual(cleanDraft(null), { title: '', triggers: [], intro: '', steps: [] });
});

describe('POST /api/guides/draft', () => {
  let ollama;
  let srv;
  before(async () => {
    ollama = await startMockOllama({ reply: (body) => (body.format ? JSON.stringify(DRAFT) : 'Not JSON.') });
    srv = await startTestServer({ ollamaUrl: ollama.url });
  });
  after(async () => {
    await srv.close();
    await ollama.close();
  });

  test('pasted docs become a drafted guide through Gemma structured output', async () => {
    const r = await srv.request('POST', '/api/guides/draft', { body: { text: 'To export a PDF, open File, then Export, then PDF.' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.draft.title, 'Export a PDF in Bluebeam');
    assert.deepEqual(r.body.draft.triggers, ['export a pdf', 'save as pdf']);
    assert.equal(r.body.draft.steps.length, 2);
    const [call] = ollama.chats();
    assert.equal(call.body.format.type, 'object');
    assert.deepEqual(call.body.format.required, ['title', 'triggers', 'intro', 'steps']);
    assert.equal(call.body.think, false);
    assert.match(call.body.messages[1].content, /^Documentation:\nTo export a PDF/);
  });

  test('empty docs are a 400; a reply without steps is a 502', async () => {
    const empty = await srv.request('POST', '/api/guides/draft', { body: { text: '  ' } });
    assert.equal(empty.status, 400);
    assert.equal(empty.body.error, 'empty_docs');
    ollama.state.reply = () => '{"title":"x","triggers":[],"intro":"","steps":[]}';
    const none = await srv.request('POST', '/api/guides/draft', { body: { text: 'Nothing useful.' } });
    assert.equal(none.status, 502);
    assert.equal(none.body.error, 'draft_failed');
  });
});
