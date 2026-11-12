import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { describe } from 'node:test';
import { CONTINUE_MS, createChats, HISTORY_TURNS } from '../src/chats.js';
import { startMockOllama } from './helpers/mock-ollama.js';
import { startTestServer } from './helpers/test-server.js';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'goat-chats-'));
const GUIDE_TURN = { question: 'how do I log an issue', answer: "Let's log an issue.", source: 'guide', guide: { id: 'forma-log-issue', title: 'Log an issue in Forma Build' } };

test('chats keep their turns on disk, newest chat first, per user', () => {
  let t = 1000;
  const dataDir = tmpDir();
  const chats = createChats({ dataDir, now: () => t });
  const a = chats.add('pat', null, GUIDE_TURN);
  t += 10;
  const a2 = chats.add('pat', a, { question: 'and who checks it?', answer: 'Whoever raised it.', source: 'llm' });
  t += 10;
  const b = chats.add('pat', null, { question: 'x'.repeat(80), answer: 'B', source: 'llm' });
  assert.equal(a2.id, a.id);
  assert.equal(a2.turns.length, 2);
  assert.equal(a.title, 'how do I log an issue');
  assert.equal(b.title, `${'x'.repeat(59)}…`);
  assert.deepEqual(chats.list('pat').map((c) => [c.id, c.turns]), [[b.id, 1], [a.id, 2]]);
  assert.deepEqual(chats.list('sam'), []);
  assert.ok(fs.existsSync(path.join(dataDir, 'chats', 'pat', `${a.id}.json`)));
  // A played guide reaches the model as a note, not as its intro text.
  assert.deepEqual(chats.history(chats.get('pat', a.id)), [
    { question: 'how do I log an issue', answer: '(GOAT played the guide "Log an issue in Forma Build".)' },
    { question: 'and who checks it?', answer: 'Whoever raised it.' },
  ]);
});

test('the model sees only the last few turns of a chat', () => {
  const chats = createChats({ dataDir: tmpDir() });
  let chat = null;
  for (let i = 1; i <= HISTORY_TURNS + 2; i += 1) chat = chats.add('pat', chat, { question: `q${i}`, answer: `a${i}`, source: 'llm' });
  const seen = chats.history(chat).map((h) => h.question);
  assert.equal(seen.length, HISTORY_TURNS);
  assert.equal(seen.at(-1), `q${HISTORY_TURNS + 2}`);
});

test('an ask continues the chat it names; null starts one; no id continues only a fresh chat', () => {
  let t = 0;
  const chats = createChats({ dataDir: tmpDir(), now: () => t });
  const c = chats.add('pat', null, { question: 'q1', answer: 'a1', source: 'llm' });
  assert.equal(chats.resolve('pat', c.id).id, c.id);
  assert.equal(chats.resolve('pat', null), null);
  assert.equal(chats.resolve('pat', 'new'), null);
  assert.equal(chats.resolve('pat', undefined).id, c.id);
  t += CONTINUE_MS + 1;
  assert.equal(chats.resolve('pat', undefined), null, 'a stale chat is not continued by accident');
  assert.equal(chats.resolve('pat', c.id).id, c.id, 'but it can still be reopened');
  assert.equal(chats.resolve('pat', '../../users'), null);
  assert.equal(chats.resolve('sam', c.id), null, "another user's chat id leads nowhere");
});

describe('chat routes and assist', () => {
  test('asks join a chat: its id continues it, null starts a new one, and chats can be listed and deleted', async () => {
    const ollama = await startMockOllama({ reply: (body) => `Answer ${body.messages.length}` });
    const srv = await startTestServer({ ollamaUrl: ollama.url });
    try {
      const first = await srv.request('POST', '/api/assist', { user: 'pat', body: { question: 'Why do issues need a photo?', chatId: null } });
      assert.match(first.body.chatId, /^[a-f0-9]{16}$/);
      assert.equal(first.body.chatTurns, 1);
      assert.equal(first.body.chatTitle, 'Why do issues need a photo?');
      const second = await srv.request('POST', '/api/assist', { user: 'pat', body: { question: 'and who checks it?', chatId: first.body.chatId } });
      assert.equal(second.body.chatId, first.body.chatId);
      assert.equal(second.body.chatTurns, 2);
      assert.deepEqual(
        ollama.chats().at(-1).body.messages.slice(1, -1).map((m) => [m.role, m.content]),
        [['user', 'Why do issues need a photo?'], ['assistant', first.body.say]],
        'the follow-up carried the first exchange',
      );
      const fresh = await srv.request('POST', '/api/assist', { user: 'pat', body: { question: 'how do I log an issue', chatId: null } });
      assert.equal(fresh.body.source, 'guide');
      assert.notEqual(fresh.body.chatId, first.body.chatId);

      const list = await srv.request('GET', '/api/chats', { user: 'pat' });
      assert.deepEqual(list.body.chats.map((c) => [c.title, c.turns]), [['how do I log an issue', 1], ['Why do issues need a photo?', 2]]);
      const full = await srv.request('GET', `/api/chats/${first.body.chatId}`, { user: 'pat' });
      assert.deepEqual(full.body.turns.map((t) => [t.question, t.answer]), [['Why do issues need a photo?', first.body.say], ['and who checks it?', second.body.say]]);

      assert.deepEqual((await srv.request('GET', '/api/chats', { user: 'sam' })).body.chats, [], "sam sees none of pat's chats");
      assert.equal((await srv.request('GET', `/api/chats/${first.body.chatId}`, { user: 'sam' })).status, 404);

      assert.equal((await srv.request('DELETE', `/api/chats/${fresh.body.chatId}`, { user: 'pat' })).body.deleted, 1);
      assert.equal((await srv.request('DELETE', '/api/chats', { user: 'pat' })).body.deleted, 1);
      assert.deepEqual((await srv.request('GET', '/api/chats', { user: 'pat' })).body.chats, []);
    } finally {
      await srv.close();
      await ollama.close();
    }
  });

  test('an ask that fails (model offline) adds nothing to the chat', async () => {
    const srv = await startTestServer({ ollamaUrl: 'http://127.0.0.1:9' });
    try {
      const r = await srv.request('POST', '/api/assist', { user: 'pat', body: { question: 'Why do issues need a photo?', chatId: null } });
      assert.equal(r.status, 503);
      assert.deepEqual((await srv.request('GET', '/api/chats', { user: 'pat' })).body.chats, []);
    } finally {
      await srv.close();
    }
  });
});
