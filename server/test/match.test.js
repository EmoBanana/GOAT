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
  assert.equal(triggerScore(tokens('make a new issue'), 'create an issue'), 0.5);
  assert.equal(triggerScore(tokens('nothing related'), 'create an issue'), 0);
});

test('the app bonus lifts a partial match over the 0.6 threshold', () => {
  assert.equal(matchGuide('how do I make a new issue', [forma], {}), null);
  const hit = matchGuide('how do I make a new issue', [forma], { app: 'Google Chrome', title: 'Forma Build - Issues' });
  assert.equal(hit.guide.id, 'forma-log-issue');
  assert.equal(hit.score, 0.65);
  assert.equal(hit.appMatch, true);
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

test('related guides are app matches or partial matches (score >= 0.34)', () => {
  const deck = { id: 'deck', triggers: ['present the pitch'], apps: ['Keynote'] };
  const other = { id: 'other', triggers: ['approve a timesheet'], apps: ['Excel'] };
  const ids = relatedGuides('why do issues need photos', [forma, deck, other], { app: 'Keynote' }).map((r) => r.guide.id);
  assert.deepEqual(ids.sort(), ['deck', 'forma-log-issue']);
});
