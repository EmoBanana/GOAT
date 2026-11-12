import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
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

test('rare words and section headings outrank words found everywhere', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goat-docs-'));
  fs.writeFileSync(
    path.join(dir, 'pitch.md'),
    [
      '# GOAT: the tool',
      '## Problem',
      'Partners use tools a few times a month and GOAT helps.',
      '## Stack',
      'Payments use the x402 libraries with viem.',
      '## Why x402',
      'x402 revives HTTP 402: one-cent payments without card fees.',
    ].join('\n'),
  );
  const docs = createDocs({ dir });
  const hits = docs.search('What is x402 and why does GOAT use it?');
  assert.equal(hits[0].heading, 'GOAT: the tool › Why x402');
  assert.ok(hits.every((h) => h.score >= 0.34), 'the 34% rule still filters');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a missing docs folder is just empty', () => {
  const docs = createDocs({ dir: path.join(ROOT, 'no-such-docs') });
  assert.equal(docs.count, 0);
  assert.deepEqual(docs.search('photo'), []);
});
