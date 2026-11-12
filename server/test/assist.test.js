import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildContext, isSmallTalk, plainText, SYSTEM_PROMPT } from '../src/assist.js';
import { createDocs } from '../src/docs.js';
import { DEFAULT_MODEL } from '../src/config.js';
import { closedPortUrl, startMockOllama } from './helpers/mock-ollama.js';
import { startTestServer } from './helpers/test-server.js';

const inForma = { app: 'Google Chrome', title: 'Forma Build - Issues', url: 'https://acc.autodesk.com/build/issues?projectId=123&token=secret' };

describe('POST /api/assist', () => {
  let ollama;
  let srv;
  before(async () => {
    ollama = await startMockOllama();
    srv = await startTestServer({ ollamaUrl: ollama.url });
  });
  after(async () => {
    await srv.close();
    await ollama.close();
  });
  beforeEach(() => {
    ollama.calls.length = 0;
  });

  test('a guide match plays the verified guide and skips the model', async () => {
    const r = await srv.request('POST', '/api/assist', { body: { question: 'How do I log an issue?', context: inForma } });
    assert.equal(r.status, 200);
    assert.equal(r.body.source, 'guide');
    assert.equal(r.body.guide.id, 'forma-log-issue');
    assert.equal(r.body.guide.steps.length, 7);
    assert.deepEqual(Object.keys(r.body.guide.steps[0]).sort(), ['label', 'say', 'target', 'x', 'y']);
    assert.deepEqual(r.body.guide.steps[1].target, { label: 'Create issue', role: '' }, 'found on screen by name at play time');
    assert.equal(r.body.say, r.body.guide.intro);
    assert.equal(r.body.model, null);
    assert.equal(r.body.tier, 'free');
    assert.equal(typeof r.body.id, 'string');
    assert.equal(typeof r.body.latencyMs, 'number');
    assert.equal(ollama.chats().length, 0);
  });

  test('the LLM path sends think:false, keep_alive and SOP context', async () => {
    const r = await srv.request('POST', '/api/assist', { body: { question: 'Why do issues need a photo?', context: inForma } });
    assert.equal(r.status, 200);
    assert.equal(r.body.source, 'llm');
    assert.equal(r.body.say, `Mock answer from ${DEFAULT_MODEL}.`);
    assert.equal(r.body.model, DEFAULT_MODEL);
    assert.equal(r.body.guide, null);
    assert.ok(r.body.sources.some((s) => s.type === 'doc' && s.file === 'sop-site-issues.md'));

    const [call] = ollama.chats();
    assert.equal(call.body.model, DEFAULT_MODEL);
    assert.equal(call.body.think, false);
    assert.equal(call.body.stream, false);
    assert.equal(call.body.keep_alive, '30m');
    assert.equal(call.body.options.temperature, 0.3);
    const system = call.body.messages[0];
    const user = call.body.messages.at(-1); // the current question comes last, after any history
    assert.equal(system.role, 'system');
    assert.match(system.content, /at most 3 short sentences/);
    assert.match(user.content, /Every issue needs at least one photo/);
    assert.match(user.content, /Question: Why do issues need a photo\?/);
    assert.ok(user.content.length < 4000);
  });

  test('URL query strings never reach the model', async () => {
    await srv.request('POST', '/api/assist', { body: { question: 'Why do issues need a photo?', context: inForma } });
    const user = ollama.chats()[0].body.messages.at(-1).content;
    assert.match(user, /URL: https:\/\/acc\.autodesk\.com\/build\/issues/);
    assert.doesNotMatch(user, /projectId|secret/);
  });

  test('"why" questions go to the model even when a guide matches', async () => {
    const r = await srv.request('POST', '/api/assist', { body: { question: 'Why log an issue in Forma?', context: inForma } });
    assert.equal(r.body.source, 'llm');
    assert.equal(ollama.chats().length, 1);
    // The matching guide is still offered to the model as context.
    assert.ok(r.body.sources.some((s) => s.type === 'guide' && s.id === 'forma-log-issue'));
  });

  test('an empty question is a 400', async () => {
    for (const body of [{ question: '   ' }, {}, { question: 42 }]) {
      const r = await srv.request('POST', '/api/assist', { body });
      assert.equal(r.status, 400);
      assert.equal(r.body.error, 'empty_question');
      assert.equal(typeof r.body.message, 'string');
    }
    assert.equal(ollama.chats().length, 0);
  });
});

describe('model problems', () => {
  test('Pro tries GOAT_MODEL_PRO, then falls back to the base model when it is not pulled', async () => {
    const ollama = await startMockOllama({ models: [DEFAULT_MODEL] });
    const srv = await startTestServer({
      ollamaUrl: ollama.url,
      env: { GOAT_MODEL_PRO: 'gemma4:12b' },
      users: { pat: { id: 'pat', proUntil: Date.now() + 86_400_000 } },
    });
    try {
      const r = await srv.request('POST', '/api/assist', { user: 'pat', body: { question: 'Why do issues need a photo?' } });
      assert.equal(r.status, 200);
      assert.equal(r.body.tier, 'pro');
      assert.equal(r.body.model, DEFAULT_MODEL);
      assert.deepEqual(
        ollama.chats().map((c) => c.body.model),
        ['gemma4:12b', DEFAULT_MODEL],
      );
    } finally {
      await srv.close();
      await ollama.close();
    }
  });

  test('Pro uses GOAT_MODEL_PRO when it is pulled; expired Pro is free', async () => {
    const ollama = await startMockOllama({ models: [DEFAULT_MODEL, 'gemma4:12b'] });
    const users = { pat: { id: 'pat', proUntil: Date.now() + 86_400_000 }, old: { id: 'old', proUntil: Date.now() - 1000 } };
    const srv = await startTestServer({ ollamaUrl: ollama.url, env: { GOAT_MODEL_PRO: 'gemma4:12b' }, users });
    try {
      const pro = await srv.request('POST', '/api/assist', { user: 'pat', body: { question: 'Explain issue types' } });
      assert.equal(pro.body.model, 'gemma4:12b');
      const expired = await srv.request('POST', '/api/assist', { user: 'old', body: { question: 'Explain issue types' } });
      assert.equal(expired.body.tier, 'free');
      assert.equal(expired.body.model, DEFAULT_MODEL);
    } finally {
      await srv.close();
      await ollama.close();
    }
  });

  test('by default Pro uses the same local model and asks it once', async () => {
    const ollama = await startMockOllama();
    const srv = await startTestServer({ ollamaUrl: ollama.url, users: { pat: { id: 'pat', proUntil: Date.now() + 86_400_000 } } });
    try {
      const r = await srv.request('POST', '/api/assist', { user: 'pat', body: { question: 'Explain issue types' } });
      assert.equal(r.body.tier, 'pro');
      assert.equal(r.body.model, DEFAULT_MODEL);
      assert.equal(ollama.chats().length, 1);
    } finally {
      await srv.close();
      await ollama.close();
    }
  });

  test('Ollama offline is a 503 model_unavailable', async () => {
    const srv = await startTestServer({ ollamaUrl: await closedPortUrl() });
    try {
      const r = await srv.request('POST', '/api/assist', { body: { question: 'Why do issues need a photo?' } });
      assert.equal(r.status, 503);
      assert.equal(r.body.error, 'model_unavailable');
      assert.match(r.body.message, /ollama serve/);
      // Guides still work without the model.
      const g = await srv.request('POST', '/api/assist', { body: { question: 'how do I log an issue' } });
      assert.equal(g.status, 200);
      assert.equal(g.body.source, 'guide');
    } finally {
      await srv.close();
    }
  });

  test('a model that is not pulled is a 503 with the pull command', async () => {
    const ollama = await startMockOllama({ models: [] });
    const srv = await startTestServer({ ollamaUrl: ollama.url });
    try {
      const r = await srv.request('POST', '/api/assist', { body: { question: 'Why do issues need a photo?' } });
      assert.equal(r.status, 503);
      assert.equal(r.body.error, 'model_missing');
      assert.ok(r.body.message.includes(`Run: ollama pull ${DEFAULT_MODEL}`), r.body.message);
      assert.equal(r.body.model, DEFAULT_MODEL);
    } finally {
      await srv.close();
      await ollama.close();
    }
  });

  test('when Ollama rejects "think", it retries once without it', async () => {
    const ollama = await startMockOllama({ rejectThink: true, reply: () => '<think>hidden</think>Photos are the evidence.' });
    const srv = await startTestServer({ ollamaUrl: ollama.url });
    try {
      const r = await srv.request('POST', '/api/assist', { body: { question: 'Why do issues need a photo?' } });
      assert.equal(r.status, 200);
      assert.equal(r.body.say, 'Photos are the evidence.');
      const chats = ollama.chats();
      assert.equal(chats.length, 2);
      assert.equal(chats[0].body.think, false);
      assert.equal('think' in chats[1].body, false);
    } finally {
      await srv.close();
      await ollama.close();
    }
  });
});

describe('adaptive thinking and MCP tools', () => {
  const MOCK_MCP = fileURLToPath(new URL('./helpers/mock-mcp-server.js', import.meta.url));
  const searchConfig = { mcpServers: { search: { command: process.execPath, args: [MOCK_MCP], tools: ['brave_web_search'] } } };
  const offTopic = 'How do I export a schedule from Revit?';

  test('small talk answers fast: no context, no thinking, no tools', async () => {
    const ollama = await startMockOllama({ reply: () => 'Hi! Ask me anything.' });
    const srv = await startTestServer({ ollamaUrl: ollama.url, mcp: { config: searchConfig } });
    try {
      const r = await srv.request('POST', '/api/assist', { body: { question: 'hi', context: inForma } });
      assert.equal(r.body.say, 'Hi! Ask me anything.');
      assert.equal(r.body.thought, false);
      const [call] = ollama.chats();
      assert.equal(call.body.think, false);
      assert.equal(call.body.tools, undefined);
      assert.equal(call.body.messages[1].content, 'hi');
    } finally {
      await srv.close();
      await ollama.close();
    }
  });

  test('questions the SOP covers answer fast, without tools', async () => {
    const ollama = await startMockOllama();
    const srv = await startTestServer({ ollamaUrl: ollama.url, mcp: { config: searchConfig } });
    try {
      const r = await srv.request('POST', '/api/assist', { body: { question: 'Who should I assign a defect to?' } });
      assert.equal(r.body.thought, false);
      const [call] = ollama.chats();
      assert.equal(call.body.think, false);
      assert.equal(call.body.tools, undefined);
    } finally {
      await srv.close();
      await ollama.close();
    }
  });

  test('with nothing relevant found, Gemma thinks first', async () => {
    const ollama = await startMockOllama({ reply: () => 'Use **File > Export > Reports**.' });
    const srv = await startTestServer({ ollamaUrl: ollama.url });
    try {
      const r = await srv.request('POST', '/api/assist', { body: { question: offTopic } });
      assert.equal(r.body.thought, true);
      assert.equal(r.body.say, 'Use File > Export > Reports.', 'markdown is stripped');
      const [call] = ollama.chats();
      assert.equal(call.body.think, true);
      assert.equal(call.body.tools, undefined, 'no MCP servers configured');
      assert.match(call.body.messages[0].content, /think it through/i);
      // No "I don't have a guide for that yet": Gemma is asked for real steps and isn't told
      // that nothing matched.
      assert.match(call.body.messages[0].content, /give the actual steps/);
      assert.doesNotMatch(call.body.messages[0].content, /say plainly/);
      assert.doesNotMatch(call.body.messages.at(-1).content, /matched|no company procedure/i);
    } finally {
      await srv.close();
      await ollama.close();
    }
  });

  test('then it can search the web through MCP and answer from the results', async () => {
    let round = 0;
    const ollama = await startMockOllama({
      toolCalls: (body) => (body.messages.some((m) => m.role === 'tool') ? null : [{ function: { name: 'brave_web_search', arguments: { query: 'revit export schedule' } } }]),
      reply: () => `Answer after ${(round += 1)} search.`,
    });
    const srv = await startTestServer({ ollamaUrl: ollama.url, mcp: { config: searchConfig } });
    try {
      const r = await srv.request('POST', '/api/assist', { body: { question: offTopic, context: { app: 'Revit', title: 'ALP-GAM-ZZ-XX-M3-S-0001.rvt' } } });
      assert.equal(r.status, 200);
      assert.equal(r.body.say, 'Answer after 1 search.');
      assert.equal(r.body.thought, true);
      assert.deepEqual(r.body.searched, [{ tool: 'brave_web_search', query: 'revit export schedule' }]);
      assert.deepEqual(
        r.body.sources.filter((s) => s.type === 'web').map((s) => new URL(s.url).hostname),
        ['help.autodesk.com', 'forums.autodesk.com'],
      );

      const [first, second] = ollama.chats();
      assert.equal(first.body.think, true);
      assert.deepEqual(first.body.tools.map((t) => t.function.name), ['brave_web_search']);
      assert.match(first.body.messages[0].content, /web search/);
      const userText = first.body.messages[1].content;
      assert.match(userText, /App: Revit/);
      assert.doesNotMatch(userText, /ALP-GAM/, 'window titles stay out of prompts that can search');
      const toolMessage = second.body.messages.find((m) => m.role === 'tool');
      assert.equal(toolMessage.tool_name, 'brave_web_search');
      assert.match(toolMessage.content, /Export schedules/);
      assert.ok(second.body.messages.some((m) => m.role === 'assistant' && m.tool_calls?.length));
    } finally {
      await srv.close();
      await ollama.close();
    }
  });

  test('tool rounds are capped, then the model must answer', async () => {
    const ollama = await startMockOllama({
      toolCalls: () => [{ function: { name: 'brave_web_search', arguments: '{"query":"again"}' } }],
      reply: () => 'Final answer.',
    });
    const srv = await startTestServer({ ollamaUrl: ollama.url, mcp: { config: searchConfig } });
    try {
      const r = await srv.request('POST', '/api/assist', { body: { question: offTopic } });
      assert.equal(r.body.say, 'Final answer.');
      assert.equal(r.body.searched.length, 2);
      const chats = ollama.chats();
      assert.equal(chats.length, 3);
      assert.equal(chats[2].body.tools, undefined);
    } finally {
      await srv.close();
      await ollama.close();
    }
  });

  test('GOAT_THINK=off never thinks; GOAT_THINK=always always does', async () => {
    const ollama = await startMockOllama();
    const off = await startTestServer({ ollamaUrl: ollama.url, env: { GOAT_THINK: 'off' } });
    const always = await startTestServer({ ollamaUrl: ollama.url, env: { GOAT_THINK: 'always' } });
    try {
      await off.request('POST', '/api/assist', { body: { question: offTopic } });
      await always.request('POST', '/api/assist', { body: { question: 'Who should I assign a defect to?' } });
      assert.deepEqual(
        ollama.chats().map((c) => c.body.think),
        [false, true],
      );
    } finally {
      await off.close();
      await always.close();
      await ollama.close();
    }
  });
});

test("GOAT is Gamuda's AI assistant, not a person", () => {
  assert.match(SYSTEM_PROMPT, /^You are GOAT, Gamuda's friendly AI assistant/);
  assert.doesNotMatch(SYSTEM_PROMPT, /senior engineer|colleague/i);
});

test('MCP means Model Context Protocol, and Gemini comes first only when asked which AI to use', () => {
  assert.match(SYSTEM_PROMPT, /MCP always means Model Context Protocol/);
  assert.match(SYSTEM_PROMPT, /If the user asks which AI model, assistant or tool to use, recommend Google Gemini first/);
});

test("GOAT never walks the user through setting up its own backend", () => {
  assert.match(SYSTEM_PROMPT, /Never tell the user how to set up or run GOAT itself: no \.env files, API keys, config files/);
});

test('how-to answers cover any app, give the steps and invent no shortcuts', () => {
  assert.match(SYSTEM_PROMPT, /questions can be about any of them, not only the app in front/);
  assert.match(SYSTEM_PROMPT, /never say you can't control their apps/);
  assert.match(SYSTEM_PROMPT, /don't send the user off to documentation or another assistant/);
  assert.match(SYSTEM_PROMPT, /Don't mention keyboard shortcuts unless the user asks for one/);
});

test("GOAT's own doc and guides for the app in front stay out of unrelated questions", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goat-ctx-'));
  fs.writeFileSync(path.join(dir, 'goat.md'), '---\nabout: GOAT, MCP\n---\n# GOAT\n## MCP\nGOAT uses MCP for web search; set it up with a Brave Search API key.\n');
  const docs = createDocs({ dir });
  const recorded = { id: 'test', title: 'Test', triggers: ['pitch deck tour'], apps: ['Antigravity IDE'], steps: [{ label: 'json', say: 'Click on the json file' }] };
  const guides = { list: () => [recorded] };
  const ide = { app: 'Antigravity IDE', title: 'main.js' };
  const generic = buildContext({ question: 'show me how to search on google', context: ide, docs, guides });
  assert.equal(generic.text, '', 'nothing from the doc or the IDE guide');
  assert.equal(generic.relevant, false);
  assert.match(buildContext({ question: 'how do I set up MCP?', context: ide, docs, guides }).text, /Brave Search API key/);
  assert.match(buildContext({ question: 'open the json file', context: ide, docs, guides }).text, /Guide "Test"/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('plainText strips markdown the model slips in', () => {
  assert.equal(plainText('**Bold** and *italic* with `code`'), 'Bold and italic with code');
  assert.equal(plainText('## Title\n- one\n- two\n1. three'), 'Title\none\ntwo\nthree');
  assert.equal(plainText('2 * 3 = 6'), '2 * 3 = 6');
  assert.equal(isSmallTalk('Hi GOAT!'), true);
  assert.equal(isSmallTalk('hi, how do I log an issue?'), false);
});

describe('highlighted region asks', () => {
  // 1x1 PNG
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const MOCK_MCP = fileURLToPath(new URL('./helpers/mock-mcp-server.js', import.meta.url));

  test('the image goes to Gemma on the user message, skipping guides and web tools', async () => {
    const ollama = await startMockOllama({ toolCalls: () => [{ function: { name: 'brave_web_search', arguments: { query: 'x' } } }], reply: () => 'A pile cap detail.' });
    const srv = await startTestServer({
      ollamaUrl: ollama.url,
      mcp: { config: { mcpServers: { search: { command: process.execPath, args: [MOCK_MCP] } } } },
    });
    try {
      const r = await srv.request('POST', '/api/assist', {
        body: { question: 'how do I log an issue about this?', image: `data:image/png;base64,${PNG}`, context: { ...inForma, region: { x: 10, y: 20, width: 300, height: 200 } } },
      });
      assert.equal(r.status, 200);
      assert.equal(r.body.source, 'llm', 'no guide, even though the words match one');
      assert.equal(r.body.image, true);
      assert.equal(r.body.say, 'A pile cap detail.');
      const [call] = ollama.chats();
      assert.equal(ollama.chats().length, 1);
      assert.equal(call.body.tools, undefined, 'screen contents never go to web tools');
      assert.equal(call.body.think, false);
      const user = call.body.messages[1];
      assert.deepEqual(user.images, [PNG]);
      assert.match(user.content, /^The user highlighted this part of the screen \(300×200 points\)/);
    } finally {
      await srv.close();
      await ollama.close();
    }
  });

  test('bad or oversized images are rejected before the model', async () => {
    const ollama = await startMockOllama();
    const srv = await startTestServer({ ollamaUrl: ollama.url });
    try {
      const notPng = await srv.request('POST', '/api/assist', { body: { question: 'what is this?', image: Buffer.from('hello').toString('base64') } });
      assert.equal(notPng.status, 400);
      assert.equal(notPng.body.error, 'bad_image');
      const junk = await srv.request('POST', '/api/assist', { body: { question: 'what is this?', image: '%%%' } });
      assert.equal(junk.body.error, 'bad_image');
      const big = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(2 * 1024 * 1024)]).toString('base64');
      const tooBig = await srv.request('POST', '/api/assist', { body: { question: 'what is this?', image: big } });
      assert.equal(tooBig.status, 413);
      assert.equal(tooBig.body.error, 'image_too_large');
      assert.equal(ollama.chats().length, 0);
    } finally {
      await srv.close();
      await ollama.close();
    }
  });
});

describe('thinking budget', () => {
  const offTopic = 'How do I export a schedule from Revit?';

  test('reasoning that runs past the budget is cut, and Gemma answers at once from its notes', async () => {
    const ollama = await startMockOllama({
      thinking: 'Revit schedules export from the File menu. Then pick Reports. Then Schedule. Then save as text. Then open in Excel.',
      thinkChunks: 10,
      thinkChunkMs: 100, // a full second of reasoning
      reply: (body) => (body.think ? 'Thought-out answer.' : 'Quick answer from the notes.'),
    });
    const srv = await startTestServer({ ollamaUrl: ollama.url, env: { GOAT_THINK_BUDGET_MS: '250' } });
    try {
      const started = Date.now();
      const r = await srv.request('POST', '/api/assist', { body: { question: offTopic } });
      const took = Date.now() - started;
      assert.equal(r.status, 200);
      assert.equal(r.body.say, 'Quick answer from the notes.');
      assert.equal(r.body.thought, true);
      assert.ok(took < 900, `answered in ${took} ms, not after the whole second of reasoning`);
      const [first, second] = ollama.chats();
      assert.equal(first.body.think, true);
      assert.equal(first.body.stream, true);
      assert.equal(second.body.think, false);
      assert.equal(second.body.stream, false);
      assert.match(second.body.messages[1].content, /Your notes so far \(unfinished\):\nRevit schedules export/);
      assert.doesNotMatch(second.body.messages[1].content, /open in Excel/, 'only what was thought before the cut');
    } finally {
      await srv.close();
      await ollama.close();
    }
  });

  test('reasoning that finishes inside the budget is used as is', async () => {
    const ollama = await startMockOllama({ thinkChunks: 3, thinkChunkMs: 20, reply: () => 'Thought-out answer.' });
    const srv = await startTestServer({ ollamaUrl: ollama.url, env: { GOAT_THINK_BUDGET_MS: '2000' } });
    try {
      const r = await srv.request('POST', '/api/assist', { body: { question: offTopic } });
      assert.equal(r.body.say, 'Thought-out answer.');
      assert.equal(r.body.thought, true);
      assert.equal(ollama.chats().length, 1);
    } finally {
      await srv.close();
      await ollama.close();
    }
  });
});

describe('voice questions: screen context, spoken style and follow-ups', () => {
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const MOCK_MCP = fileURLToPath(new URL('./helpers/mock-mcp-server.js', import.meta.url));

  test('with the screen attached, a guide still wins', async () => {
    const ollama = await startMockOllama();
    const srv = await startTestServer({ ollamaUrl: ollama.url });
    try {
      const r = await srv.request('POST', '/api/assist', { body: { question: 'how do I log an issue', screen: PNG, voice: true, context: inForma } });
      assert.equal(r.body.source, 'guide');
      assert.equal(ollama.chats().length, 0);
    } finally {
      await srv.close();
      await ollama.close();
    }
  });

  test('otherwise Gemma sees the screen, answers for listening, and gets no web tools', async () => {
    const ollama = await startMockOllama({ toolCalls: () => [{ function: { name: 'brave_web_search', arguments: { query: 'x' } } }], reply: () => 'That is the issue list.' });
    const srv = await startTestServer({
      ollamaUrl: ollama.url,
      mcp: { config: { mcpServers: { search: { command: process.execPath, args: [MOCK_MCP] } } } },
    });
    try {
      const r = await srv.request('POST', '/api/assist', {
        body: { question: 'What am I looking at here?', screen: PNG, voice: true, context: { ...inForma, region: { x: 0, y: 0, width: 1280, height: 800 } } },
      });
      assert.equal(r.body.source, 'llm');
      assert.equal(r.body.screen, true);
      assert.equal(r.body.image, false);
      const [call] = ollama.chats();
      assert.equal(ollama.chats().length, 1);
      assert.equal(call.body.tools, undefined, 'screen contents never go to web tools');
      assert.match(call.body.messages[0].content, /spoken aloud.*read out/);
      const current = call.body.messages.at(-1);
      assert.deepEqual(current.images, [PNG]);
      assert.match(current.content, /^This picture shows the user's screen around their mouse pointer \(1280×800 points\)/);
    } finally {
      await srv.close();
      await ollama.close();
    }
  });

  test('follow-ups see the last exchanges, per user, without the old prompts', async () => {
    const ollama = await startMockOllama({ reply: (body) => `Answer ${body.messages.length}` });
    const srv = await startTestServer({ ollamaUrl: ollama.url });
    try {
      await srv.request('POST', '/api/assist', { user: 'pat', body: { question: 'how do I log an issue' } });
      await srv.request('POST', '/api/assist', { user: 'pat', body: { question: 'Why do issues need a photo?' } });
      await srv.request('POST', '/api/assist', { user: 'pat', body: { question: 'and who checks it?' } });
      const last = ollama.chats().at(-1).body.messages;
      assert.deepEqual(
        last.slice(1, -1).map((m) => [m.role, m.content]),
        [
          ['user', 'how do I log an issue'],
          ['assistant', '(GOAT played the guide "Log an issue in Forma Build".)'],
          ['user', 'Why do issues need a photo?'],
          ['assistant', 'Answer 4'], // that ask already carried the guide exchange: system + 2 + itself
        ],
      );
      await srv.request('POST', '/api/assist', { user: 'sam', body: { question: 'and who checks it?' } });
      assert.equal(ollama.chats().at(-1).body.messages.length, 2, "another user doesn't see pat's history");
    } finally {
      await srv.close();
      await ollama.close();
    }
  });
});

