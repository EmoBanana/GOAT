import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  bareImports,
  buildFileName,
  collectPackages,
  copyPackage,
  CORE_DEPENDENCIES,
  keepPackageFile,
  LEFT_OUT,
  listCoreFiles,
  mergeManifest,
  packageName,
  stagedPackageJson,
} from '../lib/package-core.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const rootPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('bare imports skip relative paths, builtins, electron and JXA ObjC.import', () => {
  const source = `
    import fs from 'node:fs';
    import path from 'path';
    import { app } from 'electron';
    import { a } from './lib/a.js';
    import { ExactEvmScheme } from '@x402/evm/exact/client';
    import { privateKeyToAccount } from "viem/accounts";
    const { CdpX402Client } = await import('@coinbase/cdp-sdk/x402');
    const { contextBridge } = require('electron');
    const SCRIPT = \`ObjC.import('AppKit');\`;
  `;
  assert.deepEqual(bareImports(source), ['@coinbase/cdp-sdk', '@x402/evm', 'viem']);
  assert.equal(packageName('@x402/fetch'), '@x402/fetch');
  assert.equal(packageName('viem/accounts'), 'viem');
});

test('every package the app imports ships in the download or is left out on purpose', () => {
  const imported = new Set();
  for (const rel of listCoreFiles(path.join(root, 'app'))) {
    if (/\.c?js$/.test(rel)) for (const name of bareImports(fs.readFileSync(path.join(root, 'app', rel), 'utf8'))) imported.add(name);
  }
  for (const name of imported) {
    assert.ok(CORE_DEPENDENCIES.includes(name) || LEFT_OUT.includes(name), `app/ imports ${name}: add it to CORE_DEPENDENCIES or LEFT_OUT`);
  }
  for (const name of CORE_DEPENDENCIES) assert.ok(imported.has(name), `${name} is packaged but nothing in app/ imports it`);
});

test('the core files are the app without its tests', () => {
  const files = listCoreFiles(path.join(root, 'app'));
  for (const f of ['main.js', 'preload.cjs', 'lib/api.js', 'lib/wallet.js', 'renderer/index.html', 'renderer/overlay.js', 'assets/trayTemplate.png']) {
    assert.ok(files.includes(f), `${f} should ship`);
  }
  assert.ok(!files.some((f) => f.startsWith('test/')), 'app/test stays out');
  assert.ok(!files.some((f) => f.split('/').some((part) => part.startsWith('.'))), 'no dotfiles');
});

test('the dependency closure has the x402 client and viem, and no server packages', () => {
  const packages = collectPackages(root, CORE_DEPENDENCIES);
  const names = new Set(packages.map((p) => p.name));
  for (const name of ['@x402/fetch', '@x402/evm', '@x402/core', 'viem', 'ox', '@noble/curves', 'zod']) assert.ok(names.has(name), `${name} is needed`);
  for (const name of ['express', '@x402/express', '@coinbase/cdp-sdk', 'electron', 'playwright', 'gsap', 'typescript']) {
    assert.ok(!names.has(name), `${name} must not ship`);
  }
  // Nested copies resolve where Node would find them.
  const evmZod = packages.find((p) => p.dir === path.join('node_modules', '@x402', 'evm', 'node_modules', 'zod'));
  assert.ok(evmZod && evmZod.version.startsWith('4.'), '@x402/evm gets its own zod 4');
});

test('a missing dependency is a clear error', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goat-pkg-'));
  fs.mkdirSync(path.join(dir, 'node_modules', 'a'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'a', 'package.json'), JSON.stringify({ name: 'a', version: '1.0.0', dependencies: { b: '1' }, peerDependencies: { c: '1', typescript: '5' } }));
  assert.throws(() => collectPackages(dir, ['a']), /Missing packages: b\. Run npm install\./);
  fs.mkdirSync(path.join(dir, 'node_modules', 'b'));
  fs.writeFileSync(path.join(dir, 'node_modules', 'b', 'package.json'), JSON.stringify({ name: 'b', version: '2.0.0' }));
  // An uninstalled peer (c) is fine.
  assert.deepEqual(collectPackages(dir, ['a']).map((p) => p.name), ['a', 'b']);
});

test('copied packages drop types, maps, docs and nested node_modules but keep code and licences', () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'goat-pkg-src-'));
  const write = (rel, text = 'x') => {
    fs.mkdirSync(path.dirname(path.join(src, rel)), { recursive: true });
    fs.writeFileSync(path.join(src, rel), text);
  };
  for (const rel of ['package.json', 'LICENSE', 'LICENSE.md', 'README.md', '_esm/index.js', '_cjs/index.cjs', '_esm/index.js.map', '_types/index.d.ts', 'src/index.ts', 'tsconfig.json', 'node_modules/x/package.json']) write(rel);
  const dest = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'goat-pkg-dest-')), 'pkg');
  copyPackage(src, dest);
  const kept = listCoreFiles(dest).concat(fs.existsSync(path.join(dest, 'node_modules')) ? ['node_modules'] : []);
  assert.deepEqual(kept.sort(), ['LICENSE', 'LICENSE.md', '_cjs/index.cjs', '_esm/index.js', 'package.json']);
  assert.equal(keepPackageFile('x/y.mts'), false);
  assert.equal(keepPackageFile('x/y.mjs'), true);
});

test('the staged package.json runs app/main.js with the core dependencies and the baked server', () => {
  const pkg = stagedPackageJson(rootPkg, { serverUrl: 'http://192.168.1.20:8402', commit: 'abc1234', builtAt: '2026-11-12T08:00:00.000Z' });
  assert.equal(pkg.main, 'app/main.js');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.productName, 'GOAT');
  assert.equal(pkg.version, rootPkg.version);
  assert.deepEqual(Object.keys(pkg.dependencies), CORE_DEPENDENCIES);
  assert.equal(pkg.dependencies['@x402/fetch'], rootPkg.dependencies['@x402/fetch']);
  assert.deepEqual(pkg.goat, { serverUrl: 'http://192.168.1.20:8402', commit: 'abc1234', builtAt: '2026-11-12T08:00:00.000Z' });
  assert.equal(pkg.devDependencies, undefined);
  assert.throws(() => stagedPackageJson({ version: '1', main: 'app/main.js', dependencies: {} }, { serverUrl: 'x' }), /doesn't list/);
});

test('the manifest keeps other architectures of the same version and drops older versions', () => {
  const build = (arch, version = '0.1.0') => ({ platform: 'darwin', arch, file: buildFileName({ version, arch }), bytes: 1, sha256: arch });
  assert.equal(buildFileName({ version: '0.1.0', arch: 'arm64' }), 'GOAT-0.1.0-mac-arm64.zip');
  const first = mergeManifest(null, { version: '0.1.0', build: build('x64') });
  const both = mergeManifest(first, { version: '0.1.0', build: build('arm64') });
  assert.deepEqual(both.builds.map((b) => b.arch), ['arm64', 'x64']);
  const rebuilt = mergeManifest(both, { version: '0.1.0', build: { ...build('arm64'), sha256: 'new' } });
  assert.deepEqual(rebuilt.builds.map((b) => b.sha256), ['new', 'x64']);
  const next = mergeManifest(rebuilt, { version: '0.2.0', build: build('arm64', '0.2.0') });
  assert.deepEqual(next.builds.map((b) => b.file), ['GOAT-0.2.0-mac-arm64.zip']);
  assert.equal(next.name, 'GOAT');
});
