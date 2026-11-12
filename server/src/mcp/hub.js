import fs from 'node:fs';
import { connectStdio } from './client.js';

// Only these variables reach MCP servers (plus their own env from config/mcp.json), so a
// third-party server never sees GOAT's wallet or CDP keys.
const PASS_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'SystemRoot', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'ComSpec'];
const RESULT_CAP = 3500;

// "${BRAVE_API_KEY}" -> value; reports which variables are missing.
export function expandEnv(value, env, missing) {
  return String(value).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, key) => {
    const v = env[key];
    if (v === undefined || v === '') missing.add(key);
    return v ?? '';
  });
}

export function loadMcpConfig(file, env = process.env) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw new Error(`Can't read ${file}: ${err.message}`);
  }
  return Object.entries(raw?.mcpServers || {}).map(([name, s]) => {
    const missing = new Set();
    const ownEnv = Object.fromEntries(Object.entries(s.env || {}).map(([k, v]) => [k, expandEnv(v, env, missing)]));
    const args = (s.args || []).map((a) => expandEnv(a, env, missing));
    const enabled = s.disabled !== true && missing.size === 0 && Boolean(s.command);
    const reason = s.disabled === true ? 'disabled in config' : missing.size ? `set ${[...missing].join(', ')} in .env` : '';
    const base = Object.fromEntries(PASS_ENV.filter((k) => env[k] !== undefined).map((k) => [k, env[k]]));
    return { name, command: s.command, args, env: { ...base, ...ownEnv }, allow: Array.isArray(s.tools) ? new Set(s.tools) : null, enabled, reason };
  });
}

// MCP tool -> Ollama function spec. Only required parameters are shown to the model:
// small models pick tools better from short schemas, and the server fills in defaults.
export function toOllamaTool(tool) {
  const schema = tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : { type: 'object', properties: {} };
  const required = Array.isArray(schema.required) ? schema.required : [];
  const properties = required.length
    ? Object.fromEntries(required.filter((k) => schema.properties?.[k]).map((k) => [k, schema.properties[k]]))
    : schema.properties || {};
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: String(tool.description || tool.name).slice(0, 400),
      parameters: { type: 'object', properties, required },
    },
  };
}

export function resultText(result) {
  const parts = (result?.content || []).map((c) => (c.type === 'text' ? c.text : c.type === 'resource' ? c.resource?.text || '' : `[${c.type}]`));
  let text = parts.join('\n').trim() || JSON.stringify(result?.structuredContent ?? {});
  if (result?.isError) text = `The tool reported an error: ${text}`;
  return text.length > RESULT_CAP ? `${text.slice(0, RESULT_CAP)}…` : text;
}

export function findUrls(text) {
  const seen = new Set();
  const urls = [];
  for (const m of String(text).matchAll(/https?:\/\/[^\s"'<>\\)\]},]+/g)) {
    const url = m[0].replace(/[.,;:]+$/, '');
    try {
      const host = new URL(url).hostname;
      if (seen.has(host)) continue;
      seen.add(host);
      urls.push(url);
    } catch {
      // not a URL after all
    }
  }
  return urls;
}

// Starts the configured MCP servers and gives the model their tools.
export function createMcpHub({ file, env = process.env, logger = console, connect = connectStdio, callTimeoutMs = 15_000 }) {
  const servers = loadMcpConfig(file, env);
  const live = new Map(); // name -> { client, tools, error, starting }

  function startOne(s) {
    const entry = { client: null, tools: [], error: null, starting: null };
    live.set(s.name, entry);
    entry.starting = (async () => {
      try {
        entry.client = connect({ name: s.name, command: s.command, args: s.args, env: s.env, logger });
        const tools = await entry.client.listTools();
        entry.tools = tools.filter((t) => !s.allow || s.allow.has(t.name));
        logger.log(`[mcp] ${s.name} ready: ${entry.tools.map((t) => t.name).join(', ') || 'no tools'}`);
      } catch (err) {
        entry.error = err.message;
        logger.warn(`[mcp] ${s.name} failed: ${err.message}`);
      }
    })();
    return entry.starting;
  }

  function start() {
    return Promise.all(servers.filter((s) => s.enabled && !live.has(s.name)).map(startOne));
  }

  // Ollama tool specs from servers that are ready, waiting briefly for ones still starting.
  async function tools(waitMs = 3000) {
    if (!servers.some((s) => s.enabled)) return [];
    start();
    const starting = [...live.values()].map((e) => e.starting);
    await Promise.race([Promise.all(starting), new Promise((r) => setTimeout(r, waitMs))]);
    return [...live.values()].filter((e) => !e.error).flatMap((e) => e.tools.map(toOllamaTool));
  }

  async function call(toolName, args) {
    const entry = [...live.values()].find((e) => !e.error && e.tools.some((t) => t.name === toolName));
    if (!entry) return { text: `There is no tool called ${toolName}.`, urls: [] };
    try {
      const result = await entry.client.callTool(toolName, args, callTimeoutMs);
      const text = resultText(result);
      return { text, urls: result?.isError ? [] : findUrls(text) };
    } catch (err) {
      return { text: `The tool failed: ${err.message}`, urls: [] };
    }
  }

  function status() {
    return servers.map((s) => {
      const e = live.get(s.name);
      return {
        name: s.name,
        enabled: s.enabled,
        ready: Boolean(e && !e.error && e.client && e.tools.length),
        tools: e ? e.tools.map((t) => t.name) : [],
        ...(s.reason ? { reason: s.reason } : {}),
        ...(e?.error ? { error: e.error } : {}),
      };
    });
  }

  function close() {
    for (const e of live.values()) e.client?.close();
    live.clear();
  }

  return { enabled: servers.some((s) => s.enabled), start, tools, call, status, close };
}
