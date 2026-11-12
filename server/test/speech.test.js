import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { DEFAULT_VOICE, DEFAULT_VOICE_MODEL, loadConfig, loadEnvFiles } from '../src/config.js';
import { createSpeech } from '../src/speech.js';
import { startMockElevenLabs, toneWav } from './helpers/mock-elevenlabs.js';
import { closedPortUrl } from './helpers/mock-ollama.js';
import { quietLogger, startTestServer } from './helpers/test-server.js';

const PRO = { pat: { id: 'pat', proUntil: Date.now() + 86_400_000 } };
const speak = (srv, text, user = 'pat') => srv.request('POST', '/api/voice/speak', { user, body: { text } });

describe('POST /api/voice/speak with ElevenLabs', () => {
  let eleven;
  let srv;
  before(async () => {
    eleven = await startMockElevenLabs();
    srv = await startTestServer({ users: PRO, env: { ELEVENLABS_API_KEY: 'test-key', ELEVENLABS_BASE_URL: eleven.url } });
  });
  after(async () => {
    await srv.close();
    await eleven.close();
  });

  test('free users get 403 pro_required and nothing is sent', async () => {
    const r = await speak(srv, 'MCP is Model Context Protocol.', 'freebie');
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'pro_required');
    assert.equal(eleven.calls.length, 0);
  });

  test("Pro text goes to the voice with the server's key, and the audio comes back as base64", async () => {
    const r = await speak(srv, '  MCP is\n Model Context Protocol. ');
    assert.equal(r.status, 200);
    assert.equal(r.body.voice, 'elevenlabs');
    assert.equal(r.body.mime, 'audio/mpeg');
    assert.equal(r.body.cached, false);
    assert.ok(Buffer.from(r.body.audio, 'base64').equals(toneWav()), 'the audio is passed through untouched');
    assert.equal(eleven.calls.length, 1);
    const [call] = eleven.calls;
    assert.equal(call.path, `/v1/text-to-speech/${DEFAULT_VOICE}`);
    assert.equal(call.query.output_format, 'mp3_44100_128');
    assert.equal(call.key, 'test-key');
    assert.deepEqual(call.body, {
      text: 'MCP is Model Context Protocol.',
      model_id: DEFAULT_VOICE_MODEL,
      voice_settings: { stability: 0.4, similarity_boost: 0.75 },
    });
    assert.ok(!JSON.stringify(r.body).includes('test-key'), 'the key never reaches the app');
  });

  test('the same line again comes from memory, not from ElevenLabs', async () => {
    const r = await speak(srv, 'MCP is Model Context Protocol.');
    assert.equal(r.status, 200);
    assert.equal(r.body.cached, true);
    assert.equal(eleven.calls.length, 1);
  });

  test('empty or very long text is refused before anything is sent', async () => {
    const before = eleven.calls.length;
    const empty = await speak(srv, '   ');
    assert.equal(empty.status, 400);
    assert.equal(empty.body.error, 'empty_text');
    const none = await srv.request('POST', '/api/voice/speak', { user: 'pat', body: {} });
    assert.equal(none.status, 400);
    const long = await speak(srv, 'word '.repeat(250));
    assert.equal(long.status, 413);
    assert.equal(long.body.error, 'text_too_long');
    assert.equal(eleven.calls.length, before);
  });

  test('health names the voice and model, never the key', async () => {
    const r = await srv.request('GET', '/api/health');
    assert.deepEqual(r.body.speech, { provider: 'elevenlabs', voice: DEFAULT_VOICE, model: DEFAULT_VOICE_MODEL });
    assert.ok(!r.text.includes('test-key'));
  });
});

describe("when ElevenLabs can't speak, the answer is 503 so the overlay uses the Mac's voice", () => {
  test('no key: 503 speech_unavailable, and health says system', async () => {
    const srv = await startTestServer({ users: PRO });
    try {
      const r = await speak(srv, 'Hello.');
      assert.equal(r.status, 503);
      assert.equal(r.body.error, 'speech_unavailable');
      assert.deepEqual((await srv.request('GET', '/api/health')).body.speech, { provider: 'system' });
    } finally {
      await srv.close();
    }
  });

  test('GOAT_TTS=system keeps every word on the laptop even with a key', async () => {
    const eleven = await startMockElevenLabs();
    const srv = await startTestServer({ users: PRO, env: { ELEVENLABS_API_KEY: 'test-key', ELEVENLABS_BASE_URL: eleven.url, GOAT_TTS: 'system' } });
    try {
      assert.equal((await speak(srv, 'Hello.')).status, 503);
      assert.equal(eleven.calls.length, 0);
    } finally {
      await srv.close();
      await eleven.close();
    }
  });

  test('a refusal (quota used up) pauses ElevenLabs for a minute; lines already made still play', async () => {
    const eleven = await startMockElevenLabs();
    const warnings = [];
    let clock = 1_000_000;
    const config = loadConfig({ ELEVENLABS_API_KEY: 'test-key', ELEVENLABS_BASE_URL: eleven.url });
    const speech = createSpeech({ config, logger: { ...quietLogger, warn: (line) => warnings.push(line) }, now: () => clock });
    try {
      assert.equal((await speech.say('Open Issues from the left menu.')).cached, false);
      eleven.state.fail = { status: 401, detail: 'quota_exceeded' };
      await assert.rejects(speech.say('Top secret site name.'), { status: 503, code: 'speech_unavailable' });
      assert.equal(eleven.calls.length, 2);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /answered 401 \(quota_exceeded\)/);
      assert.ok(!warnings[0].includes('Top secret'), 'what GOAT was saying stays out of the log');
      // Paused: nothing is sent, though ElevenLabs would answer again.
      eleven.state.fail = null;
      await assert.rejects(speech.say('Another line.'), { status: 503 });
      assert.equal(eleven.calls.length, 2);
      assert.equal((await speech.say('Open Issues from the left menu.')).cached, true);
      // A minute later it's tried again.
      clock += 61_000;
      assert.equal((await speech.say('Another line.')).cached, false);
      assert.equal(eleven.calls.length, 3);
    } finally {
      await eleven.close();
    }
  });

  test('an unreachable ElevenLabs is a 503 too', async () => {
    const config = loadConfig({ ELEVENLABS_API_KEY: 'test-key', ELEVENLABS_BASE_URL: await closedPortUrl() });
    const speech = createSpeech({ config, logger: quietLogger });
    await assert.rejects(speech.say('Hello.'), { status: 503, code: 'speech_unavailable' });
  });
});

test('.env.local is read before .env; a variable already set wins and an empty one counts as unset', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goat-env-'));
  try {
    fs.writeFileSync(path.join(dir, '.env.local'), 'ELEVENLABS_API_KEY=from-local\nGOAT_PORT=1111\n');
    fs.writeFileSync(path.join(dir, '.env'), 'ELEVENLABS_API_KEY=\nGOAT_PORT=2222\nGOAT_MODEL=from-env # the model\nMYR_PER_USD=4.5\n');
    const env = { ELEVENLABS_API_KEY: '', MYR_PER_USD: '4.2' };
    loadEnvFiles(dir, env);
    assert.deepEqual(env, { ELEVENLABS_API_KEY: 'from-local', GOAT_PORT: '1111', GOAT_MODEL: 'from-env', MYR_PER_USD: '4.2' });
    const none = {};
    loadEnvFiles(path.join(dir, 'missing'), none);
    assert.deepEqual(none, {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
