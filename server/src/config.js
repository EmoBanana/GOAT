import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));

// Settings live in .env; keys a tool writes for the project live in .env.local (ElevenLabs'
// sign-in puts ELEVENLABS_API_KEY there). A variable already set wins, then .env.local, then
// .env. An empty value counts as unset, so a blank "KEY=" line can't hide a key.
export function loadEnvFiles(root = ROOT, env = process.env) {
  for (const name of ['.env.local', '.env']) {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) continue;
    for (const [key, value] of Object.entries(parseEnv(fs.readFileSync(file, 'utf8')))) {
      if (!env[key]) env[key] = value;
    }
  }
}

// The Gemma 4 E4B build already on the demo Mac (text, images and audio). Pro and transcription
// use it too unless set: gemma4:12b answers better, but a 16 GB Mac can't keep both loaded and
// swapping models mid-demo costs seconds per answer.
export const DEFAULT_MODEL = 'gemma4:e4b-it-qat';

// GOAT's voice on ElevenLabs: Jessica, a premade voice ("playful, bright, warm") that every plan
// can use through the API, on the fastest and cheapest model.
export const DEFAULT_VOICE = 'cgSgspJ2msm6clMCkdW9';
export const DEFAULT_VOICE_MODEL = 'eleven_flash_v2_5';

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
    // auto: Gemma thinks (and may search) only when no SOP or guide covers the question.
    think: ['auto', 'off', 'always'].includes(str(env.GOAT_THINK, 'auto')) ? str(env.GOAT_THINK, 'auto') : 'auto',
    // Gemma 4 reasons for 10-30 s; past this budget GOAT stops it and answers from its notes.
    thinkBudgetMs: num(env.GOAT_THINK_BUDGET_MS, 1500),
    mcpConfig: path.resolve(root, str(env.GOAT_MCP_CONFIG, 'config/mcp.json')),
    payments: ['off', 'x402-local', 'x402'].includes(str(env.GOAT_PAYMENTS, 'x402-local')) ? str(env.GOAT_PAYMENTS, 'x402-local') : 'x402-local',
    network: str(env.X402_NETWORK, 'eip155:84532'),
    facilitatorUrl: str(env.X402_FACILITATOR_URL, 'https://x402.org/facilitator'),
    payTo: str(env.X402_PAY_TO, ''),
    priceUsd: num(env.GOAT_PRICE_USD, 0.01),
    proPriceUsd: num(env.GOAT_PRO_PRICE_USD, 1),
    proDays: num(env.GOAT_PRO_DAYS, 30),
    myrPerUsd: num(env.MYR_PER_USD, 4.2),
    welcomeCreditMyr: num(env.GOAT_WELCOME_CREDIT_MYR, 2),
    topupMode: str(env.TOPUP_MODE, 'mock'),
    treasuryKey: str(env.TREASURY_PRIVATE_KEY, ''),
    rpcUrl: str(env.BASE_SEPOLIA_RPC, 'https://sepolia.base.org'),
    cdp: { apiKeyId: str(env.CDP_API_KEY_ID, ''), apiKeySecret: str(env.CDP_API_KEY_SECRET, ''), walletSecret: str(env.CDP_WALLET_SECRET, '') },
    reownProjectId: str(env.REOWN_PROJECT_ID, ''), // sign-in with Reown AppKit (dashboard.reown.com)
    numCtx: num(env.GOAT_NUM_CTX, 8192), // the model's context window: a whole deck or page fits
    // Spoken answers: ElevenLabs when its key is set (the answer's text goes there), else the
    // Mac's own voice. GOAT_TTS=system keeps every word on the laptop.
    tts: str(env.GOAT_TTS, 'elevenlabs') === 'system' ? 'system' : 'elevenlabs',
    elevenLabsKey: str(env.ELEVENLABS_API_KEY, ''),
    elevenLabsUrl: str(env.ELEVENLABS_BASE_URL, 'https://api.elevenlabs.io').replace(/\/+$/, ''),
    elevenLabsVoice: str(env.ELEVENLABS_VOICE_ID, DEFAULT_VOICE),
    elevenLabsModel: str(env.ELEVENLABS_MODEL, DEFAULT_VOICE_MODEL),
    // manglish: spoken answers the way colleagues in KL say it ("MCP ah? MCP is ..."). plain: as typed.
    voiceStyle: str(env.GOAT_VOICE_STYLE, 'manglish') === 'plain' ? 'plain' : 'manglish',
    projectsFile: path.resolve(root, str(env.GOAT_PROJECTS_FILE, 'config/projects.json')),
    guidesDir: path.resolve(root, str(env.GOAT_GUIDES_DIR, 'guides')),
    docsDir: path.resolve(root, str(env.GOAT_DOCS_DIR, 'docs')),
    dataDir: path.resolve(root, str(env.GOAT_DATA_DIR, 'data')),
    siteDir: path.resolve(root, str(env.GOAT_SITE_DIR, 'web/out')), // the download page, once built (cd web && npm run build)
    distDir: path.resolve(root, str(env.GOAT_DIST_DIR, 'dist')),
  };
}
