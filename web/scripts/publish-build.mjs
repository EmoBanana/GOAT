// npm run publish-build: writes data/downloads.json, the builds and prices the page shows, from the
// repo's dist/latest.json (npm run package, once per platform) and the GOAT server's price settings.
//   -- --upload           upload each zip to a public Vercel Blob store first, with the Vercel CLI.
//                         Needs BLOB_READ_WRITE_TOKEN in web/.env.local or the repo's .env.
//   -- --base-url <url>   zips you uploaded yourself into one Blob folder, e.g.
//                         https://<store>.public.blob.vercel-storage.com/goat/
// With neither, the download buttons point at the GOAT server's /download route, which only works
// when a GOAT server serves the page. Rebuild the site after publishing: npm run build.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const web = fileURLToPath(new URL('..', import.meta.url));
const root = path.resolve(web, '..');
const VERCEL_CLI = 'vercel@65.14.0';
const ORDER = { darwin: 0, win32: 1 };

function fail(message) {
  console.error(`[publish] ${message}`);
  process.exit(1);
}

for (const file of [path.join(web, '.env.local'), path.join(root, '.env')]) {
  if (fs.existsSync(file)) process.loadEnvFile(file);
}

const { values: args } = parseArgs({ options: { upload: { type: 'boolean', default: false }, 'base-url': { type: 'string' } } });
const baseUrl = args['base-url'];
if (baseUrl && !/^https:\/\//.test(baseUrl)) fail('--base-url must be an https URL.');

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(path.join(root, 'dist', 'latest.json'), 'utf8'));
} catch {
  fail('No build in dist/. In the repo root, run: npm run package (and npm run package -- --platform win32)');
}
// One build per platform, the Mac one first.
const builds = [];
for (const b of [...manifest.builds].sort((x, y) => (ORDER[x.platform] ?? 9) - (ORDER[y.platform] ?? 9))) {
  if (builds.some((kept) => kept.platform === b.platform)) continue;
  if (!fs.existsSync(path.join(root, 'dist', b.file))) fail(`dist/latest.json lists ${b.file}, but the file isn't there. Run npm run package again.`);
  builds.push(b);
}

// The prices the GOAT server charges, from the same settings it reads.
const { loadConfig } = await import(pathToFileURL(path.join(root, 'server', 'src', 'config.js')));
const config = loadConfig(process.env, root);
const myr = (usd) => Math.round(usd * config.myrPerUsd * 100) / 100;

// The Vercel CLI prints the blob's URL when an upload finishes.
function blobUrlFrom(output) {
  const match = String(output).match(/https:\/\/[a-z0-9-]+\.public\.blob\.vercel-storage\.com\/\S+/i);
  return match ? match[0].replace(/[),.]+$/, '') : null;
}

let cli = null;
function upload(build) {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) fail('Set BLOB_READ_WRITE_TOKEN (from your Blob store’s settings in Vercel) in web/.env.local, then run this again.');
  if (!cli) {
    try {
      execFileSync('vercel', ['--version'], { stdio: 'ignore' });
      cli = ['vercel'];
    } catch {
      cli = ['npx', '--yes', VERCEL_CLI];
    }
  }
  console.log(`[publish] Uploading ${build.file} (${Math.round(build.bytes / 1e6)} MB) to Vercel Blob…`);
  const zip = path.join(root, 'dist', build.file);
  let output;
  try {
    output = execFileSync(cli[0], [...cli.slice(1), 'blob', 'put', zip, '--access', 'public', '--pathname', `goat/${build.file}`, '--force', '--rw-token', token], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 1 << 24,
    });
  } catch (err) {
    // Show the CLI's own reason (the token masked), not just "Command failed".
    const said = `${err.stdout || ''}${err.stderr || ''}`.split(token).join('<token>');
    const reason = said.split('\n').find((line) => /error/i.test(line) && !/DeprecationWarning|trace-warnings/.test(line)) || said.trim();
    const hint = /private store/i.test(said)
      ? '\nThe downloads need a public Blob store (a store’s access can’t change after it’s made). In Vercel, create a Blob store with Public access and put its token in web/.env.local.'
      : '';
    fail(`Uploading ${build.file} failed: ${reason}${hint}`);
  }
  const url = blobUrlFrom(output);
  if (!url) fail(`The upload finished, but no blob URL was in its output:\n${output}`);
  return url;
}

const data = {
  version: manifest.version,
  builds: builds.map((b) => ({
    platform: b.platform,
    arch: b.arch,
    file: b.file,
    bytes: b.bytes,
    sha256: b.sha256,
    serverUrl: b.serverUrl,
    builtAt: b.builtAt,
    url: args.upload ? upload(b) : baseUrl ? new URL(b.file, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).href : null,
  })),
  pricing: {
    payments: config.payments,
    network: config.network,
    assistUsd: config.priceUsd,
    assistMyr: myr(config.priceUsd),
    proUsd: config.proPriceUsd,
    proMyr: myr(config.proPriceUsd),
    proDays: config.proDays,
    welcomeMyr: config.welcomeCreditMyr,
  },
};
fs.mkdirSync(path.join(web, 'data'), { recursive: true });
fs.writeFileSync(path.join(web, 'data', 'downloads.json'), `${JSON.stringify(data, null, 2)}\n`);
console.log(`[publish] Wrote web/data/downloads.json: GOAT ${data.version} for ${data.builds.map((b) => b.platform).join(' and ')}, RM ${data.pricing.assistMyr.toFixed(2)} an assist.`);
for (const b of data.builds) console.log(`[publish] ${b.file}: ${b.url || '/download on the GOAT server (for Vercel, use --upload or --base-url)'}`);
console.log('[publish] Now rebuild the site: npm run build');
