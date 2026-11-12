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

export function createDocs({ dir }) {
  const chunks = [];
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md')).sort();
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  for (const file of files) {
    const markdown = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const c of splitByHeadings(markdown)) {
      const section = c.heading.split(' › ').pop();
      chunks.push({ file, ...c, tokens: new Set(tokens(`${c.heading}\n${c.text}`)), headingTokens: new Set(tokens(section)) });
    }
  }

  // Rare words say more than words in every chunk (like a doc title that heads each section).
  const df = new Map();
  for (const c of chunks) for (const t of c.tokens) df.set(t, (df.get(t) || 0) + 1);
  const idf = (t) => Math.log(1 + chunks.length / (1 + (df.get(t) || 0)));

  // Chunks where at least minShare of the question's tokens appear, ranked by how rare the
  // matching words are, with matches in the section heading counting extra.
  function search(question, { limit = 2, minShare = 0.34 } = {}) {
    const q = [...new Set(tokens(question))];
    if (!q.length) return [];
    const total = q.reduce((sum, t) => sum + idf(t), 0) || 1;
    return chunks
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
