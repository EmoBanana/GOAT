// Short video clips GOAT plays before it answers a spoken question: "What's MCP?" plays MCP.mp4 in
// the middle of a cloudy screen, and the answer is spoken once the clip ends. The clips are files
// on this Mac, kept out of the repo and the downloads: in GOAT_CLIPS_DIR, else the project folder.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// "What's MCP?", "what is MCP", "Okay, what is an MCP?", "Hey GOAT, what's M.C.P.?", "What is
// Model Context Protocol?", a few words after it at most ("…exactly?"), and nothing else.
const LEAD = String.raw`^\W*(?:(?:hey\s+)?goat\W+)?(?:(?:so|okay|ok|um+|uh+|and|then|right)\W+)*`;
const WHAT_IS = String.raw`(?:what(?:['’]s|\s+is)|whats)\s+(?:an?\s+|the\s+)?`;
const TAIL = String.raw`(?:\s+[a-z]+){0,3}\W*$`;

const MCP = String.raw`(?:mcp|m\.?\s?c\.?\s?p\.?|model\s+context\s+protocol)`;
// Speech to text doesn't always hear "what's": "What? MCP", "months MCP". A short transcript (four
// words at most) that names MCP counts too, unless it asks how to do something with it.
const SHORT_MCP = new RegExp(`\\b${MCP}\\b`, 'i');
const NOT_WHAT = /^\W*(?:how|where|show|set|setup|install|open|use|enable|configure|connect|can|could|do|does|is|are|should|turn)\b/i;
const shortMention = (q) => SHORT_MCP.test(q) && !NOT_WHAT.test(q) && (q.match(/[a-z0-9]+/gi) || []).length <= 4;

export const CLIPS = [
  {
    name: 'MCP',
    file: 'MCP.mp4',
    asked: new RegExp(`${LEAD}${WHAT_IS}${MCP}${TAIL}`, 'i'),
    loosely: shortMention,
    // What the model is asked, whatever speech to text made of it ("Once MCP" got setup steps).
    question: "What's MCP?",
  },
];

// { name, url, question } for a question that has a clip on this Mac, else null. dirs: where to
// look, in order. question: the question as it's meant, to ask the model instead of the transcript.
export function clipFor(question, { dirs = [] } = {}) {
  const q = String(question || '').slice(0, 300);
  const clip = CLIPS.find((c) => c.asked.test(q) || (c.loosely && c.loosely(q)));
  if (!clip) return null;
  for (const dir of dirs.filter(Boolean)) {
    const file = path.join(String(dir), clip.file);
    try {
      if (fs.statSync(file).isFile()) return { name: clip.name, url: pathToFileURL(file).href, question: clip.question };
    } catch {
      // not in this folder
    }
  }
  return null;
}
