import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from './errors.js';

// Conversations, so a question can be continued now or reopened later. Kept on this laptop in
// data/chats/<user>/<id>.json: the question and answer text only, never screenshots or audio.
export const HISTORY_TURNS = 4; // the turns of a chat that Gemma sees with a new question
export const CONTINUE_MS = 10 * 60_000; // an ask with no chat id continues a chat this fresh
export const MAX_TURNS = 200;
const ID = /^[a-f0-9]{16}$/;

const titleOf = (question) => {
  const t = String(question).replace(/\s+/g, ' ').trim();
  return t.length > 60 ? `${t.slice(0, 59).trimEnd()}…` : t;
};

const summary = (c) => ({
  id: c.id,
  title: c.title,
  createdAt: c.createdAt,
  updatedAt: c.updatedAt,
  turns: c.turns.length,
  last: String(c.turns.at(-1)?.answer || '').slice(0, 140),
});

export function createChats({ dataDir, now = () => Date.now() }) {
  const dirOf = (user) => path.join(dataDir, 'chats', user);
  const fileOf = (user, id) => path.join(dirOf(user), `${id}.json`);

  function read(user, id) {
    if (!ID.test(String(id))) return null;
    try {
      const chat = JSON.parse(fs.readFileSync(fileOf(user, id), 'utf8'));
      return chat && Array.isArray(chat.turns) ? chat : null;
    } catch {
      return null;
    }
  }

  function write(user, chat) {
    fs.mkdirSync(dirOf(user), { recursive: true });
    const file = fileOf(user, chat.id);
    fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(chat)}\n`);
    fs.renameSync(`${file}.tmp`, file);
  }

  // Newest first.
  function all(user) {
    let files = [];
    try {
      files = fs.readdirSync(dirOf(user)).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }
    return files
      .map((f) => read(user, f.slice(0, -5)))
      .filter(Boolean)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  // The chat an ask continues: the given id, a new chat for null or "new", or, when the client
  // sends no id at all, the latest chat if it was used in the last 10 minutes.
  function resolve(user, chatId) {
    if (chatId === null || chatId === 'new') return null;
    if (chatId !== undefined) return read(user, chatId);
    const latest = all(user)[0];
    return latest && now() - latest.updatedAt < CONTINUE_MS ? latest : null;
  }

  // The last few turns, as the model sees them.
  function history(chat) {
    return (chat?.turns || []).slice(-HISTORY_TURNS).map((t) => ({
      question: t.question,
      answer: t.source === 'guide' ? `(GOAT played the guide "${t.guide?.title || 'a guide'}".)` : t.answer,
    }));
  }

  // Adds a turn to chat (or starts a new chat) and returns the saved chat.
  function add(user, chat, turn) {
    const at = now();
    const c = chat ? { ...chat } : { id: crypto.randomBytes(8).toString('hex'), title: titleOf(turn.question), createdAt: at, turns: [] };
    const t = { at, question: String(turn.question).slice(0, 1000), answer: String(turn.answer ?? '').slice(0, 2000), source: turn.source === 'guide' ? 'guide' : 'llm' };
    if (turn.guide) t.guide = { id: String(turn.guide.id), title: String(turn.guide.title) };
    if (turn.voice) t.voice = true;
    if (turn.image) t.image = true;
    c.turns = [...c.turns, t].slice(-MAX_TURNS);
    c.updatedAt = at;
    write(user, c);
    return c;
  }

  function remove(user, id) {
    if (!read(user, id)) return false;
    fs.rmSync(fileOf(user, id), { force: true });
    return true;
  }

  function clear(user) {
    const chats = all(user);
    for (const c of chats) fs.rmSync(fileOf(user, c.id), { force: true });
    return chats.length;
  }

  return { list: (user) => all(user).map(summary), get: read, resolve, history, add, remove, clear };
}

// The user's chats: a list, one chat in full, delete one, delete all. Never paid.
export function mountChats(app, { chats }) {
  app.get('/api/chats', (req, res) => {
    res.json({ chats: chats.list(req.userId) });
  });
  app.get('/api/chats/:id', (req, res) => {
    const chat = chats.get(req.userId, req.params.id);
    if (!chat) throw new HttpError(404, 'not_found', "That chat isn't here any more.");
    res.json(chat);
  });
  app.delete('/api/chats/:id', (req, res) => {
    res.json({ deleted: chats.remove(req.userId, req.params.id) ? 1 : 0 });
  });
  app.delete('/api/chats', (req, res) => {
    res.json({ deleted: chats.clear(req.userId) });
  });
}
