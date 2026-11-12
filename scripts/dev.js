// npm start: the server (unless one is already answering) and then the overlay.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';

const root = fileURLToPath(new URL('..', import.meta.url));
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const port = Number(process.env.GOAT_PORT) || 8402;
const serverUrl = process.env.GOAT_SERVER_URL || `http://127.0.0.1:${port}`;
const env = { ...process.env, GOAT_SERVER_URL: serverUrl };
// Shells started by VS Code extensions carry ELECTRON_RUN_AS_NODE=1, which turns Electron into
// plain Node (the app then dies with "app is undefined").
delete env.ELECTRON_RUN_AS_NODE;

const children = [];
let stopping = false;

function pipe(child, tag) {
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => process.stdout.write(String(chunk).replace(/^(?=.)/gm, `[${tag}] `)));
  }
}

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 300);
}

async function healthy() {
  try {
    const res = await fetch(`${serverUrl}/api/health`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

if (await healthy()) {
  console.log(`[dev] Using the GOAT server already running at ${serverUrl}`);
} else {
  const server = spawn(process.execPath, [path.join(root, 'server', 'src', 'index.js')], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(server);
  pipe(server, 'server');
  server.on('exit', (code) => {
    if (!stopping) {
      console.error(`[dev] The server stopped (exit ${code}).`);
      stop(code || 1);
    }
  });
  const deadline = Date.now() + 15_000;
  while (!(await healthy())) {
    if (stopping) process.exit(1);
    if (Date.now() > deadline) {
      console.error(`[dev] The server didn't answer at ${serverUrl} within 15 s.`);
      stop(1);
      break;
    }
    await sleep(250);
  }
}

if (!stopping) {
  const overlay = spawn(electronPath, [root], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(overlay);
  pipe(overlay, 'app');
  overlay.on('exit', (code) => stop(code ?? 0));
}
