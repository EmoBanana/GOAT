// End-to-end check of the real Electron app against an in-process test server (mock Ollama).
// npm run test:electron. The overlay briefly appears on screen and takes focus.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';
import { _electron as electron } from 'playwright';
import { DEFAULT_MODEL } from '../server/src/config.js';
import { startMockOllama } from '../server/test/helpers/mock-ollama.js';
import { startTestServer } from '../server/test/helpers/test-server.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const artifacts = path.join(root, 'test-artifacts');
fs.mkdirSync(artifacts, { recursive: true });

const ollama = await startMockOllama({ reply: () => 'Photos are the evidence for every issue.' });
const srv = await startTestServer({ ollamaUrl: ollama.url });
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'goat-e2e-'));
const env = {
  ...process.env,
  GOAT_SERVER_URL: srv.url,
  GOAT_USER_DATA: userData,
  GOAT_TEST_HOOKS: '1',
  GOAT_FAKE_WINDOW: 'Google Chrome|Forma Build - Issues',
  GOAT_USER: 'e2e-tester',
};
delete env.ELECTRON_RUN_AS_NODE; // see Gotchas: VS Code extension shells set it

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
async function until(fn, what, timeout = 8000) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(50);
  }
}

let app;
const pageErrors = [];
try {
  app = await electron.launch({ executablePath: electronPath, args: [root], env, timeout: 30_000 });
  app.process().stderr?.on('data', (d) => process.stderr.write(`[app] ${d}`));
  const page = await app.firstWindow();
  page.on('pageerror', (err) => pageErrors.push(err.message));
  await page.waitForFunction(() => window.GOATUI && window.GOATUI.ready);

  async function askThroughMain(question) {
    await app.evaluate(() => globalThis.__goatTest.openAsk());
    await page.waitForSelector('#goat-ask-input', { state: 'visible' });
    await page.fill('#goat-ask-input', question);
    await page.press('#goat-ask-input', 'Enter');
  }

  await check('the overlay window is visible and always on top', async () => {
    const s = await until(async () => {
      const w = await app.evaluate(() => globalThis.__goatTest.windowState());
      return w.visible && w;
    }, 'the window to show');
    assert.equal(s.onTop, true);
    assert.equal(s.level, 'modal-panel', 'below the macOS Screenshot UI');
    assert.ok(s.bounds.width > 0 && s.bounds.height > 0);
  });

  await check('a guide reply comes back through main and plays', async () => {
    await askThroughMain('how do I log an issue?');
    await until(() => page.evaluate(() => window.GOATUI.state().guide?.landed === true), 'the cursor to land on step 1');
    const text = await page.locator('#goat-bubble').innerText();
    assert.match(text, /Step 1 of 7/);
    assert.match(text, /Open Issues from the left menu\./);
    assert.deepEqual(await app.evaluate(() => globalThis.__goatTest.askContext()), { app: 'Google Chrome', title: 'Forma Build - Issues', url: '' });
    await page.screenshot({ path: path.join(artifacts, 'electron-guide.png') });
    await page.keyboard.press('Escape');
    await until(() => page.evaluate(() => window.GOATUI.state().guide === null), 'the guide to stop');
  });

  await check('an LLM reply comes back through main with the ask context', async () => {
    ollama.calls.length = 0;
    await askThroughMain('Why do issues need a photo?');
    await until(() => page.evaluate(() => /evidence/.test(document.getElementById('goat-bubble').innerText)), 'the answer bubble');
    assert.ok((await page.locator('#goat-bubble').innerText()).includes(`${DEFAULT_MODEL} · running on this laptop`));
    const [chat] = ollama.chats();
    assert.match(chat.body.messages[1].content, /App: Google Chrome/);
    assert.match(chat.body.messages[1].content, /Window: Forma Build - Issues/);
    await page.screenshot({ path: path.join(artifacts, 'electron-llm.png') });
  });

  await check('the answer bubble follows the cursor in the real app', async () => {
    await app.evaluate(() => globalThis.__goatTest.sendCursor(400, 300));
    const placed = () =>
      page.evaluate(() => {
        const b = document.getElementById('goat-bubble');
        return { x: parseFloat(b.style.left), y: parseFloat(b.style.top), hidden: b.hidden };
      });
    // Blue tip settles at +14, +16; the bubble sits +24, +22 from the tip.
    await until(async () => {
      const b = await placed();
      return !b.hidden && Math.abs(b.x - 438) <= 1 && Math.abs(b.y - 338) <= 1;
    }, 'the bubble to reach (438, 338)');
    await app.evaluate(() => globalThis.__goatTest.sendCursor(700, 500));
    await until(async () => {
      const b = await placed();
      return Math.abs(b.x - 738) <= 1 && Math.abs(b.y - 538) <= 1;
    }, 'the bubble to follow to (738, 538)');
  });

  await check('recording a guide with the hotkeys saves it, and asking for it plays it', async () => {
    await app.evaluate(() => globalThis.__goatTest.toggleRecording());
    await page.waitForSelector('.rec-hud', { state: 'visible' });
    await app.evaluate(() => globalThis.__goatTest.captureStep({ x: 220, y: 310 }));
    await app.evaluate(() => globalThis.__goatTest.captureStep({ x: 640, y: 420 }));
    await until(() => page.evaluate(() => document.querySelectorAll('.rec-marker').length === 2), 'two markers');
    await app.evaluate(() => globalThis.__goatTest.toggleRecording());
    await page.waitForSelector('.rec-form', { state: 'visible' });
    await page.fill('[name="title"]', 'Export a PDF in Bluebeam');
    await page.fill('[name="triggers"]', 'export a pdf, save as pdf');
    await page.fill('[name="say-0"]', 'Open the File menu.');
    await page.click('.rec-form button[type="submit"]');
    await until(() => page.evaluate(() => /Saved "Export a PDF in Bluebeam"/.test(document.getElementById('goat-toasts').innerText)), 'the saved toast');
    const saved = await srv.request('GET', '/api/guides/export-a-pdf-in-bluebeam');
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.apps, ['Google Chrome'], 'the app that was frontmost when recording started');
    assert.deepEqual(saved.body.steps.map((s) => [s.x, s.y]), [[220, 310], [640, 420]]);
    await askThroughMain('how do I save as pdf?');
    await until(
      () => page.evaluate(() => window.GOATUI.state().guide?.id === 'export-a-pdf-in-bluebeam' && window.GOATUI.state().guide.landed),
      'the recorded guide to play',
    );
    assert.match(await page.locator('#goat-bubble').innerText(), /Open the File menu\./);
    await page.keyboard.press('Escape');
  });

  await check('no page errors', async () => {
    assert.deepEqual(pageErrors, []);
  });
} catch (err) {
  failed += 1;
  console.log(`FAIL  launching the app\n      ${err.stack || err.message}`);
} finally {
  if (app) await app.close().catch(() => {});
  await srv.close();
  await ollama.close();
  fs.rmSync(userData, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} Electron check(s) failed.` : '\nAll Electron checks passed.');
process.exit(failed ? 1 : 0);
