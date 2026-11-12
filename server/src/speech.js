import { HttpError } from './errors.js';

export const SPEECH_MAX_CHARS = 1000;
const TIMEOUT_MS = 8000;
const PAUSE_MS = 60_000; // after a failure the Mac's voice takes over this long, then ElevenLabs is tried again
const CACHE_MAX = 60; // clips kept in memory, so a guide's steps aren't paid for on every run

const unavailable = () => new HttpError(503, 'speech_unavailable', "GOAT's voice isn't available right now.");

// GOAT's voice: the text of a spoken answer goes to ElevenLabs and comes back as an MP3. Without
// a key (or with GOAT_TTS=system) it's off, and the overlay reads answers with the Mac's own
// voice. The key stays here on the server; the app only ever gets the audio.
export function createSpeech({ config, fetchImpl = fetch, logger = console, now = Date.now }) {
  const enabled = config.tts === 'elevenlabs' && Boolean(config.elevenLabsKey);
  const cache = new Map(); // text -> base64 MP3, oldest first
  let pausedUntil = 0;

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
      return { audio: hit, mime: 'audio/mpeg', cached: true };
    }
    if (now() < pausedUntil) throw unavailable();
    let res;
    try {
      res = await fetchImpl(`${config.elevenLabsUrl}/v1/text-to-speech/${encodeURIComponent(config.elevenLabsVoice)}?output_format=mp3_44100_128`, {
        method: 'POST',
        headers: { 'xi-api-key': config.elevenLabsKey, 'content-type': 'application/json', accept: 'audio/mpeg' },
        body: JSON.stringify({ text, model_id: config.elevenLabsModel, voice_settings: { stability: 0.4, similarity_boost: 0.75 } }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw pause(err?.name === 'TimeoutError' ? `took over ${TIMEOUT_MS / 1000} s` : "can't be reached");
    }
    if (!res.ok) {
      // e.g. 401 quota_exceeded once the month's characters are used, 402 paid_plan_required
      // for a Voice Library voice on the free plan.
      const detail = await res.json().then((body) => body?.detail?.status || body?.detail?.code || '', () => '');
      throw pause(`answered ${res.status}${typeof detail === 'string' && detail ? ` (${detail})` : ''}`);
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    if (!bytes.length) throw pause('sent no audio');
    const audio = bytes.toString('base64');
    cache.set(text, audio);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    return { audio, mime: 'audio/mpeg', cached: false };
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
