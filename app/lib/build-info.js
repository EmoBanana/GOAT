import fs from 'node:fs';
import path from 'node:path';

// A packaged GOAT has no .env and no npm start: scripts/package.js writes the server it was
// built for into its package.json ("goat": { "serverUrl", "commit", "builtAt" }).
// GOAT_SERVER_URL still wins, so one build can be pointed at a test server.
export const DEFAULT_SERVER_URL = 'http://127.0.0.1:8402';

// An http(s) origin, or '' for anything else. Paths are dropped: the API client asks for
// absolute paths like /api/assist.
export function cleanServerUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : '';
  } catch {
    return '';
  }
}

// { version, serverUrl?, commit?, builtAt? } from the app's package.json; {} if it can't be read.
export function readBuildInfo(appPath) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(appPath, 'package.json'), 'utf8'));
    const baked = pkg.goat && typeof pkg.goat === 'object' ? pkg.goat : {};
    return { version: typeof pkg.version === 'string' ? pkg.version : '', ...baked };
  } catch {
    return {};
  }
}

export function resolveServerUrl({ env = process.env, build = {} } = {}) {
  return cleanServerUrl(env.GOAT_SERVER_URL) || cleanServerUrl(build.serverUrl) || DEFAULT_SERVER_URL;
}

// True when the GOAT server (and so the model) runs on this computer.
export function isLocalServer(url) {
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  } catch {
    return false;
  }
}

// How an answer's label says where the model ran.
export function whereItRuns(url) {
  if (isLocalServer(url)) return 'running on this laptop';
  try {
    return `on ${new URL(url).host}`;
  } catch {
    return 'on the GOAT server';
  }
}
