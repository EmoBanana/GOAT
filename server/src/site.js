import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { HttpError } from './errors.js';
import { roundMoney } from './payments/money.js';

// The download page (site/), the libraries it loads, and the packaged app (dist/, from
// npm run package). Mounted before the x402 middleware: downloading GOAT is free, and assists
// are what get paid for. GSAP and the fonts come from node_modules, so the page works offline.
const FONT_PACKAGES = {
  'bodoni-moda': '@fontsource-variable/bodoni-moda',
  'hanken-grotesk': '@fontsource-variable/hanken-grotesk',
  'playwrite-fr-trad': '@fontsource-variable/playwrite-fr-trad',
};
const ARCH_LABELS = { arm64: 'Apple silicon', x64: 'Intel' };
const BUILD_FILE = /^GOAT-[0-9A-Za-z.+-]+-mac-(arm64|x64)\.zip$/;

// dist/latest.json, or null when nothing has been built.
export function readManifest(distDir) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(distDir, 'latest.json'), 'utf8'));
    return manifest && Array.isArray(manifest.builds) ? manifest : null;
  } catch {
    return null;
  }
}

// What GET /api/downloads answers: the builds that exist on disk, and the prices the server charges.
export function downloadsView(manifest, config) {
  const builds = (manifest?.builds || [])
    .filter((b) => BUILD_FILE.test(String(b.file)) && fs.existsSync(path.join(config.distDir, b.file)))
    .map((b) => ({
      platform: b.platform,
      arch: b.arch,
      label: `macOS · ${ARCH_LABELS[b.arch] || b.arch}`,
      file: b.file,
      url: `/download/${b.file}`,
      bytes: b.bytes,
      sha256: b.sha256,
      serverUrl: b.serverUrl,
      builtAt: b.builtAt,
    }));
  const myr = (usd) => roundMoney(usd * config.myrPerUsd);
  return {
    name: 'GOAT',
    version: builds.length ? manifest.version : null,
    builds,
    pricing: {
      payments: config.payments,
      network: config.network,
      assistUsd: config.priceUsd,
      assistMyr: myr(config.priceUsd),
      proUsd: config.proPriceUsd,
      proMyr: myr(config.proPriceUsd),
      proDays: config.proDays,
      welcomeMyr: config.welcomeCreditMyr,
      myrPerUsd: config.myrPerUsd,
    },
  };
}

export function mountSite(app, { config }) {
  const modules = path.join(config.root, 'node_modules');
  const vendor = { index: false, maxAge: '1d' };
  app.use('/vendor/gsap', express.static(path.join(modules, 'gsap', 'dist'), vendor));
  for (const [name, pkg] of Object.entries(FONT_PACKAGES)) {
    app.use(`/vendor/fonts/${name}`, express.static(path.join(modules, pkg, 'files'), vendor));
  }
  app.get('/icon.svg', (_req, res) => res.sendFile(path.join(config.root, 'app', 'assets', 'icon.svg')));

  app.get('/api/downloads', (_req, res) => {
    res.json(downloadsView(readManifest(config.distDir), config));
  });

  app.get('/download/:file', (req, res, next) => {
    const build = downloadsView(readManifest(config.distDir), config).builds.find((b) => b.file === req.params.file);
    if (!build) throw new HttpError(404, 'not_found', `There's no download called "${req.params.file}". Run npm run package on the GOAT server.`);
    res.download(path.join(config.distDir, build.file), build.file, { headers: { 'cache-control': 'no-cache' } }, (err) => {
      if (err && !res.headersSent) next(err);
    });
  });

  // The page itself. API paths skip the file lookup.
  const page = express.static(config.siteDir, { index: 'index.html' });
  app.use((req, res, next) => (req.path.startsWith('/api/') ? next() : page(req, res, next)));
  app.get('/', (_req, res) => {
    res.type('text/plain').send('GOAT server. The app downloads are listed at /api/downloads.\n');
  });
}
