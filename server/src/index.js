import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, ROOT } from './config.js';
import { buildServer, listen } from './server.js';

const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const config = loadConfig();
const { app, guides, docs, llm } = await buildServer(config);

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
