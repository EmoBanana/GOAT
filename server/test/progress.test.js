import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createProgress } from '../src/progress.js';
import { startMockOllama } from './helpers/mock-ollama.js';
import { startTestServer } from './helpers/test-server.js';

const MOCK_MCP = fileURLToPath(new URL('./helpers/mock-mcp-server.js', import.meta.url));

test('steps are kept per ask id, without repeats, and forgotten after a while', () => {
  let t = 0;
  const progress = createProgress({ ttlMs: 1000, now: () => t });
  progress.step('ask-12345678', 'Checking the guides');
  progress.step('ask-12345678', 'Checking the guides');
  progress.step('ask-12345678', 'Writing the answer');
  progress.step('../etc', 'nope');
  assert.deepEqual(progress.get('ask-12345678'), { steps: ['Checking the guides', 'Writing the answer'], done: false });
  progress.done('ask-12345678');
  assert.equal(progress.get('ask-12345678').done, true);
  t = 2000;
  assert.deepEqual(progress.get('ask-12345678'), { steps: [], done: false });
});

describe('live steps and whole documents', () => {
  test('an ask reports its steps, read back by its id', async () => {
    const ollama = await startMockOllama({ reply: () => 'Photos are the evidence.' });
    const srv = await startTestServer({ ollamaUrl: ollama.url });
    try {
      await srv.request('POST', '/api/assist', { body: { question: 'Why do issues need a photo?' }, headers: { 'x-goat-progress': 'llm-ask-0001' } });
      const llm = (await srv.request('GET', '/api/progress/llm-ask-0001')).body;
      assert.equal(llm.done, true);
      assert.equal(llm.steps[0], 'Checking company procedures');
      assert.match(llm.steps[1], /^Using “.+”$/);
      assert.equal(llm.steps.at(-1), 'Writing the answer');

      await srv.request('POST', '/api/assist', { body: { question: 'how do I log an issue' }, headers: { 'x-goat-progress': 'guide-ask-01' } });
      assert.deepEqual((await srv.request('GET', '/api/progress/guide-ask-01')).body, {
        steps: ['Checking the guides', 'Found the guide “Log an issue in Forma Build”'],
        done: true,
      });
      assert.deepEqual((await srv.request('GET', '/api/progress/never-asked-1')).body, { steps: [], done: false });
    } finally {
      await srv.close();
      await ollama.close();
    }
  });

  test('a whole deck goes to Gemma with the question, answered from it: no web tools, no slow thinking', async () => {
    const ollama = await startMockOllama({ toolCalls: () => [{ function: { name: 'brave_web_search', arguments: { query: 'x' } } }], reply: () => 'Slide 3: pay per assist.' });
    const srv = await startTestServer({ ollamaUrl: ollama.url, mcp: { config: { mcpServers: { search: { command: process.execPath, args: [MOCK_MCP] } } } } });
    try {
      const document = { kind: 'deck', app: 'Keynote', title: 'GOAT pitch', slides: 4, current: 3, text: 'Slide 1: GOAT\n\nSlide 3 (on screen): Business model\nPay per assist' };
      const r = await srv.request('POST', '/api/assist', {
        body: { question: 'what is the business model?', context: { app: 'Keynote', title: 'GOAT pitch.key' }, document },
        headers: { 'x-goat-progress': 'deck-ask-001' },
      });
      assert.equal(r.status, 200);
      assert.equal(r.body.document, 'deck');
      const [call] = ollama.chats();
      assert.equal(ollama.chats().length, 1);
      assert.equal(call.body.think, false);
      assert.equal(call.body.tools, undefined, 'deck contents never go to web tools');
      assert.equal(call.body.options.num_ctx, 8192, 'room for the whole deck');
      assert.match(call.body.messages[0].content, /open deck or page is included/);
      assert.match(call.body.messages.at(-1).content, /^The deck open in Keynote, "GOAT pitch" \(4 slides, slide 3 on screen\):\nSlide 1: GOAT/);
      assert.match(call.body.messages.at(-1).content, /Question: what is the business model\?$/);
      assert.ok(!(await srv.request('GET', '/api/progress/deck-ask-001')).body.steps.includes('Thinking it through'));
    } finally {
      await srv.close();
      await ollama.close();
    }
  });
});
