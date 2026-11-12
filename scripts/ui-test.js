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

// Fake media devices: getUserMedia returns a synthetic audio stream for the voice checks.
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
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

await check('a deep answer says it thought and searched, and lists its web sources', async () => {
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
    return x.visible && /searched the web/.test(x.text) && x;
  }, 'the deep answer');
  assert.match(b.text, /gemma4:e4b-it-qat · running on this laptop · thought it through · searched the web/);
  assert.match(b.text, /Sources: help\.autodesk\.com, revitforum\.org/);
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
  assert.deepEqual(askCall.args, ['what is this?', { region: { x: 100, y: 500, width: 300, height: 200 } }]);
  assert.equal((await hlBox()).hidden, false, 'the rectangle stays while GOAT looks at it');
  const b = await until(async () => {
    const x = await bubble();
    return x.visible && /pile cap/.test(x.text) && x;
  }, 'the answer');
  assert.match(b.text, /read the highlighted area/);
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
  assert.equal(plain.args[1], null, 'a plain ask carries no region');
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

await check("timesheet: today's projects, Approve and Export CSV", async () => {
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
  };
  await setReply('approveTimesheet', { ...sheet, approved: { at: '2026-11-12T09:00:00Z' } });
  await setReply('exportTimesheetCsv', { ok: true, url: 'http://127.0.0.1:8402/api/timesheet.csv?date=2026-11-12&user=ui-tester' });
  await page.evaluate(() => (window.__calls.length = 0));
  await emit({ type: 'open-timesheet', timesheet: sheet });
  await page.waitForSelector('.ts-table', { state: 'visible' });
  const rows = await page.evaluate(() => [...document.querySelectorAll('.ts-table tbody tr')].map((tr) => [...tr.cells].map((c) => c.textContent)));
  assert.deepEqual(rows, [
    ['ALPHASample: Alpha Viaduct', '1.25', 'Google Chrome, Revit'],
    ['GOATGOAT hackathon', '0.50', 'Keynote'],
    ['Unassigned', '0.10', ''],
    ['Total', '1.85', ''],
  ]);
  assert.equal(await page.locator('.ts-note').innerText(), '0.20 h idle, not counted.');
  assert.equal(await page.locator('.ts-status').innerText(), 'Draft');
  await shot('ui-11-timesheet');
  await page.click('[data-action="approve"]');
  await until(async () => (await page.locator('.ts-status').innerText()) === 'Approved', 'the approved status');
  assert.deepEqual((await calls('approveTimesheet'))[0].args, ['2026-11-12']);
  assert.equal(await page.locator('[data-action="approve"]').innerText(), 'Approve again');
  await page.click('[data-action="csv"]');
  assert.deepEqual((await until(async () => {
    const c = await calls('exportTimesheetCsv');
    return c.length && c;
  }, 'the CSV export'))[0].args, ['2026-11-12']);
  await page.click('[data-action="close"]');
  assert.equal((await ui()).panel, null);
  await emit({ type: 'open-timesheet', timesheet: { ...sheet, entries: [], unassignedMinutes: 0, totalMinutes: 0, idleMinutes: 0 } });
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
  assert.match(await page.locator('.wallet-sub').innerText(), /Each assist costs RM 0\.04 \(1¢\)/);
  assert.doesNotMatch(await page.locator('#goat-panel').innerText(), /0x0000/, 'users never see an address');
  await setReply('topup', { ...WALLET, balanceMyr: 19.96, balanceUsd: 4.7524 });
  await page.click('[data-action="topup"]');
  await until(async () => (await page.locator('.wallet-balance').innerText()) === 'RM 19.96', 'the topped-up balance');
  assert.deepEqual((await calls('topup'))[0].args, [10]);
  const proUntil = Date.now() + 30 * 86_400_000;
  await setReply('upgradePro', { tier: 'pro', pro: true, proUntil, payment: { success: true, transaction: `0x${'b'.repeat(64)}`, network: 'eip155:84532' } });
  await setReply('wallet', { ...WALLET, balanceMyr: 15.76, pro: true, proUntil });
  await page.click('[data-action="upgrade"]');
  await until(() => page.evaluate(() => /You're on GOAT Pro until/.test(document.getElementById('goat-toasts').innerText)), 'the Pro toast');
  assert.equal(await page.locator('[data-action="upgrade"]').innerText(), 'Extend Pro');
  assert.match(await page.locator('.wallet-pro').innerText(), /GOAT Pro until/);
  await shot('ui-13-wallet-panel');
  await page.click('[data-action="close"]');
  await setReply('wallet', WALLET);
});

await check('a paid answer flies a coin and says "1¢ paid via x402"', async () => {
  await setReply('ask', { ...LLM_REPLY, payment: { success: true, transaction: `0x${'a'.repeat(64)}`, network: 'eip155:84532', payer: WALLET.address } });
  await askVia('why do issues need a photo?');
  await until(() => page.evaluate(() => document.querySelectorAll('.coin').length > 0), 'the coin');
  await until(() => page.evaluate(() => /1¢ paid via x402/.test(document.getElementById('goat-toasts').innerText)), 'the payment toast');
  await shot('ui-14-paid');
  await setReply('ask', LLM_REPLY);
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

await check('voice: Ctrl+Option+V records, sends a 16 kHz mono WAV, asks the transcript and speaks the answer', async () => {
  await setReply('wallet', { ...WALLET, pro: true, proUntil: Date.now() + 86_400_000 });
  await setReply('transcribe', { transcript: 'why do issues need a photo', model: 'gemma4:e4b-it-qat' });
  await setReply('ask', LLM_REPLY);
  await page.evaluate(() => {
    window.__calls.length = 0;
    window.__spoken = [];
    window.speechSynthesis.speak = (u) => window.__spoken.push(u.text);
  });
  await emit({ type: 'voice-toggle' });
  await until(() => page.evaluate(() => document.getElementById('goat-cursor').classList.contains('listening')), 'the listening pill');
  assert.match(await page.locator('.voice-pill').innerText(), /Listening… Ctrl\+Option\+V to send/);
  await shot('ui-15-listening');
  await sleep(1200);
  await emit({ type: 'voice-toggle' });
  const [tc] = await until(async () => {
    const c = await calls('transcribe');
    return c.length && c;
  }, 'goat.transcribe', 8000);
  const info = wavInfo(tc.args[0]);
  assert.deepEqual({ ...info, seconds: undefined }, { riff: 'RIFF', wave: 'WAVE', format: 1, channels: 1, rate: 16000, bits: 16, seconds: undefined });
  assert.ok(info.seconds > 0.6 && info.seconds < 2.5, `recorded ${info.seconds} s`);
  const [askCall] = await until(async () => {
    const c = await calls('ask');
    return c.length && c;
  }, 'the ask');
  assert.equal(askCall.args[0], 'why do issues need a photo');
  await until(() => page.evaluate(() => window.__spoken.length > 0), 'the spoken answer');
  assert.deepEqual(await page.evaluate(() => window.__spoken), [LLM_REPLY.say]);
  assert.equal((await ui()).voice, false, 'voice mode ends with the answer');
});

await check('voice: free users are pointed to the Pro upgrade', async () => {
  await setReply('wallet', WALLET);
  await page.evaluate(() => (window.__calls.length = 0));
  await emit({ type: 'voice-toggle' });
  await page.waitForSelector('.wallet-balance', { state: 'visible' });
  assert.match((await bubble()).text, /Voice mode is part of GOAT Pro/);
  assert.equal((await calls('transcribe')).length, 0);
  assert.equal(await page.evaluate(() => document.getElementById('goat-cursor').classList.contains('listening')), false);
  await page.click('[data-action="close"]');
});

await check('no page errors or CSP violations', async () => {
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(await page.evaluate(() => window.__csp), []);
});

await browser.close();
console.log(failed ? `\n${failed} UI check(s) failed.` : '\nAll UI checks passed. Screenshots in test-artifacts/.');
process.exit(failed ? 1 : 0);
