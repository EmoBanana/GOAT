import { HttpError } from './errors.js';

const AUDIO_MAX_BYTES = 3 * 1024 * 1024; // about 90 s of 16 kHz mono PCM16; Gemma takes about 30 s

// Terms engineers say that a general model mishears; project names come from config/projects.json.
export const BASE_TERMS = [
  'Forma Build', 'Autodesk Build', 'Revit', 'Bluebeam', 'Navisworks', 'AutoCAD', 'RFI', 'ISO 19650',
  'timesheet', 'site issue', 'defect', 'pier', 'viaduct', 'package manager', 'submittal', 'GOAT',
];

export function vocabulary(projectNames = []) {
  const names = projectNames.map((n) => String(n).replace(/^sample:\s*/i, '').trim()).filter(Boolean);
  return [...new Set([...BASE_TERMS, ...names])].slice(0, 30);
}

// Measured on Gemma 4 E4B (30 utterances, 5 accents): domain terms in the system message, an
// explicit NO_SPEECH and "never this list" gave the most perfect transcripts, clean and noisy,
// and stopped silence turning into invented sentences or a recital of the term list.
export function transcriptionMessages(audio, terms) {
  return [
    {
      role: 'system',
      content: `You are a speech-to-text engine for engineers at a construction company. Terms they use: ${terms.join(', ')}. Output only the words actually spoken, never this list. If there is no clear speech, output NO_SPEECH.`,
    },
    { role: 'user', content: 'Transcribe this audio.', images: [audio] },
  ];
}

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
    .replace(/^(transcript(ion)?|the speaker says)\s*:\s*/i, '')
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Nothing heard, or the model reciting its term list instead of transcribing.
export function isNoSpeech(transcript, terms) {
  if (!transcript || /\bNO[_ ]?SPEECH\b/i.test(transcript)) return true;
  const t = transcript.toLowerCase();
  return terms.filter((term) => t.includes(term.toLowerCase())).length >= 4;
}

// Speech to text for Pro. On Ollama 0.32 audio goes in `images` on the native /api/chat (the
// OpenAI-compatible endpoint silently drops input_audio parts; see Gotchas in CLAUDE.md).
export function mountVoice(app, { config, users, llm, projects }) {
  const terms = vocabulary(projects?.names || []);
  app.post('/api/voice/transcribe', async (req, res) => {
    if (!users.isPro(req.userId)) throw new HttpError(403, 'pro_required', 'Voice mode is part of GOAT Pro. Upgrade in the wallet to use it.');
    const audio = checkWav(req.body?.audio);
    const started = Date.now();
    const r = await llm.chat({ model: config.sttModel, temperature: 0, messages: transcriptionMessages(audio, terms) });
    const transcript = cleanTranscript(r.text);
    if (isNoSpeech(transcript, terms)) throw new HttpError(422, 'no_speech', "I didn't catch that. Hold Option+Cmd and try again.");
    res.json({ transcript, model: config.sttModel, latencyMs: Date.now() - started });
  });
}
