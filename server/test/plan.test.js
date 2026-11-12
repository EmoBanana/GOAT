import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { aboutAnotherApp, checkPlan, cleanTargets, findTarget, HOW_TO, planMessages, PLAN_SCHEMA } from '../src/guides/plan.js';
import { startMockOllama } from './helpers/mock-ollama.js';
import { startTestServer } from './helpers/test-server.js';

const T = (label, role, x, y, w = 100, h = 30) => ({ label, role, x, y, w, h });
const SCREEN = [T('Issues', 'link', 10, 100), T('Photos', 'link', 10, 140), T('Create issue', 'button', 900, 40), T('Filters', 'button', 300, 80), T('Open (12)', 'tab', 300, 120)];

test('how-to questions are the ones GOAT can guide', () => {
  for (const q of ['how do I filter issues?', 'How to export the list', 'where do I find photos', "where's the export button", 'show me how to add a photo', 'walk me through closing an issue', 'what do I click to export?']) assert.match(q, HOW_TO, q);
  for (const q of ['Can you show me how to search on Google?', 'please show me where the filters are', 'Hey GOAT, show me how to export', 'point me to the export button', 'where are the filters']) assert.match(q, HOW_TO, q);
  // Asking to be shown counts wherever it comes, as people say and type it.
  for (const q of ['I want to search on google, can you show me how?', 'Okay, so show me how to export the list', 'could you please show me where the filters are', 'filtering issues, walk me through it', 'I want a visual guide for exporting', 'where to find the export button']) {
    assert.match(q, HOW_TO, q);
  }
  for (const q of ['why do issues need a photo?', 'what is MCP?', 'summarise this deck', 'hi', 'can you summarise this deck?', 'I showed my manager the list', 'what does this show?']) assert.doesNotMatch(q, HOW_TO, q);
});

test('controls are matched by name, loosely', () => {
  assert.equal(findTarget(SCREEN, 'Create issue').label, 'Create issue');
  assert.equal(findTarget(SCREEN, 'create an issue').label, 'Create issue');
  assert.equal(findTarget(SCREEN, 'Filters button').label, 'Filters');
  assert.equal(findTarget(SCREEN, 'Open').label, 'Open (12)');
  assert.equal(findTarget(SCREEN, 'Export'), null);
  assert.deepEqual(cleanTargets([{ label: '  Save  ', role: 'button', x: '1', y: 2, w: 3, h: 4 }, { label: '', x: 1, y: 1, w: 1, h: 1 }, { label: 'No size', x: 1, y: 1 }]), [
    { role: 'button', label: 'Save', x: 1, y: 2, w: 3, h: 4 },
  ]);
});

test('the planner sees the controls (quoted, once each), the procedures, the page and the task', () => {
  const [system, user] = planMessages({
    question: 'how do I filter issues?',
    ctx: { app: 'Microsoft Edge', title: 'Issues - Autodesk Build' },
    procedures: 'Every issue needs a photo.',
    doc: { kind: 'page', text: 'Issues (12 open)' },
    targets: [...SCREEN, T('Issues', 'link', 10, 400)],
  });
  assert.match(system.content, /first step's target must be a control from the list/);
  assert.match(user.content, /^App: Microsoft Edge · Window: Issues - Autodesk Build/);
  assert.equal((user.content.match(/"Issues"/g) || []).length, 1, 'listed once');
  assert.match(user.content, /- "Create issue" button/);
  assert.match(user.content, /Company procedures:\nEvery issue needs a photo\./);
  assert.match(user.content, /The page open now:\nIssues \(12 open\)/);
  assert.match(user.content, /Task: how do I filter issues\?$/);
  assert.deepEqual(PLAN_SCHEMA.required, ['possible', 'intro', 'steps']);
  assert.match(system.content, /possible to false, with no steps, only when the task is about another app or website/);
});

test('a plan starts on a control that is on screen; names are tidied and positions filled in', () => {
  const plan = checkPlan(
    JSON.stringify({
      intro: "Here's how to filter.",
      steps: [
        { target: '"Filters" button', say: 'Click Filters.' },
        { target: 'Assignee (assumed)', say: 'Pick the assignee.' },
        { target: '', say: 'Choose a person.' },
      ],
    }),
    SCREEN,
  );
  assert.deepEqual(plan, {
    intro: "Here's how to filter.",
    steps: [
      { target: 'Filters', label: 'Filters', say: 'Click Filters.', x: 350, y: 95 },
      { target: 'Assignee', label: 'Assignee', say: 'Pick the assignee.' },
      { target: '', label: 'Step', say: 'Choose a person.' },
    ],
  });
  assert.equal(checkPlan({ intro: 'x', steps: [{ target: 'Export', say: 'Click Export.' }] }, SCREEN), null, 'the first control must be on screen');
  assert.equal(checkPlan('not json', SCREEN), null);
  assert.equal(checkPlan({ possible: false, intro: 'x', steps: [{ target: 'Filters', say: 'Click.' }] }, SCREEN), null, 'Gemma can decline');
  assert.equal(checkPlan({ possible: true, intro: 'x', steps: [{ target: 'Filters button', say: 'Click.' }] }, SCREEN).steps[0].target, 'Filters');
  assert.equal(checkPlan({ intro: 'x', steps: [] }, SCREEN), null);
});

test('a question about another app or website is never planned on the app in front', () => {
  const ide = { app: 'Antigravity IDE', title: 'main.js — goat' };
  assert.equal(aboutAnotherApp('show me how to search in google', ide), true);
  assert.equal(aboutAnotherApp('how do I sort a column in excel', ide), true);
  assert.equal(aboutAnotherApp('show me how to search in google', { app: 'Microsoft Edge', title: 'Google', url: 'https://www.google.com/' }), false);
  assert.equal(aboutAnotherApp('how do I log an issue in forma', { app: 'Microsoft Edge', title: 'Issues - Autodesk Build' }), false);
  assert.equal(aboutAnotherApp('how do I open the .env file', ide), false);
});

describe('planned guides through /api/assist', () => {
  test('a how-to with the controls on screen and no recorded guide comes back as a guide to play', async () => {
    const plan = { intro: "Here's how to filter issues.", steps: [{ target: 'Filters', say: 'Click Filters.' }, { target: 'Assignee', say: 'Pick the assignee.' }] };
    const ollama = await startMockOllama({ reply: (body) => (body.format ? JSON.stringify(plan) : 'Words.') });
    const srv = await startTestServer({ ollamaUrl: ollama.url });
    try {
      const r = await srv.request('POST', '/api/assist', {
        body: { question: 'how do I filter issues by assignee?', context: { app: 'Microsoft Edge', title: 'Issues' }, targets: SCREEN },
        headers: { 'x-goat-progress': 'plan-ask-001' },
      });
      assert.equal(r.status, 200);
      assert.equal(r.body.source, 'guide');
      assert.equal(r.body.planned, true);
      assert.equal(r.body.say, "Here's how to filter issues.");
      assert.deepEqual(r.body.guide.steps, [
        { target: 'Filters', label: 'Filters', say: 'Click Filters.', x: 350, y: 95 },
        { target: 'Assignee', label: 'Assignee', say: 'Pick the assignee.' },
      ]);
      const [call] = ollama.chats();
      assert.deepEqual(call.body.format, PLAN_SCHEMA);
      assert.ok(call.body.messages.at(-1).content.includes('- "Filters" button'));
      const steps = (await srv.request('GET', '/api/progress/plan-ask-001')).body.steps;
      assert.ok(steps.includes('Planning the steps') && steps.includes('Found “Filters” on screen'), steps.join(' > '));
    } finally {
      await srv.close();
      await ollama.close();
    }
  });

  test('a plan that cannot start on screen, or no controls at all, means an answer in words', async () => {
    const ollama = await startMockOllama({ reply: (body) => (body.format ? JSON.stringify({ intro: 'x', steps: [{ target: 'Export', say: 'Click Export.' }] }) : 'Use Export at the top right.') });
    const srv = await startTestServer({ ollamaUrl: ollama.url });
    try {
      const planned = await srv.request('POST', '/api/assist', { body: { question: 'how do I export the list?', targets: SCREEN } });
      assert.equal(planned.body.source, 'llm');
      assert.equal(planned.body.say, 'Use Export at the top right.');
      ollama.calls.length = 0;
      const none = await srv.request('POST', '/api/assist', { body: { question: 'how do I export the list?' } });
      assert.equal(none.body.source, 'llm');
      assert.ok(ollama.chats().every((c) => !c.body.format), 'no planning without controls');
      const recorded = await srv.request('POST', '/api/assist', { body: { question: 'how do I log an issue?', targets: SCREEN } });
      assert.equal(recorded.body.guide.id, 'forma-log-issue', 'a recorded guide still wins');
      ollama.calls.length = 0;
      const elsewhere = await srv.request('POST', '/api/assist', { body: { question: 'show me how to search in google', context: { app: 'Antigravity IDE' }, targets: SCREEN } });
      assert.equal(elsewhere.body.source, 'llm');
      assert.ok(ollama.chats().every((c) => !c.body.format), 'not planned on the IDE');
    } finally {
      await srv.close();
      await ollama.close();
    }
  });
});
