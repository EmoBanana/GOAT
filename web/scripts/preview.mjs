// npm run preview: serves the built page (out/) at http://localhost:3000 with the GOAT server's own
// download routes, so Download hands out the zip from the repo's dist/. Run npm run build first.
// PORT=3001 npm run preview to use another port.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { loadConfig } from '../../server/src/config.js';
import { mountSite } from '../../server/src/site.js';

const web = fileURLToPath(new URL('..', import.meta.url));
const root = path.resolve(web, '..');
const out = path.join(web, 'out');
if (!fs.existsSync(path.join(out, 'index.html'))) {
  console.error('[preview] No build yet. Run: npm run build');
  process.exit(1);
}
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const port = Number(process.env.PORT) || 3000;
const app = express();
mountSite(app, { config: { ...loadConfig(process.env, root), siteDir: out } });
const server = app.listen(port, '127.0.0.1', () => console.log(`[preview] The GOAT page is at http://localhost:${port}`));
server.on('error', (err) => {
  console.error(err.code === 'EADDRINUSE' ? `[preview] Port ${port} is busy. Try: PORT=${port + 1} npm run preview` : `[preview] ${err.message}`);
  process.exit(1);
});
