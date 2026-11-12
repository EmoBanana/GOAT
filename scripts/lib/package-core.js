import fs from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';

// What goes into the GOAT download: the Electron app (app/ without its tests) and the packages
// it imports, which are the x402 client and viem for the wallet abstraction. Guides, Gemma, SOPs,
// timesheets and payments stay on the GOAT server; the app reaches them through its API.
export const CORE_DEPENDENCIES = ['@x402/evm', '@x402/fetch', 'viem'];

// Imported by app/ but left out: the CDP wallet needs API keys only a developer has, and
// without it the app uses its local wallet.
export const LEFT_OUT = ['@coinbase/cdp-sdk'];

// Peers that are only TypeScript types.
const TYPE_ONLY_PEERS = new Set(['typescript']);
const BUILTINS = new Set(builtinModules);

// '@x402/evm/exact/client' -> '@x402/evm', 'viem/accounts' -> 'viem'.
export function packageName(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

// Packages a source file imports (static, dynamic or require), without builtins and electron.
// The lookbehind skips JXA's ObjC.import('AppKit') inside script strings.
export function bareImports(source) {
  const names = new Set();
  for (const m of source.matchAll(/(?:\bfrom\s*|(?<![.\w$])import\s*\(\s*|(?<![.\w$])require\s*\(\s*)['"]([^'"]+)['"]/g)) {
    const spec = m[1];
    if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) continue;
    const name = packageName(spec);
    if (!BUILTINS.has(name) && name !== 'electron') names.add(name);
  }
  return [...names].sort();
}

// Files under app/ that ship, relative to it: everything but test/ folders and dotfiles.
export function listCoreFiles(appDir) {
  const files = [];
  (function walk(dir, rel) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'test') continue;
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), r);
      else if (entry.isFile()) files.push(r);
    }
  })(appDir, '');
  return files.sort();
}

// Node's lookup: <dir>/node_modules/<name>, then each parent directory up to root.
export function resolvePackageDir(name, fromDir, root) {
  const top = path.resolve(root);
  let dir = path.resolve(fromDir);
  for (;;) {
    const candidate = path.join(dir, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    if (dir === top) return null;
    const parent = path.dirname(dir);
    if (parent === dir || !parent.startsWith(top)) return null;
    dir = parent;
  }
}

// Every installed package the given names need at run time (dependencies, plus optional
// dependencies and peers when installed), as { dir, name, version } with dir relative to root.
export function collectPackages(root, names) {
  const found = new Map();
  const missing = [];
  const queue = names.map((name) => ({ name, from: root, optional: false }));
  while (queue.length) {
    const { name, from, optional } = queue.shift();
    const dir = resolvePackageDir(name, from, root);
    if (!dir) {
      if (!optional) missing.push(name);
      continue;
    }
    const rel = path.relative(root, dir);
    if (found.has(rel)) continue;
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    found.set(rel, { name, version: pkg.version });
    for (const dep of Object.keys(pkg.dependencies || {})) queue.push({ name: dep, from: dir, optional: false });
    for (const dep of Object.keys(pkg.optionalDependencies || {})) queue.push({ name: dep, from: dir, optional: true });
    for (const dep of Object.keys(pkg.peerDependencies || {})) {
      if (!TYPE_ONLY_PEERS.has(dep)) queue.push({ name: dep, from: dir, optional: true });
    }
  }
  if (missing.length) throw new Error(`Missing packages: ${[...new Set(missing)].join(', ')}. Run npm install.`);
  return [...found].map(([dir, info]) => ({ dir, ...info })).sort((a, b) => a.dir.localeCompare(b.dir));
}

// Package files the app never loads: TypeScript sources and types, source maps and docs.
export function keepPackageFile(rel) {
  const base = path.basename(rel);
  if (/^licen[cs]e/i.test(base)) return true;
  if (/\.(map|tsbuildinfo)$/i.test(base)) return false;
  if (/\.[cm]?tsx?$/i.test(base)) return false; // .ts, .d.ts, .mts, .d.cts, .tsx
  if (/^(readme|changelog|history)(\.|$)/i.test(base)) return false;
  if (/^tsconfig.*\.json$/i.test(base)) return false;
  return true;
}

// Copies one package without its nested node_modules (those are collected on their own).
export function copyPackage(src, dest) {
  fs.cpSync(src, dest, {
    recursive: true,
    filter: (from) => {
      const rel = path.relative(src, from);
      if (!rel) return true;
      if (rel.split(path.sep)[0] === 'node_modules') return false;
      return fs.lstatSync(from).isDirectory() || keepPackageFile(rel);
    },
  });
}

// The package.json inside the download: the app's entry point, its core dependencies at the
// versions this checkout uses, and the server the build talks to.
export function stagedPackageJson(rootPkg, { serverUrl, commit = '', builtAt = '' }) {
  const dependencies = {};
  for (const name of CORE_DEPENDENCIES) {
    if (!rootPkg.dependencies?.[name]) throw new Error(`package.json doesn't list ${name}.`);
    dependencies[name] = rootPkg.dependencies[name];
  }
  return {
    name: 'goat',
    productName: 'GOAT',
    version: rootPkg.version,
    private: true,
    type: 'module',
    main: rootPkg.main,
    dependencies,
    goat: { serverUrl, commit, builtAt },
  };
}

// The platforms GOAT is packaged for, the tag in their file names, and their architectures.
export const PLATFORMS = {
  darwin: { tag: 'mac', name: 'macOS', archs: { arm64: 'Apple silicon', x64: 'Intel' } },
  win32: { tag: 'win', name: 'Windows', archs: { x64: 'x64', arm64: 'Arm' } },
};

export function buildLabel(platform, arch) {
  const p = PLATFORMS[platform];
  return p ? `${p.name} · ${p.archs[arch] || arch}` : `${platform} · ${arch}`;
}

export function buildFileName({ version, platform = 'darwin', arch }) {
  return `GOAT-${version}-${PLATFORMS[platform].tag}-${arch}.zip`;
}

// dist/latest.json lists the builds of the newest version; a build for another architecture of
// the same version stays listed, an older version's builds drop off.
export function mergeManifest(previous, { version, build }) {
  const kept = previous?.version === version ? (previous.builds || []).filter((b) => !(b.platform === build.platform && b.arch === build.arch)) : [];
  return { name: 'GOAT', version, builds: [...kept, build].sort((a, b) => a.arch.localeCompare(b.arch)) };
}
