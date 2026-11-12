import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, ROOT } from '../../src/config.js';
import { createMcpHub } from '../../src/mcp/hub.js';
import { buildServer, listen } from '../../src/server.js';

export const quietLogger = { log() {}, warn() {}, error() {} };

// Builds a real server on a random port with temp guide and data dirs.
// Options: ollamaUrl, env, users (data/users.json contents), setupGuides(dir), logger,
// mcp: { config, env } to run MCP servers (none by default, so tests never spawn real ones).
export async function startTestServer({ ollamaUrl, env = {}, users, setupGuides, logger = quietLogger, mcp } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'goat-test-'));
  const guidesDir = path.join(tmp, 'guides');
  fs.cpSync(path.join(ROOT, 'guides'), guidesDir, { recursive: true });
  if (setupGuides) setupGuides(guidesDir);
  const dataDir = path.join(tmp, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  if (users) fs.writeFileSync(path.join(dataDir, 'users.json'), JSON.stringify(users));

  const config = {
    ...loadConfig({ OLLAMA_HOST: ollamaUrl ?? 'http://127.0.0.1:9', GOAT_LLM_TIMEOUT_MS: '5000', ...env }),
    guidesDir,
    dataDir,
  };
  const mcpFile = path.join(tmp, 'mcp.json');
  fs.writeFileSync(mcpFile, JSON.stringify(mcp?.config ?? { mcpServers: {} }));
  const hub = createMcpHub({ file: mcpFile, env: { ...process.env, ...(mcp?.env || {}) }, logger });
  const built = await buildServer(config, { logger, mcp: hub });
  const server = await listen(built.app, { port: 0, host: '127.0.0.1' });
  const url = `http://127.0.0.1:${server.address().port}`;

  async function request(method, urlPath, { body, user, headers = {} } = {}) {
    const res = await fetch(url + urlPath, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(user ? { 'x-goat-user': user } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, body: json, text, headers: res.headers };
  }

  return {
    ...built,
    url,
    tmp,
    guidesDir,
    dataDir,
    request,
    close: async () => {
      hub.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}
