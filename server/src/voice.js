import { HttpError } from './errors.js';

export const TRANSCRIBE_PROMPT = 'Transcribe this audio verbatim. Reply with only the transcript.';
const AUDIO_MAX_BYTES = 3 * 1024 * 1024; // about 90 s of 16 kHz mono PCM16; Gemma takes about 30 s

// A base64 WAV (RIFF/WAVE), at most 3 MB.
export function checkWav(audio) {
  if (typeof audio !== 'string') throw new HttpError(400, 'bad_audio', 'Send the recording as a base64 WAV.');
  const b64 = audio.replace(/^data:audio\/[a-z0-9.+-]+;base64,/i, '').replace(/\s+/g, '');
  if (!b64 || !/^[A-Za-z0-9+/]+=*$/.test(b64)) throw new HttpError(400, 'bad_audio', 'Send the recording as a base64 WAV.');
  const bytes = Buffer.from(b64, 'base64');
  if (bytes.length > AUDIO_MAX_BYTES) throw new HttpError(413, 'audio_too_long', 'Keep voice questions under 30 seconds.');
  if (bytes.length < 44 || bytes.toString('latin1', 0, 4) !== 'RIFF' || bytes.toString('latin1', 8, 12) !== 'WAVE') {
    throw new HttpError(400, 'bad_audio', 'Send the recording as a WAV file.');
  }
  return b64;
}

export function cleanTranscript(text) {
  return String(text ?? '')
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Speech to text for Pro. On Ollama 0.32 audio goes in `images` on the native /api/chat (the
// OpenAI-compatible endpoint silently drops input_audio parts; see Gotchas in CLAUDE.md).
export function mountVoice(app, { config, users, llm }) {
  app.post('/api/voice/transcribe', async (req, res) => {
    if (!users.isPro(req.userId)) throw new HttpError(403, 'pro_required', 'Voice mode is part of GOAT Pro. Upgrade in the wallet to use it.');
    const audio = checkWav(req.body?.audio);
    const started = Date.now();
    const r = await llm.chat({ model: config.sttModel, temperature: 0, messages: [{ role: 'user', content: TRANSCRIBE_PROMPT, images: [audio] }] });
    const transcript = cleanTranscript(r.text);
    if (!transcript) throw new HttpError(422, 'no_speech', "I couldn't hear a question. Try again a little closer to the mic.");
    res.json({ transcript, model: config.sttModel, latencyMs: Date.now() - started });
  });
}
