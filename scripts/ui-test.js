// Overlay UI checks: Playwright Chromium loads the renderer with a stubbed window.goat.
// npm run test:ui (screenshots land in test-artifacts/)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('..', import.meta.url));
const artifacts = path.join(root, 'test-artifacts');
fs.mkdirSync(artifacts, { recursive: true });

const STEPS = [
  { x: 300, y: 220, label: 'One', say: 'Click the first button.' },
  { x: 900, y: 260, label: 'Two', say: 'Then this one.' },
  { x: 640, y: 620, label: 'Three', say: 'And finish here.' },
];
const GUIDE_REPLY = { id: 'r1', source: 'guide', say: 'Three quick steps.', model: null, tier: 'free', sources: [], guide: { id: 'ui-guide', title: 'UI guide', intro: 'Three quick steps.', steps: STEPS } };
const LLM_REPLY = { id: 'r2', source: 'llm', say: 'Photos are the evidence for every issue.', model: 'gemma4:e4b-it-qat', tier: 'free', guide: null, sources: [] };
const ERROR_REPLY = { error: 'model_missing', message: "The model gemma4:e4b-it-qat isn't pulled yet. Run: ollama pull gemma4:e4b-it-qat", status: 503 };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const pageErrors = [];
page.on('pageerror', (err) => pageErrors.push(err.message));

// Stub bridge: every method is recorded and resolves to window.__replies[name] (plain objects only).
await page.addInitScript(() => {
  const listeners = [];
  window.__calls = [];
  window.__delays = {};
  window.__csp = [];
  window.__replies = { info: { platform: 'darwin', userId: 'ui-tester', serverUrl: 'http://127.0.0.1:8402', hotkeys: { ask: 'Ctrl+Option+G' } } };
  document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  window.__emit = (message) => listeners.forEach((cb) => cb(message));
  window.goat = new Proxy(
    {},
    {
      get(_target, name) {
        if (name === 'onEvent') return (cb) => (listeners.push(cb), () => {});
        if (typeof name !== 'string' || name === 'then') return undefined;
        return (...args) => {
          window.__calls.push({ name, args: JSON.parse(JSON.stringify(args)) });
          return new Promise((resolve) => setTimeout(() => resolve(window.__replies[name]), window.__delays[name] || 0));
        };
      },
    },
  );
});
await page.goto(pathToFileURL(path.join(root, 'app', 'renderer', 'index.html')).href);
await page.waitForFunction(() => window.GOATUI && window.GOATUI.ready);

const emit = (message) => page.evaluate((m) => window.__emit(m), message);
const ui = () => page.evaluate(() => window.GOATUI.state());
const calls = (name) => page.evaluate((n) => window.__calls.filter((c) => c.name === n), name);
const setReply = (name, reply, delay = 0) =>
  page.evaluate(([n, r, d]) => {
    window.__replies[n] = r;
    window.__delays[n] = d;
  }, [name, reply, delay]);
const tip = () =>
  page.evaluate(() => {
    const r = document.getElementById('goat-cursor').getBoundingClientRect();
    return { x: r.left, y: r.top };
  });
const ringCentre = () =>
  page.evaluate(() => {
    const r = document.querySelector('#goat-ring .ring-core').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
const bubble = () =>
  page.evaluate(() => {
    const b = document.getElementById('goat-bubble');
    return { visible: !b.hidden, text: b.innerText, className: b.className };
  });
const near = (a, b, tolerance) => Math.abs(a.x - b.x) <= tolerance && Math.abs(a.y - b.y) <= tolerance;

async function until(fn, what, timeout = 4000) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(25);
  }
}

async function shot(name) {
  // A light backdrop (set through CSSOM, which the CSP allows) so the screenshot is readable.
  await page.evaluate(() => (document.documentElement.style.background = 'linear-gradient(135deg, #dfe6ef, #f5f7fa)'));
  // Fade-ins are 140-160 ms; without this, shots taken right after a bubble appears are blank.
  await page.screenshot({ path: path.join(artifacts, `${name}.png`), animations: 'disabled' });
  await page.evaluate(() => (document.documentElement.style.background = ''));
}

async function askVia(question) {
  await emit({ type: 'open-ask', context: {} });
  await page.waitForSelector('#goat-ask-input', { state: 'visible' });
  await page.keyboard.type(question);
  await page.keyboard.press('Enter');
}

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

await check('the page is transparent', async () => {
  const colours = await page.evaluate(() => [getComputedStyle(document.documentElement).backgroundColor, getComputedStyle(document.body).backgroundColor]);
  assert.deepEqual(colours, ['rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)']);
});

await check('the greeting shows the ask hotkey', async () => {
  await emit({ type: 'cursor', x: 400, y: 300 });
  const b = await until(async () => {
    const x = await bubble();
    return x.visible && x;
  }, 'the greeting');
  assert.match(b.text, /Ctrl\+Option\+G/);
  await shot('ui-01-greeting');
});

await check('idle: the blue tip settles at +14, +16 from the system cursor', async () => {
  await emit({ type: 'cursor', x: 700, y: 500 });
  await until(async () => near(await tip(), { x: 714, y: 516 }, 0.5), 'the cursor to settle at (714, 516)');
  assert.equal((await ui()).mode, 'follow');
  assert.equal(await page.evaluate(() => document.getElementById('goat-cursor').classList.contains('ready')), true);
});

await check('click-through turns off over a visible control and back on away from it', async () => {
  await page.evaluate(() => window.GOATUI.showBubble({ text: 'Hover me', at: { x: 200, y: 200 } }));
  const box = await page.locator('#goat-bubble').boundingBox();
  await page.evaluate(() => (window.__calls.length = 0));
  await emit({ type: 'cursor', x: box.x + box.width / 2, y: box.y + box.height / 2 });
  await until(async () => (await calls('setClickThrough')).at(-1)?.args[0] === false, 'setClickThrough(false)');
  await emit({ type: 'cursor', x: 1300, y: 850 });
  await until(async () => (await calls('setClickThrough')).at(-1)?.args[0] === true, 'setClickThrough(true)');
  await page.evaluate(() => window.GOATUI.hideBubble());
});

await check('ask: focused input, keyboard captured, Enter sends the question and the cursor pulses', async () => {
  await setReply('ask', GUIDE_REPLY, 500);
  await page.evaluate(() => (window.__calls.length = 0));
  await emit({ type: 'open-ask', context: { app: 'Google Chrome', title: 'Forma Build - Issues' } });
  await page.waitForSelector('#goat-ask-input', { state: 'visible' });
  await until(() => page.evaluate(() => document.activeElement && document.activeElement.id === 'goat-ask-input'), 'input focus');
  assert.equal((await ui()).clickThrough, false, 'the panel needs the keyboard');
  assert.ok((await calls('focus')).length >= 1, 'asked main for focus');
  assert.equal(await page.locator('.ask-context').innerText(), 'In Google Chrome · Forma Build - Issues');
  await shot('ui-02-ask');
  await page.keyboard.type('how do I log an issue?');
  await page.keyboard.press('Enter');
  const asks = await until(async () => {
    const c = await calls('ask');
    return c.length && c;
  }, 'goat.ask');
  assert.equal(asks[0].args[0], 'how do I log an issue?');
  assert.equal(await page.locator('#goat-panel').isHidden(), true);
  assert.equal((await ui()).thinking, true);
  assert.equal(await page.evaluate(() => document.getElementById('goat-cursor').classList.contains('thinking')), true);
});

await check('guide: flies to step 1, tip on the target, ring centred, bubble with "Step 1 of 3"', async () => {
  await until(async () => {
    const s = await ui();
    return s.guide && s.guide.index === 0 && s.guide.landed;
  }, 'landing on step 1', 5000);
  const t = await tip();
  assert.ok(near(t, STEPS[0], 0.5), `tip at ${JSON.stringify(t)}`);
  const r = await ringCentre();
  assert.ok(near(r, STEPS[0], 0.5), `ring centre at ${JSON.stringify(r)}`);
  const b = await bubble();
  assert.match(b.text, /Three quick steps\./);
  assert.match(b.text, /Click the first button\./);
  assert.match(b.text, /Step 1 of 3/);
  assert.equal((await ui()).thinking, false);
  assert.equal((await ui()).clickThrough, true, 'click-through while waiting on the step');
  await shot('ui-03-step1');
});

await check('Next moves to step 2', async () => {
  await page.click('#goat-bubble [data-action="next"]');
  await until(async () => {
    const s = await ui();
    return s.guide && s.guide.index === 1 && s.guide.landed;
  }, 'step 2');
  assert.ok(near(await tip(), STEPS[1], 0.5));
  assert.match((await bubble()).text, /Step 2 of 3/);
});

await check('dwell: hovering within 28 px for 450 ms advances, and finishes the guide', async () => {
  await emit({ type: 'cursor', x: STEPS[1].x + 40, y: STEPS[1].y }); // 40 px away: not close enough
  await sleep(700);
  assert.equal((await ui()).guide.index, 1);
  await emit({ type: 'cursor', x: STEPS[1].x + 5, y: STEPS[1].y + 5 });
  await until(async () => {
    const s = await ui();
    return s.guide && s.guide.index === 2 && s.guide.landed;
  }, 'step 3 after the dwell');
  assert.match((await bubble()).text, /Step 3 of 3/);
  const started = Date.now();
  await emit({ type: 'cursor', x: STEPS[2].x, y: STEPS[2].y - 20 });
  await until(async () => (await ui()).guide === null, 'the guide to finish');
  assert.ok(Date.now() - started >= 400, `finished after ${Date.now() - started} ms`);
  assert.equal((await bubble()).visible, false);
  assert.equal(await page.locator('#goat-ring').isHidden(), true);
  await until(async () => near(await tip(), { x: STEPS[2].x + 14, y: STEPS[2].y - 20 + 16 }, 0.5), 'the cursor back beside the system cursor');
});

await check('LLM reply: answer bubble with "<model> · running on this laptop"', async () => {
  await setReply('ask', LLM_REPLY);
  await askVia('why do issues need a photo?');
  const b = await until(async () => {
    const x = await bubble();
    return x.visible && /evidence/.test(x.text) && x;
  }, 'the answer bubble');
  assert.match(b.text, /gemma4:e4b-it-qat · running on this laptop/);
  assert.match(b.className, /\banswer\b/);
  await shot('ui-04-llm');
});

await check('errors show in a red bubble', async () => {
  await setReply('ask', ERROR_REPLY);
  await askVia('why do issues need a photo?');
  const b = await until(async () => {
    const x = await bubble();
    return x.visible && /ollama pull/.test(x.text) && x;
  }, 'the error bubble');
  assert.match(b.className, /\berror\b/);
  const colour = await page.evaluate(() => getComputedStyle(document.getElementById('goat-bubble')).backgroundColor);
  assert.equal(colour, 'rgb(254, 242, 242)');
  await shot('ui-05-error');
});

await check('Escape closes the ask panel and stops a running guide', async () => {
  await emit({ type: 'open-ask', context: {} });
  await page.waitForSelector('#goat-ask-input', { state: 'visible' });
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#goat-panel').isHidden(), true);
  assert.equal((await ui()).panel, null);
  await page.evaluate((g) => {
    window.GOATUI.playGuide(g);
  }, GUIDE_REPLY.guide);
  await until(async () => (await ui()).guide?.landed, 'a running guide');
  await page.keyboard.press('Escape');
  await until(async () => (await ui()).guide === null, 'the guide to stop');
  assert.equal((await bubble()).visible, false);
});

await check("the bubble's Close button stops a guide; a click outside the panel closes it", async () => {
  await page.evaluate((g) => {
    window.GOATUI.playGuide(g);
  }, GUIDE_REPLY.guide);
  await until(async () => (await ui()).guide?.landed, 'a running guide');
  await page.click('#goat-bubble [data-action="close"]');
  await until(async () => (await ui()).guide === null, 'the guide to stop');
  await emit({ type: 'open-ask', context: {} });
  await page.waitForSelector('#goat-ask-input', { state: 'visible' });
  await page.mouse.click(40, 860);
  await until(async () => (await ui()).panel === null, 'the panel to close');
});

await check('no page errors or CSP violations', async () => {
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(await page.evaluate(() => window.__csp), []);
});

await browser.close();
console.log(failed ? `\n${failed} UI check(s) failed.` : '\nAll UI checks passed. Screenshots in test-artifacts/.');
process.exit(failed ? 1 : 0);
