import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { connectStdio } from '../src/mcp/client.js';
import { createMcpHub, expandEnv, findUrls, loadMcpConfig, resultText, toOllamaTool } from '../src/mcp/hub.js';

const MOCK = fileURLToPath(new URL('./helpers/mock-mcp-server.js', import.meta.url));
const mockServer = (extra = {}) => ({ command: process.execPath, args: [MOCK], ...extra });

function writeConfig(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goat-mcp-'));
  const file = path.join(dir, 'mcp.json');
  fs.writeFileSync(file, JSON.stringify(config));
  return file;
}

test('the stdio client initializes, lists and calls tools, and answers server pings', async () => {
  const lines = [];
  const client = connectStdio({ name: 'mock', command: process.execPath, args: [MOCK], env: { PATH: process.env.PATH }, logger: { log: (l) => lines.push(l) } });
  try {
    const info = await client.ready;
    assert.equal(info.serverInfo.name, 'mock-search');
    const tools = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name), ['brave_web_search', 'brave_image_search']);
    const result = await client.callTool('brave_web_search', { query: 'revit schedule export' });
    assert.match(result.content[0].text, /revit schedule export/);
    await assert.rejects(client.callTool('nope', {}), /Unknown tool nope/);
    for (let i = 0; i < 40 && !lines.some((l) => /ping answered/.test(l)); i += 1) await new Promise((r) => setTimeout(r, 25));
    assert.ok(lines.some((l) => /ping answered/.test(l)), 'the client answered the server ping');
  } finally {
    client.close();
  }
  await assert.rejects(client.callTool('brave_web_search', { query: 'x' }), /closed/);
});

test('a server that cannot start fails cleanly', async () => {
  const client = connectStdio({ name: 'ghost', command: '/no/such/binary', env: {}, logger: { log() {} } });
  await assert.rejects(client.ready, /ghost/);
});

test('config: ${VARS} expand from the env, missing ones disable the server', () => {
  const missing = new Set();
  assert.equal(expandEnv('Bearer ${KEY}', { KEY: 'k1' }, missing), 'Bearer k1');
  assert.equal(expandEnv('${NOPE}', {}, missing), '');
  assert.deepEqual([...missing], ['NOPE']);

  const file = writeConfig({ mcpServers: { search: mockServer({ env: { MOCK_KEY: '${MOCK_KEY}' } }), off: mockServer({ disabled: true }) } });
  const [off1] = loadMcpConfig(file, { PATH: '/bin' });
  assert.equal(off1.enabled, false);
  assert.equal(off1.reason, 'set MOCK_KEY in .env');
  const [on, off2] = loadMcpConfig(file, { PATH: '/bin', MOCK_KEY: 'secret', TREASURY_PRIVATE_KEY: '0xabc' });
  assert.equal(on.enabled, true);
  assert.equal(on.env.MOCK_KEY, 'secret');
  assert.equal(on.env.TREASURY_PRIVATE_KEY, undefined, 'GOAT secrets never reach MCP servers');
  assert.equal(off2.reason, 'disabled in config');
  assert.deepEqual(loadMcpConfig('/no/such/mcp.json'), []);
});

test('tools become short Ollama function specs; results become text and source URLs', () => {
  const spec = toOllamaTool({
    name: 'brave_web_search',
    description: 'Search',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, count: { type: 'number' } }, required: ['query'] },
  });
  assert.deepEqual(spec, {
    type: 'function',
    function: { name: 'brave_web_search', description: 'Search', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  });
  assert.equal(resultText({ isError: true, content: [{ type: 'text', text: 'Rate limited' }] }), 'The tool reported an error: Rate limited');
  assert.ok(resultText({ content: [{ type: 'text', text: 'x'.repeat(5000) }] }).length <= 3501);
  assert.deepEqual(findUrls('see https://a.com/x, https://a.com/y and (https://b.org/z).'), ['https://a.com/x', 'https://b.org/z']);
});

test('the hub starts enabled servers, filters tools and routes calls', async () => {
  const file = writeConfig({ mcpServers: { search: mockServer({ env: { MOCK_KEY: '${MOCK_KEY}' }, tools: ['brave_web_search'] }) } });
  const hub = createMcpHub({ file, env: { PATH: process.env.PATH, MOCK_KEY: 'secret', TREASURY_PRIVATE_KEY: '0xabc' }, logger: { log() {}, warn() {} } });
  try {
    assert.equal(hub.enabled, true);
    const tools = await hub.tools(5000);
    assert.deepEqual(tools.map((t) => t.function.name), ['brave_web_search']);
    const result = await hub.call('brave_web_search', { query: 'export a revit schedule' });
    assert.match(result.text, /"key":"set"/);
    assert.match(result.text, /"leaked":"no"/);
    assert.deepEqual(result.urls, ['https://help.autodesk.com/view/RVT/2027/ENU/?guid=export', 'https://forums.autodesk.com/t5/revit/export-schedule/td-p/1']);
    const failed = await hub.call('brave_web_search', { query: 'fail please' });
    assert.match(failed.text, /reported an error/);
    assert.deepEqual(failed.urls, []);
    assert.match((await hub.call('brave_image_search', { query: 'x' })).text, /no tool called/);
    assert.deepEqual(hub.status(), [{ name: 'search', enabled: true, ready: true, tools: ['brave_web_search'] }]);
  } finally {
    hub.close();
  }
});

test('a hub whose servers need missing keys offers no tools', async () => {
  const file = writeConfig({ mcpServers: { search: mockServer({ env: { MOCK_KEY: '${MOCK_KEY}' } }) } });
  const hub = createMcpHub({ file, env: { PATH: process.env.PATH }, logger: { log() {}, warn() {} } });
  assert.equal(hub.enabled, false);
  assert.deepEqual(await hub.tools(), []);
  assert.deepEqual(hub.status(), [{ name: 'search', enabled: false, ready: false, tools: [], reason: 'set MOCK_KEY in .env' }]);
});
