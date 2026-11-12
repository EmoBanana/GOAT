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

test('browsers list their controls from the page; other apps through Accessibility', async () => {
  const calls = [];
  const run = async (script, args) => {
    calls.push({ page: script.includes('querySelectorAll'), ax: script.includes('AXUIElementCreateApplication'), args });
    return JSON.stringify({ source: script.includes('AXUIElement') ? 'ax' : 'page', elements: [T('Create issue', 'button', 900, 40), { label: '', x: 1, y: 1, w: 1, h: 1 }] });
  };
  const page = await readTargets({ app: 'Microsoft Edge', pid: 0, env: {}, run });
  assert.deepEqual(page, { source: 'page', elements: [T('Create issue', 'button', 900, 40)] });
  assert.deepEqual(calls[0], { page: true, ax: false, args: ['Microsoft Edge'] });
  const native = await readTargets({ app: 'Keynote', pid: 4242, env: {}, run });
  assert.equal(native.source, 'ax');
  assert.deepEqual(calls[1], { page: false, ax: true, args: [4242] });
  assert.equal(await readTargets({ app: 'Keynote', pid: 0, env: {}, run }), null, 'Accessibility needs the process');
  assert.deepEqual(await readTargets({ app: 'Google Chrome', env: {}, run: async () => JSON.stringify({ error: 'js_off' }) }), { error: 'js_off' });
  assert.match(PAGE_TARGETS_JS, /window\.outerWidth \/ window\.innerWidth/, 'CSS pixels become screen points through the zoom');
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
