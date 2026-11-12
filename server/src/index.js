import { loadConfig, loadEnvFiles } from './config.js';
import { buildServer, listen } from './server.js';

loadEnvFiles(); // .env.local (keys such as ELEVENLABS_API_KEY), then .env

const config = loadConfig();
const { app, guides, docs, llm, mcp, speech } = await buildServer(config);

function shutdown() {
  mcp.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

try {
  await listen(app, config);
} catch (err) {
  if (err.code === 'EADDRINUSE') {
    console.error(`[goat] Port ${config.port} is busy. Is GOAT already running? Set GOAT_PORT to use another port.`);
    process.exit(1);
  }
  throw err;
}
console.log(`[goat] Server on http://${config.host}:${config.port} · ${guides.count()} guides · ${docs.count} doc chunks`);

const voice = speech.status();
console.log(
  voice.provider === 'elevenlabs'
    ? `[goat] Spoken answers use ElevenLabs (${voice.model}, voice ${voice.voice})`
    : `[goat] Spoken answers use the Mac's voice${config.tts === 'system' ? ' (GOAT_TTS=system)' : ' (no ELEVENLABS_API_KEY)'}`,
);

// Tools for questions the SOPs don't cover (config/mcp.json), started in the background.
for (const s of mcp.status()) {
  if (!s.enabled) console.log(`[goat] MCP ${s.name} is off: ${s.reason}`);
}
if (mcp.enabled) mcp.start();

const ollama = await llm.status(config.model);
if (!ollama.reachable) {
  console.warn(`[goat] Can't reach Ollama at ${config.ollamaHost}. Start it with: ollama serve`);
} else if (!ollama.hasModel) {
  console.warn(`[goat] ${config.model} isn't pulled. Run: ollama pull ${config.model}`);
} else if (config.warmModel) {
  // Load the model now so the first answer in the demo is quick.
  llm
    .warm(config.model)
    .then(() => console.log(`[goat] ${config.model} is loaded (keep_alive ${config.keepAlive})`))
    .catch((err) => console.warn(`[goat] Couldn't warm ${config.model}: ${err.message}`));
}
