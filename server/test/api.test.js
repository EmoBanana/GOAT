import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { sanitizeUserId } from '../src/users.js';
import { closedPortUrl, startMockOllama } from './helpers/mock-ollama.js';
import { startTestServer } from './helpers/test-server.js';

describe('health, me and errors', () => {
  let ollama;
  let srv;
  before(async () => {
    ollama = await startMockOllama({ models: ['gemma4:e2b', 'qwen2.5:3b'] });
    srv = await startTestServer({ ollamaUrl: ollama.url });
  });
  after(async () => {
    await srv.close();
    await ollama.close();
  });

  test('GET /api/health reports models, Ollama, payments, guides and docs', async () => {
    const r = await srv.request('GET', '/api/health');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.models, { base: 'gemma4:e2b', pro: 'gemma4:e4b', stt: 'gemma4:e2b' });
    assert.equal(r.body.ollama.reachable, true);
    assert.equal(r.body.ollama.hasModel, true);
    assert.deepEqual(r.body.ollama.models, ['gemma4:e2b', 'qwen2.5:3b']);
    assert.equal(r.body.payments.mode, 'x402-local');
    assert.ok(r.body.guides >= 2);
    assert.ok(r.body.docs.files >= 1 && r.body.docs.chunks > 0);
  });

  test('GET /api/me uses the sanitised x-goat-user header', async () => {
    const me = await srv.request('GET', '/api/me', { user: 'site.engineer@example.com' });
    assert.deepEqual(me.body, { id: 'site.engineer@example.com', tier: 'free', pro: false, proUntil: null, model: 'gemma4:e2b' });
    const bad = await srv.request('GET', '/api/me', { user: 'robert"); drop table' });
    assert.equal(bad.body.id, 'anonymous');
    const none = await srv.request('GET', '/api/me');
    assert.equal(none.body.id, 'anonymous');
  });

  test('unknown routes and bad JSON come back as JSON errors', async () => {
    const missing = await srv.request('GET', '/api/nope');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error, 'not_found');
    const badJson = await srv.request('POST', '/api/assist', { body: '{"question":', headers: { 'content-type': 'application/json' } });
    assert.equal(badJson.status, 400);
    assert.equal(badJson.body.error, 'bad_json');
  });
});

test('health says unreachable within the 1.5 s timeout when Ollama is down', async () => {
  const srv = await startTestServer({ ollamaUrl: await closedPortUrl() });
  try {
    const started = Date.now();
    const r = await srv.request('GET', '/api/health');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.ollama.models, []);
    assert.equal(r.body.ollama.reachable, false);
    assert.equal(r.body.ollama.hasModel, false);
    assert.ok(Date.now() - started < 2500);
  } finally {
    await srv.close();
  }
});

test('user ids are sanitised to [A-Za-z0-9._@-]{1,80}', () => {
  assert.equal(sanitizeUserId('alice'), 'alice');
  assert.equal(sanitizeUserId('a.b-c_d@e'), 'a.b-c_d@e');
  assert.equal(sanitizeUserId('has space'), 'anonymous');
  assert.equal(sanitizeUserId('x'.repeat(81)), 'anonymous');
  assert.equal(sanitizeUserId(''), 'anonymous');
  assert.equal(sanitizeUserId(undefined), 'anonymous');
});
