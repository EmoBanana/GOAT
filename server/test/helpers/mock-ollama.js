import http from 'node:http';
import { DEFAULT_MODEL } from '../../src/config.js';

// A stand-in for Ollama with the same response shapes as the real thing (checked on 0.32.4):
// 404 {"error":"model 'x' not found"} for unknown models, 400 "... does not support thinking".
export async function startMockOllama({
  models = [DEFAULT_MODEL],
  rejectThink = false,
  reply = (body) => `Mock answer from ${body.model}.`,
  transcript = 'How do I log an issue?',
} = {}) {
  const state = { models: [...models], rejectThink, reply, transcript, calls: [] };

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body = null;
    try {
      body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
    } catch {
      body = null;
    }
    state.calls.push({ method: req.method, path: req.url, body });
    const send = (status, obj) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };

    if (req.method === 'GET' && req.url === '/api/tags') {
      return send(200, { models: state.models.map((name) => ({ name, model: name, size: 1 })) });
    }
    if (req.method === 'POST' && req.url === '/api/chat') {
      if (!state.models.includes(body?.model)) return send(404, { error: `model '${body?.model}' not found` });
      if (state.rejectThink && body && 'think' in body) {
        return send(400, { error: `"${body.model}" does not support thinking` });
      }
      // Audio rides in `images` on the native endpoint (that's how Ollama 0.32 takes it).
      const hasWav = (body.messages || []).some((m) =>
        (m.images || []).some((b64) => Buffer.from(String(b64).slice(0, 24), 'base64').toString('latin1').startsWith('RIFF')),
      );
      const content = !body.messages?.length ? '' : hasWav ? state.transcript : state.reply(body);
      return send(200, {
        model: body.model,
        created_at: new Date().toISOString(),
        message: { role: 'assistant', content },
        done: true,
        done_reason: body.messages?.length ? 'stop' : 'load',
      });
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      if (!state.models.includes(body?.model)) {
        return send(404, { error: { message: `model '${body?.model}' not found`, type: 'not_found_error', param: null, code: null } });
      }
      return send(200, {
        id: 'chatcmpl-mock',
        object: 'chat.completion',
        model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: state.transcript }, finish_reason: 'stop' }],
      });
    }
    return send(404, { error: '404 page not found' });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    state,
    calls: state.calls,
    chats: () => state.calls.filter((c) => c.path === '/api/chat'),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

// A URL where nothing is listening, for "Ollama is offline" tests.
export async function closedPortUrl() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return `http://127.0.0.1:${port}`;
}
