import http from 'node:http';

// A short tone as a WAV, too quiet to hear when a test plays it (-64 dBFS). The real API sends
// MP3; the overlay decodes either.
export function toneWav(ms = 300, rate = 16000) {
  const samples = Math.round((rate * ms) / 1000);
  const b = Buffer.alloc(44 + samples * 2);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(36 + samples * 2, 4);
  b.write('WAVE', 8, 'latin1');
  b.write('fmt ', 12, 'latin1');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'latin1');
  b.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i += 1) b.writeInt16LE(Math.round(Math.sin((i / rate) * 2 * Math.PI * 440) * 20), 44 + i * 2);
  return b;
}

// A stand-in for ElevenLabs text to speech: POST /v1/text-to-speech/:voice with xi-api-key
// answers audio bytes; errors have the real shape, { detail: { status, message } }.
// state.fail = { status, detail } makes every call fail that way.
export async function startMockElevenLabs({ key = 'test-key', audio = toneWav() } = {}) {
  const state = { key, audio, fail: null, calls: [] };

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body = null;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      body = null;
    }
    const url = new URL(req.url, 'http://mock');
    state.calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), key: req.headers['xi-api-key'], body });
    const fail = (status, detail) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ detail: { status: detail, message: `Mock ${detail}.` } }));
    };
    if (req.method !== 'POST' || !/^\/v1\/text-to-speech\/[^/]+$/.test(url.pathname)) return fail(404, 'not_found');
    if (req.headers['xi-api-key'] !== state.key) return fail(401, 'invalid_api_key');
    if (state.fail) return fail(state.fail.status, state.fail.detail);
    if (typeof body?.text !== 'string' || !body.text) return fail(422, 'invalid_text');
    res.writeHead(200, { 'content-type': 'audio/mpeg' });
    return res.end(state.audio);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    state,
    calls: state.calls,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}
