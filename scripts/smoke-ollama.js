// Real-model checks against the local Ollama, run by hand on the Mac: npm run smoke
// Uses GOAT_MODEL and GOAT_STT_MODEL from .env or the environment.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, ROOT } from '../server/src/config.js';
import { createOllama, hasModel } from '../server/src/llm/ollama.js';

const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
const config = loadConfig();
const llm = createOllama({ host: config.ollamaHost, keepAlive: config.keepAlive, timeoutMs: 180_000 });

let failures = 0;
function report(ok, name, detail = '') {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `: ${detail}` : ''}`);
  return ok;
}

const tags = await llm.tags(3000);
report(tags.reachable, `Ollama reachable at ${config.ollamaHost}`, tags.reachable ? `${tags.models.length} models` : 'start it with: ollama serve');

const textReady =
  tags.reachable &&
  report(hasModel(tags.models, config.model), `${config.model} is pulled`, hasModel(tags.models, config.model) ? '' : `run: ollama pull ${config.model}`);

if (textReady) {
  const started = Date.now();
  try {
    const answer = await llm.chat({
      model: config.model,
      messages: [{ role: 'user', content: 'In one short sentence: why does a site defect report need a photo?' }],
    });
    report(answer.text.length > 0, `chat answer from ${config.model}`, `${Date.now() - started} ms, "${answer.text.slice(0, 140)}"`);
  } catch (err) {
    report(false, `chat answer from ${config.model}`, err.message);
  }
} else {
  report(false, 'chat answer', 'skipped, the model is not available');
}

async function transcribeCheck() {
  const name = `voice transcript from ${config.sttModel}`;
  if (process.platform !== 'darwin') return report(false, name, 'needs macOS (say and afconvert)');
  if (!tags.reachable) return report(false, name, 'skipped, Ollama is not reachable');
  if (!hasModel(tags.models, config.sttModel)) return report(false, name, `run: ollama pull ${config.sttModel}`);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goat-smoke-'));
  try {
    const aiff = path.join(dir, 'goat.aiff');
    const wav = path.join(dir, 'goat.wav');
    execFileSync('say', ['-o', aiff, 'how do I log an issue']);
    execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', aiff, wav]);
    const data = fs.readFileSync(wav).toString('base64');

    const started = Date.now();
    // On Ollama 0.32 audio goes in `images` on the native /api/chat (the OpenAI-compatible
    // endpoint silently drops input_audio parts). See Gotchas in CLAUDE.md.
    const res = await fetch(`${config.ollamaHost}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(180_000),
      body: JSON.stringify({
        model: config.sttModel,
        stream: false,
        think: false,
        keep_alive: config.keepAlive,
        messages: [{ role: 'user', content: 'Transcribe this audio verbatim. Reply with only the transcript.', images: [data] }],
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return report(false, name, `HTTP ${res.status} ${JSON.stringify(body.error ?? body).slice(0, 200)}`);
    const transcript = String(body.message?.content ?? '').trim();
    const heard = transcript.toLowerCase().replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ');
    // Small words get misheard ("log in issue"), so look for "log ... issue".
    return report(/\blog\b.*\bissue\b/.test(heard), name, `${Date.now() - started} ms, "${transcript.slice(0, 140)}"`);
  } catch (err) {
    return report(false, name, err.message);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

await transcribeCheck();
console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
