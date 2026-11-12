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
      chunks.push({ file, ...c, tokens: new Set(tokens(`${c.heading}\n${c.text}`)) });
    }
  }

  // Top chunks where at least minShare of the question's tokens appear.
  function search(question, { limit = 2, minShare = 0.34 } = {}) {
    const q = [...new Set(tokens(question))];
    if (!q.length) return [];
    return chunks
      .map((c) => ({ file: c.file, heading: c.heading, text: c.text, score: q.filter((t) => c.tokens.has(t)).length / q.length }))
      .filter((r) => r.score >= minShare)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  return { files: files.length, count: chunks.length, search };
}
