import assert from 'node:assert/strict';
import test from 'node:test';
import { matchGuide, relatedGuides, scoreGuide, triggerScore, wantsExplanation } from '../src/guides/match.js';
import { stem, tokens } from '../src/text.js';

const forma = {
  id: 'forma-log-issue',
  triggers: ['log an issue', 'create an issue', 'raise an issue', 'report a defect'],
  apps: ['Forma', 'acc.autodesk.com'],
};

test('light stemming folds plurals and verb forms', () => {
  assert.equal(stem('issues'), stem('issue'));
  assert.equal(stem('logging'), 'log');
  assert.equal(stem('logged'), 'log');
  assert.equal(stem('boxes'), 'box');
  assert.equal(stem('creating'), stem('create'));
  assert.equal(stem('raised'), stem('raise'));
  assert.equal(stem('added'), stem('add'));
  assert.equal(stem('class'), 'class');
  assert.equal(stem('status'), 'status');
});

test('tokens drop punctuation and stopwords', () => {
  assert.deepEqual(tokens('How do I log an issue?'), ['log', stem('issue')]);
  assert.deepEqual(tokens('Show me the boxes!'), ['box']);
  assert.deepEqual(tokens('ALP-GAM-ZZ'), ['alp', 'gam', 'zz']);
});

test('a trigger found inside the question scores 1', () => {
  assert.equal(scoreGuide('how do I log an issue?', forma).score, 1);
  assert.equal(scoreGuide('Logging issues, please', forma).base, 1);
});

test('a partial trigger scores the share of its tokens', () => {
  assert.equal(triggerScore(tokens('close an issue'), 'create an issue'), 0.5);
  assert.equal(triggerScore(tokens('nothing related'), 'create an issue'), 0);
});

test('"make" and "add" ask for "create"', () => {
  assert.equal(matchGuide('how do I make a new issue', [forma], {}).score, 1);
  assert.equal(matchGuide('add an issue', [forma], {}).score, 1);
});

test('the app bonus lifts a partial match over the 0.6 threshold', () => {
  // "report" and "issue" come from different triggers: two shared words, half of "report a defect".
  assert.equal(matchGuide('how do I report an issue', [forma], {}), null);
  const hit = matchGuide('how do I report an issue', [forma], { app: 'Google Chrome', title: 'Forma Build - Issues' });
  assert.equal(hit.guide.id, 'forma-log-issue');
  assert.equal(hit.score, 0.65);
  assert.equal(hit.appMatch, true);
});

test('one shared word is not a match, even in the right app', () => {
  const inForma = { app: 'Google Chrome', title: 'Forma Build - Issues' };
  for (const q of ['how do I filter issues by assignee', 'how do I close an issue', 'how do I create a checklist']) {
    assert.equal(matchGuide(q, [forma], inForma), null, q);
  }
  // ... and it doesn't make the guide context for another app's question either.
  assert.deepEqual(relatedGuides('How do I create a new sheet in Revit?', [forma], { app: 'Revit' }), []);
});

test('apps also match on the URL', () => {
  const s = scoreGuide('log an issue', forma, { app: 'Safari', url: 'https://acc.autodesk.com/build/issues' });
  assert.equal(s.appMatch, true);
  assert.equal(s.score, 1.15);
});

test('unrelated questions match nothing, even in the right app', () => {
  assert.equal(matchGuide('export the timesheet to excel', [forma], { app: 'Forma' }), null);
});

test('why / what is / explain / summarise / describe go to the model', () => {
  for (const q of ['Why do issues need a photo?', 'What is a defect?', "what's x402?", 'Explain the issue types', 'summarise the SOP', 'Summarize this', 'Describe the process']) {
    assert.ok(wantsExplanation(q), q);
  }
  for (const q of ['how do I log an issue', 'log an issue', 'whatever works']) assert.equal(wantsExplanation(q), false, q);
});

test('ties go to the most recently recorded guide', () => {
  const shipped = { id: 'shipped', triggers: ['export a pdf'], apps: [], createdAt: 0 };
  const recorded = { id: 'recorded', triggers: ['export a pdf'], apps: [], createdAt: 5 };
  assert.equal(matchGuide('export a pdf', [shipped, recorded]).guide.id, 'recorded');
  assert.equal(matchGuide('export a pdf', [recorded, shipped]).guide.id, 'recorded');
});

test('a guide recorded on this Mac beats a sample guide, even with the app bonus', () => {
  const sample = { ...forma, recordedOn: 'sample-1440x900' };
  // Recorded from the draft panel: GOAT was in front, so no app.
  const recorded = { id: 'recorded', triggers: ['log an issue'], apps: [], recordedOn: '1710x1107', createdAt: 5 };
  const inForma = { app: 'Google Chrome', title: 'Forma Build - Issues' };
  assert.equal(matchGuide('how do I log an issue', [sample, recorded], inForma).guide.id, 'recorded');
  assert.equal(matchGuide('how do I log an issue', [recorded, sample], inForma).guide.id, 'recorded');
  // The sample still plays when no recorded guide matches.
  assert.equal(matchGuide('how do I raise an issue', [sample, recorded], inForma).guide.id, 'forma-log-issue');
});

test('related guides are partial matches, or guides for the app in front that share a word with the question', () => {
  const deck = { id: 'deck', title: 'Pitch deck tour', triggers: ['present the pitch'], apps: ['Keynote'], steps: [{ label: 'Business model', say: 'How we make money.' }] };
  const other = { id: 'other', triggers: ['approve a timesheet'], apps: ['Excel'] };
  const ids = (q, ctx) => relatedGuides(q, [forma, deck, other], ctx).map((r) => r.guide.id);
  // "report a defect" is a Forma trigger; the deck guide is for the app in front but shares no word.
  assert.deepEqual(ids('why do we report defects', { app: 'Keynote' }), ['forma-log-issue']);
  assert.deepEqual(ids('why do issues need photos', { app: 'Keynote' }), []);
  // The app in front plus a word from the guide's title, triggers or step names.
  assert.deepEqual(ids('what goes on the business model slide?', { app: 'Keynote' }), ['deck']);
  assert.deepEqual(ids('what goes on the business model slide?', { app: 'Excel' }), []);
  // A recorded IDE guide is no context for a Revit question asked with the IDE in front.
  const ide = { id: 'test', title: 'Test', triggers: ['pitch deck tour'], apps: ['Antigravity IDE'], steps: [{ label: 'json', say: 'Click on the json file' }] };
  assert.deepEqual(relatedGuides('how do I set up the model in revit', [ide], { app: 'Antigravity IDE' }), []);
  assert.equal(relatedGuides('which json file holds the settings?', [ide], { app: 'Antigravity IDE' })[0].guide.id, 'test');
});
