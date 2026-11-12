import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { DEFAULT_MODEL } from '../src/config.js';
import { closedPortUrl, startMockOllama } from './helpers/mock-ollama.js';
import { startTestServer } from './helpers/test-server.js';

const inForma = { app: 'Google Chrome', title: 'Forma Build - Issues', url: 'https://acc.autodesk.com/build/issues?projectId=123&token=secret' };

describe('POST /api/assist', () => {
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
  beforeEach(() => {
    ollama.calls.length = 0;
  });

  test('a guide match plays the verified guide and skips the model', async () => {
    const r = await srv.request('POST', '/api/assist', { body: { question: 'How do I log an issue?', context: inForma } });
    assert.equal(r.status, 200);
    assert.equal(r.body.source, 'guide');
    assert.equal(r.body.guide.id, 'forma-log-issue');
    assert.equal(r.body.guide.steps.length, 7);
    assert.deepEqual(Object.keys(r.body.guide.steps[0]).sort(), ['label', 'say', 'x', 'y']);
    assert.equal(r.body.say, r.body.guide.intro);
    assert.equal(r.body.model, null);
    assert.equal(r.body.tier, 'free');
    assert.equal(typeof r.body.id, 'string');
    assert.equal(typeof r.body.latencyMs, 'number');
    assert.equal(ollama.chats().length, 0);
  });

  test('the LLM path sends think:false, keep_alive and SOP context', async () => {
    const r = await srv.request('POST', '/api/assist', { body: { question: 'Why do issues need a photo?', context: inForma } });
    assert.equal(r.status, 200);
    assert.equal(r.body.source, 'llm');
    assert.equal(r.body.say, `Mock answer from ${DEFAULT_MODEL}.`);
    assert.equal(r.body.model, DEFAULT_MODEL);
    assert.equal(r.body.guide, null);
    assert.ok(r.body.sources.some((s) => s.type === 'doc' && s.file === 'sop-site-issues.md'));

    const [call] = ollama.chats();
    assert.equal(call.body.model, DEFAULT_MODEL);
    assert.equal(call.body.think, false);
    assert.equal(call.body.stream, false);
    assert.equal(call.body.keep_alive, '30m');
    assert.equal(call.body.options.temperature, 0.3);
    const [system, user] = call.body.messages;
    assert.equal(system.role, 'system');
    assert.match(system.content, /at most 3 short sentences/);
    assert.match(user.content, /Every issue needs at least one photo/);
    assert.match(user.content, /Question: Why do issues need a photo\?/);
    assert.ok(user.content.length < 4000);
  });

  test('URL query strings never reach the model', async () => {
    await srv.request('POST', '/api/assist', { body: { question: 'Why do issues need a photo?', context: inForma } });
    const user = ollama.chats()[0].body.messages[1].content;
    assert.match(user, /URL: https:\/\/acc\.autodesk\.com\/build\/issues/);
    assert.doesNotMatch(user, /projectId|secret/);
  });

  test('"why" questions go to the model even when a guide matches', async () => {
    const r = await srv.request('POST', '/api/assist', { body: { question: 'Why log an issue in Forma?', context: inForma } });
    assert.equal(r.body.source, 'llm');
    assert.equal(ollama.chats().length, 1);
    // The matching guide is still offered to the model as context.
    assert.ok(r.body.sources.some((s) => s.type === 'guide' && s.id === 'forma-log-issue'));
  });

  test('an empty question is a 400', async () => {
    for (const body of [{ question: '   ' }, {}, { question: 42 }]) {
      const r = await srv.request('POST', '/api/assist', { body });
      assert.equal(r.status, 400);
      assert.equal(r.body.error, 'empty_question');
      assert.equal(typeof r.body.message, 'string');
    }
    assert.equal(ollama.chats().length, 0);
  });
});

describe('model problems', () => {
  test('Pro tries GOAT_MODEL_PRO, then falls back to the base model when it is not pulled', async () => {
    const ollama = await startMockOllama({ models: [DEFAULT_MODEL] });
    const srv = await startTestServer({
      ollamaUrl: ollama.url,
      env: { GOAT_MODEL_PRO: 'gemma4:12b' },
      users: { pat: { id: 'pat', proUntil: Date.now() + 86_400_000 } },
    });
    try {
      const r = await srv.request('POST', '/api/assist', { user: 'pat', body: { question: 'Why do issues need a photo?' } });
      assert.equal(r.status, 200);
      assert.equal(r.body.tier, 'pro');
      assert.equal(r.body.model, DEFAULT_MODEL);
      assert.deepEqual(
        ollama.chats().map((c) => c.body.model),
        ['gemma4:12b', DEFAULT_MODEL],
      );
    } finally {
      await srv.close();
      await ollama.close();
    }
  });

  test('Pro uses GOAT_MODEL_PRO when it is pulled; expired Pro is free', async () => {
    const ollama = await startMockOllama({ models: [DEFAULT_MODEL, 'gemma4:12b'] });
    const users = { pat: { id: 'pat', proUntil: Date.now() + 86_400_000 }, old: { id: 'old', proUntil: Date.now() - 1000 } };
    const srv = await startTestServer({ ollamaUrl: ollama.url, env: { GOAT_MODEL_PRO: 'gemma4:12b' }, users });
    try {
      const pro = await srv.request('POST', '/api/assist', { user: 'pat', body: { question: 'Explain issue types' } });
      assert.equal(pro.body.model, 'gemma4:12b');
      const expired = await srv.request('POST', '/api/assist', { user: 'old', body: { question: 'Explain issue types' } });
      assert.equal(expired.body.tier, 'free');
      assert.equal(expired.body.model, DEFAULT_MODEL);
    } finally {
      await srv.close();
      await ollama.close();
    }
  });

  test('by default Pro uses the same local model and asks it once', async () => {
    const ollama = await startMockOllama();
    const srv = await startTestServer({ ollamaUrl: ollama.url, users: { pat: { id: 'pat', proUntil: Date.now() + 86_400_000 } } });
    try {
      const r = await srv.request('POST', '/api/assist', { user: 'pat', body: { question: 'Explain issue types' } });
      assert.equal(r.body.tier, 'pro');
      assert.equal(r.body.model, DEFAULT_MODEL);
      assert.equal(ollama.chats().length, 1);
    } finally {
      await srv.close();
      await ollama.close();
    }
  });

  test('Ollama offline is a 503 model_unavailable', async () => {
    const srv = await startTestServer({ ollamaUrl: await closedPortUrl() });
    try {
      const r = await srv.request('POST', '/api/assist', { body: { question: 'Why do issues need a photo?' } });
      assert.equal(r.status, 503);
      assert.equal(r.body.error, 'model_unavailable');
      assert.match(r.body.message, /ollama serve/);
      // Guides still work without the model.
      const g = await srv.request('POST', '/api/assist', { body: { question: 'how do I log an issue' } });
      assert.equal(g.status, 200);
      assert.equal(g.body.source, 'guide');
    } finally {
      await srv.close();
    }
  });

  test('a model that is not pulled is a 503 with the pull command', async () => {
    const ollama = await startMockOllama({ models: [] });
    const srv = await startTestServer({ ollamaUrl: ollama.url });
    try {
      const r = await srv.request('POST', '/api/assist', { body: { question: 'Why do issues need a photo?' } });
      assert.equal(r.status, 503);
      assert.equal(r.body.error, 'model_missing');
      assert.ok(r.body.message.includes(`Run: ollama pull ${DEFAULT_MODEL}`), r.body.message);
      assert.equal(r.body.model, DEFAULT_MODEL);
    } finally {
      await srv.close();
      await ollama.close();
    }
  });

  test('when Ollama rejects "think", it retries once without it', async () => {
    const ollama = await startMockOllama({ rejectThink: true, reply: () => '<think>hidden</think>Photos are the evidence.' });
    const srv = await startTestServer({ ollamaUrl: ollama.url });
    try {
      const r = await srv.request('POST', '/api/assist', { body: { question: 'Why do issues need a photo?' } });
      assert.equal(r.status, 200);
      assert.equal(r.body.say, 'Photos are the evidence.');
      const chats = ollama.chats();
      assert.equal(chats.length, 2);
      assert.equal(chats[0].body.think, false);
      assert.equal('think' in chats[1].body, false);
    } finally {
      await srv.close();
      await ollama.close();
    }
  });
});
