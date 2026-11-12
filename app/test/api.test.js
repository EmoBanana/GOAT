import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';
import { createApi } from '../lib/api.js';
import { closedPortUrl } from '../../server/test/helpers/mock-ollama.js';

let server;
let baseUrl;
const seen = [];

before(async () => {
  server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    seen.push({ method: req.method, url: req.url, user: req.headers['x-goat-user'], body: chunks.length ? JSON.parse(Buffer.concat(chunks)) : null });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/assist' && seen.at(-1).body.question === 'boom') {
      res.statusCode = 503;
      return res.end(JSON.stringify({ error: 'model_missing', message: 'Run: ollama pull gemma4:e2b', model: 'gemma4:e2b' }));
    }
    if (req.url === '/api/slow') return setTimeout(() => res.end('{}'), 500);
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((resolve) => (server.closeAllConnections(), server.close(resolve))));

test('assist posts the question and context with the x-goat-user header', async () => {
  const api = createApi({ baseUrl, userId: 'site.engineer' });
  const reply = await api.assist({ question: 'how do I log an issue', context: { app: 'Google Chrome' } });
  assert.deepEqual(reply, { ok: true, path: '/api/assist' });
  const last = seen.at(-1);
  assert.equal(last.method, 'POST');
  assert.equal(last.user, 'site.engineer');
  assert.deepEqual(last.body, { question: 'how do I log an issue', context: { app: 'Google Chrome' } });
});

test('server errors come back as { error, message, status } instead of throwing', async () => {
  const api = createApi({ baseUrl, userId: 'x' });
  const reply = await api.assist({ question: 'boom' });
  assert.equal(reply.error, 'model_missing');
  assert.equal(reply.message, 'Run: ollama pull gemma4:e2b');
  assert.equal(reply.status, 503);
  assert.equal(reply.model, 'gemma4:e2b');
});

test('an unreachable server or a timeout is a friendly error', async () => {
  const down = createApi({ baseUrl: await closedPortUrl(), userId: 'x' });
  const reply = await down.health();
  assert.equal(reply.error, 'server_unreachable');
  assert.match(reply.message, /npm start/);

  const slow = createApi({ baseUrl, userId: 'x', timeoutMs: 100 });
  assert.equal((await slow.request('GET', '/api/slow')).error, 'server_timeout');
});
