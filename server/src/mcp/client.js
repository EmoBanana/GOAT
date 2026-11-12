import { spawn } from 'node:child_process';
import readline from 'node:readline';

export const PROTOCOL_VERSION = '2025-06-18';

export class McpError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'McpError';
    this.code = code;
  }
}

// A minimal MCP client over stdio: newline-delimited JSON-RPC 2.0 to a child process.
// Enough for initialize, tools/list and tools/call; answers the server's pings.
export function connectStdio({ name, command, args = [], env = {}, cwd, logger = console, timeoutMs = 20_000 }) {
  const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], shell: process.platform === 'win32' });
  const pending = new Map();
  let nextId = 1;
  let closed = false;
  let exitError = null;

  const write = (message) => {
    if (!closed && child.stdin.writable) child.stdin.write(`${JSON.stringify(message)}\n`);
  };

  function settle(id, fn) {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    clearTimeout(p.timer);
    fn(p);
  }

  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // not protocol output
    }
    if (msg.id !== undefined && msg.id !== null && ('result' in msg || 'error' in msg)) {
      settle(msg.id, (p) => (msg.error ? p.reject(new McpError(msg.error.message || 'MCP error', msg.error.code)) : p.resolve(msg.result)));
    } else if (msg.method && msg.id !== undefined) {
      // A request from the server: answer pings, decline everything else.
      if (msg.method === 'ping') write({ jsonrpc: '2.0', id: msg.id, result: {} });
      else write({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `GOAT doesn't support ${msg.method}` } });
    }
  });
  child.stderr.on('data', (chunk) => {
    const text = String(chunk).trim();
    if (text) logger.log(`[mcp:${name}] ${text.slice(0, 300)}`);
  });

  function failAll(error) {
    closed = true;
    exitError = error;
    for (const id of [...pending.keys()]) settle(id, (p) => p.reject(error));
  }
  child.on('error', (err) => failAll(new McpError(`${name} didn't start: ${err.message}`)));
  child.on('exit', (code, signal) => failAll(new McpError(`${name} exited (${signal || code})`)));

  function request(method, params, ms = timeoutMs) {
    if (closed) return Promise.reject(exitError || new McpError(`${name} is closed`));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => settle(id, (p) => p.reject(new McpError(`${name} didn't answer ${method} within ${ms} ms`))), ms);
      pending.set(id, { resolve, reject, timer });
      write({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
    });
  }

  const ready = (async () => {
    const info = await request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'goat', version: '0.1.0' },
    });
    write({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return info;
  })();
  ready.catch(() => {}); // callers see the error through the promise they await

  async function listTools() {
    await ready;
    const tools = [];
    let cursor;
    do {
      const page = await request('tools/list', cursor ? { cursor } : {});
      tools.push(...(page.tools || []));
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  }

  async function callTool(toolName, args, ms) {
    await ready;
    return request('tools/call', { name: toolName, arguments: args || {} }, ms);
  }

  function close() {
    if (!closed) {
      failAll(new McpError(`${name} was closed`));
      child.kill();
    }
  }

  return { name, ready, listTools, callTool, close, get closed() {
    return closed;
  } };
}
