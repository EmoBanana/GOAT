// npm run test:package: checks the GOAT.app that npm run package put in dist/, then runs the
// Electron e2e test (scripts/electron-smoke.js) against it instead of the dev checkout.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORE_DEPENDENCIES } from './lib/package-core.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const appPath = path.join(root, 'dist', `mac-${process.arch}`, 'GOAT.app');
const manifestFile = path.join(root, 'dist', 'latest.json');
if (process.platform !== 'darwin' || !fs.existsSync(appPath) || !fs.existsSync(manifestFile)) {
  console.error(`No packaged GOAT.app for this Mac in dist/. Run: npm run package`);
  process.exit(1);
}
const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
const build = manifest.builds.find((b) => b.platform === 'darwin' && b.arch === process.arch);

// app.asar: an 8-byte pickle holding the header's size, the header pickle (payload size, string
// length, JSON), then the file contents at the offsets the header gives.
function readAsar(file) {
  const readAt = (length, position) => {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, position);
      return buf;
    } finally {
      fs.closeSync(fd);
    }
  };
  const headerSize = readAt(8, 0).readUInt32LE(4);
  const raw = readAt(headerSize, 8);
  const header = JSON.parse(raw.toString('utf8', 8, 8 + raw.readUInt32LE(4)));
  const files = new Map();
  (function walk(node, prefix) {
    for (const [name, entry] of Object.entries(node.files || {})) {
      if (entry.files) walk(entry, `${prefix}${name}/`);
      else files.set(`${prefix}${name}`, entry);
    }
  })(header, '');
  return {
    files: [...files.keys()],
    json: (p) => {
      const entry = files.get(p);
      return JSON.parse(readAt(entry.size, 8 + headerSize + Number(entry.offset)).toString('utf8'));
    },
  };
}

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL  ${name}\n      ${String(err.message).split('\n').join('\n      ')}`);
  }
}

const asar = readAsar(path.join(appPath, 'Contents', 'Resources', 'app.asar'));
const plist = (key) => execFileSync('plutil', ['-extract', key, 'raw', path.join(appPath, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim();
const packageOf = (file) => {
  const parts = file.split('/');
  return parts[1].startsWith('@') ? `${parts[1]}/${parts[2]}` : parts[1];
};

check('the download holds only the core: app/ without its tests, and the x402 client', () => {
  const outside = asar.files.filter((f) => !f.startsWith('app/') && !f.startsWith('node_modules/') && f !== 'package.json');
  assert.deepEqual(outside, [], 'nothing but app/, node_modules/ and package.json');
  assert.ok(asar.files.includes('app/main.js') && asar.files.includes('app/renderer/index.html'));
  assert.ok(!asar.files.some((f) => f.startsWith('app/test/')), 'no tests');
  const packages = new Set(asar.files.filter((f) => f.startsWith('node_modules/')).map(packageOf));
  for (const name of [...CORE_DEPENDENCIES, '@x402/core']) assert.ok(packages.has(name), `${name} ships`);
  for (const name of ['express', '@x402/express', '@coinbase/cdp-sdk', 'electron', 'playwright', 'gsap']) assert.ok(!packages.has(name), `${name} stays out`);
});

check('its package.json starts app/main.js and names the server it was built for', () => {
  const pkg = asar.json('package.json');
  assert.equal(pkg.main, 'app/main.js');
  assert.equal(pkg.type, 'module');
  assert.deepEqual(Object.keys(pkg.dependencies), CORE_DEPENDENCIES);
  assert.equal(pkg.goat.serverUrl, build.serverUrl);
});

check('Info.plist keeps GOAT out of the Dock and explains the microphone and window titles', () => {
  assert.equal(plist('LSUIElement'), 'true');
  assert.equal(plist('CFBundleName'), 'GOAT');
  assert.equal(plist('CFBundleShortVersionString'), manifest.version);
  assert.match(plist('NSMicrophoneUsageDescription'), /Option\+Cmd/);
  assert.match(plist('NSAppleEventsUsageDescription'), /window/);
});

check('the bundle has a valid ad-hoc signature', () => {
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'pipe' });
  const details = spawnSync('codesign', ['-dv', appPath], { encoding: 'utf8' }).stderr; // codesign -d writes to stderr
  assert.match(details, /Signature=adhoc/);
  assert.match(details, /Identifier=io\.github\.emobanana\.goat/);
});

check('the zip in dist/latest.json matches its size and hash', () => {
  const zip = path.join(root, 'dist', build.file);
  assert.equal(fs.statSync(zip).size, build.bytes);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex'), build.sha256);
});

if (failed) {
  console.log(`\n${failed} packaging check(s) failed; skipping the e2e run.`);
  process.exit(1);
}

console.log('\nThe Electron e2e checks, against the packaged app:');
const env = { ...process.env, GOAT_E2E_APP: appPath };
delete env.ELECTRON_RUN_AS_NODE;
const e2e = spawnSync(process.execPath, [path.join(root, 'scripts', 'electron-smoke.js')], { stdio: 'inherit', env });
process.exit(e2e.status ?? 1);
