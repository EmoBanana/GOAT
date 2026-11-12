import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));

// The Gemma 4 E4B build already on the demo Mac (text, images and audio). Pro and transcription
// use it too unless set: gemma4:12b answers better, but a 16 GB Mac can't keep both loaded and
// swapping models mid-demo costs seconds per answer.
export const DEFAULT_MODEL = 'gemma4:e4b-it-qat';

// .env values may carry trailing "# comments"; Node strips them, but be safe.
function str(value, fallback) {
  const v = typeof value === 'string' ? value.replace(/\s+#.*$/, '').trim() : '';
  return v || fallback;
}

function num(value, fallback) {
  const v = str(value, '');
  const n = Number(v);
  return v !== '' && Number.isFinite(n) ? n : fallback;
}

// Ollama's own OLLAMA_HOST may be "0.0.0.0" or "127.0.0.1:11434" without a scheme.
export function normalizeOllamaHost(value) {
  let s = str(value, '127.0.0.1:11434');
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  try {
    const u = new URL(s);
    if (u.hostname === '0.0.0.0' || u.hostname === '[::]') u.hostname = '127.0.0.1';
    if (!u.port && u.protocol === 'http:') u.port = '11434';
    return u.origin;
  } catch {
    return 'http://127.0.0.1:11434';
  }
}

export function loadConfig(env = process.env, root = ROOT) {
  const model = str(env.GOAT_MODEL, DEFAULT_MODEL);
  return {
    root,
    host: str(env.GOAT_HOST, '127.0.0.1'),
    port: num(env.GOAT_PORT, 8402),
    ollamaHost: normalizeOllamaHost(env.OLLAMA_HOST),
    model,
    modelPro: str(env.GOAT_MODEL_PRO, model),
    sttModel: str(env.GOAT_STT_MODEL, model),
    keepAlive: str(env.OLLAMA_KEEP_ALIVE, '30m'),
    llmTimeoutMs: num(env.GOAT_LLM_TIMEOUT_MS, 120_000),
    warmModel: str(env.GOAT_WARM, '1') !== '0',
    payments: str(env.GOAT_PAYMENTS, 'x402-local'),
    guidesDir: path.resolve(root, str(env.GOAT_GUIDES_DIR, 'guides')),
    docsDir: path.resolve(root, str(env.GOAT_DOCS_DIR, 'docs')),
    dataDir: path.resolve(root, str(env.GOAT_DATA_DIR, 'data')),
  };
}
