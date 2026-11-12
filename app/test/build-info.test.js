import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { closedPortUrl } from '../../server/test/helpers/mock-ollama.js';
import { createApi } from '../lib/api.js';
import { cleanServerUrl, DEFAULT_SERVER_URL, isLocalServer, readBuildInfo, resolveServerUrl, whereItRuns } from '../lib/build-info.js';

function appDir(pkg) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goat-build-'));
  if (pkg !== undefined) fs.writeFileSync(path.join(dir, 'package.json'), typeof pkg === 'string' ? pkg : JSON.stringify(pkg));
  return dir;
}

test('a packaged app reads the server it was built for', () => {
  const build = readBuildInfo(appDir({ version: '0.1.0', goat: { serverUrl: 'http://192.168.1.20:8402', commit: 'abc1234' } }));
  assert.deepEqual(build, { version: '0.1.0', serverUrl: 'http://192.168.1.20:8402', commit: 'abc1234' });
  assert.equal(resolveServerUrl({ env: {}, build }), 'http://192.168.1.20:8402');
});

test('GOAT_SERVER_URL beats the baked URL, and the default is the local server', () => {
  const build = { serverUrl: 'http://192.168.1.20:8402' };
  assert.equal(resolveServerUrl({ env: { GOAT_SERVER_URL: 'http://127.0.0.1:9000' }, build }), 'http://127.0.0.1:9000');
  assert.equal(resolveServerUrl({ env: {}, build: {} }), DEFAULT_SERVER_URL);
  // the dev checkout's package.json has no "goat" field
  assert.equal(resolveServerUrl({ env: {}, build: readBuildInfo(appDir({ version: '0.1.0' })) }), DEFAULT_SERVER_URL);
});

test('broken or missing package.json and bad URLs fall through to the default', () => {
  assert.deepEqual(readBuildInfo(appDir()), {});
  assert.deepEqual(readBuildInfo(appDir('{not json')), {});
  assert.equal(resolveServerUrl({ env: { GOAT_SERVER_URL: 'file:///etc/passwd' }, build: { serverUrl: 'not a url' } }), DEFAULT_SERVER_URL);
  assert.equal(cleanServerUrl(' https://goat.example.com/some/path?x=1 '), 'https://goat.example.com');
  assert.equal(cleanServerUrl(''), '');
  assert.equal(cleanServerUrl(42), '');
});

test('answers say "running on this laptop" only when the server is local', () => {
  assert.equal(isLocalServer('http://127.0.0.1:8402'), true);
  assert.equal(isLocalServer('http://localhost:8402'), true);
  assert.equal(isLocalServer('http://[::1]:8402'), true);
  assert.equal(isLocalServer('http://192.168.1.20:8402'), false);
  assert.equal(whereItRuns('http://127.0.0.1:8402'), 'running on this laptop');
  assert.equal(whereItRuns('https://goat.example.com'), 'on goat.example.com');
  assert.equal(whereItRuns('http://192.168.1.20:8402'), 'on 192.168.1.20:8402');
});

test('a packaged app explains an unreachable server without suggesting npm start', async () => {
  const api = createApi({ baseUrl: await closedPortUrl(), userId: 'x', unreachableHint: 'Check that it is running and that this Mac can reach it.' });
  const reply = await api.health();
  assert.equal(reply.error, 'server_unreachable');
  assert.match(reply.message, /^Can't reach the GOAT server at http:\/\/127\.0\.0\.1:\d+\. Check that it is running/);
  assert.doesNotMatch(reply.message, /npm start/);
});
