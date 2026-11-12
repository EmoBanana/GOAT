// npm run package: builds the GOAT app (the core: overlay, blue cursor, hotkeys, recorder and the
// wallet abstraction) into dist/ as a zipped GOAT.app, plus dist/latest.json for the download route.
//   npm run package -- --server http://192.168.1.20:8402 --arch arm64
// Everything else the app does is a call to the GOAT server it's built for; GOAT_SERVER_URL still
// overrides that at launch. macOS only (codesign, ditto, iconutil).
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { packager } from '@electron/packager';
import { cleanServerUrl, DEFAULT_SERVER_URL } from '../app/lib/build-info.js';
import {
  ARCH_LABELS,
  buildFileName,
  collectPackages,
  copyPackage,
  CORE_DEPENDENCIES,
  listCoreFiles,
  mergeManifest,
  stagedPackageJson,
} from './lib/package-core.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const log = (line) => console.log(`[package] ${line}`);

function fail(message) {
  console.error(`[package] ${message}`);
  process.exit(1);
}

if (process.platform !== 'darwin') fail('Packaging needs macOS (codesign, ditto and iconutil).');

const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const { values: args } = parseArgs({
  options: {
    server: { type: 'string' },
    arch: { type: 'string', default: process.arch },
    out: { type: 'string', default: 'dist' },
  },
});
if (!ARCH_LABELS[args.arch]) fail(`--arch must be one of ${Object.keys(ARCH_LABELS).join(', ')}.`);
const serverArg = args.server ?? process.env.GOAT_PUBLIC_URL ?? process.env.GOAT_SERVER_URL ?? DEFAULT_SERVER_URL;
const serverUrl = cleanServerUrl(serverArg);
if (!serverUrl) fail(`"${serverArg}" isn't an http(s) URL. Pass the GOAT server's address, e.g. --server http://192.168.1.20:8402`);

const rootPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const electronVersion = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', 'electron', 'package.json'), 'utf8')).version;
const outDir = path.resolve(root, args.out);
const stage = path.join(outDir, `.stage-${args.arch}`);
const srcDir = path.join(stage, 'src');
const appDest = path.join(outDir, `mac-${args.arch}`, 'GOAT.app');
const zipFile = path.join(outDir, buildFileName({ version: rootPkg.version, arch: args.arch }));

function gitCommit() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

// @electron/get keeps the Electron zip that npm install downloaded; reuse it so packaging works offline.
function cachedElectronZipDir(version, arch) {
  const cache = process.env.electron_config_cache || path.join(os.homedir(), 'Library', 'Caches', 'electron');
  const name = `electron-v${version}-darwin-${arch}.zip`;
  try {
    for (const entry of fs.readdirSync(cache)) {
      const dir = path.join(cache, entry);
      if (fs.existsSync(path.join(dir, name))) return dir;
    }
  } catch {
    // no cache: the packager downloads it
  }
  return fs.existsSync(path.join(cache, name)) ? cache : null;
}

const ICON_SIZES = [
  [16, 'icon_16x16.png'],
  [32, 'icon_16x16@2x.png'],
  [32, 'icon_32x32.png'],
  [64, 'icon_32x32@2x.png'],
  [128, 'icon_128x128.png'],
  [256, 'icon_128x128@2x.png'],
  [256, 'icon_256x256.png'],
  [512, 'icon_256x256@2x.png'],
  [512, 'icon_512x512.png'],
  [1024, 'icon_512x512@2x.png'],
];

// app/assets/icon.svg -> .icns, drawn by Playwright's Chromium at every size macOS asks for.
async function makeIcns(svgFile, icnsFile) {
  const { chromium } = await import('playwright');
  const iconset = icnsFile.replace(/\.icns$/, '.iconset');
  fs.mkdirSync(iconset, { recursive: true });
  const svg = fs.readFileSync(svgFile, 'utf8');
  const browser = await chromium.launch();
  try {
    for (const [size, name] of ICON_SIZES) {
      const page = await browser.newPage({ viewport: { width: size, height: size } });
      await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent"><style>svg{display:block;width:${size}px;height:${size}px}</style>${svg}</body></html>`);
      await page.screenshot({ path: path.join(iconset, name), omitBackground: true });
      await page.close();
    }
  } finally {
    await browser.close();
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', icnsFile]);
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

const started = Date.now();
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(srcDir, { recursive: true });
try {
  // 1. The app without its tests, and a package.json that knows its server.
  const files = listCoreFiles(path.join(root, 'app'));
  for (const rel of files) {
    const dest = path.join(srcDir, 'app', rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(root, 'app', rel), dest);
  }
  const builtAt = new Date().toISOString();
  const commit = gitCommit();
  fs.writeFileSync(path.join(srcDir, 'package.json'), `${JSON.stringify(stagedPackageJson(rootPkg, { serverUrl, commit, builtAt }), null, 2)}\n`);

  // 2. Only the packages the app imports, and theirs.
  const packages = collectPackages(root, CORE_DEPENDENCIES);
  for (const p of packages) copyPackage(path.join(root, p.dir), path.join(srcDir, p.dir));
  log(`${files.length} app files and ${packages.length} packages (${CORE_DEPENDENCIES.join(', ')} and their dependencies)`);

  // 3. The icon. A missing icon isn't worth failing the build for.
  let icon;
  try {
    icon = path.join(stage, 'GOAT.icns');
    await makeIcns(path.join(root, 'app', 'assets', 'icon.svg'), icon);
  } catch (err) {
    icon = undefined;
    log(`No app icon (${err.message.split('\n')[0]}); using Electron's.`);
  }

  // 4. GOAT.app. LSUIElement keeps it out of the Dock; macOS shows the usage strings when it asks.
  const zipDir = cachedElectronZipDir(electronVersion, args.arch);
  const [packaged] = await packager({
    dir: srcDir,
    out: path.join(stage, 'out'),
    name: 'GOAT',
    executableName: 'GOAT',
    platform: 'darwin',
    arch: args.arch,
    electronVersion,
    ...(zipDir ? { electronZipDir: zipDir } : {}),
    appBundleId: 'io.github.emobanana.goat',
    appCategoryType: 'public.app-category.productivity',
    appVersion: rootPkg.version,
    buildVersion: rootPkg.version,
    ...(icon ? { icon } : {}),
    asar: true,
    prune: false, // the staged node_modules is already just the core
    overwrite: true,
    quiet: true,
    extendInfo: {
      LSUIElement: true,
      NSMicrophoneUsageDescription: 'GOAT listens only while you hold Option+Cmd, so you can ask a question out loud.',
      NSAppleEventsUsageDescription: 'GOAT reads the title of the window you ask about, and of allowlisted apps while timesheet tracking is on.',
    },
  });

  // 5. Ad-hoc signature: Apple silicon won't run unsigned code, and a broken signature makes
  // macOS call a downloaded app "damaged". It isn't notarised, so the first launch needs Open Anyway.
  fs.rmSync(path.dirname(appDest), { recursive: true, force: true });
  fs.mkdirSync(path.dirname(appDest), { recursive: true });
  fs.renameSync(path.join(packaged, 'GOAT.app'), appDest);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appDest], { stdio: 'pipe' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', appDest], { stdio: 'pipe' });

  // 6. The download, and the manifest the server reads.
  fs.rmSync(zipFile, { force: true });
  execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appDest, zipFile]);
  const build = {
    platform: 'darwin',
    arch: args.arch,
    file: path.basename(zipFile),
    bytes: fs.statSync(zipFile).size,
    sha256: sha256(zipFile),
    serverUrl,
    electron: electronVersion,
    commit,
    builtAt,
  };
  const manifestFile = path.join(outDir, 'latest.json');
  let previous = null;
  try {
    previous = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  } catch {
    // first build
  }
  fs.writeFileSync(manifestFile, `${JSON.stringify(mergeManifest(previous, { version: rootPkg.version, build }), null, 2)}\n`);

  const mb = (build.bytes / 1e6).toFixed(1);
  log(`GOAT ${rootPkg.version} for macOS (${ARCH_LABELS[args.arch]}): ${path.relative(root, zipFile)}, ${mb} MB, in ${((Date.now() - started) / 1000).toFixed(0)} s`);
  log(`It talks to ${serverUrl}. Build for another server with: npm run package -- --server <url>`);
  log(`The GOAT server offers it at /download/${build.file}`);
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}
