import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { checkWav, cleanTranscript, isNoSpeech, vocabulary } from '../src/voice.js';
import { startMockOllama } from './helpers/mock-ollama.js';
import { startTestServer } from './helpers/test-server.js';

// A tiny valid WAV: 16 kHz mono PCM16, 0.1 s of silence.
function wav(samples = 1600) {
  const b = Buffer.alloc(44 + samples * 2);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(36 + samples * 2, 4);
  b.write('WAVE', 8, 'latin1');
  b.write('fmt ', 12, 'latin1');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'latin1');
  b.writeUInt32LE(samples * 2, 40);
  return b.toString('base64');
}

test('only WAV recordings are accepted', () => {
  assert.equal(checkWav(`data:audio/wav;base64,${wav()}`), wav());
  assert.throws(() => checkWav(Buffer.from('not a wav file at all, honestly not one').toString('base64')), /WAV/);
  assert.throws(() => checkWav(42), /base64 WAV/);
  assert.equal(cleanTranscript('  "How do I log an issue?"\n'), 'How do I log an issue?');
});

describe('POST /api/voice/transcribe', () => {
  let ollama;
  let srv;
  before(async () => {
    ollama = await startMockOllama({ transcript: '"How do I log an issue?"' });
    srv = await startTestServer({ ollamaUrl: ollama.url, users: { pat: { id: 'pat', proUntil: Date.now() + 86_400_000 } } });
  });
  after(async () => {
    await srv.close();
    await ollama.close();
  });

  test('free users get 403 pro_required', async () => {
    const r = await srv.request('POST', '/api/voice/transcribe', { user: 'freebie', body: { audio: wav() } });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'pro_required');
    assert.equal(ollama.chats().length, 0);
  });

  test('Pro audio goes to Gemma in images on the native /api/chat, and the transcript comes back', async () => {
    const r = await srv.request('POST', '/api/voice/transcribe', { user: 'pat', body: { audio: wav() } });
    assert.equal(r.status, 200);
    assert.equal(r.body.transcript, 'How do I log an issue?');
    const [call] = ollama.chats();
    assert.equal(call.body.think, false);
    assert.equal(call.body.options.temperature, 0);
    const [system, user] = call.body.messages;
    assert.match(system.content, /speech-to-text engine/);
    assert.match(system.content, /Alpha Viaduct/, 'project names from config/projects.json');
    assert.match(system.content, /including words that are not in this list; never write the list itself/);
    assert.match(system.content, /NO_SPEECH only if the audio is silent or just noise/);
    assert.deepEqual(user, { role: 'user', content: 'Transcribe this audio.', images: [wav()] });
  });

  test('bad audio is a 400 and never reaches the model', async () => {
    ollama.calls.length = 0;
    const r = await srv.request('POST', '/api/voice/transcribe', { user: 'pat', body: { audio: 'aGVsbG8=' } });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'bad_audio');
    assert.equal(ollama.chats().length, 0);
  });
});

describe('transcription guards', () => {
  test('NO_SPEECH and a recited term list are a 422 no_speech, never a question', async () => {
    const ollama = await startMockOllama({ transcript: 'NO_SPEECH' });
    const srv = await startTestServer({ ollamaUrl: ollama.url, users: { pat: { id: 'pat', proUntil: Date.now() + 86_400_000 } } });
    try {
      const silent = await srv.request('POST', '/api/voice/transcribe', { user: 'pat', body: { audio: wav() } });
      assert.equal(silent.status, 422);
      assert.equal(silent.body.error, 'no_speech');
      ollama.state.transcript = 'Forma Build, Revit, Bluebeam, RFI, ISO 19650, timesheet?';
      const echo = await srv.request('POST', '/api/voice/transcribe', { user: 'pat', body: { audio: wav() } });
      assert.equal(echo.status, 422);
      ollama.state.transcript = 'Transcript: "Raise an RFI for pier P12 in Revit."';
      const ok = await srv.request('POST', '/api/voice/transcribe', { user: 'pat', body: { audio: wav() } });
      assert.equal(ok.body.transcript, 'Raise an RFI for pier P12 in Revit.');
    } finally {
      await srv.close();
      await ollama.close();
    }
  });

  test('the vocabulary adds project names without the "Sample:" prefix', () => {
    const terms = vocabulary(['Sample: Alpha Viaduct', 'GOAT hackathon']);
    assert.ok(terms.includes('Alpha Viaduct'));
    assert.ok(terms.includes('GOAT hackathon'));
    assert.ok(terms.length <= 30);
    assert.equal(isNoSpeech('How do I log an issue in Forma Build?', terms), false);
  });
});
