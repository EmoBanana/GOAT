// npm test (in web/), after npm run build: serves web/out from a real GOAT test server with stand-in
// zips for each build in a temp dist/, and checks the page in Chromium.
// Screenshots go to ../test-artifacts/web-*.png.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { startTestServer } from '../../server/test/helpers/test-server.js';
import { isLocal } from '../lib/format.js';

const { chromium } = createRequire(new URL('../../package.json', import.meta.url))('playwright');
const web = fileURLToPath(new URL('..', import.meta.url));
const out = path.join(web, 'out');
const data = JSON.parse(fs.readFileSync(path.join(web, 'data', 'downloads.json'), 'utf8'));
const artifacts = path.join(web, '..', 'test-artifacts');
fs.mkdirSync(artifacts, { recursive: true });
const shot = (name) => path.join(artifacts, `web-${name}.png`);
if (!fs.existsSync(path.join(out, 'index.html'))) {
  console.error('No build in web/out. Run: npm run build');
  process.exit(1);
}
const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
// The page should stay short: one screen of hero, then three grouped sections.
const MAX_PAGE_HEIGHT = 4200;

// Stand-in zips under the names the page was built with.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'goat-web-ui-'));
const zips = {};
for (const b of data.builds) {
  zips[b.platform] = Buffer.from(`PK pretend GOAT for ${b.platform}`);
  fs.writeFileSync(path.join(tmp, b.file), zips[b.platform]);
}
fs.writeFileSync(path.join(tmp, 'latest.json'), JSON.stringify({ name: 'GOAT', version: data.version, builds: data.builds.map((b) => ({ ...b, bytes: zips[b.platform].length })) }));
const srv = await startTestServer({ env: { GOAT_SITE_DIR: out, GOAT_DIST_DIR: tmp } });
const browser = await chromium.launch();

let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL  ${name}\n      ${String(err.message).split('\n').join('\n      ')}`);
  }
}
async function until(fn, what, timeout = 12000) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(50);
  }
}
async function open(options = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true, ...options });
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => msg.type() === 'error' && problems.push(`console: ${msg.text()}`));
  page.on('response', (res) => res.status() >= 400 && problems.push(`HTTP ${res.status()}: ${res.url()}`));
  await page.goto(srv.url);
  await page.evaluate(() => document.fonts.ready);
  return { context, page, problems };
}
const centre = (box) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
const near = (a, b, tol = 2) => Math.hypot(a.x - b.x, a.y - b.y) <= tol;
const heroButtons = (page) => page.$$eval('.hero [data-download]', (as) => as.map((a) => ({ platform: a.dataset.download, plain: a.classList.contains('btn-plain'), href: a.getAttribute('href') })));

try {
  const { context, page, problems } = await open();

  await check('the page loads its fonts, the cup logo, and has no errors', async () => {
    const families = await page.evaluate(() => [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family));
    assert.ok(families.some((f) => /archivo/i.test(f)), `Archivo loaded (${families.join(', ')})`);
    assert.ok(families.some((f) => /plex/i.test(f)), 'IBM Plex Mono loaded');
    assert.equal(await page.locator('.wordmark .logo').count(), 1);
    assert.match(await page.getAttribute('link[rel="icon"]', 'href'), /icon\.svg/);
    await sleep(600);
    await page.screenshot({ path: shot('01-hero') });
    assert.deepEqual(problems, []);
  });

  await check('on a Mac the Mac download comes first; Windows is beside it', async () => {
    await until(async () => (await page.locator('.hero a[data-download]').count()) === 2, 'both download links');
    const buttons = await heroButtons(page);
    assert.deepEqual(
      buttons.map((b) => [b.platform, b.plain]),
      [
        ['darwin', false],
        ['win32', true],
      ],
    );
    for (const b of buttons) assert.match(b.href, /^\/download\/GOAT-/, 'served by this GOAT server');
  });

  await check('the demo plays the guide: the tip lands on Create issue, ring centred, bubble says the step', async () => {
    await until(() => page.locator('.demo-stage').getAttribute('data-step').then((s) => s === '2'), 'step 2 of the demo');
    await sleep(300);
    const target = centre(await page.locator('[data-target="create"]').boundingBox());
    const tip = await page.locator('.demo-cursor').boundingBox();
    assert.ok(near({ x: tip.x, y: tip.y }, target), `the tip is on the button (${tip.x},${tip.y} vs ${target.x},${target.y})`);
    const ring = await page.locator('.demo-ring').boundingBox();
    assert.ok(near({ x: ring.x, y: ring.y }, target), 'the ring is centred on the button');
    const bubble = await page.locator('.demo-bubble').innerText();
    assert.match(bubble, /Click Create issue at the top right\./);
    assert.match(bubble, /Step 2 of 7/);
    await page.screenshot({ path: shot('02-demo-step2') });
  });

  await check('Pause stops the demo and Play carries on', async () => {
    const button = page.locator('.demo-bar button');
    await button.click();
    assert.equal(await button.getAttribute('aria-pressed'), 'true');
    const before = await page.locator('.demo-stage').getAttribute('data-step');
    await sleep(2600);
    assert.equal(await page.locator('.demo-stage').getAttribute('data-step'), before, 'no step went by while paused');
    await button.click();
    await until(async () => (await page.locator('.demo-stage').getAttribute('data-step')) !== before, 'the next step after Play');
  });

  await check('three grouped sections, and the page stays short', async () => {
    const ids = await page.$$eval('main > section', (els) => els.map((el) => el.id || el.className));
    assert.deepEqual(ids, ['hero', 'how', 'pricing', 'download']);
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    assert.ok(height <= MAX_PAGE_HEIGHT, `the page is ${height}px tall (at most ${MAX_PAGE_HEIGHT})`);
    for (const [id, name] of [
      ['#how', '03-how'],
      ['#pricing', '04-pricing'],
      ['#download', '05-download'],
    ]) {
      await page.evaluate((sel) => document.querySelector(sel).scrollIntoView({ block: 'start', behavior: 'instant' }), id);
      await sleep(id === '#pricing' ? 4200 : 500);
      await page.screenshot({ path: shot(name) });
    }
    const arrows = await page.$$eval('.flow-arrow', (els) => els.map((el) => getComputedStyle(el).transform));
    assert.ok(arrows.some((t) => t === 'none' || /matrix\(1, /.test(t)), 'the payment arrows draw while on screen');
    assert.equal(await page.locator('.price').innerText(), `RM ${data.pricing.assistMyr.toFixed(2)}`);
  });

  await check('each platform card downloads its own zip from this GOAT server', async () => {
    for (const b of data.builds) {
      const button = page.locator(`.platform [data-download="${b.platform}"]`);
      const [download] = await Promise.all([page.waitForEvent('download'), button.click()]);
      assert.equal(download.suggestedFilename(), b.file);
      assert.equal(fs.readFileSync(await download.path()).toString(), zips[b.platform].toString());
    }
  });

  await check('served by the GOAT server itself, the page doesn’t say the server is down', async () => {
    assert.equal(await page.locator('[data-server-note]').count(), 0);
  });

  await check('no errors on the way down', async () => {
    assert.deepEqual(problems, []);
  });
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.screenshot({ path: shot('09-full'), fullPage: true });
  await context.close();

  await check('on another host (like Vercel) an unpublished build says so instead of linking to a 404', async () => {
    // Chromium resolves goat.test to this test server, so the page isn't on localhost.
    const away = await chromium.launch({ args: ['--host-resolver-rules=MAP goat.test 127.0.0.1'] });
    try {
      const p = await away.newPage();
      await p.goto(srv.url.replace('127.0.0.1', 'goat.test'));
      await p.waitForLoadState('networkidle');
      const unpublished = data.builds.filter((b) => !b.url);
      const labels = await p.$$eval('.hero [data-download]', (els) => els.map((el) => ({ tag: el.tagName, disabled: el.getAttribute('aria-disabled'), text: el.textContent })));
      assert.equal(labels.length, data.builds.length);
      for (const l of labels.filter((x) => unpublished.length && x.disabled)) assert.match(l.text, /not published yet/);
      assert.equal(labels.filter((l) => l.tag === 'A').length, data.builds.length - unpublished.length, 'only published builds are links');
    } finally {
      await away.close();
    }
  });

  await check('on another host, builds for a server on your own computer say GOAT’s server isn’t online', async () => {
    const away = await chromium.launch({ args: ['--host-resolver-rules=MAP goat.test 127.0.0.1'] });
    try {
      for (const viewport of [{ width: 1280, height: 800 }, { width: 375, height: 760 }]) {
        const p = await away.newPage({ viewport });
        await p.goto(srv.url.replace('127.0.0.1', 'goat.test'));
        await p.waitForLoadState('networkidle');
        const notes = await p.$$eval('[data-server-note]', (els) => els.map((el) => el.textContent));
        if (!isLocal(data.builds[0].serverUrl)) {
          assert.deepEqual(notes, [], 'builds for a hosted server need no note');
        } else {
          assert.equal(notes.length, 2, 'one by the hero buttons, one above the platform cards');
          for (const text of notes) assert.match(text, /^GOAT’s server isn’t online right now\./);
          assert.ok(await p.locator('.hero [data-server-note]').isVisible(), 'the hero note shows');
        }
        const sideways = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        assert.ok(sideways <= 0, `no sideways scrolling at ${viewport.width}px (${sideways}px over)`);
        await p.screenshot({ path: shot(`10-away-${viewport.width}`), animations: 'disabled' });
        await p.close();
      }
    } finally {
      await away.close();
    }
  });

  await check('on Windows the Windows download comes first', async () => {
    const { context: c, page: p } = await open({ userAgent: WINDOWS_UA });
    await until(async () => (await heroButtons(p))[0]?.platform === 'win32', 'the Windows button to lead');
    assert.deepEqual(
      (await heroButtons(p)).map((b) => [b.platform, b.plain]),
      [
        ['win32', false],
        ['darwin', true],
      ],
    );
    await c.close();
  });

  await check('reduced motion: one still frame of the guide, everything visible', async () => {
    const { context: c, page: p, problems: pr } = await open({ reducedMotion: 'reduce' });
    await until(() => p.locator('.demo-stage').getAttribute('data-step').then((s) => s === '2'), 'the still frame');
    assert.match(await p.locator('.demo-bubble').innerText(), /Click Create issue/);
    const steps = await p.$$eval('.flow-words', (els) => els.map((el) => getComputedStyle(el).opacity));
    assert.deepEqual(steps, ['1', '1', '1', '1'], 'the whole payment exchange shows');
    assert.deepEqual(pr, []);
    await c.close();
  });

  await check('phone width: no sideways scrolling, the demo fits, the step reads under it', async () => {
    const { context: c, page: p, problems: pr } = await open({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 0, `the page is ${overflow}px wider than the screen`);
    const frame = await p.locator('.demo-frame').boundingBox();
    assert.ok(frame.width <= 390 - 16, 'the demo fits inside the gutters');
    await until(() => p.locator('.demo-stage').getAttribute('data-step').then((s) => s === '2'), 'step 2 on the phone');
    assert.equal(await p.locator('.demo-say').innerText(), 'Click Create issue at the top right.');
    await p.screenshot({ path: shot('11-phone') });
    await p.screenshot({ path: shot('12-phone-full'), fullPage: true });
    assert.deepEqual(pr, []);
    await c.close();
  });
} finally {
  await browser.close();
  await srv.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} check(s) failed.` : '\nAll page checks passed. Screenshots in test-artifacts/web-*.png.');
process.exit(failed ? 1 : 0);
