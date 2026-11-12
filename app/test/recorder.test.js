import assert from 'node:assert/strict';
import test from 'node:test';
import { buildGuide, createRecorder } from '../lib/recorder.js';

test('recording captures numbered steps in screen points until stopped', () => {
  let t = 1000;
  const rec = createRecorder({ now: () => t });
  assert.equal(rec.capture({ x: 1, y: 2 }), null, 'nothing is captured before start');
  assert.equal(rec.start({ app: 'Bluebeam Revu' }), true);
  assert.equal(rec.start({ app: 'other' }), false, 'a second start is ignored');
  assert.deepEqual(rec.capture({ x: 40.6, y: 22.2 }), { n: 1, x: 41, y: 22 });
  assert.deepEqual(rec.capture({ x: 120, y: 300 }), { n: 2, x: 120, y: 300 });
  assert.equal(rec.capture({ x: NaN, y: 3 }), null);
  assert.equal(rec.steps.length, 2);
  rec.steps[0].x = 999; // a copy, not the live state
  assert.equal(rec.steps[0].x, 41);
  assert.deepEqual(rec.undo(), { n: 2, x: 120, y: 300 });
  rec.capture({ x: 5, y: 6 });
  t = 4000;
  const result = rec.stop();
  assert.deepEqual(result, { app: 'Bluebeam Revu', steps: [{ n: 1, x: 41, y: 22 }, { n: 2, x: 5, y: 6 }], startedAt: 1000, stoppedAt: 4000 });
  assert.equal(rec.recording, false);
  assert.equal(rec.stop(), null);
});

test('the save form becomes a POST /api/guides body with the recorded app', () => {
  const guide = buildGuide(
    { title: ' Export a PDF ', triggers: 'export a pdf, save as pdf', intro: '', steps: [{ x: 41, y: 22, label: 'File', say: '' }, { x: 5, y: 6, label: '', say: 'Click Export.' }] },
    { app: 'Bluebeam Revu', recordedOn: '1710x1107' },
  );
  assert.deepEqual(guide, {
    title: 'Export a PDF',
    triggers: 'export a pdf, save as pdf',
    intro: '',
    apps: ['Bluebeam Revu'],
    recordedOn: '1710x1107',
    steps: [
      { x: 41, y: 22, label: 'File', say: 'File.' },
      { x: 5, y: 6, label: 'Step 2', say: 'Click Export.' },
    ],
  });
  assert.deepEqual(buildGuide({ title: 'x', triggers: ['a'], steps: [] }).apps, []);
});
