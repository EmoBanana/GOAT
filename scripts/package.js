// npm run package: builds the GOAT app (the core: overlay, blue cursor, hotkeys, recorder and the
// wallet abstraction) into dist/ as a zip, plus dist/latest.json for the download route.
//   npm run package -- --server http://192.168.1.20:8402 --arch arm64
//   npm run package -- --platform win32          (Windows, x64 unless --arch says otherwise)
// Everything else the app does is a call to the GOAT server it's built for; GOAT_SERVER_URL still
// overrides that at launch. Runs on macOS: the Mac app needs codesign, ditto and iconutil.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { packager } from '@electron/packager';
import { cleanServerUrl, DEFAULT_SERVER_URL } from '../app/lib/build-info.js';
import { ICO_SIZES, icoFromPngs } from './lib/ico.js';
import {
  buildFileName,
  buildLabel,
  collectPackages,
  copyPackage,
  CORE_DEPENDENCIES,
  listCoreFiles,
  mergeManifest,
  PLATFORMS,
  stagedPackageJson,
} from './lib/package-core.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const log = (line) => console.log(`[package] ${line}`);

function fail(message) {
  console.error(`[package] ${message}`);
  process.exit(1);
}

if (process.platform !== 'darwin') fail('Packaging runs on macOS (codesign, ditto, iconutil and zip).');

const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const { values: args } = parseArgs({
  options: {
    server: { type: 'string' },
    platform: { type: 'string', default: 'darwin' },
    arch: { type: 'string' },
    out: { type: 'string', default: 'dist' },
  },
});
const target = PLATFORMS[args.platform];
if (!target) fail(`--platform must be one of ${Object.keys(PLATFORMS).join(', ')}.`);
const isMac = args.platform === 'darwin';
const arch = args.arch ?? (isMac ? process.arch : 'x64');
if (!target.archs[arch]) fail(`--arch for ${target.name} must be one of ${Object.keys(target.archs).join(', ')}.`);
const serverArg = args.server ?? process.env.GOAT_PUBLIC_URL ?? process.env.GOAT_SERVER_URL ?? DEFAULT_SERVER_URL;
const serverUrl = cleanServerUrl(serverArg);
if (!serverUrl) fail(`"${serverArg}" isn't an http(s) URL. Pass the GOAT server's address, e.g. --server http://192.168.1.20:8402`);

const rootPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const electronVersion = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', 'electron', 'package.json'), 'utf8')).version;
const outDir = path.resolve(root, args.out);
const stage = path.join(outDir, `.stage-${target.tag}-${arch}`);
const srcDir = path.join(stage, 'src');
// macOS: dist/mac-arm64/GOAT.app. Windows: dist/win-x64/GOAT/GOAT.exe and its files.
const appDest = path.join(outDir, `${target.tag}-${arch}`, isMac ? 'GOAT.app' : 'GOAT');
const zipFile = path.join(outDir, buildFileName({ version: rootPkg.version, platform: args.platform, arch }));

function gitCommit() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

// @electron/get keeps the Electron zips it downloads; reuse one so packaging works offline.
function cachedElectronZipDir(version, platform, cpu) {
  const cache = process.env.electron_config_cache || path.join(os.homedir(), 'Library', 'Caches', 'electron');
  const name = `electron-v${version}-${platform}-${cpu}.zip`;
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

// SVG -> PNG buffers at each size, drawn by Playwright's Chromium.
async function renderSvg(svg, sizes) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  try {
    const pngs = new Map();
    for (const size of new Set(sizes)) {
      const page = await browser.newPage({ viewport: { width: size, height: size } });
      await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent"><style>svg{display:block;width:${size}px;height:${size}px}</style>${svg}</body></html>`);
      pngs.set(size, await page.screenshot({ omitBackground: true }));
      await page.close();
    }
    return pngs;
  } finally {
    await browser.close();
  }
}

const ICNS_FILES = [
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

async function makeIcns(svg, file) {
  const pngs = await renderSvg(svg, ICNS_FILES.map(([size]) => size));
  const iconset = file.replace(/\.icns$/, '.iconset');
  fs.mkdirSync(iconset, { recursive: true });
  for (const [size, name] of ICNS_FILES) fs.writeFileSync(path.join(iconset, name), pngs.get(size));
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', file]);
}

// Windows icons fill their square, so Apple's margins come off the tile first.
async function makeIco(svg, file) {
  const pngs = await renderSvg(svg.replace(/viewBox="[^"]*"/, 'viewBox="92 92 840 840"'), ICO_SIZES);
  fs.writeFileSync(file, icoFromPngs(ICO_SIZES.map((size) => ({ size, png: pngs.get(size) }))));
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

  // 2. Only the packages the app imports, and theirs. All plain JavaScript, so one set fits both platforms.
  const packages = collectPackages(root, CORE_DEPENDENCIES);
  for (const p of packages) copyPackage(path.join(root, p.dir), path.join(srcDir, p.dir));
  log(`${files.length} app files and ${packages.length} packages (${CORE_DEPENDENCIES.join(', ')} and their dependencies)`);

  // 3. The icon. A missing icon isn't worth failing the build for.
  let icon;
  try {
    const svg = fs.readFileSync(path.join(root, 'app', 'assets', 'icon.svg'), 'utf8');
    icon = path.join(stage, isMac ? 'GOAT.icns' : 'GOAT.ico');
    await (isMac ? makeIcns(svg, icon) : makeIco(svg, icon));
  } catch (err) {
    icon = undefined;
    log(`No app icon (${err.message.split('\n')[0]}); using Electron's.`);
  }

  // 4. The app. On macOS, LSUIElement keeps it out of the Dock and the usage strings are what
  // macOS shows when it asks for the microphone and window titles.
  const zipDir = cachedElectronZipDir(electronVersion, args.platform, arch);
  if (!zipDir) log(`Downloading Electron ${electronVersion} for ${buildLabel(args.platform, arch)}…`);
  const [packaged] = await packager({
    dir: srcDir,
    out: path.join(stage, 'out'),
    name: 'GOAT',
    executableName: 'GOAT',
    platform: args.platform,
    arch,
    electronVersion,
    ...(zipDir ? { electronZipDir: zipDir } : {}),
    appVersion: rootPkg.version,
    buildVersion: rootPkg.version,
    appCopyright: `© ${new Date().getFullYear()} GOAT`, // else Windows shows Electron's own copyright
    ...(icon ? { icon } : {}),
    asar: true,
    prune: false, // the staged node_modules is already just the core
    overwrite: true,
    quiet: true,
    ...(isMac
      ? {
          appBundleId: 'io.github.emobanana.goat',
          appCategoryType: 'public.app-category.productivity',
          extendInfo: {
            LSUIElement: true,
            NSMicrophoneUsageDescription: 'GOAT listens only while you hold Option+Cmd, so you can ask a question out loud.',
            NSAppleEventsUsageDescription: 'GOAT reads the title of the window you ask about, and of allowlisted apps while timesheet tracking is on.',
          },
        }
      : { win32metadata: { CompanyName: 'GOAT', FileDescription: 'GOAT', ProductName: 'GOAT', InternalName: 'GOAT', OriginalFilename: 'GOAT.exe' } }),
  });

  fs.rmSync(path.dirname(appDest), { recursive: true, force: true });
  fs.mkdirSync(path.dirname(appDest), { recursive: true });
  fs.rmSync(zipFile, { force: true });
  if (isMac) {
    // Ad-hoc signature: Apple silicon won't run unsigned code, and a broken signature makes macOS
    // call a downloaded app "damaged". It isn't notarised, so the first open needs Open Anyway.
    fs.renameSync(path.join(packaged, 'GOAT.app'), appDest);
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', appDest], { stdio: 'pipe' });
    execFileSync('codesign', ['--verify', '--deep', '--strict', appDest], { stdio: 'pipe' });
    execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appDest, zipFile]);
  } else {
    // Unsigned, so SmartScreen asks once: More info, then Run anyway.
    fs.renameSync(packaged, appDest);
    execFileSync('zip', ['-r', '-q', '-X', zipFile, path.basename(appDest)], { cwd: path.dirname(appDest) });
  }

  // 5. The manifest the server reads.
  const build = {
    platform: args.platform,
    arch,
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
  log(`GOAT ${rootPkg.version} for ${buildLabel(args.platform, arch)}: ${path.relative(root, zipFile)}, ${mb} MB, in ${((Date.now() - started) / 1000).toFixed(0)} s`);
  log(`It talks to ${serverUrl}. Build for another server with: npm run package -- --server <url>`);
  log(`The GOAT server offers it at /download/${build.file}`);
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}
