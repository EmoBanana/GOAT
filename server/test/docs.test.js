import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { ROOT } from '../src/config.js';
import { createDocs, splitByHeadings } from '../src/docs.js';

test('markdown is split into one chunk per heading', () => {
  const chunks = splitByHeadings('# Title\nintro\n## A\nalpha text\n## B\nbravo text\n### Empty\n');
  assert.deepEqual(
    chunks.map((c) => c.heading),
    ['Title', 'Title › A', 'Title › B'],
  );
  assert.equal(chunks[1].text, 'alpha text');
});

test('the SOP photo section answers "why do issues need a photo"', () => {
  const docs = createDocs({ dir: path.join(ROOT, 'docs') });
  assert.ok(docs.files >= 1);
  const hits = docs.search('Why do issues need a photo?');
  assert.ok(hits.length >= 1 && hits.length <= 2);
  assert.equal(hits[0].file, 'sop-site-issues.md');
  assert.match(hits[0].heading, /Photos/);
  assert.equal(hits[0].score, 1);
});

test('chunks under 34% of the question tokens are dropped', () => {
  const docs = createDocs({ dir: path.join(ROOT, 'docs') });
  assert.deepEqual(docs.search('quantum chromodynamics on a lattice'), []);
  assert.deepEqual(docs.search('how do I'), []);
});

test('a missing docs folder is just empty', () => {
  const docs = createDocs({ dir: path.join(ROOT, 'no-such-docs') });
  assert.equal(docs.count, 0);
  assert.deepEqual(docs.search('photo'), []);
});
