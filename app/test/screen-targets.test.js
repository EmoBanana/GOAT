import assert from 'node:assert/strict';
import test from 'node:test';
import { buildGuide, createRecorder } from '../lib/recorder.js';
import { centre, cleanTargets, findTarget, PAGE_TARGETS_JS, readTargets, targetAt } from '../lib/screen-targets.js';

const T = (label, role, x, y, w = 100, h = 30) => ({ label, role, x, y, w, h });
const SCREEN = [T('Issues', 'link', 10, 100), T('Create issue', 'button', 900, 40), T('Filter by assignee', 'button', 300, 80), T('⚲', 'button', 500, 80)];

test('a control is found by its name, loosely, and pointed at by its centre', () => {
  assert.equal(findTarget(SCREEN, 'Create issue').label, 'Create issue');
  assert.equal(findTarget(SCREEN, 'create an issue').label, 'Create issue');
  assert.equal(findTarget(SCREEN, 'filter').label, 'Filter by assignee');
  assert.equal(findTarget(SCREEN, 'Issues tab', 'link').label, 'Issues');
  assert.equal(findTarget(SCREEN, 'Export'), null);
  assert.equal(findTarget(SCREEN, '⚲'), null, 'icons without words never match');
  assert.deepEqual(centre(SCREEN[1]), { x: 950, y: 55 });
});

const isAx = (script) => script.includes('AXUIElementCreateApplication');
const BAR = [T('Back', 'button', 0, 78, 36, 32), T('Address and search bar', 'textfield', 104, 82, 1306, 24), T('New Tab', 'button', 1634, 34, 32, 41)];

test('browsers list their controls from the page; other apps through Accessibility', async () => {
  const calls = [];
  const run = async (script, args) => {
    calls.push({ page: script.includes('querySelectorAll'), ax: isAx(script), args });
    if (isAx(script) && args[1] === 'toolbar') return JSON.stringify({ error: 'no_window' });
    return JSON.stringify({ source: isAx(script) ? 'ax' : 'page', top: 152, elements: [T('Create issue', 'button', 900, 400), { label: '', x: 1, y: 1, w: 1, h: 1 }] });
  };
  const page = await readTargets({ app: 'Microsoft Edge', pid: 0, env: {}, run });
  assert.deepEqual(page, { source: 'page', elements: [T('Create issue', 'button', 900, 400)] });
  assert.deepEqual(calls[0], { page: true, ax: false, args: ['Microsoft Edge'] });
  const native = await readTargets({ app: 'Keynote', pid: 4242, env: {}, run });
  assert.deepEqual(native, { source: 'ax', elements: [T('Create issue', 'button', 900, 400)] });
  assert.deepEqual(calls.at(-1), { page: false, ax: true, args: [4242] });
  assert.equal(await readTargets({ app: 'Keynote', pid: 0, env: {}, run }), null, 'Accessibility needs the process');
  assert.deepEqual(await readTargets({ app: 'Google Chrome', env: {}, run: async () => JSON.stringify({ error: 'js_off' }) }), { error: 'js_off' });
  assert.match(PAGE_TARGETS_JS, /window\.outerWidth \/ window\.innerWidth/, 'CSS pixels become screen points through the zoom');
  assert.match(PAGE_TARGETS_JS, /shadowRoot/, 'web components keep their controls in shadow roots');
  assert.match(PAGE_TARGETS_JS, /contentDocument/, 'and same-origin frames have their own');
});

test("a browser also gives its own toolbar's controls, marked as such, after the page's", async () => {
  const calls = [];
  const pageRead = JSON.stringify({ source: 'page', top: 152, elements: [T('Search', 'combobox', 559, 526, 448, 50)] });
  const run = async (script, args) => {
    calls.push(args);
    // The browser exposes a control of the page to Accessibility too: it sits below the toolbar.
    return isAx(script) ? JSON.stringify({ source: 'ax', elements: [...BAR, T('Search', 'textfield', 559, 526, 448, 50)] }) : pageRead;
  };
  const read = await readTargets({ app: 'Microsoft Edge', pid: 1399, env: {}, run });
  assert.deepEqual(read, {
    source: 'page',
    elements: [T('Search', 'combobox', 559, 526, 448, 50), T('Back', 'toolbar button', 0, 78, 36, 32), T('Address and search bar', 'toolbar textfield', 104, 82, 1306, 24), T('New Tab', 'toolbar button', 1634, 34, 32, 41)],
  });
  assert.deepEqual(calls, [['Microsoft Edge'], [1399, 'toolbar', 'Microsoft Edge']], 'the toolbar read names the browser, for when its pid is unknown');

  // The page can't be read (the switch is off): the toolbar still comes, with the reason.
  const off = await readTargets({ app: 'Google Chrome', pid: 0, env: {}, run: async (script) => (isAx(script) ? JSON.stringify({ source: 'ax', elements: BAR }) : JSON.stringify({ error: 'js_off' })) });
  assert.equal(off.pageError, 'js_off');
  assert.deepEqual(off.elements.map((t) => `${t.label}|${t.role}`), ['Back|toolbar button', 'Address and search bar|toolbar textfield', 'New Tab|toolbar button']);

  // No Accessibility (the toolbar read fails): the page alone, as before.
  const noAx = await readTargets({
    app: 'Safari',
    pid: 0,
    env: {},
    run: async (script) => {
      if (isAx(script)) throw new Error('osascript: not allowed assistive access');
      return pageRead;
    },
  });
  assert.deepEqual(noAx, { source: 'page', elements: [T('Search', 'combobox', 559, 526, 448, 50)] });
});

test('the control under the pointer is the page’s, or above the page the browser’s own', async () => {
  // Accessibility is asked with [pid, x, y, browser]; the page with the point inside its script.
  const run = async (script, args) => (isAx(script) ? JSON.stringify(args[2] < 152 && args[3] === 'Microsoft Edge' ? { role: 'textfield', label: 'Address and search bar' } : {}) : JSON.stringify(script.includes('(600 - left)') ? { role: 'combobox', label: 'Search' } : {}));
  assert.deepEqual(await targetAt({ app: 'Microsoft Edge', pid: 1399, x: 600, y: 550, env: {}, run }), { role: 'combobox', label: 'Search' });
  assert.deepEqual(await targetAt({ app: 'Microsoft Edge', pid: 1399, x: 700, y: 90, env: {}, run }), { role: 'toolbar textfield', label: 'Address and search bar' });
  assert.equal(await targetAt({ app: 'Microsoft Edge', pid: 1399, x: 700, y: 300, env: {}, run }), null);
});

test('tests never read real apps: GOAT_FAKE_TARGETS stands in, and a faked window reads nothing', async () => {
  const run = async () => {
    throw new Error('a real app was read');
  };
  const env = { GOAT_FAKE_TARGETS: JSON.stringify({ elements: SCREEN }) };
  assert.equal((await readTargets({ app: 'Google Chrome', env, run })).elements.length, 4);
  assert.deepEqual(await targetAt({ app: 'Google Chrome', x: 950, y: 55, env, run }), { role: 'button', label: 'Create issue' });
  assert.equal(await targetAt({ app: 'Google Chrome', x: 5, y: 5, env, run }), null);
  assert.equal(await readTargets({ app: 'Google Chrome', env: { GOAT_FAKE_WINDOW: 'Google Chrome|x' }, run }), null);
  assert.deepEqual(cleanTargets([{ label: 'x'.repeat(100), role: 'button', x: 1, y: 2, w: 3, h: 4 }])[0].label.length, 80);
});

test('the recorder keeps the control under each capture, and the saved guide carries it', () => {
  const recorder = createRecorder();
  recorder.start({ app: 'Microsoft Edge' });
  recorder.capture({ x: 950, y: 55 });
  recorder.capture({ x: 20, y: 110 });
  assert.equal(recorder.setTarget(1, { label: 'Create issue', role: 'button' }), true);
  assert.equal(recorder.setTarget(9, { label: 'Nope' }), false);
  const { steps } = recorder.stop();
  assert.deepEqual(steps[0], { n: 1, x: 950, y: 55, target: { label: 'Create issue', role: 'button' } });
  const guide = buildGuide({ title: 'T', triggers: 't', steps: [{ ...steps[0], label: 'Create issue', say: 'Click it.' }, { ...steps[1], label: '', say: '' }] });
  assert.deepEqual(guide.steps, [
    { x: 950, y: 55, label: 'Create issue', say: 'Click it.', target: { label: 'Create issue', role: 'button' } },
    { x: 20, y: 110, label: 'Step 2', say: 'Step 2.' },
  ]);
});
