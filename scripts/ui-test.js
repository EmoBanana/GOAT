// Overlay UI checks: Playwright Chromium loads the renderer with a stubbed window.goat.
// npm run test:ui (screenshots land in test-artifacts/)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { toneWav } from '../server/test/helpers/mock-elevenlabs.js';

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

// Fake media devices: getUserMedia returns a synthetic audio stream for the voice checks.
const speechFixture = path.join(root, 'scripts', 'fixtures', 'question.wav'); // "how do I log an issue"
const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${speechFixture}`, '--autoplay-policy=no-user-gesture-required'],
});
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
const bubblePlace = () =>
  page.evaluate(() => {
    const b = document.getElementById('goat-bubble');
    return { x: parseFloat(b.style.left), y: parseFloat(b.style.top) };
  });

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
  const placed = await bubblePlace();
  await emit({ type: 'cursor', x: 1100, y: 700 });
  await sleep(250);
  assert.deepEqual(await bubblePlace(), placed, 'the step bubble stays by its target');
  assert.ok(near(await tip(), STEPS[0], 0.5), 'the cursor stays parked on the target');
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

await check('LLM reply: a clean answer bubble, with no model or credit line', async () => {
  await setReply('ask', LLM_REPLY);
  await askVia('why do issues need a photo?');
  const b = await until(async () => {
    const x = await bubble();
    return x.visible && /evidence/.test(x.text) && x;
  }, 'the answer bubble');
  assert.doesNotMatch(b.text, /gemma|running on|x402/i);
  assert.equal(await page.locator('#goat-bubble .meta').count(), 0);
  assert.match(b.className, /\banswer\b/);
  await shot('ui-04-llm');
});

await check('the answer bubble follows the cursor, lets clicks through and hides after a reading time', async () => {
  await emit({ type: 'cursor', x: 300, y: 300 });
  await until(async () => near(await tip(), { x: 314, y: 316 }, 0.5), 'the cursor to settle');
  await until(async () => near(await bubblePlace(), { x: 338, y: 338 }, 0.5), 'the bubble to follow the cursor');
  const look = await page.evaluate(() => {
    const b = document.getElementById('goat-bubble');
    return { pointerEvents: getComputedStyle(b).pointerEvents, closeButtons: b.querySelectorAll('.close').length };
  });
  assert.deepEqual(look, { pointerEvents: 'none', closeButtons: 0 });
  const s = await ui();
  assert.equal(s.bubble.follow, true);
  assert.ok(s.bubble.ms >= 7000 && s.bubble.ms <= 30000, `hides after ${s.bubble.ms} ms`);
  assert.equal(s.clickThrough, true);
  await shot('ui-04b-llm-follows');
});

await check('an answer from the web lists its sources, and nothing else', async () => {
  await setReply('ask', {
    ...LLM_REPLY,
    say: 'Open the schedule, then File > Export > Reports > Schedule.',
    thought: true,
    searched: [{ tool: 'brave_web_search', query: 'revit export schedule' }],
    sources: [{ type: 'web', url: 'https://help.autodesk.com/view/RVT/2027/ENU/' }, { type: 'web', url: 'https://www.revitforum.org/t/1' }],
  });
  await askVia('how do I export a schedule from revit?');
  const b = await until(async () => {
    const x = await bubble();
    return x.visible && /Sources:/.test(x.text) && x;
  }, 'the answer with sources');
  assert.match(b.text, /Sources: help\.autodesk\.com, revitforum\.org/);
  assert.doesNotMatch(b.text, /thought it through|searched the web|gemma/i);
  await shot('ui-04c-deep-answer');
});

await check('errors show in a red bubble', async () => {
  await setReply('ask', ERROR_REPLY);
  await askVia('why do issues need a photo?');
  const b = await until(async () => {
    const x = await bubble();
    return x.visible && /ollama pull/.test(x.text) && x;
  }, 'the error bubble');
  assert.match(b.className, /\berror\b/);
  assert.match(b.className, /\bfollowing\b/);
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

await check('recorder: HUD and numbered markers, the cursor hops to each capture', async () => {
  await emit({ type: 'cursor', x: 1200, y: 800 });
  await emit({ type: 'record:start', app: 'Bluebeam Revu' });
  assert.equal(await page.locator('.rec-hud').isVisible(), true);
  assert.match(await page.locator('.rec-hud').innerText(), /Recording a guide in Bluebeam Revu/);
  assert.match(await page.locator('.rec-hud').innerText(), /Ctrl\+Option\+C/);
  await emit({ type: 'record:step', step: { n: 1, x: 200, y: 300 }, count: 1 });
  await until(async () => near(await tip(), { x: 200, y: 300 }, 0.5), 'the hop to capture 1');
  await emit({ type: 'record:step', step: { n: 2, x: 600, y: 420 }, count: 2 });
  await until(async () => near(await tip(), { x: 600, y: 420 }, 0.5), 'the hop to capture 2');
  const marks = await page.evaluate(() =>
    [...document.querySelectorAll('.rec-marker')].map((m) => {
      const r = m.getBoundingClientRect();
      return { n: m.textContent, x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }),
  );
  assert.deepEqual(marks.map((m) => m.n), ['1', '2']);
  assert.ok(near(marks[0], { x: 200, y: 300 }, 0.5) && near(marks[1], { x: 600, y: 420 }, 0.5), JSON.stringify(marks));
  assert.match(await page.locator('.rec-hud').innerText(), /\(600, 420\)/);
  await until(async () => (await ui()).mode === 'follow', 'the cursor to go back to the mouse');
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.rec-hud')).pointerEvents), 'none');
  await shot('ui-06-recording');
});

await check('recorder: the save form needs a title and a trigger, then sends the guide', async () => {
  await emit({ type: 'record:stop', app: 'Bluebeam Revu', steps: [{ n: 1, x: 200, y: 300 }, { n: 2, x: 600, y: 420 }] });
  await page.waitForSelector('.rec-form', { state: 'visible' });
  assert.equal(await page.locator('.rec-hud').isHidden(), true);
  assert.equal(await page.locator('.rec-step').count(), 2);
  assert.match(await page.locator('.form-sub').innerText(), /2 steps · recorded in Bluebeam Revu/);
  await page.evaluate(() => (window.__calls.length = 0));
  await page.click('.rec-form button[type="submit"]');
  assert.equal(await page.locator('.form-error').innerText(), 'Add a title.');
  await page.fill('[name="title"]', 'Export a PDF in Bluebeam');
  await page.click('.rec-form button[type="submit"]');
  assert.equal(await page.locator('.form-error').innerText(), 'Add at least one trigger phrase.');
  assert.equal((await calls('saveGuide')).length, 0, 'nothing is sent until the form is valid');
  await page.fill('[name="triggers"]', 'export a pdf, save as pdf');
  await page.fill('[name="label-0"]', 'File');
  await page.fill('[name="say-0"]', 'Open the File menu.');
  await page.fill('[name="label-1"]', 'Export');
  await page.mouse.click(30, 870); // a stray click on the backdrop keeps the form
  assert.equal(await page.locator('.rec-form').isVisible(), true);
  await shot('ui-07-save-form');
  await setReply('saveGuide', { id: 'export-a-pdf-in-bluebeam', title: 'Export a PDF in Bluebeam', triggers: ['export a pdf', 'save as pdf'] });
  await page.click('.rec-form button[type="submit"]');
  const [save] = await until(async () => {
    const c = await calls('saveGuide');
    return c.length && c;
  }, 'goat.saveGuide');
  assert.deepEqual(save.args[0], {
    title: 'Export a PDF in Bluebeam',
    triggers: 'export a pdf, save as pdf',
    intro: '',
    steps: [
      { x: 200, y: 300, label: 'File', say: 'Open the File menu.' },
      { x: 600, y: 420, label: 'Export', say: '' },
    ],
  });
  await until(async () => (await ui()).panel === null, 'the form to close');
  await until(() => page.evaluate(() => /Try Ctrl\+Option\+G, then "export a pdf"/.test(document.getElementById('goat-toasts').innerText)), 'the trigger toast');
  assert.equal(await page.locator('.rec-marker').count(), 0);
});

await check('recorder: Preview plays the recording, then the form comes back as it was', async () => {
  await emit({ type: 'record:start', app: '' });
  await emit({ type: 'record:stop', app: '', steps: [{ n: 1, x: 300, y: 300 }] });
  await page.waitForSelector('.rec-form', { state: 'visible' });
  await page.fill('[name="title"]', 'Preview me');
  await page.fill('[name="say-0"]', 'Right here.');
  await page.click('[data-action="preview"]');
  await until(async () => (await ui()).guide?.landed, 'the preview to play');
  assert.match((await bubble()).text, /Right here\./);
  await page.keyboard.press('Escape');
  await page.waitForSelector('.rec-form', { state: 'visible' });
  assert.equal(await page.inputValue('[name="title"]'), 'Preview me');
  assert.equal(await page.inputValue('[name="say-0"]'), 'Right here.');
  await page.keyboard.press('Escape');
  assert.match(await page.locator('.form-error').innerText(), /Press Esc again/);
  await page.keyboard.press('Escape');
  await until(async () => (await ui()).panel === null, 'the second Esc to discard');
});

const hlBox = () =>
  page.evaluate(() => {
    const el = document.querySelector('.hl-rect');
    const r = el.getBoundingClientRect();
    return { hidden: el.hidden, locked: el.classList.contains('locked'), x: r.left, y: r.top, width: r.width, height: r.height };
  });

await check('highlight: a drag draws the rectangle, locks it, and the ask carries the region', async () => {
  await setReply('ask', { ...LLM_REPLY, say: 'A pile cap detail with four piles.', image: true }, 300);
  await page.evaluate(() => (window.__calls.length = 0));
  await emit({ type: 'open-ask', context: { app: 'Bluebeam Revu', title: 'Drawing.pdf' } });
  await page.waitForSelector('#goat-ask-input', { state: 'visible' });
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('goat-backdrop')).cursor), 'crosshair');
  await page.mouse.move(100, 500);
  await page.mouse.down();
  await page.mouse.move(250, 600, { steps: 5 });
  const mid = await hlBox();
  assert.deepEqual(mid, { hidden: false, locked: false, x: 100, y: 500, width: 150, height: 100 });
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('goat-panel')).visibility), 'hidden');
  await shot('ui-08-highlight-drag');
  await page.mouse.move(400, 700, { steps: 5 });
  await page.mouse.up();
  assert.deepEqual(await hlBox(), { hidden: false, locked: true, x: 100, y: 500, width: 300, height: 200 });
  assert.equal(await page.locator('#goat-panel').isVisible(), true, 'releasing brings the panel back');
  assert.equal(await page.locator('.ask-context').innerText(), 'Asking about the highlighted area');
  await until(() => page.evaluate(() => document.activeElement && document.activeElement.id === 'goat-ask-input'), 'input focus');
  await shot('ui-09-highlight-locked');
  await page.keyboard.type('what is this?');
  await page.keyboard.press('Enter');
  const [askCall] = await until(async () => {
    const c = await calls('ask');
    return c.length && c;
  }, 'goat.ask');
  assert.deepEqual(askCall.args, ['what is this?', { region: { x: 100, y: 500, width: 300, height: 200 }, chatId: null }]);
  assert.equal((await hlBox()).hidden, false, 'the rectangle stays while GOAT looks at it');
  await until(async () => {
    const x = await bubble();
    return x.visible && /pile cap/.test(x.text) && x;
  }, 'the answer');
  assert.equal((await hlBox()).hidden, true);
});

await check('highlight: a tiny drag or a click is not a highlight, and Esc cancels one', async () => {
  await setReply('ask', LLM_REPLY);
  await emit({ type: 'open-ask', context: {} });
  await page.waitForSelector('#goat-ask-input', { state: 'visible' });
  await page.mouse.move(100, 100);
  await page.mouse.down();
  await page.mouse.move(104, 103);
  await page.mouse.up();
  await until(async () => (await ui()).panel === null, 'a click to close the panel');
  assert.equal((await hlBox()).hidden, true, 'no rectangle after a tiny drag');
  await emit({ type: 'open-ask', context: {} });
  await page.waitForSelector('#goat-ask-input', { state: 'visible' });
  await page.mouse.move(200, 200);
  await page.mouse.down();
  await page.mouse.move(420, 380, { steps: 4 });
  await page.mouse.up();
  const afterDrag = await hlBox();
  assert.equal(afterDrag.locked, true, `locked after a real drag: ${JSON.stringify(afterDrag)} panel=${JSON.stringify((await ui()).panel)}`);
  await page.keyboard.press('Escape');
  await until(async () => (await hlBox()).hidden, 'Esc to cancel the highlight');
  assert.equal((await ui()).panel, null);
  await page.evaluate(() => (window.__calls.length = 0));
  await askVia('plain question');
  const [plain] = await until(async () => {
    const c = await calls('ask');
    return c.length && c;
  }, 'a plain ask');
  assert.deepEqual(plain.args[1], { chatId: null }, 'a plain ask carries no region');
});

await check('tracking: a red dot rides with the cursor while tracking is on', async () => {
  const dotShown = () => page.evaluate(() => getComputedStyle(document.querySelector('#goat-cursor .track-dot')).display === 'block');
  assert.equal(await dotShown(), false);
  await emit({ type: 'tracking', on: true });
  assert.equal(await dotShown(), true);
  await shot('ui-10-tracking-dot');
  await emit({ type: 'tracking', on: false });
  assert.equal(await dotShown(), false);
});

await check('timesheet: opens at once, then the day as activities with times, by project, Approve and Export CSV', async () => {
  const at = (h, m) => new Date(2026, 10, 12, h, m).toISOString();
  const act = (key, start, end, minutes, site, code, summary, guides = []) => ({ key, start, end, minutes, app: 'Google Chrome', site, titles: [`${site} page`], guides, code, name: code, summary, described: true });
  const sheet = {
    user: 'ui-tester',
    date: '2026-11-12',
    entries: [
      { code: 'ALPHA', name: 'Sample: Alpha Viaduct', minutes: 75, hours: 1.25, apps: ['Google Chrome', 'Revit'] },
      { code: 'GOAT', name: 'GOAT hackathon', minutes: 30, hours: 0.5, apps: ['Keynote'] },
    ],
    totalMinutes: 111,
    unassignedMinutes: 6,
    idleMinutes: 12,
    approved: false,
    activities: [
      act('a', at(9, 2), at(9, 32), 30, 'canva.com', 'GOAT', 'Worked on the GOAT pitch presentation in Canva.'),
      act('b', at(9, 32), at(9, 32), 0.5, 'google.com', null, 'Searched for the Gamuda logo on Google.'),
      act('c', at(9, 33), at(10, 48), 75, 'acc.autodesk.com', 'ALPHA', 'Created a form in Autodesk Construction Cloud with a GOAT guide.', ['Create a form']),
    ],
  };
  await setReply('approveTimesheet', { ...sheet, approved: { at: '2026-11-12T09:00:00Z' } });
  await setReply('exportTimesheetCsv', { ok: true, url: 'http://127.0.0.1:8402/api/timesheet.csv?date=2026-11-12&user=ui-tester' });
  await page.evaluate(() => (window.__calls.length = 0));

  // Closed while it loads, it stays closed when the day arrives.
  await emit({ type: 'open-timesheet', loading: true });
  await page.waitForSelector('.ts-loading', { state: 'visible' });
  await page.keyboard.press('Escape');
  await emit({ type: 'open-timesheet', timesheet: sheet });
  await page.waitForTimeout(100);
  assert.equal((await ui()).panel, null);

  // Main opens the panel at once, then sends the day once its lines are written.
  await emit({ type: 'open-timesheet', loading: true });
  await page.waitForSelector('.ts-loading', { state: 'visible' });
  assert.match(await page.locator('.ts-loading').innerText(), /Writing up your day/);
  assert.equal(await page.locator('[data-action="approve"]').isDisabled(), true);
  await shot('ui-11a-timesheet-loading');
  await emit({ type: 'open-timesheet', timesheet: sheet });
  await page.waitForSelector('.ts-act', { state: 'visible' });
  assert.equal(await page.locator('.ts-loading').isHidden(), true);
  const acts = await page.evaluate(() => [...document.querySelectorAll('.ts-act')].map((li) => [...li.children].map((c) => c.textContent)));
  assert.deepEqual(acts, [
    ['09:02–09:32', 'Worked on the GOAT pitch presentation in Canva.', 'GOAT', '30 min'],
    ['09:32', 'Searched for the Gamuda logo on Google.', '—', '30 s'],
    ['09:33–10:48', 'Created a form in Autodesk Construction Cloud with a GOAT guide.', 'ALPHA', '1 h 15 min'],
  ]);
  assert.equal(await page.locator('.ts-act').first().getAttribute('title'), 'canva.com\ncanva.com page', 'what GOAT saw, on hover');
  const rows = await page.evaluate(() => [...document.querySelectorAll('.ts-table tbody tr')].map((tr) => [...tr.cells].map((c) => c.textContent)));
  assert.deepEqual(rows, [
    ['ALPHASample: Alpha Viaduct', '1.25', 'Google Chrome, Revit'],
    ['GOATGOAT hackathon', '0.50', 'Keynote'],
    ['Unassigned', '0.10', ''],
    ['Total', '1.85', ''],
  ]);
  assert.equal(await page.locator('.ts-note').innerText(), '0.20 h idle, not counted.');
  assert.equal(await page.locator('.ts-status').innerText(), 'Draft');
  // Docked at the bottom right like the account cards, in their look, with no backdrop.
  const box = await until(async () => {
    const b = await page.locator('#goat-panel').boundingBox();
    return b && b.x + b.width >= 1440 - 24 && b.y + b.height >= 900 - 24 && b;
  }, 'the timesheet docked at the bottom right');
  assert.ok(box.width > 400, JSON.stringify(box));
  assert.equal(await page.locator('#goat-backdrop').isHidden(), true, 'no backdrop');
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('goat-panel')).borderTopWidth), '2px');
  assert.equal(await page.locator('#goat-panel .panel-back').count(), 0, 'opened by main: nothing to go back to');
  await shot('ui-11-timesheet');
  await page.click('[data-action="approve"]');
  await until(async () => (await page.locator('.ts-status').innerText()) === 'Approved', 'the approved status');
  assert.deepEqual((await calls('approveTimesheet'))[0].args, ['2026-11-12']);
  assert.equal(await page.locator('[data-action="approve"]').innerText(), 'Approve again');
  assert.equal(await page.locator('.ts-act').count(), 3, 'the activities stay after approving');
  await page.click('[data-action="csv"]');
  assert.deepEqual((await until(async () => {
    const c = await calls('exportTimesheetCsv');
    return c.length && c;
  }, 'the CSV export'))[0].args, ['2026-11-12']);
  await page.click('[data-action="close"]');
  assert.equal((await ui()).panel, null);
  await emit({ type: 'open-timesheet', timesheet: { ...sheet, entries: [], activities: [], unassignedMinutes: 0, totalMinutes: 0, idleMinutes: 0 } });
  await page.waitForSelector('.ts-empty', { state: 'visible' });
  assert.match(await page.locator('.ts-empty').innerText(), /Nothing tracked yet today/);
  assert.equal(await page.locator('[data-action="approve"]').isDisabled(), true);
  await page.keyboard.press('Escape');
});

const WALLET = {
  mode: 'x402-local',
  network: 'eip155:84532',
  address: '0x0000000000000000000000000000000000000001',
  balanceUsd: 2.3714,
  balanceMyr: 9.96,
  myrPerUsd: 4.2,
  priceUsd: 0.01,
  priceMyr: 0.04,
  proPriceUsd: 1,
  proPriceMyr: 4.2,
  proDays: 30,
  pro: false,
  proUntil: null,
  topupMode: 'mock',
  topupMyr: 10,
  topupUsd: 2.381,
  explorer: null,
};

await check('wallet: a ringgit chip in the ask panel; the wallet panel tops up and upgrades to Pro', async () => {
  await setReply('wallet', WALLET);
  await emit({ type: 'open-ask', context: {} });
  await page.waitForSelector('#goat-ask-input', { state: 'visible' });
  await until(async () => (await page.locator('.wallet-chip').innerText()) === 'RM 9.96', 'the RM 9.96 chip');
  await shot('ui-12-wallet-chip');
  await page.click('.wallet-chip');
  await page.waitForSelector('.wallet-balance', { state: 'visible' });
  assert.equal(await page.locator('.wallet-balance').innerText(), 'RM 9.96');
  assert.equal(await page.locator('.wallet-sub').innerText(), 'RM 0.04 per assist');
  assert.equal(await page.locator('.wallet-usdc').innerText(), '2.37 USDC · 1 USDC = RM 4.20', 'the USDC behind the ringgit');
  assert.match(await page.locator('[data-action="topup"]').innerText(), /^Top up RM 10\.00\s+2\.38 USDC$/);
  assert.doesNotMatch(await page.locator('#goat-panel').innerText(), /x402|ledger/, 'no plumbing in the wallet');
  assert.doesNotMatch(await page.locator('#goat-panel').innerText(), /0x0000/, 'users never see an address');
  await setReply('topup', { ...WALLET, balanceMyr: 19.96, balanceUsd: 4.7524, topup: { mode: 'mock', usd: 10 / 4.2, myr: 10 } });
  await page.click('[data-action="topup"]');
  await until(async () => (await page.locator('.wallet-balance').innerText()) === 'RM 19.96', 'the topped-up balance');
  assert.equal(await page.locator('.wallet-usdc').innerText(), '4.75 USDC · 1 USDC = RM 4.20');
  assert.deepEqual((await calls('topup'))[0].args, [10]);
  await until(() => page.evaluate(() => /Topped up 2\.38 USDC \(RM 10\.00\)/.test(document.getElementById('goat-toasts').innerText)), 'the top-up toast in USDC and ringgit');
  const proUntil = Date.now() + 30 * 86_400_000;
  await setReply('upgradePro', { tier: 'pro', pro: true, proUntil, payment: { success: true, transaction: `0x${'b'.repeat(64)}`, network: 'eip155:84532' } });
  await setReply('wallet', { ...WALLET, balanceMyr: 15.76, balanceUsd: 3.7524, pro: true, proUntil });
  await page.click('[data-action="upgrade"]');
  await until(() => page.evaluate(() => /Pro until/.test(document.getElementById('goat-toasts').innerText)), 'the Pro toast');
  assert.equal(await page.locator('[data-action="upgrade"]').innerText(), 'Extend Pro');
  assert.match(await page.locator('.wallet-pro').innerText(), /^Pro until .+: the better model and voice mode\. Each assist is still RM 0\.04\.$/);
  await shot('ui-13-wallet-panel');
  await page.click('[data-action="close"]');
  await setReply('wallet', WALLET);
});

await check("on Base Sepolia, Top up is one faucet request: 1 USDC shown in ringgit, linked to the transfer", async () => {
  const chain = { ...WALLET, mode: 'x402', topupMode: 'cdp-faucet', topupMyr: 4.2, topupUsd: 1, explorer: 'https://sepolia.basescan.org/tx/' };
  await setReply('wallet', chain);
  await emit({ type: 'open-wallet' });
  await page.waitForSelector('.wallet-usdc', { state: 'visible' });
  await until(async () => (await page.locator('.wallet-usdc').innerText()) === '2.37 USDC on Base Sepolia · 1 USDC = RM 4.20', 'the USDC on chain');
  assert.match(await page.locator('[data-action="topup"]').innerText(), /^Top up RM 4\.20\s+1\.00 USDC$/);
  assert.match(await page.locator('.wallet-pro').innerText(), /Each assist is still RM 0\.04\.$/, 'Pro still pays per assist');
  const tx = `0x${'d'.repeat(64)}`;
  await setReply('topup', { ...chain, balanceMyr: 14.16, balanceUsd: 3.3714, topup: { mode: 'cdp-faucet', transaction: tx, usd: 1, myr: 4.2 } });
  await page.click('[data-action="topup"]');
  assert.deepEqual((await calls('topup')).at(-1).args, [4.2]);
  const toast = await until(async () => {
    const t = await page.evaluate(() => [...document.querySelectorAll('#goat-toasts .toast.link')].map((e) => e.textContent).find((x) => /Topped up/.test(x)));
    return t || null;
  }, 'the linked top-up toast');
  assert.equal(toast, 'Topped up 1.00 USDC (RM 4.20)');
  await page.click('[data-action="close"]');
  await setReply('wallet', WALLET);
  await page.evaluate(() => new Promise((done) => setTimeout(done, 4600))); // the toasts go before the next check
});

await check('a paid answer flies a coin and says "Paid 1¢"', async () => {
  await setReply('ask', { ...LLM_REPLY, payment: { success: true, transaction: `0x${'a'.repeat(64)}`, network: 'eip155:84532', payer: WALLET.address } });
  await askVia('why do issues need a photo?');
  await until(() => page.evaluate(() => document.querySelectorAll('.coin').length > 0), 'the coin');
  await until(() => page.evaluate(() => /Paid 1¢/.test(document.getElementById('goat-toasts').innerText)), 'the payment toast');
  await shot('ui-14-paid');
  await setReply('ask', LLM_REPLY);
});

await check('a price under a cent shows as "Paid 0.1¢" and "RM 0.0042 per assist"', async () => {
  await page.evaluate(() => new Promise((done) => setTimeout(done, 3600))); // the "Paid 1¢" toast goes first
  await setReply('wallet', { ...WALLET, priceUsd: 0.001, priceMyr: 0.0042, proPriceUsd: 0.1, proPriceMyr: 0.42 });
  await setReply('ask', { ...LLM_REPLY, payment: { success: true, transaction: `0x${'c'.repeat(64)}`, network: 'eip155:84532', payer: WALLET.address } });
  await askVia('why do issues need a photo?');
  await until(() => page.evaluate(() => /Paid 0\.1¢/.test(document.getElementById('goat-toasts').innerText)), 'the payment toast');
  await setReply('ask', LLM_REPLY);
  await emit({ type: 'open-wallet' });
  await page.waitForSelector('.wallet-sub', { state: 'visible' });
  await until(async () => (await page.locator('.wallet-sub').innerText()) === 'RM 0.0042 per assist', 'the price under a sen');
  assert.match(await page.locator('.wallet-pro').innerText(), /RM 0\.42 for 30 days/);
  await page.click('[data-action="close"]');
  await setReply('wallet', WALLET);
});

function wavInfo(b64) {
  const b = Buffer.from(b64, 'base64');
  return {
    riff: b.toString('latin1', 0, 4),
    wave: b.toString('latin1', 8, 12),
    format: b.readUInt16LE(20),
    channels: b.readUInt16LE(22),
    rate: b.readUInt32LE(24),
    bits: b.readUInt16LE(34),
    seconds: b.readUInt32LE(40) / 2 / 16000,
  };
}

const spySpeech = () =>
  page.evaluate(() => {
    window.__calls.length = 0;
    window.__spoken = [];
    window.speechSynthesis.speak = (u) => window.__spoken.push(u.text);
  });

await check('voice: hold to talk shows a live waveform; letting go sends only the speech as a 16 kHz mono WAV', async () => {
  await setReply('wallet', { ...WALLET, pro: true, proUntil: Date.now() + 86_400_000 });
  await setReply('transcribe', { transcript: 'why do issues need a photo', model: 'gemma4:e4b-it-qat' });
  await setReply('ask', LLM_REPLY);
  await spySpeech();
  await emit({ type: 'voice-hold', down: true });
  await until(() => page.evaluate(() => document.getElementById('goat-cursor').dataset.voice === 'listening'), 'the waveform');
  await sleep(1600); // the fake mic plays the fixture on a loop
  const scales = await page.evaluate(() => [...document.querySelectorAll('.voice-hud .bar')].map((b) => parseFloat(/scaleY\(([\d.]+)\)/.exec(b.style.transform)?.[1] || '0')));
  assert.ok(Math.max(...scales) > 0.3, `the bars follow the voice: ${scales}`);
  await shot('ui-15-listening');
  await emit({ type: 'voice-hold', down: false });
  const [tc] = await until(async () => {
    const c = await calls('transcribe');
    return c.length && c;
  }, 'goat.transcribe', 8000);
  const info = wavInfo(tc.args[0]);
  assert.deepEqual({ ...info, seconds: undefined }, { riff: 'RIFF', wave: 'WAVE', format: 1, channels: 1, rate: 16000, bits: 16, seconds: undefined });
  assert.ok(info.seconds > 0.4 && info.seconds < 2.2, `sent ${info.seconds} s of speech`);
  const pcm = Buffer.from(tc.args[0], 'base64');
  let peak = 0;
  for (let i = 44; i + 1 < pcm.length; i += 2) peak = Math.max(peak, Math.abs(pcm.readInt16LE(i)));
  assert.ok(peak > 0.8 * 32767, `normalised to about -1 dBFS (peak ${peak})`);
  const [askCall] = await until(async () => {
    const c = await calls('ask');
    return c.length && c;
  }, 'the ask');
  assert.deepEqual(askCall.args, ['why do issues need a photo', { voice: true, chatId: null }]);
  const b = await until(async () => {
    const x = await bubble();
    return x.visible && /You said/.test(x.text) && x;
  }, 'the spoken answer');
  assert.match(b.text, /You said “why do issues need a photo”/);
  // the stub has no voice of its own to send, so the Mac's voice reads the answer
  await until(() => page.evaluate(() => window.__spoken.length > 0), "the Mac's voice");
  assert.deepEqual(await page.evaluate(() => window.__spoken), [LLM_REPLY.say]);
  await until(() => page.evaluate(() => [...document.querySelectorAll('#goat-bubble .text .w')].every((w) => w.classList.contains('on'))), 'every word revealed', 6000);
  assert.equal((await ui()).voice, false, 'the voice turn ends with the answer');
  await shot('ui-16-voice-answer');
});

await check('voice: a quick Option+Cmd tap, silence or noise sends nothing', async () => {
  await spySpeech();
  await emit({ type: 'voice-hold', down: true });
  await sleep(150);
  await emit({ type: 'voice-hold', down: false });
  await sleep(600);
  assert.equal((await calls('transcribe')).length, 0, 'a tap is a shortcut, not a question');
  const verdicts = await page.evaluate(() => {
    const V = window.GOATVoice;
    const silence = new Float32Array(16000);
    const hiss = Float32Array.from({ length: 16000 }, () => (Math.random() * 2 - 1) * 0.002);
    const talk = Float32Array.from({ length: 16000 }, (_, i) => (i > 4000 && i < 12000 ? Math.sin(i / 8) * 0.3 * Math.abs(Math.sin(i / 400)) : (Math.random() * 2 - 1) * 0.002));
    const roar = Float32Array.from({ length: 16000 }, () => (Math.random() * 2 - 1) * 0.2);
    return [V.findSpeech(silence), V.findSpeech(hiss), V.findSpeech(talk), V.findSpeech(roar)];
  });
  assert.equal(verdicts[0], null, 'silence');
  assert.equal(verdicts[1], null, 'quiet noise');
  assert.ok(verdicts[2] && verdicts[2].voicedMs >= 300 && verdicts[2].start > 0 && verdicts[2].end < 16000, JSON.stringify(verdicts[2]));
  assert.equal(verdicts[3], null, 'loud steady noise');
  // Speech that fills the whole hold (press, talk, let go, no pause around it) still counts:
  // the recorded question on a loop, starting at six different points.
  const wav = fs.readFileSync(speechFixture);
  const pcm = Array.from({ length: (wav.length - 44) / 2 }, (_, i) => wav.readInt16LE(44 + i * 2) / 32768);
  const nonstop = await page.evaluate(
    (pcm) => Array.from({ length: 6 }, (_, k) => window.GOATVoice.findSpeech(Float32Array.from({ length: 24000 }, (_, i) => pcm[(i + k * 4000) % pcm.length]))?.voicedMs ?? 0),
    pcm,
  );
  assert.ok(nonstop.every((ms) => ms >= 300), `voiced ms per start point: ${nonstop}`);
});

await check('voice: a spoken question that matches a guide reads each step aloud', async () => {
  await setReply('transcribe', { transcript: 'how do I log an issue' });
  await setReply('ask', GUIDE_REPLY);
  await spySpeech();
  await emit({ type: 'voice-hold', down: true });
  await sleep(1000);
  await emit({ type: 'voice-hold', down: false });
  await until(async () => (await ui()).guide?.landed, 'the guide');
  await until(() => page.evaluate(() => window.__spoken.length > 0), 'step 1 read aloud');
  assert.equal((await page.evaluate(() => window.__spoken))[0], 'Three quick steps. Click the first button.');
  await page.keyboard.press('Escape');
  await until(async () => (await ui()).guide === null, 'the guide to stop');
});

await check("voice: GOAT's own voice plays when the server sends one, the words keep pace with it, and the Mac's voice is the fallback", async () => {
  const clip = toneWav(1500).toString('base64'); // the real clips are MP3; Web Audio decodes either
  const say = 'MCP is Model Context Protocol, the open standard that connects AI assistants to tools.';
  const words = say.split(/\s+/).length;
  const answer = (text) =>
    page.evaluate((t) => {
      window.GOATUI.setVoice(true, 'what is MCP');
      window.GOATUI.handleReply({ id: 'v1', source: 'llm', say: t, guide: null, sources: [] });
      window.GOATUI.setVoice(false);
    }, text);
  const lit = () => page.evaluate(() => [...document.querySelectorAll('#goat-bubble .text .w')].filter((w) => w.textContent.trim() && w.classList.contains('on')).length);
  const heard = (type) => page.evaluate((t) => window.__speech.filter((e) => e.type === t), type);
  await page.evaluate(() => {
    window.__speech = [];
    for (const type of ['speak:wait', 'speak:start', 'speak:end']) window.GOATUI.onEvent(type, (e) => window.__speech.push({ type, voice: e.voice, ms: e.ms }));
  });

  await spySpeech();
  await setReply('speak', { audio: clip, mime: 'audio/mpeg', voice: 'elevenlabs' }, 400);
  await answer(say);
  assert.deepEqual((await calls('speak')).map((c) => c.args), [[say]], 'the text goes to main, which asks the server');
  assert.equal(await lit(), 0, 'the words wait for the voice');
  assert.equal(await page.evaluate(() => window.GOATUI.speechPending()), true);
  const [start] = await until(async () => {
    const s = await heard('speak:start');
    return s.length && s;
  }, "GOAT's voice to start");
  assert.equal(start.voice, 'elevenlabs');
  assert.ok(Math.abs(start.ms - 1500) < 60, `the clip is ${start.ms} ms long`);
  assert.ok((await lit()) < words, 'the words come one by one');
  await until(async () => (await lit()) === words, 'every word lit by the end of the clip', 2500);
  await until(async () => (await heard('speak:end')).length === 1, 'the clip to end', 3000);
  assert.deepEqual(await page.evaluate(() => window.__spoken), [], "the Mac's voice stayed quiet");
  await shot('ui-16b-goat-voice');

  // Esc stops it mid-sentence.
  await page.evaluate(() => (window.__speech.length = 0));
  await answer(say);
  await until(async () => (await heard('speak:start')).length === 1, 'the second clip');
  await page.keyboard.press('Escape');
  await until(async () => (await heard('speak:end')).length === 1, 'the clip to stop');
  assert.equal((await bubble()).visible, false);

  // The server can't speak (no key, no network, quota used up): the Mac's voice reads it.
  await page.evaluate(() => (window.__speech.length = 0));
  await setReply('speak', { error: 'speech_unavailable', message: "GOAT's voice isn't available right now.", status: 503 });
  await answer('Second answer here.');
  await until(() => page.evaluate(() => window.__spoken.length === 1), "the Mac's voice");
  assert.deepEqual(await page.evaluate(() => window.__spoken), ['Second answer here.']);
  await until(async () => (await lit()) === 3, 'the words of the fallback answer');
  assert.equal((await heard('speak:start')).length, 0, 'no clip was played');
  await page.keyboard.press('Escape');
  await setReply('speak', undefined);
});

await check('voice: free users are pointed to the Pro upgrade', async () => {
  await setReply('wallet', WALLET);
  await page.evaluate(() => (window.__calls.length = 0));
  await emit({ type: 'voice-hold', down: true });
  await page.waitForSelector('.wallet-balance', { state: 'visible' });
  await emit({ type: 'voice-hold', down: false });
  assert.match((await bubble()).text, /Voice mode is part of GOAT Pro/);
  assert.equal((await calls('transcribe')).length, 0);
  assert.equal(await page.evaluate(() => document.getElementById('goat-cursor').dataset.voice || ''), '');
  await page.click('[data-action="close"]');
});

await check('GOAT-compatible: docs become drafted steps, the recorder adds positions, the form comes pre-filled', async () => {
  const drafted = {
    title: 'Export a PDF in Bluebeam',
    triggers: ['export a pdf', 'save as pdf'],
    intro: 'Two clicks. Follow the blue cursor.',
    steps: [
      { label: 'File', say: 'Open the File menu.' },
      { label: 'Export', say: 'Choose Export, then PDF.' },
    ],
  };
  await setReply('draftGuide', { draft: drafted, model: 'gemma4:e4b-it-qat' });
  await page.evaluate(() => (window.__calls.length = 0));
  await emit({ type: 'open-draft' });
  await page.waitForSelector('.draft-text', { state: 'visible' });
  await page.click('[data-action="draft"]');
  assert.equal(await page.locator('.draft .form-error').innerText(), 'Paste the instructions first.');
  await page.fill('.draft-text', 'To export a PDF in Bluebeam, open File, then Export, then PDF.');
  await page.click('[data-action="draft"]');
  await page.waitForSelector('.draft-steps', { state: 'visible' });
  assert.match(await page.locator('.draft-result').innerText(), /File Open the File menu\./);
  assert.deepEqual((await calls('draftGuide'))[0].args, ['To export a PDF in Bluebeam, open File, then Export, then PDF.']);
  await shot('ui-16-draft');
  await page.click('[data-action="record"]');
  assert.equal((await calls('startRecording')).length, 1);
  await emit({ type: 'record:start', app: 'Bluebeam Revu' });
  assert.match(await page.locator('.rec-hud').innerText(), /Next: 1\. File\. Open the File menu\./);
  await emit({ type: 'record:step', step: { n: 1, x: 120, y: 80 }, count: 1 });
  assert.match(await page.locator('.rec-hud').innerText(), /Next: 2\. Export\. Choose Export, then PDF\./);
  await emit({ type: 'record:step', step: { n: 2, x: 140, y: 300 }, count: 2 });
  assert.match(await page.locator('.rec-hud').innerText(), /All drafted steps captured\./);
  await emit({ type: 'record:stop', app: 'Bluebeam Revu', steps: [{ n: 1, x: 120, y: 80 }, { n: 2, x: 140, y: 300 }] });
  await page.waitForSelector('.rec-form', { state: 'visible' });
  assert.equal(await page.inputValue('[name="title"]'), 'Export a PDF in Bluebeam');
  assert.equal(await page.inputValue('[name="triggers"]'), 'export a pdf, save as pdf');
  assert.equal(await page.inputValue('[name="intro"]'), 'Two clicks. Follow the blue cursor.');
  assert.equal(await page.inputValue('[name="label-0"]'), 'File');
  assert.equal(await page.inputValue('[name="say-1"]'), 'Choose Export, then PDF.');
  await page.click('[data-action="discard"]');
});

const ACCOUNT = { method: 'email', label: 'pat@example.com', how: 'Signed in with email', short: '0xabab…abab' };
const CHAT_ID = 'a1b2c3d4e5f60718';
const OLD_CHAT = {
  id: CHAT_ID,
  title: 'Why do issues need a photo?',
  turns: [
    { question: 'Why do issues need a photo?', answer: 'Photos are the evidence for every issue.', source: 'llm' },
    { question: 'how do I log an issue', answer: "Let's log an issue.", source: 'guide', guide: { id: 'forma-log-issue', title: 'Log an issue in Forma Build' } },
  ],
};

await check('welcome: without an account GOAT asks you to sign in; the card closes once the browser takes over', async () => {
  await page.keyboard.press('Escape');
  await page.evaluate(() => (window.__calls.length = 0));
  await setReply('signIn', { ok: true, url: 'http://127.0.0.1:8402/account/?code=x&mode=create' });
  await emit({ type: 'open-welcome', signedIn: false, account: null, userId: 'ivanw' });
  await page.waitForSelector('.panel-welcome', { state: 'visible' });
  assert.match(await page.locator('.panel-welcome').innerText(), /Sign in to GOAT[\s\S]*Create account[\s\S]*Connect wallet[\s\S]*Continue offline/);
  assert.doesNotMatch(await page.locator('.panel-welcome').innerText(), /Reown|AppKit/, 'no credits');
  await shot('ui-17-welcome');
  // Create account opens the sign-in page in the browser, and the card gets out of the way.
  await page.click('[data-action="create"]');
  await until(async () => (await ui()).panel === null, 'the card to close for the browser');
  assert.deepEqual((await calls('signIn'))[0].args, ['create']);
  await until(() => page.evaluate(() => /Continue in your browser/.test(document.getElementById('goat-toasts').innerText)), 'the browser toast');
  // So does Connect wallet; a sign-in page that expires meanwhile says how to start again.
  await emit({ type: 'open-welcome', signedIn: false, account: null, userId: 'ivanw' });
  await page.waitForSelector('.panel-welcome', { state: 'visible' });
  await page.click('[data-action="connect"]');
  await until(async () => (await ui()).panel === null, 'the card to close again');
  assert.deepEqual((await calls('signIn'))[1].args, ['connect']);
  await emit({ type: 'sign-in-expired' });
  await until(() => page.evaluate(() => /sign-in page expired[\s\S]*Ctrl\+Option\+A/.test(document.getElementById('goat-toasts').innerText)), 'the expired toast');
  // Continue offline happens in the card.
  await emit({ type: 'open-welcome', signedIn: false, account: null, userId: 'ivanw' });
  await page.waitForSelector('.panel-welcome', { state: 'visible' });
  await page.click('[data-action="offline"]');
  assert.equal((await calls('signInOffline')).length, 1);
  // Main reports the account once the browser sign-in (or offline) is done.
  await emit({ type: 'account', signedIn: true, account: ACCOUNT, userId: '0xabab' });
  await until(async () => (await ui()).panel === null, 'the welcome panel to close');
  await until(() => page.evaluate(() => /Signed in: pat@example\.com/.test(document.getElementById('goat-toasts').innerText)), 'the signed-in toast');
  assert.match((await bubble()).text, /Ctrl\+Option\+G[\s\S]*Ctrl\+Option\+A/);
  await page.keyboard.press('Escape');
});

await check('account (Ctrl+Option+A): who you are, your balance and your chats; a chat reopens above the ask input', async () => {
  await page.evaluate(() => (window.__calls.length = 0));
  await setReply('wallet', { mode: 'x402-local', balanceMyr: 7.8, balanceUsd: 1.86, priceMyr: 0.042, priceUsd: 0.01, pro: false });
  await setReply('chats', { chats: [
    { id: CHAT_ID, title: OLD_CHAT.title, turns: 2, updatedAt: Date.now() - 5 * 60_000 },
    { id: 'ffffffffffffffff', title: 'how do I freeze the top row', turns: 1, updatedAt: Date.now() - 26 * 3600_000 },
  ] });
  await setReply('chat', OLD_CHAT);
  await emit({ type: 'open-account', signedIn: true, account: ACCOUNT, userId: '0xabab' });
  await page.waitForSelector('.panel-account .acct-chat', { state: 'visible' });
  const text = await page.locator('.panel-account').innerText();
  assert.match(text, /pat@example\.com/);
  assert.match(text, /Signed in with email/);
  await until(async () => /RM 7\.80/.test(await page.locator('.acct-balance').innerText()), 'the balance');
  assert.match(text, /Why do issues need a photo\?[\s\S]*2 questions · 5 min ago[\s\S]*how do I freeze the top row[\s\S]*1 question · yesterday/);
  await shot('ui-18-account');

  await page.click(`[data-chat="${CHAT_ID}"]`);
  await page.waitForSelector('.panel-ask .ask-thread', { state: 'visible' });
  assert.deepEqual((await calls('chat'))[0].args, [CHAT_ID]);
  const thread = await page.locator('.ask-thread').innerText();
  assert.match(thread, /Why do issues need a photo\?[\s\S]*Photos are the evidence[\s\S]*Showed the guide “Log an issue in Forma Build”/);
  assert.equal(await page.getAttribute('#goat-ask-input', 'placeholder'), 'Ask a follow-up…');
  assert.equal(await page.locator('[data-action="toggle-thread"]').innerText(), 'Hide', 'a chat picked in the account panel opens listed');
  // It opens in the account card's place, docked at the bottom right, with a way back.
  const chatBox = await until(async () => {
    const b = await page.locator('#goat-panel').boundingBox();
    return b && b.x + b.width >= 1440 - 24 && b.y + b.height >= 900 - 24 && b;
  }, 'the chat docked where the account card was');
  assert.ok(chatBox.width <= 420, JSON.stringify(chatBox));
  assert.equal(await page.locator('#goat-panel .panel-back').innerText(), 'Account');
  await shot('ui-19-thread');
  await page.click('#goat-panel [data-back]');
  await page.waitForSelector('.panel-account .acct-chat', { state: 'visible' });
  await page.click(`[data-chat="${CHAT_ID}"]`);
  await page.waitForSelector('.panel-ask .ask-thread', { state: 'visible' });

  // The follow-up continues that chat.
  await setReply('ask', { ...LLM_REPLY, say: 'Whoever raised it checks the fix.', chatId: CHAT_ID, chatTitle: OLD_CHAT.title, chatTurns: 3 });
  await page.keyboard.type('and who checks it?');
  await page.keyboard.press('Enter');
  const [follow] = await until(async () => {
    const c = await calls('ask');
    return c.length && c;
  }, 'the follow-up');
  assert.deepEqual(follow.args, ['and who checks it?', { chatId: CHAT_ID }]);
  await until(() => page.evaluate(() => (window.GOATUI.chat() || { turns: [] }).turns.length === 3), 'the chat to grow');
  await page.keyboard.press('Escape');

  // Ctrl+Option+G: the chat folds to one line (its last question), so the panel stays small;
  // Show lists the turns and typing carries on.
  await emit({ type: 'open-ask', context: {} });
  await page.waitForSelector('.ask-thread', { state: 'visible' });
  assert.equal(await page.locator('#goat-panel .panel-back').count(), 0, 'the ask hotkey opens in the middle, with nothing to go back to');
  const folded = await page.evaluate(() => {
    const t = document.querySelector('.ask-thread');
    return { text: t.innerText, height: t.getBoundingClientRect().height };
  });
  assert.match(folded.text, /this chat\s*and who checks it\?\s*Show\s*New chat/i);
  assert.doesNotMatch(folded.text, /Whoever raised it/, 'answers stay folded away');
  assert.ok(folded.height <= 40, `the chat takes one line, not ${folded.height}px`);
  await shot('ui-19b-thread-folded');
  await page.click('[data-action="toggle-thread"]');
  assert.match(await page.locator('.ask-thread').innerText(), /Hide[\s\S]*and who checks it\?[\s\S]*Whoever raised it checks the fix\./);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'goat-ask-input', 'typing carries on');
  await page.click('[data-action="toggle-thread"]');
  assert.doesNotMatch(await page.locator('.ask-thread').innerText(), /Whoever raised it/);

  // New chat: the thread goes and the next ask starts fresh.
  await page.click('[data-action="new-chat"]');
  assert.equal(await page.locator('.ask-thread').isHidden(), true);
  assert.equal(await page.getAttribute('#goat-ask-input', 'placeholder'), 'Ask GOAT… e.g. how do I log an issue?');
  await setReply('ask', { ...LLM_REPLY, chatId: 'bbbbbbbbbbbbbbbb', chatTitle: 'fresh', chatTurns: 1 });
  await page.keyboard.type('fresh question');
  await page.keyboard.press('Enter');
  const fresh = await until(async () => {
    const c = await calls('ask');
    return c.length > 1 && c.at(-1);
  }, 'the fresh ask');
  assert.deepEqual(fresh.args, ['fresh question', { chatId: null }]);
  await until(() => page.evaluate(() => (window.GOATUI.chat() || {}).id === 'bbbbbbbbbbbbbbbb'), 'the new chat');
  await page.keyboard.press('Escape');
  await setReply('ask', LLM_REPLY);
});

await check('account: delete a chat, clear all (two clicks), and sign out', async () => {
  await page.evaluate(() => (window.__calls.length = 0));
  await setReply('deleteChat', { deleted: 1 });
  await setReply('clearChats', { deleted: 1 });
  await setReply('signOut', { signedIn: false, account: null });
  await emit({ type: 'open-account', signedIn: true, account: ACCOUNT, userId: '0xabab' });
  await page.waitForSelector('.panel-account .acct-chat', { state: 'visible' });
  await page.click('[data-delete="ffffffffffffffff"]');
  await until(async () => (await calls('deleteChat')).length === 1, 'the delete');
  assert.deepEqual((await calls('deleteChat'))[0].args, ['ffffffffffffffff']);
  await page.click('[data-action="clear"]');
  assert.equal(await page.locator('[data-action="clear"]').innerText(), 'Clear all chats?');
  assert.equal((await calls('clearChats')).length, 0, 'the first click only asks');
  await page.click('[data-action="clear"]');
  await until(async () => (await calls('clearChats')).length === 1, 'the clear');
  await page.click('[data-action="signout"]');
  await until(async () => (await calls('signOut')).length === 1, 'sign out');
  await emit({ type: 'account', signedIn: false, account: null, userId: 'ivanw' });
  await page.waitForSelector('.panel-welcome', { state: 'visible' });
  await page.keyboard.press('Escape');
});

await check("account: today's timesheet opens from the account card, tracking or not", async () => {
  const at = (h, m) => new Date(2026, 10, 12, h, m).toISOString();
  const sheet = {
    user: 'ui-tester',
    date: '2026-11-12',
    entries: [{ code: 'GOAT', name: 'GOAT hackathon', minutes: 30, hours: 0.5, apps: ['Google Chrome'] }],
    totalMinutes: 30,
    unassignedMinutes: 0,
    idleMinutes: 0,
    approved: false,
    activities: [{ key: 'a', start: at(9, 2), end: at(9, 32), minutes: 30, app: 'Google Chrome', site: 'canva.com', titles: ['GOAT pitch'], guides: [], code: 'GOAT', name: 'GOAT hackathon', summary: 'Worked on the GOAT pitch presentation in Canva.', described: true }],
  };
  await page.evaluate(() => (window.__calls.length = 0));
  await setReply('getTimesheet', sheet);
  await page.evaluate(() => (window.__delays.getTimesheet = 300)); // the model is writing the lines
  await emit({ type: 'open-account', signedIn: true, account: ACCOUNT, userId: '0xabab' });
  await page.waitForSelector('.panel-account .acct-sheet', { state: 'visible' });
  assert.match(await page.locator('.acct-sheet').innerText(), /Today's timesheet\s*Ctrl\+Option\+T starts tracking\s*Open/);
  await emit({ type: 'tracking', on: true });
  await until(async () => (await page.locator('.acct-sheet-sub').innerText()) === 'Tracking now', 'the live tracking line');
  await shot('ui-18b-account-timesheet');
  await page.click('[data-action="timesheet"]');
  await page.waitForSelector('.panel-timesheet .ts-loading', { state: 'visible' });
  await page.waitForSelector('.panel-timesheet .ts-act', { state: 'visible' });
  assert.deepEqual((await calls('getTimesheet'))[0].args, [], "today's, without stopping tracking");
  assert.match(await page.locator('.ts-act').innerText(), /Worked on the GOAT pitch presentation in Canva\./);
  assert.equal(await page.evaluate(() => document.getElementById('goat-cursor').classList.contains('tracking')), true, 'still tracking');
  // Opened from the account card, it has a way back to it.
  await page.click('.panel-timesheet [data-back]');
  await page.waitForSelector('.panel-account', { state: 'visible' });
  await emit({ type: 'tracking', on: false });
  await page.keyboard.press('Escape');
  await page.evaluate(() => (window.__delays.getTimesheet = 0));
});

await check('panels move: drag one by an empty spot and it opens there next time', async () => {
  await page.evaluate(() => localStorage.clear());
  await emit({ type: 'open-ask', context: { app: 'Keynote', title: 'Deck.key' } });
  await page.waitForSelector('#goat-ask-input', { state: 'visible' });
  await sleep(250); // let the open animation finish
  const before = await page.locator('#goat-panel').boundingBox();
  // Dragging from the input does nothing: that's for typing.
  const input = await page.locator('#goat-ask-input').boundingBox();
  await page.mouse.move(input.x + 30, input.y + 10);
  await page.mouse.down();
  await page.mouse.move(input.x + 230, input.y + 130, { steps: 5 });
  await page.mouse.up();
  assert.deepEqual(await page.locator('#goat-panel').boundingBox(), before);
  // The strip at the bottom of the panel is a handle.
  const meta = await page.locator('.ask-meta').boundingBox();
  await page.mouse.move(meta.x + meta.width / 2, meta.y + meta.height / 2);
  await page.mouse.down();
  await page.mouse.move(meta.x + meta.width / 2 - 300, meta.y + meta.height / 2 + 160, { steps: 8 });
  await page.mouse.up();
  const after = await page.locator('#goat-panel').boundingBox();
  assert.ok(Math.abs(after.x - (before.x - 300)) <= 1 && Math.abs(after.y - (before.y + 160)) <= 1, JSON.stringify({ before, after }));
  await page.keyboard.press('Escape');
  await emit({ type: 'open-ask', context: {} });
  await page.waitForSelector('#goat-ask-input', { state: 'visible' });
  await sleep(250);
  const again = await page.locator('#goat-panel').boundingBox();
  assert.ok(Math.abs(again.x - after.x) <= 1 && Math.abs(again.y - after.y) <= 1, 'it opens where it was left');
  await shot('ui-20-moved');
  await page.keyboard.press('Escape');
  await page.evaluate(() => localStorage.clear());
});

await check('account and sign-in are small cards at the bottom right, clear of the Dock, that leave the screen usable', async () => {
  await emit({ type: 'open-account', signedIn: true, account: ACCOUNT, userId: '0xabab' });
  await page.waitForSelector('.panel-account', { state: 'visible' });
  await sleep(250); // let the open animation finish
  const box = await page.locator('#goat-panel').boundingBox();
  assert.ok(box.x + box.width >= 1440 - 24 && box.y + box.height >= 900 - 24 && box.width <= 340, JSON.stringify(box));
  // Drawn like the download page: a 2px black rule, square corners and a hard shadow.
  const look = await page.evaluate(() => {
    const s = getComputedStyle(document.getElementById('goat-panel'));
    return { border: `${s.borderTopWidth} ${s.borderTopStyle}`, radius: s.borderTopLeftRadius, shadow: s.boxShadow };
  });
  assert.deepEqual([look.border, look.radius], ['2px solid', '0px'], JSON.stringify(look));
  assert.match(look.shadow, /6px 6px 0px/, look.shadow);
  await shot('ui-18c-account-docked');
  // The Dock draws above the overlay; main's insets lift the card clear of it.
  await emit({ type: 'origin', x: 0, y: 0, insets: { top: 25, right: 0, bottom: 80, left: 0 } });
  await until(async () => {
    const b = await page.locator('#goat-panel').boundingBox();
    return Math.abs(b.y + b.height - (900 - 80 - 20)) <= 1;
  }, 'the card above the Dock');
  await emit({ type: 'origin', x: 0, y: 0, insets: { top: 0, right: 0, bottom: 0, left: 0 } });
  assert.equal(await page.locator('#goat-backdrop').isHidden(), true, 'no backdrop');
  assert.equal((await ui()).panel.keyboard, false);
  await emit({ type: 'cursor', x: 300, y: 500 }); // away from the card, clicks reach the apps
  await until(async () => (await ui()).clickThrough === true, 'click-through away from the card');
  // Top up opens the wallet in the card's place, and "← Account" comes back.
  await page.click('.panel-account [data-action="wallet"]');
  await page.waitForSelector('.panel-wallet .panel-back', { state: 'visible' });
  await page.click('.panel-wallet [data-back]');
  await page.waitForSelector('.panel-account', { state: 'visible' });
  await page.click('.panel-account [data-action="close"]');
  assert.equal((await ui()).panel, null);
});

await check('while GOAT works, a "Thinking…" pill sits beside the cursor, and nothing else', async () => {
  const pill = () =>
    page.evaluate(() => {
      const el = document.querySelector('#goat-cursor .pill');
      return { shown: Boolean(el.offsetParent), text: el.textContent, lines: document.querySelectorAll('#goat-cursor li').length };
    });
  assert.equal((await pill()).shown, false, 'hidden until GOAT is working');
  await setReply('ask', LLM_REPLY, 1500);
  await askVia('what does slide 3 say?');
  await until(async () => (await pill()).shown, 'the pill');
  // Whatever main sends meanwhile, the pill stays as it is: there is no list of steps.
  await emit({ type: 'progress', step: 'Reading the deck' });
  assert.deepEqual(await pill(), { shown: true, text: 'Thinking…', lines: 0 });
  assert.equal(await page.evaluate(() => document.querySelector('#goat-cursor').classList.contains('thinking')), true);
  await shot('ui-21-thinking');
  await until(async () => (await bubble()).visible && /evidence/.test((await bubble()).text), 'the answer', 4000);
  assert.equal((await pill()).shown, false);
  assert.equal(await page.evaluate(() => document.querySelector('#goat-cursor').classList.contains('thinking')), false);
  await setReply('ask', LLM_REPLY);
});

const guideWith = (recordedOn, step) => ({ ...GUIDE_REPLY, guide: { id: `live-${recordedOn}`, title: 'Live', intro: 'Follow me.', recordedOn, steps: [step, { x: 640, y: 620, label: 'End', say: 'Done here.' }] } });

await check('a step that names its control lands on it where it is now, not where it was recorded', async () => {
  await page.keyboard.press('Escape');
  await page.evaluate(() => (window.__calls.length = 0));
  await setReply('locate', { x: 700, y: 400, w: 100, h: 40, label: 'Create issue' });
  await setReply('ask', guideWith('1710x1107', { x: 10, y: 10, label: 'Create issue', say: 'Click Create issue.', target: { label: 'Create issue', role: 'button' } }));
  await askVia('how do I create an issue?');
  await until(async () => (await ui()).guide?.landed === true, 'the first step');
  assert.equal((await ui()).guide.located, 'live');
  assert.ok(near(await tip(), { x: 750, y: 420 }, 0.5), `tip at ${JSON.stringify(await tip())}`);
  assert.ok(near(await ringCentre(), { x: 750, y: 420 }, 1));
  assert.deepEqual((await calls('locate'))[0].args, [{ label: 'Create issue', role: 'button' }]);
  await shot('ui-22-live-target');
  await page.keyboard.press('Escape');
});

await check("a sample step it can't find says what to look for instead of pointing somewhere wrong", async () => {
  await setReply('locate', null);
  await setReply('ask', guideWith('sample-1440x900', { x: 10, y: 10, label: 'Issues', say: 'Open Issues from the left menu.', target: { label: 'Issues' } }));
  await askVia('how do I log an issue?');
  await until(async () => (await ui()).guide?.landed === true, 'the first step');
  assert.equal((await ui()).guide.located, 'none');
  const b = await bubble();
  assert.match(b.text, /Open Issues from the left menu\. Look for “Issues”\./);
  assert.equal(await page.locator('#goat-ring').isHidden(), true, 'no ring without a target');
  await page.click('#goat-bubble .next');
  await until(async () => (await ui()).guide?.index === 1, 'Next to move on');
  await page.keyboard.press('Escape');
});

await check("a recorded step it can't find falls back to its recorded points", async () => {
  await setReply('locate', null);
  await setReply('ask', guideWith('1710x1107', { x: 300, y: 220, label: 'Old button', say: 'Click it.', target: { label: 'Old button' } }));
  await askVia('how do I do the old thing?');
  await until(async () => (await ui()).guide?.landed === true, 'the first step');
  assert.equal((await ui()).guide.located, 'recorded');
  assert.ok(near(await tip(), { x: 300, y: 220 }, 0.5));
  await page.keyboard.press('Escape');
  await setReply('ask', LLM_REPLY);
});

await check('recording names each step after the control under the pointer', async () => {
  await emit({ type: 'record:start', app: 'Microsoft Edge' });
  await emit({ type: 'record:step', step: { n: 1, x: 950, y: 55 }, count: 1 });
  await emit({ type: 'record:target', n: 1, target: { label: 'Create issue', role: 'button' } });
  assert.match(await page.locator('.rec-hud').innerText(), /“Create issue” \(950, 55\)/);
  await emit({ type: 'record:step', step: { n: 2, x: 20, y: 110 }, count: 2 });
  await emit({ type: 'record:stop', app: 'Microsoft Edge', steps: [{ n: 1, x: 950, y: 55, target: { label: 'Create issue', role: 'button' } }, { n: 2, x: 20, y: 110 }] });
  await page.waitForSelector('.rec-form', { state: 'visible' });
  assert.equal(await page.inputValue('[name="label-0"]'), 'Create issue');
  assert.equal(await page.inputValue('[name="label-1"]'), '');
  // A name found after the form opened fills the empty field.
  await emit({ type: 'record:target', n: 2, target: { label: 'Issues', role: 'link' } });
  assert.equal(await page.inputValue('[name="label-1"]'), 'Issues');
  await page.click('[data-action="discard"]');
});

await check('no page errors or CSP violations', async () => {
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(await page.evaluate(() => window.__csp), []);
});

await browser.close();
console.log(failed ? `\n${failed} UI check(s) failed.` : '\nAll UI checks passed. Screenshots in test-artifacts/.');
process.exit(failed ? 1 : 0);
