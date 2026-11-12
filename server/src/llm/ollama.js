import { HttpError } from '../errors.js';

export function stripThink(text) {
  return String(text ?? '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^[\s\S]*?<\/think>/i, '') // closing tag without an opener
    .replace(/<think>[\s\S]*$/i, '') // opener that never closed
    .trim();
}

export function hasModel(models, model) {
  const want = model.includes(':') ? model : `${model}:latest`;
  return models.some((m) => m === model || m === want);
}

function errorText(r) {
  const e = r.data?.error;
  if (typeof e === 'string') return e;
  if (e && typeof e.message === 'string') return e.message;
  return (r.text || '').slice(0, 300) || `HTTP ${r.status}`;
}

export function createOllama({ host, keepAlive = '30m', timeoutMs = 120_000, fetchImpl = globalThis.fetch }) {
  async function post(path, body, timeout = timeoutMs) {
    let res;
    try {
      res = await fetchImpl(`${host}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      });
    } catch (err) {
      const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      const e = new HttpError(
        503,
        'model_unavailable',
        timedOut
          ? `The model took longer than ${Math.round(timeout / 1000)} s to answer. Try again in a moment.`
          : `Can't reach Ollama at ${host}. Start it with: ollama serve`,
      );
      e.cause = err;
      throw e;
    }
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      // not JSON; keep the text for the error message
    }
    return { status: res.status, ok: res.ok, data, text };
  }

  function fail(r, model) {
    const message = errorText(r);
    if (r.status === 404 && /not found/i.test(message)) {
      throw new HttpError(503, 'model_missing', `The model ${model} isn't pulled yet. Run: ollama pull ${model}`, { model });
    }
    throw new HttpError(502, 'model_error', `Ollama said: ${message}`, { model });
  }

  // Non-streaming chat. Older Ollama builds reject `think`; retry once without it.
  async function chat({ model, messages, temperature = 0.3 }) {
    const body = { model, messages, stream: false, think: false, keep_alive: keepAlive, options: { temperature } };
    let r = await post('/api/chat', body);
    if (r.status === 400 && /think/i.test(errorText(r))) {
      const { think, ...withoutThink } = body;
      r = await post('/api/chat', withoutThink);
    }
    if (!r.ok) fail(r, model);
    return { text: stripThink(r.data?.message?.content), model };
  }

  // Loads the model into memory without generating anything.
  async function warm(model) {
    const r = await post('/api/chat', { model, messages: [], keep_alive: keepAlive });
    if (!r.ok) fail(r, model);
  }

  async function tags(timeout = 1500) {
    try {
      const res = await fetchImpl(`${host}/api/tags`, { signal: AbortSignal.timeout(timeout) });
      if (!res.ok) return { reachable: false, models: [] };
      const data = await res.json();
      return { reachable: true, models: (data.models || []).map((m) => m.name || m.model).filter(Boolean) };
    } catch {
      return { reachable: false, models: [] };
    }
  }

  async function status(model, timeout = 1500) {
    const t = await tags(timeout);
    return { reachable: t.reachable, models: t.models, hasModel: hasModel(t.models, model) };
  }

  return { host, chat, warm, tags, status };
}
