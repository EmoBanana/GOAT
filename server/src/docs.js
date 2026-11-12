import fs from 'node:fs';
import path from 'node:path';
import { tokens } from './text.js';

// Split markdown into one chunk per heading; the chunk heading reads "Doc title › Section".
export function splitByHeadings(markdown) {
  const chunks = [];
  let title = '';
  let section = '';
  let lines = [];
  const flush = () => {
    const body = lines.join('\n').trim();
    if (body) chunks.push({ heading: [title, section].filter(Boolean).join(' › '), text: body });
    lines = [];
  };
  for (const line of String(markdown).split(/\r?\n/)) {
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) {
      flush();
      if (m[1].length === 1) {
        title = m[2];
        section = '';
      } else {
        section = m[2];
      }
      continue;
    }
    lines.push(line);
  }
  flush();
  return chunks;
}

// Optional front matter (`---` lines at the very top) with `key: value` lines.
export function frontMatter(markdown) {
  const text = String(markdown);
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^\s*([A-Za-z][\w-]*)\s*:\s*(.*?)\s*$/.exec(line);
    if (kv) meta[kv[1].toLowerCase()] = kv[2];
  }
  return { meta, body: text.slice(m[0].length) };
}

// `about: GOAT, x402, Model Context Protocol` limits a doc to questions that mention one of
// those terms (a phrase counts when its words come in order). A doc about GOAT itself would
// otherwise answer "how do I search on Google" or "set up the model in Revit" from its own setup notes.
export function aboutTerms(meta) {
  const terms = String(meta.about || '')
    .split(',')
    .map((t) => tokens(t))
    .filter((t) => t.length);
  return terms.length ? terms : null;
}
const mentions = (words, term) => words.some((_, i) => term.every((t, j) => words[i + j] === t));

export function createDocs({ dir }) {
  const chunks = [];
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md')).sort();
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  for (const file of files) {
    const { meta, body } = frontMatter(fs.readFileSync(path.join(dir, file), 'utf8'));
    const about = aboutTerms(meta);
    for (const c of splitByHeadings(body)) {
      const section = c.heading.split(' › ').pop();
      chunks.push({ file, about, ...c, tokens: new Set(tokens(`${c.heading}\n${c.text}`)), headingTokens: new Set(tokens(section)) });
    }
  }

  // Rare words say more than words in every chunk (like a doc title that heads each section).
  const df = new Map();
  for (const c of chunks) for (const t of c.tokens) df.set(t, (df.get(t) || 0) + 1);
  const idf = (t) => Math.log(1 + chunks.length / (1 + (df.get(t) || 0)));

  // Chunks where at least minShare of the question's tokens appear, ranked by how rare the
  // matching words are, with matches in the section heading counting extra.
  function search(question, { limit = 2, minShare = 0.34 } = {}) {
    const words = tokens(question);
    const q = [...new Set(words)];
    if (!q.length) return [];
    const total = q.reduce((sum, t) => sum + idf(t), 0) || 1;
    return chunks
      .filter((c) => !c.about || c.about.some((term) => mentions(words, term)))
      .map((c) => {
        const hits = q.filter((t) => c.tokens.has(t));
        const weight = hits.reduce((sum, t) => sum + idf(t) * (c.headingTokens.has(t) ? 1.5 : 1), 0) / total;
        return { file: c.file, heading: c.heading, text: c.text, score: hits.length / q.length, rank: weight };
      })
      .filter((r) => r.score >= minShare)
      .sort((a, b) => b.rank - a.rank || b.score - a.score)
      .slice(0, limit)
      .map(({ rank, ...r }) => r);
  }

  return { files: files.length, count: chunks.length, search };
}
