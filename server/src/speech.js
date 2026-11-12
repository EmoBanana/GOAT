import { HttpError } from './errors.js';

export const SPEECH_MAX_CHARS = 1000;
const TIMEOUT_MS = 8000;
const PAUSE_MS = 60_000; // after a failure the Mac's voice takes over this long, then ElevenLabs is tried again
const CACHE_MAX = 60; // clips kept in memory, so a guide's steps aren't paid for on every run

const unavailable = () => new HttpError(503, 'speech_unavailable', "GOAT's voice isn't available right now.");

// When each word of `text` starts, in seconds, from ElevenLabs' character timings: one number per
// word (words split on whitespace, as the overlay splits them), or null when they can't be lined
// up. A word not found between its neighbours takes the time halfway between them.
export function wordMarks(text, alignment) {
  const chars = alignment?.characters;
  const starts = alignment?.character_start_times_seconds;
  if (!Array.isArray(chars) || !Array.isArray(starts) || !chars.length || chars.length !== starts.length) return null;
  const at = []; // where each character entry begins in the spoken text
  let spoken = '';
  for (const c of chars) {
    at.push(spoken.length);
    spoken += String(c);
  }
  const entryAt = (i) => {
    let k = 0;
    while (k + 1 < at.length && at[k + 1] <= i) k += 1;
    return k;
  };
  const words = String(text).split(/\s+/).filter(Boolean);
  const marks = [];
  let from = 0;
  for (const w of words) {
    const i = spoken.indexOf(w, from);
    if (i < 0) {
      marks.push(null);
      continue;
    }
    const t = Number(starts[entryAt(i)]);
    marks.push(Number.isFinite(t) ? Math.round(t * 1000) / 1000 : null);
    from = i + w.length;
  }
  const found = marks.filter((m) => m !== null).length;
  if (!words.length || found < words.length / 2) return null;
  for (let i = 0; i < marks.length; i += 1) {
    if (marks[i] !== null) continue;
    const before = marks.slice(0, i).reverse().find((m) => m !== null) ?? 0;
    const after = marks.slice(i + 1).find((m) => m !== null) ?? before;
    marks[i] = Math.round(((before + after) / 2) * 1000) / 1000;
  }
  for (let i = 1; i < marks.length; i += 1) marks[i] = Math.max(marks[i], marks[i - 1]);
  return marks;
}

// GOAT's voice: the text of a spoken answer goes to ElevenLabs and comes back as an MP3, with the
// time each word starts (so the overlay can mark the word being said). Without a key (or with
// GOAT_TTS=system) it's off, and the overlay reads answers with the Mac's own voice. The key stays
// here on the server; the app only ever gets the audio and the timings.
export function createSpeech({ config, fetchImpl = fetch, logger = console, now = Date.now }) {
  const enabled = config.tts === 'elevenlabs' && Boolean(config.elevenLabsKey);
  const cache = new Map(); // text -> { audio (base64 MP3), marks }, oldest first
  let pausedUntil = 0;
  let timestamps = true; // false once ElevenLabs says it has no timed endpoint: plain audio from then on

  function pause(why) {
    pausedUntil = now() + PAUSE_MS;
    logger.warn(`[speech] ElevenLabs ${why}; using the Mac's voice for ${PAUSE_MS / 1000} s`);
    return unavailable();
  }

  async function say(text) {
    if (!enabled) throw unavailable();
    const hit = cache.get(text);
    if (hit) {
      cache.delete(text); // most recently used goes last
      cache.set(text, hit);
      return { audio: hit.audio, mime: 'audio/mpeg', ...(hit.marks ? { marks: hit.marks } : {}), cached: true };
    }
    if (now() < pausedUntil) throw unavailable();
    const timed = timestamps;
    const voice = encodeURIComponent(config.elevenLabsVoice);
    let res;
    try {
      res = await fetchImpl(`${config.elevenLabsUrl}/v1/text-to-speech/${voice}${timed ? '/with-timestamps' : ''}?output_format=mp3_44100_128`, {
        method: 'POST',
        headers: { 'xi-api-key': config.elevenLabsKey, 'content-type': 'application/json', accept: timed ? 'application/json' : 'audio/mpeg' },
        body: JSON.stringify({ text, model_id: config.elevenLabsModel, voice_settings: { stability: 0.4, similarity_boost: 0.75 } }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw pause(err?.name === 'TimeoutError' ? `took over ${TIMEOUT_MS / 1000} s` : "can't be reached");
    }
    if (timed && (res.status === 404 || res.status === 405)) {
      timestamps = false;
      logger.warn(`[speech] ElevenLabs has no timed speech here (${res.status}); words won't be marked as they're said`);
      return say(text);
    }
    if (!res.ok) {
      // e.g. 401 quota_exceeded once the month's characters are used, 402 paid_plan_required
      // for a Voice Library voice on the free plan.
      const detail = await res.json().then((body) => body?.detail?.status || body?.detail?.code || '', () => '');
      throw pause(`answered ${res.status}${typeof detail === 'string' && detail ? ` (${detail})` : ''}`);
    }
    let audio = '';
    let marks = null;
    if (timed) {
      const body = await res.json().catch(() => null);
      audio = typeof body?.audio_base64 === 'string' ? body.audio_base64 : '';
      marks = wordMarks(text, body?.alignment || body?.normalized_alignment);
    } else {
      audio = Buffer.from(await res.arrayBuffer()).toString('base64');
    }
    if (!audio) throw pause('sent no audio');
    cache.set(text, { audio, marks });
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    return { audio, mime: 'audio/mpeg', ...(marks ? { marks } : {}), cached: false };
  }

  return {
    enabled,
    say,
    status: () => (enabled ? { provider: 'elevenlabs', voice: config.elevenLabsVoice, model: config.elevenLabsModel } : { provider: 'system' }),
  };
}

// Text to speech for Pro (voice mode is Pro). The overlay falls back to the Mac's voice on any
// error from here, so a spoken answer is never lost.
export function mountSpeech(app, { users, speech }) {
  app.post('/api/voice/speak', async (req, res) => {
    if (!users.isPro(req.userId)) throw new HttpError(403, 'pro_required', 'Voice mode is part of GOAT Pro. Upgrade in the wallet to use it.');
    const text = typeof req.body?.text === 'string' ? req.body.text.replace(/\s+/g, ' ').trim() : '';
    if (!text) throw new HttpError(400, 'empty_text', 'Send the text to say.');
    if (text.length > SPEECH_MAX_CHARS) throw new HttpError(413, 'text_too_long', `Keep spoken text under ${SPEECH_MAX_CHARS.toLocaleString('en')} characters.`);
    const started = Date.now();
    const clip = await speech.say(text);
    res.json({ ...clip, voice: 'elevenlabs', latencyMs: Date.now() - started });
  });
}
