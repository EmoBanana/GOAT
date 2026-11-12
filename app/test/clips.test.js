import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { clipFor, CLIPS } from '../lib/clips.js';

const mcp = CLIPS.find((c) => c.name === 'MCP');

test('"What\'s MCP?" and the ways it gets said have the MCP clip', () => {
  for (const q of [
    "What's MCP?",
    'What is MCP?',
    'what is mcp',
    'Whats MCP',
    'What’s MCP?',
    'Okay, what is MCP?',
    'Hey GOAT, what is an MCP?',
    'So, um, what is MCP?',
    'What is M.C.P.?',
    'What is Model Context Protocol?',
    'What is MCP exactly?',
    'What is MCP in GOAT?',
  ]) {
    assert.match(q, mcp.asked, q);
  }
  for (const q of ['How do I set up MCP?', "What is MCP's role in the timesheet?", 'What is MCPX?', 'What is a PDF?', 'Tell me about MCP', 'what is the MCP server called in the config file']) {
    assert.doesNotMatch(q, mcp.asked, q);
  }
});

test('a clip is found only when its file is on this Mac, in the first folder that has it', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'goat-clips-'));
  const full = fs.mkdtempSync(path.join(os.tmpdir(), 'goat-clips-'));
  fs.writeFileSync(path.join(full, 'MCP.mp4'), 'not really a video');
  try {
    assert.deepEqual(clipFor("What's MCP?", { dirs: [undefined, empty, full] }), { name: 'MCP', url: pathToFileURL(path.join(full, 'MCP.mp4')).href, question: "What's MCP?" });
    assert.equal(clipFor('Once MCP', { dirs: [full] }).question, "What's MCP?", 'the model gets the question as meant');
    assert.equal(clipFor("What's MCP?", { dirs: [empty] }), null, 'no file, no clip');
    assert.equal(clipFor('How do I set up MCP?', { dirs: [full] }), null, 'another question');
    assert.equal(clipFor("What's MCP?"), null, 'nowhere to look');
    fs.mkdirSync(path.join(empty, 'MCP.mp4'));
    assert.equal(clipFor("What's MCP?", { dirs: [empty] }), null, 'a folder with that name is not a clip');
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
    fs.rmSync(full, { recursive: true, force: true });
  }
});

test('a short transcript that names MCP has the clip too, since speech to text mishears "what\'s"', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goat-clips-'));
  fs.writeFileSync(path.join(dir, 'MCP.mp4'), 'not really a video');
  try {
    for (const q of ['What? MCP', 'months mcp', 'What MCP', 'MCP?']) assert.equal(clipFor(q, { dirs: [dir] })?.name, 'MCP', q);
    for (const q of ['How do I set up MCP?', 'set up MCP', 'Is MCP free?', 'How MCP works', 'Tell me about MCP and GOAT payments today']) {
      assert.equal(clipFor(q, { dirs: [dir] }), null, q);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
