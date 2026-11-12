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
import { startMockElevenLabs } from '../server/test/helpers/mock-elevenlabs.js';
import { startMockOllama } from '../server/test/helpers/mock-ollama.js';
import { startTestServer } from '../server/test/helpers/test-server.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const artifacts = path.join(root, 'test-artifacts');
fs.mkdirSync(artifacts, { recursive: true });
// GOAT_E2E_APP=dist/mac-arm64/GOAT.app runs these checks against the packaged app (npm run test:package).
const packagedApp = process.env.GOAT_E2E_APP ? path.resolve(process.env.GOAT_E2E_APP) : null;
const shot = (name) => path.join(artifacts, packagedApp ? name.replace(/^electron-/, 'packaged-') : name);

const ollama = await startMockOllama({ reply: () => 'Photos are the evidence for every issue.' });
const eleven = await startMockElevenLabs(); // GOAT's voice: answers a clip too quiet to hear
// Payments on: every ask in this run is paid with x402 through the app's wallet abstraction.
const srv = await startTestServer({
  ollamaUrl: ollama.url,
  env: { GOAT_PAYMENTS: 'x402-local', GOAT_WELCOME_CREDIT_MYR: '2', MYR_PER_USD: '4.20', ELEVENLABS_API_KEY: 'test-key', ELEVENLABS_BASE_URL: eleven.url },
});
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'goat-e2e-'));
const env = {
  ...process.env,
  GOAT_SERVER_URL: srv.url,
  GOAT_USER_DATA: userData,
  GOAT_TEST_HOOKS: '1',
  GOAT_FAKE_WINDOW: 'Google Chrome|Forma Build - Issues',
  GOAT_FAKE_OPENS: '', // "show me" opens no real app or website here; a check names the window that comes up
  GOAT_USER: 'e2e-tester',
  GOAT_FAKE_CAPTURE: '1', // tests can't grant Screen Recording
  GOAT_TRACK_INTERVAL_SEC: '0.2',
  // The app reads the Mac's real idle time: after 5 minutes without input every sample was idle
  // and the timesheet came back empty.
  GOAT_IDLE_SEC: '86400',
  GOAT_SIGN_IN_POLL_MS: '100',
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
    executablePath: packagedApp ? path.join(packagedApp, 'Contents', 'MacOS', 'GOAT') : electronPath,
    args: [...(packagedApp ? [] : [root]), '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
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

  let offlineWallet = null;
  await check('first launch asks you to sign in; Continue offline gets you going', async () => {
    await page.waitForSelector('.panel-welcome', { state: 'visible' });
    assert.equal((await app.evaluate(() => globalThis.__goatTest.account())).signedIn, false);
    await page.screenshot({ path: shot('electron-welcome.png') });
    await page.click('[data-action="offline"]');
    const info = await until(async () => {
      const a = await app.evaluate(() => globalThis.__goatTest.account());
      return a.signedIn && a;
    }, 'the offline account');
    assert.deepEqual(info.account, { method: 'local', label: 'This laptop', how: 'Offline account on this laptop', short: '' });
    assert.equal(info.userId, 'e2e-tester', 'GOAT_USER still names the user');
    await until(() => page.evaluate(() => window.GOATUI.state().panel === null), 'the welcome panel to close');
    offlineWallet = (await app.evaluate(() => globalThis.__goatTest.payer())).address;
    await page.keyboard.press('Escape');
  });

  await check('the overlay window is visible and always on top', async () => {
    const s = await until(async () => {
      const w = await app.evaluate(() => globalThis.__goatTest.windowState());
      return w.visible && w;
    }, 'the window to show');
    assert.equal(s.onTop, true);
    assert.equal(s.level, 'modal-panel', 'below the macOS Screenshot UI');
    assert.ok(s.bounds.width > 0 && s.bounds.height > 0);
  });

  await check(`the ${packagedApp ? 'packaged' : 'dev'} app talks to the server it's given`, async () => {
    const info = await app.evaluate(() => globalThis.__goatTest.info());
    assert.equal(info.packaged, Boolean(packagedApp));
    assert.equal(info.serverUrl, srv.url, 'GOAT_SERVER_URL beats the URL baked into a build');
    if (packagedApp) assert.match(info.build.serverUrl, /^https?:\/\//, 'the build names the server it was made for');
  });

  await check('a guide reply comes back through main and plays', async () => {
    await askThroughMain('how do I log an issue?');
    await until(() => page.evaluate(() => window.GOATUI.state().guide?.landed === true), 'the cursor to land on step 1');
    const text = await page.locator('#goat-bubble').innerText();
    assert.match(text, /Step 1 of 7/);
    assert.match(text, /Open Issues from the left menu\./);
    assert.deepEqual(await app.evaluate(() => globalThis.__goatTest.askContext()), { app: 'Google Chrome', title: 'Forma Build - Issues', url: '' });
    await page.screenshot({ path: shot('electron-guide.png') });
    await page.keyboard.press('Escape');
    await until(() => page.evaluate(() => window.GOATUI.state().guide === null), 'the guide to stop');
  });

  await check('an LLM reply comes back through main with the ask context', async () => {
    ollama.calls.length = 0;
    await askThroughMain('Why do issues need a photo?');
    await until(() => page.evaluate(() => /evidence/.test(document.getElementById('goat-bubble').innerText)), 'the answer bubble');
    assert.doesNotMatch(await page.locator('#goat-bubble').innerText(), /running on|gemma|x402/i, 'answers carry no credit line');
    const [chat] = ollama.chats();
    assert.match(chat.body.messages.at(-1).content, /App: Google Chrome/);
    assert.match(chat.body.messages.at(-1).content, /Window: Forma Build - Issues/);
    await page.screenshot({ path: shot('electron-llm.png') });
  });

  await check('a follow-up continues the chat: the ask panel shows it and Gemma sees the earlier exchange', async () => {
    ollama.calls.length = 0;
    await app.evaluate(() => globalThis.__goatTest.openAsk());
    await page.waitForSelector('.ask-thread', { state: 'visible' });
    assert.match(await page.locator('.ask-thread').innerText(), /Why do issues need a photo\?/);
    assert.doesNotMatch(await page.locator('.ask-thread').innerText(), /evidence/, 'folded to its last question');
    await page.click('[data-action="toggle-thread"]');
    assert.match(await page.locator('.ask-thread').innerText(), /Why do issues need a photo\?[\s\S]*evidence/);
    await page.fill('#goat-ask-input', 'and who checks the fix?');
    await page.press('#goat-ask-input', 'Enter');
    await until(() => ollama.chats().length === 1, 'the follow-up to reach Gemma');
    const contents = ollama.chats()[0].body.messages.map((m) => m.content);
    assert.ok(contents.includes('Why do issues need a photo?'), 'the earlier question went with it');
    const chat = await until(() => page.evaluate(() => (window.GOATUI.chat()?.turns.length === 3 ? window.GOATUI.chat() : null)), 'three turns in the chat');
    assert.equal(chat.turns[0].source, 'guide');
    // The answer bubble stays up for the next check.
    await until(() => page.evaluate(() => !document.getElementById('goat-bubble').hidden), 'the follow-up answer');
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

  const tipAt = () =>
    page.evaluate(() => {
      const r = document.getElementById('goat-cursor').getBoundingClientRect();
      return { x: r.left, y: r.top };
    });
  const setTargets = (elements) => app.evaluate((_electron, value) => globalThis.__goatTest.setFakeTargets(value), elements ? JSON.stringify({ elements }) : '');

  await check('GOAT works out a guide from the controls on screen, and finds each control where it is now', async () => {
    const screenNow = [
      { label: 'Issues', role: 'link', x: 20, y: 300, w: 120, h: 32 },
      { label: 'Filters', role: 'button', x: 600, y: 200, w: 100, h: 30 },
    ];
    await setTargets(screenNow);
    const before = ollama.state.reply;
    const plan = { intro: "Here's how to filter issues by assignee.", steps: [{ target: 'Filters', say: 'Click Filters.' }, { target: 'Assignee', say: 'Pick the assignee.' }] };
    ollama.state.reply = (body) => (body.format ? JSON.stringify(plan) : before(body));
    try {
      ollama.calls.length = 0;
      await askThroughMain('how do I filter issues by assignee?');
      await until(() => page.evaluate(() => window.GOATUI.state().guide?.index === 0 && window.GOATUI.state().guide.landed), 'the planned guide');
      const planned = ollama.chats().find((c) => c.body.format);
      assert.ok(planned.body.messages.at(-1).content.includes('- "Filters" button'), 'Gemma saw the controls on screen');
      assert.equal(await page.evaluate(() => window.GOATUI.state().guide.located), 'live');
      let tip = await tipAt();
      assert.ok(Math.abs(tip.x - 650) <= 1 && Math.abs(tip.y - 215) <= 1, `on Filters: ${JSON.stringify(tip)}`);
      // Clicking Filters opens a menu with Assignee in it; the next step finds it there.
      await setTargets([...screenNow, { label: 'Assignee', role: 'option', x: 600, y: 260, w: 140, h: 28 }]);
      await page.click('#goat-bubble .next');
      await until(() => page.evaluate(() => window.GOATUI.state().guide?.index === 1 && window.GOATUI.state().guide.landed), 'the second step');
      tip = await tipAt();
      assert.ok(Math.abs(tip.x - 670) <= 1 && Math.abs(tip.y - 274) <= 1, `on Assignee: ${JSON.stringify(tip)}`);
      await page.screenshot({ path: shot('electron-planned-guide.png') });
      await page.keyboard.press('Escape');
    } finally {
      ollama.state.reply = before;
      await setTargets(null);
    }
  });

  await check('"show me" opens the app or website it names, then the cursor shows the steps there', async () => {
    const hooks = (fn, value) => app.evaluate((_electron, [name, v]) => globalThis.__goatTest[name](v), [fn, value]);
    await setTargets([
      { label: 'Search', role: 'combobox', x: 400, y: 380, w: 560, h: 44 },
      { label: 'Google Search', role: 'button', x: 520, y: 460, w: 140, h: 36 },
    ]);
    await hooks('setFakeWindow', 'Antigravity IDE|main.js — goat');
    await hooks('setFakeOpen', 'Microsoft Edge|Google|https://www.google.com/');
    const before = ollama.state.reply;
    const plan = { possible: true, intro: "Here's how to search on Google.", steps: [{ target: 'Search', say: 'Click the search box and type what you want.' }, { target: 'Google Search', say: 'Then click Google Search.' }] };
    ollama.state.reply = (body) => (body.format ? JSON.stringify(plan) : before(body));
    try {
      ollama.calls.length = 0;
      // "Show me" in the middle of the question, as people say it.
      await askThroughMain('I want to search on google, can you show me how?');
      await until(() => page.evaluate(() => window.GOATUI.state().guide?.index === 0 && window.GOATUI.state().guide.landed), 'the guide on Google');
      assert.deepEqual(await app.evaluate(() => globalThis.__goatTest.opened()), ['https://www.google.com/']);
      // The ask's steps are on disk for when a guide doesn't come: apps, counts and timings only.
      const trail = fs.readFileSync(path.join(userData, 'goat.log'), 'utf8').trim().split('\n').at(-1);
      assert.match(trail, /ask \(show me\) with Antigravity IDE in front \| opened Google: up in Microsoft Edge after \d+ ms \| 2 controls \| guide planned, 2 steps, \d+ ms$/);
      assert.doesNotMatch(fs.readFileSync(path.join(userData, 'goat.log'), 'utf8'), /search on google|main\.js|google\.com/i, 'no questions, window titles or addresses');
      const planned = ollama.chats().find((c) => c.body.format);
      assert.match(planned.body.messages.at(-1).content, /^App: Microsoft Edge · Window: Google/, 'planned on the page it opened');
      assert.ok(planned.body.messages.at(-1).content.includes('- "Search" combobox'));
      const tip = await tipAt();
      assert.ok(Math.abs(tip.x - 680) <= 1 && Math.abs(tip.y - 402) <= 1, `on the search box: ${JSON.stringify(tip)}`);
      await page.screenshot({ path: shot('electron-show-me.png') });
      await page.keyboard.press('Escape');
      // Asking how (not to be shown) with the IDE in front opens nothing and answers in words.
      await hooks('setFakeWindow', 'Antigravity IDE|main.js — goat');
      ollama.calls.length = 0;
      await askThroughMain('how do I search on google?');
      await until(() => page.evaluate(() => !document.getElementById('goat-bubble').hidden && !window.GOATUI.state().guide), 'the answer in words');
      assert.deepEqual(await app.evaluate(() => globalThis.__goatTest.opened()), ['https://www.google.com/'], 'nothing else opened');
      assert.ok(ollama.chats().every((c) => !c.body.format), 'not planned on the IDE');
      await page.keyboard.press('Escape');
      // Asked to be shown, but the app's controls can't be read: GOAT says why it answered in words.
      await setTargets(null);
      await askThroughMain('show me how to open the terminal');
      await until(() => page.evaluate(() => /can't see the buttons in Antigravity IDE/.test(document.getElementById('goat-toasts').innerText)), 'the notice');
      await until(() => page.evaluate(() => !document.getElementById('goat-bubble').hidden && !window.GOATUI.state().guide), 'the answer in words');
      assert.match(fs.readFileSync(path.join(userData, 'goat.log'), 'utf8').trim().split('\n').at(-1), /ask \(show me\) with Antigravity IDE in front \| no controls \(not readable\) \| answered in words, \d+ ms$/);
      await page.keyboard.press('Escape');
    } finally {
      ollama.state.reply = before;
      await setTargets(null);
      await hooks('setFakeOpen', '');
      await hooks('setFakeWindow', env.GOAT_FAKE_WINDOW);
    }
  });

  await check('a recorded guide finds its control again after the screen changes, as at another resolution', async () => {
    const exportAt = (x, y) => [{ label: 'Export', role: 'button', x, y, w: 100, h: 30 }];
    await setTargets(exportAt(400, 100));
    try {
      await app.evaluate(() => globalThis.__goatTest.toggleRecording());
      await app.evaluate(() => globalThis.__goatTest.captureStep({ x: 450, y: 115 }));
      await until(() => page.evaluate(() => /“Export”/.test(document.querySelector('.rec-hud')?.innerText || '')), 'the control name in the HUD');
      await app.evaluate(() => globalThis.__goatTest.toggleRecording());
      await page.waitForSelector('.rec-form', { state: 'visible' });
      assert.equal(await page.inputValue('[name="label-0"]'), 'Export');
      await page.fill('[name="title"]', 'Export the issue list');
      await page.fill('[name="triggers"]', 'export the issue list');
      await page.click('.rec-form button[type="submit"]');
      await until(() => page.evaluate(() => /Saved "Export the issue list"/.test(document.getElementById('goat-toasts').innerText)), 'the saved toast');
      const saved = await srv.request('GET', '/api/guides/export-the-issue-list');
      assert.deepEqual(saved.body.steps[0].target, { label: 'Export', role: 'button' });
      // The same app at another resolution: the button is somewhere else now.
      await setTargets(exportAt(900, 500));
      await askThroughMain('how do I export the issue list?');
      await until(() => page.evaluate(() => window.GOATUI.state().guide?.id === 'export-the-issue-list' && window.GOATUI.state().guide.landed), 'the recorded guide');
      const tip = await tipAt();
      assert.ok(Math.abs(tip.x - 950) <= 1 && Math.abs(tip.y - 515) <= 1, `on the moved Export button: ${JSON.stringify(tip)}`);
      await page.keyboard.press('Escape');
    } finally {
      await setTargets(null);
    }
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
    await until(() => ollama.chats().some((c) => c.body.messages.at(-1).images), 'the area to reach Gemma');
    const [chat] = ollama.chats();
    assert.equal(chat.body.messages.at(-1).images.length, 1);
    assert.match(chat.body.messages.at(-1).content, /highlighted this part of the screen \(200×150 points\)/);
  });

  await check('tracking: Canva, then a form in ACC with a GOAT guide, become timed activities; stopping shows them; approve', async () => {
    const before = ollama.state.reply;
    // The mock model writes "aN: Worked in <site or app>." for each activity it's given.
    ollama.state.reply = (body) =>
      /tracked screen time/.test(body.messages?.[0]?.content || '')
        ? [...String(body.messages.at(-1).content).matchAll(/- id (a\d+): ([^,.\n]+)(?:, website ([a-z0-9.-]+?)\.(?=\s|$))?/gm)].map((m) => `${m[1]}: Worked in ${m[3] || m[2]}.`).join('\n')
        : before(body);
    try {
      await app.evaluate(() => globalThis.__goatTest.setFakeWindow('Google Chrome|GOAT pitch - Presentation|https://www.canva.com/design/DAF1/edit?ui=1'));
      await app.evaluate(() => globalThis.__goatTest.toggleTracking());
      await until(() => page.evaluate(() => document.getElementById('goat-cursor').classList.contains('tracking')), 'the red dot');
      await sleep(1200); // about 6 samples at 0.2 s
      await app.evaluate(() => globalThis.__goatTest.setFakeWindow('Google Chrome|Forms - ALPHA Viaduct|https://acc.autodesk.com/build/forms/projects/1?x=1'));
      await sleep(600);
      await askThroughMain('how do I log an issue?'); // a guide plays while tracking
      await until(() => page.evaluate(() => window.GOATUI.state().guide?.landed === true), 'the guide to play');
      await page.keyboard.press('Escape');
      await sleep(800);
      await app.evaluate(() => globalThis.__goatTest.toggleTracking());
      await page.waitForSelector('.ts-act', { state: 'visible' });
      assert.equal(await page.evaluate(() => document.getElementById('goat-cursor').classList.contains('tracking')), false);
      const acts = await page.evaluate(() => [...document.querySelectorAll('.ts-act')].map((li) => [li.querySelector('.ts-when').textContent, li.querySelector('.ts-what').textContent, li.querySelector('.ts-code').textContent]));
      assert.deepEqual(acts.map(([, what, code]) => [what, code]), [
        ['Worked in canva.com.', 'GOAT'],
        ['Worked in acc.autodesk.com, with a GOAT guide.', 'ALPHA'],
      ]);
      for (const [when] of acts) assert.match(when, /^\d\d:\d\d(–\d\d:\d\d)?$/);
      assert.match(await page.locator('.ts-table').innerText(), /ALPHA[\s\S]*GOAT|GOAT[\s\S]*ALPHA/);
      const dayDir = path.join(srv.dataDir, 'activity', 'e2e-tester');
      const stored = fs.readdirSync(dayDir).filter((f) => f.endsWith('.jsonl')).map((f) => fs.readFileSync(path.join(dayDir, f), 'utf8')).join('');
      assert.match(stored, /"site":"canva\.com"/);
      assert.match(stored, /"kind":"guide","guide":"Log an issue in Forma Build","app":"Google Chrome"/);
      assert.doesNotMatch(stored, /DAF1|ui=1|x=1|build\/forms|https?:/, 'site names only, never addresses');
      await page.screenshot({ path: shot('electron-timesheet.png') });
      await page.click('[data-action="approve"]');
      await until(() => page.evaluate(() => document.querySelector('.ts-status')?.textContent === 'Approved'), 'the approval');
      const approved = fs.readdirSync(path.join(srv.dataDir, 'timesheets', 'e2e-tester'));
      assert.equal(approved.length, 1);
      assert.equal(JSON.parse(fs.readFileSync(path.join(srv.dataDir, 'timesheets', 'e2e-tester', approved[0]), 'utf8')).activities.length, 2);
      await page.click('#goat-panel [data-action="close"]'); // not the Close of the guide bubble above, now hidden
      // The account card opens today's timesheet too, through main, without tracking on and off.
      await app.evaluate(() => globalThis.__goatTest.openAccount());
      await page.waitForSelector('.panel-account [data-action="timesheet"]', { state: 'visible' });
      await page.click('[data-action="timesheet"]');
      await page.waitForSelector('.panel-timesheet .ts-act', { state: 'visible' });
      assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('.ts-what')].map((e) => e.textContent)), acts.map(([, what]) => what));
      assert.equal(await page.locator('.ts-status').innerText(), 'Approved');
      await page.click('#goat-panel [data-action="close"]');
    } finally {
      ollama.state.reply = before;
      await app.evaluate(() => globalThis.__goatTest.setFakeWindow('Google Chrome|Forma Build - Issues'));
    }
  });

  await check('asks are paid with x402 through the wallet abstraction; top up and upgrade to Pro', async () => {
    const payer = await app.evaluate(() => globalThis.__goatTest.payer());
    assert.equal(payer.kind, 'local');
    assert.match(payer.address, /^0x[0-9a-fA-F]{40}$/);
    const before = await app.evaluate(() => globalThis.__goatTest.wallet());
    await askThroughMain('how do I log an issue?');
    await until(() => page.evaluate(() => /Paid 1¢/.test(document.getElementById('goat-toasts').innerText)), 'the payment toast');
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
    await until(() => page.evaluate(() => /Pro until/.test(document.getElementById('goat-toasts').innerText)), 'the Pro upgrade');
    const me = await srv.request('GET', '/api/me', { user: 'e2e-tester' });
    assert.equal(me.body.tier, 'pro');
    await page.screenshot({ path: shot('electron-wallet.png') });
    await page.click('#goat-panel [data-action="close"]'); // a hidden guide bubble keeps its own Close
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
    await page.evaluate(() => {
      window.__speech = [];
      window.GOATUI.onEvent('speak:start', (e) => window.__speech.push(e));
    });
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
    // A spoken question's guide is read aloud in GOAT's voice: overlay -> main -> server -> ElevenLabs.
    await until(() => eleven.calls.some((c) => c.key === 'test-key' && /Open Issues from the left menu\./.test(c.body?.text || '')), 'step 1 sent to be read aloud', 8000);
    await until(() => page.evaluate(() => window.__speech.some((e) => e.voice === 'elevenlabs')), "step 1 in GOAT's voice", 8000);
    await page.keyboard.press('Escape');

    ollama.calls.length = 0;
    ollama.state.transcript = 'What am I looking at here?';
    await app.evaluate(() => globalThis.__goatTest.voiceHold(true));
    await sleep(1500);
    await app.evaluate(() => globalThis.__goatTest.voiceHold(false));
    const screenAsk = () => ollama.chats().find((c) => c.body.messages?.at(-1)?.content?.startsWith("This picture shows the user's screen"));
    await until(() => Boolean(screenAsk()), 'the spoken question to reach Gemma', 15_000);
    const ask = screenAsk();
    assert.ok(ask, 'the question went to Gemma with the screen around the pointer');
    assert.equal(ask.body.messages.at(-1).images.length, 1);
    assert.match(ask.body.messages[0].content, /spoken aloud/);
    const said = 'Photos are the evidence for every issue.';
    await until(() => page.evaluate((t) => window.__speech.some((e) => e.voice === 'elevenlabs' && e.text === t), said), "the answer in GOAT's voice", 8000);
    assert.equal(await page.evaluate(() => document.getElementById('goat-bubble').hidden), true, 'a spoken answer is heard: no bubble');
    assert.ok(eleven.calls.some((c) => c.body?.text === said), 'the answer text went to ElevenLabs from the server');
    await page.screenshot({ path: shot('electron-voice.png') });
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

  await check('asking in a browser reads the whole page for context', async () => {
    const doc = { kind: 'page', title: 'Issues - Autodesk Build', url: 'https://acc.autodesk.com/build/issues?projectId=1', text: 'Issue 42: Crack in pier P3, assigned to Pat, due Friday.' };
    await app.evaluate((_electron, value) => globalThis.__goatTest.setFakeDoc(value), JSON.stringify(doc));
    ollama.calls.length = 0;
    await askThroughMain('who is issue 42 assigned to?');
    await until(() => ollama.chats().length >= 1, 'the question to reach Gemma');
    const msg = ollama.chats()[0].body.messages.at(-1).content;
    assert.match(msg, /^The page open in Google Chrome, "Issues - Autodesk Build" \(https:\/\/acc\.autodesk\.com\/build\/issues\):\nIssue 42: Crack in pier P3/);
    await app.evaluate(() => globalThis.__goatTest.setFakeDoc(''));
    await until(() => page.evaluate(() => !document.getElementById('goat-bubble').hidden), 'the answer');
  });

  await check('signing in through the browser page brings the account to the app; signing out asks again', async () => {
    const started = await app.evaluate(() => globalThis.__goatTest.startSignIn('create'));
    assert.equal(started.url, `${srv.url}/account/?code=${started.code}&mode=create`);
    // What the sign-in page posts once Reown AppKit has connected the account.
    const res = await fetch(`${srv.url}/api/account/link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: started.code, address: `0x${'12'.repeat(20)}`, method: 'email', provider: 'email', email: 'pat@example.com' }),
    });
    assert.equal(res.status, 200);
    const info = await until(async () => {
      const a = await app.evaluate(() => globalThis.__goatTest.account());
      return a.account?.method === 'email' && a;
    }, 'the signed-in account');
    assert.equal(info.account.label, 'pat@example.com');
    await until(() => page.evaluate(() => /Signed in: pat@example\.com/.test(document.getElementById('goat-toasts').innerText)), 'the signed-in toast');
    const payer = await app.evaluate(() => globalThis.__goatTest.payer());
    assert.match(payer.address, /^0x[0-9a-fA-F]{40}$/);
    assert.notEqual(payer.address, offlineWallet, 'the account pays from its own spending wallet');
    await page.keyboard.press('Escape');

    await app.evaluate(() => globalThis.__goatTest.openAccount());
    await page.waitForSelector('.panel-account', { state: 'visible' });
    assert.match(await page.locator('.panel-account').innerText(), /pat@example\.com[\s\S]*Signed in with email|Signed in with email[\s\S]*pat@example\.com/);
    await page.screenshot({ path: shot('electron-account.png') });
    await page.click('[data-action="signout"]');
    await page.waitForSelector('.panel-welcome', { state: 'visible' });
    assert.equal((await app.evaluate(() => globalThis.__goatTest.account())).signedIn, false);
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
  await eleven.close();
  fs.rmSync(userData, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} Electron check(s) failed.` : '\nAll Electron checks passed.');
process.exit(failed ? 1 : 0);
