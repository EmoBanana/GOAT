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
  function unavailable(err, timedOut, timeout = timeoutMs) {
    const e = new HttpError(
      503,
      'model_unavailable',
      timedOut
        ? `The model took longer than ${Math.round(timeout / 1000)} s to answer. Try again in a moment.`
        : `Can't reach Ollama at ${host}. Start it with: ollama serve`,
    );
    e.cause = err;
    return e;
  }

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
      throw unavailable(err, err?.name === 'TimeoutError' || err?.name === 'AbortError', timeout);
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

  // Thinking on a time budget. Gemma 4 reasons for 10-30 s whatever the think level, so stream
  // the reply and, if it is still reasoning (no answer or tool call yet) when the budget runs
  // out, stop it and hand back what it has thought so far with cut: true.
  async function streamChat(body, model, budgetMs) {
    const controller = new AbortController();
    let cut = false;
    let timedOut = false;
    const overall = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    let res;
    try {
      res = await fetchImpl(`${host}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, stream: true }),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(overall);
      throw unavailable(err, timedOut);
    }
    if (!res.ok) {
      clearTimeout(overall);
      const text = await res.text();
      let data = null;
      try {
        data = JSON.parse(text);
      } catch {
        // keep the text
      }
      return { r: { status: res.status, ok: false, data, text } };
    }
    let thinking = '';
    let content = '';
    const toolCalls = [];
    const budget = setTimeout(() => {
      if (!content && !toolCalls.length) {
        cut = true;
        controller.abort();
      }
    }, budgetMs);
    const take = (line) => {
      if (!line.trim()) return;
      let part;
      try {
        part = JSON.parse(line);
      } catch {
        return;
      }
      if (part.error) throw new HttpError(502, 'model_error', `Ollama said: ${part.error}`, { model });
      const m = part.message || {};
      if (m.thinking) thinking += m.thinking;
      if (m.content) content += m.content;
      if (Array.isArray(m.tool_calls)) toolCalls.push(...m.tool_calls);
    };
    try {
      const decoder = new TextDecoder();
      let buffer = '';
      for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          take(buffer.slice(0, nl));
          buffer = buffer.slice(nl + 1);
        }
      }
      take(buffer); // a last line without a newline
    } catch (err) {
      if (!cut) throw err instanceof HttpError ? err : unavailable(err, timedOut);
    } finally {
      clearTimeout(budget);
      clearTimeout(overall);
    }
    return { result: { text: stripThink(content), thinking, toolCalls, model, cut } };
  }

  // Chat. think: false answers fast; true lets Gemma reason first, and with thinkBudgetMs the
  // reasoning is cut off at that budget (see streamChat). tools: Ollama function specs (from MCP
  // servers). Older Ollama builds reject `think`, and some models reject tools: retry once
  // without the offending field. format: a JSON schema for structured output (guide drafts).
  async function chat({ model, messages, temperature = 0.3, think = false, tools, format, thinkBudgetMs = 0 }) {
    let body = { model, messages, stream: false, think, keep_alive: keepAlive, options: { temperature } };
    if (tools?.length) body.tools = tools;
    if (format) body.format = format;
    let r;
    if (think && thinkBudgetMs > 0) {
      const streamed = await streamChat(body, model, thinkBudgetMs);
      if (streamed.result) return streamed.result;
      r = streamed.r; // an error answer: handled below like any other
    } else {
      r = await post('/api/chat', body);
    }
    if (r.status === 400 && /think/i.test(errorText(r))) {
      const { think: _think, ...rest } = body;
      body = rest;
      r = await post('/api/chat', body);
    }
    if (r.status === 400 && body.tools && /tool/i.test(errorText(r))) {
      const { tools: _tools, ...rest } = body;
      r = await post('/api/chat', rest);
    }
    if (!r.ok) fail(r, model);
    const message = r.data?.message || {};
    return {
      text: stripThink(message.content),
      thinking: typeof message.thinking === 'string' ? message.thinking : '',
      toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls : [],
      model,
    };
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
