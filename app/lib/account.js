import fs from 'node:fs';
import path from 'node:path';
import { cleanUserId } from './identity.js';

// The signed-in GOAT account, kept in userData/account.json: the wallet address and how you
// signed in (email, social, wallet, or "local" for Continue offline). Never keys or tokens.
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const METHODS = ['email', 'social', 'wallet', 'local'];

export function cleanAccount(raw) {
  if (!raw || typeof raw !== 'object' || !ADDRESS.test(String(raw.address)) || !METHODS.includes(raw.method)) return null;
  const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const account = { address: raw.address, method: raw.method, linkedAt: text(raw.linkedAt, 40) || new Date().toISOString() };
  for (const [key, max] of [['email', 120], ['provider', 20], ['wallet', 60]]) {
    const value = text(raw[key], max);
    if (value) account[key] = value;
  }
  return account;
}

export function loadAccount(dir) {
  try {
    return cleanAccount(JSON.parse(fs.readFileSync(path.join(dir, 'account.json'), 'utf8')));
  } catch {
    return null;
  }
}

export function saveAccount(dir, account) {
  const clean = cleanAccount(account);
  if (!clean) throw new Error('Not a GOAT account.');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'account.json'), `${JSON.stringify(clean, null, 2)}\n`, { mode: 0o600 });
  return clean;
}

export function clearAccount(dir) {
  fs.rmSync(path.join(dir, 'account.json'), { force: true });
}

// Who the server sees: GOAT_USER when set (tests, rehearsals), else the account's address, else
// the login name (Continue offline keeps the laptop's existing Pro, chats and timesheets).
export function userIdFor(account, { env = process.env, fallback = 'anonymous' } = {}) {
  return cleanUserId(env.GOAT_USER) || (account && account.method !== 'local' ? account.address.toLowerCase() : '') || fallback;
}

// Each signed-in account pays from its own spending wallet; offline uses the laptop's wallet.
export function walletDirFor(account, userData) {
  return account && account.method !== 'local' ? path.join(userData, 'accounts', account.address.toLowerCase()) : userData;
}

// What the overlay shows: an email or a wallet name with a short address, never a full address.
export function describeAccount(account) {
  if (!account) return null;
  const short = `${account.address.slice(0, 6)}…${account.address.slice(-4)}`;
  const provider = account.provider ? account.provider.charAt(0).toUpperCase() + account.provider.slice(1) : '';
  const how = {
    email: 'Signed in with email',
    social: `Signed in with ${provider || 'a social account'}`,
    wallet: `Connected ${account.wallet || 'wallet'}`,
    local: 'Offline account on this laptop',
  }[account.method];
  const label = account.method === 'local' ? 'This laptop' : account.email || `${account.wallet || 'Wallet'} ${short}`;
  return { method: account.method, label, how, short: account.method === 'local' ? '' : short };
}
