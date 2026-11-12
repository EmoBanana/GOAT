import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ROOT } from '../src/config.js';
import { aboutTerms, createDocs, frontMatter, splitByHeadings } from '../src/docs.js';

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

test('front matter is read from the very top of a doc and left out of its text', () => {
  assert.deepEqual(frontMatter('---\nabout: GOAT, x402\nOwner: QA\n---\n# Title\nbody\n'), { meta: { about: 'GOAT, x402', owner: 'QA' }, body: '# Title\nbody\n' });
  assert.deepEqual(frontMatter('# Title\n---\nabout: x\n---\n').meta, {});
  assert.deepEqual(aboutTerms({ about: 'GOAT, Model Context Protocol, the, ' }), [['goat'], ['model', 'context', 'protocol']]);
  assert.equal(aboutTerms({}), null);
});

test('a doc with an `about:` list only answers questions that mention one of its terms', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goat-docs-'));
  fs.writeFileSync(
    path.join(dir, 'goat.md'),
    [
      '---',
      'about: GOAT, x402, MCP, Model Context Protocol, pricing',
      '---',
      '# GOAT',
      '## MCP (Model Context Protocol)',
      'GOAT uses MCP for web search: to set it up, add a Brave Search API key and restart.',
      '## Why x402',
      'The server answers 402 with a price and the client signs a payment.',
    ].join('\n'),
  );
  fs.writeFileSync(path.join(dir, 'sop.md'), '# Site SOP\n## Search first\nSearch the issue register before you log a new issue.\n');
  const docs = createDocs({ dir });
  // GOAT's own setup notes stay out of everyday questions; procedures without a list still match.
  assert.deepEqual(docs.search('show me how to search on google').map((h) => h.file), ['sop.md']);
  assert.deepEqual(docs.search('how do I set up the model in revit'), []);
  // A term, a phrase in order, or a stemmed form lets the doc in.
  assert.equal(docs.search('does GOAT search the web?')[0].heading, 'GOAT › MCP (Model Context Protocol)');
  assert.equal(docs.search('what is the Model Context Protocol?')[0].heading, 'GOAT › MCP (Model Context Protocol)');
  assert.deepEqual(docs.search('what is the context of this protocol?'), [], 'the words of a phrase must come in order');
  assert.equal(docs.search("what's the pricing for?")[0].heading, 'GOAT › Why x402');
  assert.ok(docs.search('what is x402?').every((h) => !h.text.includes('about:')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a missing docs folder is just empty', () => {
  const docs = createDocs({ dir: path.join(ROOT, 'no-such-docs') });
  assert.equal(docs.count, 0);
  assert.deepEqual(docs.search('photo'), []);
});
