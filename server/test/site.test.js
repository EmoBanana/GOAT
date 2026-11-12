import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { startTestServer } from './helpers/test-server.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'goat-site-'));
const siteDir = path.join(tmp, 'site');
const distDir = path.join(tmp, 'dist');
const emptyDist = path.join(tmp, 'empty-dist');
for (const dir of [siteDir, distDir, emptyDist]) fs.mkdirSync(dir);
fs.writeFileSync(path.join(siteDir, 'index.html'), '<!doctype html><title>GOAT</title><p>the page</p>');
const zip = Buffer.from('PK fake GOAT.app');
const sha256 = crypto.createHash('sha256').update(zip).digest('hex');
fs.writeFileSync(path.join(distDir, 'GOAT-0.1.0-mac-arm64.zip'), zip);
fs.writeFileSync(path.join(distDir, 'notes.txt'), 'not a build');
const build = (arch, file) => ({ platform: 'darwin', arch, file, bytes: zip.length, sha256, serverUrl: 'http://127.0.0.1:8402', builtAt: '2026-11-12T08:00:00.000Z' });
fs.writeFileSync(
  path.join(distDir, 'latest.json'),
  JSON.stringify({
    name: 'GOAT',
    version: '0.1.0',
    builds: [
      build('arm64', 'GOAT-0.1.0-mac-arm64.zip'),
      build('x64', 'GOAT-0.1.0-mac-x64.zip'), // listed, but not on disk
      build('arm64', '../notes.txt'), // not a build file name
    ],
  }),
);

let srv;
let bare;
before(async () => {
  srv = await startTestServer({ env: { GOAT_SITE_DIR: siteDir, GOAT_DIST_DIR: distDir, GOAT_PAYMENTS: 'x402-local', MYR_PER_USD: '4.20' } });
  bare = await startTestServer({ env: { GOAT_SITE_DIR: path.join(tmp, 'no-site'), GOAT_DIST_DIR: emptyDist } });
});
after(async () => {
  await srv?.close();
  await bare?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('GET /api/downloads lists the builds on disk and what the server charges', async () => {
  const res = await srv.request('GET', '/api/downloads');
  assert.equal(res.status, 200);
  assert.equal(res.body.version, '0.1.0');
  assert.deepEqual(res.body.builds, [
    {
      platform: 'darwin',
      arch: 'arm64',
      label: 'macOS · Apple silicon',
      file: 'GOAT-0.1.0-mac-arm64.zip',
      url: '/download/GOAT-0.1.0-mac-arm64.zip',
      bytes: zip.length,
      sha256,
      serverUrl: 'http://127.0.0.1:8402',
      builtAt: '2026-11-12T08:00:00.000Z',
    },
  ]);
  assert.deepEqual(res.body.pricing, {
    payments: 'x402-local',
    network: 'eip155:84532',
    assistUsd: 0.01,
    assistMyr: 0.04,
    proUsd: 1,
    proMyr: 4.2,
    proDays: 30,
    welcomeMyr: 2,
    myrPerUsd: 4.2,
  });
});

test('a Windows build is listed and downloads beside the Mac one', async () => {
  const winDist = path.join(tmp, 'win-dist');
  fs.mkdirSync(winDist);
  fs.writeFileSync(path.join(winDist, 'GOAT-0.1.0-mac-arm64.zip'), zip);
  fs.writeFileSync(path.join(winDist, 'GOAT-0.1.0-win-x64.zip'), zip);
  const builds = [build('arm64', 'GOAT-0.1.0-mac-arm64.zip'), { ...build('x64', 'GOAT-0.1.0-win-x64.zip'), platform: 'win32' }];
  fs.writeFileSync(path.join(winDist, 'latest.json'), JSON.stringify({ name: 'GOAT', version: '0.1.0', builds }));
  const win = await startTestServer({ env: { GOAT_SITE_DIR: siteDir, GOAT_DIST_DIR: winDist } });
  try {
    const res = await win.request('GET', '/api/downloads');
    assert.deepEqual(
      res.body.builds.map((b) => [b.label, b.url]),
      [
        ['macOS · Apple silicon', '/download/GOAT-0.1.0-mac-arm64.zip'],
        ['Windows · x64', '/download/GOAT-0.1.0-win-x64.zip'],
      ],
    );
    const download = await win.request('GET', '/download/GOAT-0.1.0-win-x64.zip');
    assert.equal(download.status, 200);
    assert.match(download.headers.get('content-disposition'), /GOAT-0\.1\.0-win-x64\.zip/);
  } finally {
    await win.close();
  }
});

test('with nothing built there are no builds, and the prices still show', async () => {
  const res = await bare.request('GET', '/api/downloads');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.builds, []);
  assert.equal(res.body.version, null);
  assert.equal(res.body.pricing.assistMyr, 0.04);
});

test('the app downloads free while assists still need an x402 payment', async () => {
  const res = await srv.request('GET', '/download/GOAT-0.1.0-mac-arm64.zip');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /^attachment; filename="?GOAT-0\.1\.0-mac-arm64\.zip"?$/);
  assert.equal(res.headers.get('payment-required'), null);
  assert.equal(res.text, zip.toString());
  const assist = await srv.request('POST', '/api/assist', { body: { question: 'how do I log an issue?' }, user: 'site.visitor' });
  assert.equal(assist.status, 402, 'payments are on in this server');
});

test('only builds listed in the manifest and present on disk download', async () => {
  for (const p of ['/download/GOAT-0.1.0-mac-x64.zip', '/download/notes.txt', '/download/latest.json', '/download/..%2Fnotes.txt']) {
    const res = await srv.request('GET', p);
    assert.equal(res.status, 404, p);
    assert.equal(res.body?.error, 'not_found', p);
  }
});

test('the page, GSAP, the fonts and the icon are served from this server', async () => {
  const page = await srv.request('GET', '/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(page.text, /the page/);
  for (const [p, type] of [
    ['/vendor/gsap/gsap.min.js', /javascript/],
    ['/vendor/gsap/ScrollTrigger.min.js', /javascript/],
    ['/vendor/gsap/MorphSVGPlugin.min.js', /javascript/],
    ['/vendor/fonts/bodoni-moda/bodoni-moda-latin-opsz-normal.woff2', /font\/woff2/],
    ['/vendor/fonts/hanken-grotesk/hanken-grotesk-latin-wght-normal.woff2', /font\/woff2/],
    ['/vendor/fonts/playwrite-fr-trad/playwrite-fr-trad-fallback-wght-normal.woff2', /font\/woff2/],
    ['/icon.svg', /image\/svg\+xml/],
  ]) {
    const res = await srv.request('GET', p);
    assert.equal(res.status, 200, p);
    assert.match(res.headers.get('content-type'), type, p);
  }
  for (const p of ['/vendor/fonts/comic-sans/x.woff2', '/vendor/gsap/%2e%2e/package.json', '/vendor/gsap/nope.js']) {
    assert.notEqual((await srv.request('GET', p)).status, 200, p);
  }
});

test('without a page, / says where the downloads are', async () => {
  const res = await bare.request('GET', '/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/plain/);
  assert.match(res.text, /\/api\/downloads/);
});

test('the API still answers JSON, including its 404s', async () => {
  assert.equal((await srv.request('GET', '/api/health')).body.ok, true);
  const missing = await srv.request('GET', '/api/nope');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, 'not_found');
});
