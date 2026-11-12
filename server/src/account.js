import crypto from 'node:crypto';
import path from 'node:path';
import express from 'express';
import { ROOT } from './config.js';
import { HttpError } from './errors.js';

// Sign-in with Reown AppKit runs in the browser, where Google sign-in and wallet extensions
// work (they don't inside Electron). The app asks for a one-time code, opens /account/?code=…,
// the page posts the connected account back, and the app collects it with the same code.
export const LINK_TTL_MS = 15 * 60_000;
const CODE = /^[A-Za-z0-9_-]{24}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const METHODS = ['email', 'social', 'wallet'];

const short = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export function cleanAccount(input = {}) {
  const address = short(input.address, 42);
  if (!ADDRESS.test(address)) throw new HttpError(400, 'bad_address', 'No wallet address came back from the sign-in.');
  const method = METHODS.includes(input.method) ? input.method : 'wallet';
  const account = { address, method };
  const email = short(input.email, 120);
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) account.email = email;
  const provider = short(input.provider, 20).toLowerCase();
  if (/^[a-z0-9-]+$/.test(provider)) account.provider = provider;
  const wallet = short(input.wallet, 60);
  if (wallet) account.wallet = wallet;
  return account;
}

export function mountAccount(app, { config, now = () => Date.now() }) {
  const links = new Map(); // code -> { at, account | null }
  const sweep = () => {
    for (const [code, link] of links) if (now() - link.at > LINK_TTL_MS) links.delete(code);
  };

  app.use('/account', express.static(path.join(ROOT, 'server', 'public', 'account')));

  // Public on purpose: a Reown project ID ships to every browser that signs in.
  app.get('/api/account/config', (_req, res) => {
    res.json({ projectId: config.reownProjectId || '', network: config.network });
  });

  app.post('/api/account/start', (_req, res) => {
    sweep();
    const code = crypto.randomBytes(18).toString('base64url');
    links.set(code, { at: now(), account: null });
    res.json({ code, path: `/account/?code=${code}`, expiresInMs: LINK_TTL_MS });
  });

  app.post('/api/account/link', (req, res) => {
    sweep();
    const code = String(req.body?.code ?? '');
    const link = CODE.test(code) ? links.get(code) : null;
    if (!link || link.account) throw new HttpError(404, 'link_expired', 'This sign-in link has expired. Start again from GOAT.');
    link.account = { ...cleanAccount(req.body), linkedAt: new Date(now()).toISOString() };
    res.json({ ok: true });
  });

  // The app polls this; a linked account is handed over once.
  app.get('/api/account/link/:code', (req, res) => {
    sweep();
    const link = links.get(req.params.code);
    if (!link) return res.json({ linked: false, expired: true });
    if (!link.account) return res.json({ linked: false });
    links.delete(req.params.code);
    return res.json({ linked: true, account: link.account });
  });
}
