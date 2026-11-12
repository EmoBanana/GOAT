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
// Payments on: every ask in this run is paid with x402 through the app's wallet abstraction.
const srv = await startTestServer({ ollamaUrl: ollama.url, env: { GOAT_PAYMENTS: 'x402-local', GOAT_WELCOME_CREDIT_MYR: '2', MYR_PER_USD: '4.20' } });
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'goat-e2e-'));
const env = {
  ...process.env,
  GOAT_SERVER_URL: srv.url,
  GOAT_USER_DATA: userData,
  GOAT_TEST_HOOKS: '1',
  GOAT_FAKE_WINDOW: 'Google Chrome|Forma Build - Issues',
  GOAT_USER: 'e2e-tester',
  GOAT_FAKE_CAPTURE: '1', // tests can't grant Screen Recording
  GOAT_TRACK_INTERVAL_SEC: '0.2',
  // The app reads the Mac's real idle time: after 5 minutes without input every sample was idle
  // and the timesheet came back empty.
  GOAT_IDLE_SEC: '86400',
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
  // Fake media devices, so nothing asks for the microphone. The voice check below plays a spoken
  // question into the page itself (Electron's fake audio file input stays silent; see Gotchas).
  app = await electron.launch({
    executablePath: electronPath,
    args: [root, '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
    env: { ...env, GOAT_FAKE_MEDIA: '1', GOAT_PTT: 'off' }, // the hold helper needs a real keyboard
    timeout: 30_000,
  });
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
    assert.match(chat.body.messages.at(-1).content, /App: Google Chrome/);
    assert.match(chat.body.messages.at(-1).content, /Window: Forma Build - Issues/);
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

  await check('a highlighted area goes from main to Gemma as an image', async () => {
    ollama.calls.length = 0;
    await app.evaluate(() => globalThis.__goatTest.openAsk());
    await page.waitForSelector('#goat-ask-input', { state: 'visible' });
    await page.mouse.move(300, 300);
    await page.mouse.down();
    await page.mouse.move(500, 450, { steps: 6 });
    await page.mouse.up();
    await until(() => page.evaluate(() => document.querySelector('.ask-context')?.textContent === 'Asking about the highlighted area'), 'the locked highlight');
    await page.keyboard.type('what is this?');
    await page.keyboard.press('Enter');
    await until(() => page.evaluate(() => /read the highlighted area/.test(document.getElementById('goat-bubble').innerText)), 'the answer about the area');
    const [chat] = ollama.chats();
    assert.equal(chat.body.messages.at(-1).images.length, 1);
    assert.match(chat.body.messages.at(-1).content, /highlighted this part of the screen \(200×150 points\)/);
  });

  await check('tracking samples allowlisted windows; stopping shows and approves the timesheet', async () => {
    await app.evaluate(() => globalThis.__goatTest.setFakeWindow('Revit|ALP-GAM-ZZ-XX-M3-S-0001.rvt'));
    await app.evaluate(() => globalThis.__goatTest.toggleTracking());
    await until(() => page.evaluate(() => document.getElementById('goat-cursor').classList.contains('tracking')), 'the red dot');
    await sleep(1700); // about 8 samples at 0.2 s
    await app.evaluate(() => globalThis.__goatTest.toggleTracking());
    await page.waitForSelector('.ts-table', { state: 'visible' });
    assert.match(await page.locator('.ts-table').innerText(), /ALPHA/);
    assert.equal(await page.evaluate(() => document.getElementById('goat-cursor').classList.contains('tracking')), false);
    await page.click('[data-action="approve"]');
    await until(() => page.evaluate(() => document.querySelector('.ts-status')?.textContent === 'Approved'), 'the approval');
    const approved = fs.readdirSync(path.join(srv.dataDir, 'timesheets', 'e2e-tester'));
    assert.equal(approved.length, 1);
    await page.click('[data-action="close"]');
    await app.evaluate(() => globalThis.__goatTest.setFakeWindow('Google Chrome|Forma Build - Issues'));
  });

  await check('asks are paid with x402 through the wallet abstraction; top up and upgrade to Pro', async () => {
    const payer = await app.evaluate(() => globalThis.__goatTest.payer());
    assert.equal(payer.kind, 'local');
    assert.match(payer.address, /^0x[0-9a-fA-F]{40}$/);
    const before = await app.evaluate(() => globalThis.__goatTest.wallet());
    await askThroughMain('how do I log an issue?');
    await until(() => page.evaluate(() => /1¢ paid via x402/.test(document.getElementById('goat-toasts').innerText)), 'the payment toast');
    const after = await app.evaluate(() => globalThis.__goatTest.wallet());
    assert.equal(Math.round((before.balanceUsd - after.balanceUsd) * 100), 1, 'one cent');
    await page.keyboard.press('Escape');
    await app.evaluate(() => globalThis.__goatTest.openAsk());
    await page.waitForSelector('.wallet-chip:not([hidden])', { state: 'visible' });
    await page.click('.wallet-chip');
    await page.waitForSelector('.wallet-balance', { state: 'visible' });
    const balance = await page.locator('.wallet-balance').innerText();
    await page.click('[data-action="topup"]');
    await until(async () => (await page.locator('.wallet-balance').innerText()) !== balance, 'the top-up');
    await page.click('[data-action="upgrade"]');
    await until(() => page.evaluate(() => /You're on GOAT Pro until/.test(document.getElementById('goat-toasts').innerText)), 'the Pro upgrade');
    const me = await srv.request('GET', '/api/me', { user: 'e2e-tester' });
    assert.equal(me.body.tier, 'pro');
    await page.screenshot({ path: path.join(artifacts, 'electron-wallet.png') });
    await page.click('[data-action="close"]');
  });

  await check('voice (Pro): hold to talk, transcribe through main, play a guide; a screen question carries the screen', async () => {
    // The microphone hears a recorded "how do I log an issue" on a loop; the rest of the
    // pipeline (capture, speech check, 16 kHz WAV, main, server) is the real one.
    const wav = fs.readFileSync(path.join(root, 'scripts', 'fixtures', 'question.wav')).toString('base64');
    await page.evaluate(async (b64) => {
      const ctx = new AudioContext();
      await ctx.resume();
      const source = ctx.createBufferSource();
      source.buffer = await ctx.decodeAudioData(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer);
      source.loop = true;
      const out = ctx.createMediaStreamDestination();
      source.connect(out);
      source.start();
      navigator.mediaDevices.getUserMedia = async () => out.stream.clone();
    }, wav);
    ollama.calls.length = 0;
    ollama.state.transcript = 'How do I log an issue?';
    await app.evaluate(() => globalThis.__goatTest.voiceHold(true));
    await until(() => page.evaluate(() => document.getElementById('goat-cursor').dataset.voice === 'listening'), 'listening');
    await sleep(1500);
    await app.evaluate(() => globalThis.__goatTest.voiceHold(false));
    try {
      await until(
        () => page.evaluate(() => window.GOATUI.state().guide?.id === 'forma-log-issue' && window.GOATUI.state().guide.landed),
        'the transcript "How do I log an issue?" to play the guide',
        15_000,
      );
    } catch (err) {
      const seen = await page.evaluate(() => ({ bubble: document.getElementById('goat-bubble').innerText, hud: document.getElementById('goat-cursor').dataset.voice, last: window.GOATVoice.lastTurn() }));
      throw new Error(`${err.message}; bubble: ${JSON.stringify(seen)}; Ollama calls: ${ollama.chats().length}`);
    }
    const audioCall = ollama.chats().find((c) => c.body.messages?.some((m) => m.content === 'Transcribe this audio.'));
    assert.ok(audioCall, 'the WAV reached Gemma');
    const wavB64 = audioCall.body.messages.at(-1).images[0];
    assert.equal(Buffer.from(wavB64, 'base64').toString('latin1', 8, 12), 'WAVE');
    await page.keyboard.press('Escape');

    ollama.calls.length = 0;
    ollama.state.transcript = 'What am I looking at here?';
    await app.evaluate(() => globalThis.__goatTest.voiceHold(true));
    await sleep(1500);
    await app.evaluate(() => globalThis.__goatTest.voiceHold(false));
    await until(() => page.evaluate(() => /You said “What am I looking at here\?”/.test(document.getElementById('goat-bubble').innerText)), 'the spoken answer', 15_000);
    const ask = ollama.chats().find((c) => c.body.messages?.at(-1)?.content?.startsWith("This picture shows the user's screen"));
    assert.ok(ask, 'the question went to Gemma with the screen around the pointer');
    assert.equal(ask.body.messages.at(-1).images.length, 1);
    assert.match(ask.body.messages[0].content, /spoken aloud/);
    await page.screenshot({ path: path.join(artifacts, 'electron-voice.png') });
  });

  await check('GOAT-compatible: a drafted guide gets its positions from the recorder and plays when asked', async () => {
    const drafted = {
      title: 'Open a markup in Bluebeam',
      triggers: ['open a markup', 'find a markup'],
      intro: 'Two clicks. Follow the blue cursor.',
      steps: [
        { label: 'Markups', say: 'Open the Markups list.' },
        { label: 'Filter', say: 'Filter by your name.' },
      ],
    };
    ollama.state.reply = (body) => (body.format ? JSON.stringify(drafted) : 'Photos are the evidence for every issue.');
    await app.evaluate(() => globalThis.__goatTest.openDraft());
    await page.waitForSelector('.draft-text', { state: 'visible' });
    await page.fill('.draft-text', 'Bluebeam: open the Markups list, then filter by your name.');
    await page.click('[data-action="draft"]');
    await page.waitForSelector('[data-action="record"]:not([hidden])');
    await page.click('[data-action="record"]');
    await until(() => app.evaluate(() => globalThis.__goatTest.recording().recording), 'the recording to start');
    await app.evaluate(() => globalThis.__goatTest.captureStep({ x: 300, y: 200 }));
    await app.evaluate(() => globalThis.__goatTest.captureStep({ x: 500, y: 260 }));
    await app.evaluate(() => globalThis.__goatTest.toggleRecording());
    await page.waitForSelector('.rec-form', { state: 'visible' });
    assert.equal(await page.inputValue('[name="title"]'), 'Open a markup in Bluebeam');
    await page.click('.rec-form button[type="submit"]');
    await until(() => page.evaluate(() => /Saved "Open a markup in Bluebeam"/.test(document.getElementById('goat-toasts').innerText)), 'the saved toast');
    await askThroughMain('how do I find a markup?');
    await until(
      () => page.evaluate(() => window.GOATUI.state().guide?.id === 'open-a-markup-in-bluebeam' && window.GOATUI.state().guide.landed),
      'the drafted guide to play',
    );
    assert.match(await page.locator('#goat-bubble').innerText(), /Open the Markups list\./);
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
