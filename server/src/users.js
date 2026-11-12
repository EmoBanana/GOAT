import fs from 'node:fs';
import path from 'node:path';

const USER_ID = /^[A-Za-z0-9._@-]{1,80}$/;

export function sanitizeUserId(raw) {
  const id = typeof raw === 'string' ? raw.trim() : '';
  // Ids name folders under data/, so "." and ".." are out.
  return USER_ID.test(id) && !/^\.+$/.test(id) ? id : 'anonymous';
}

// data/users.json maps id -> { id, proUntil }. Pro means proUntil is in the future.
export function createUsers({ dataDir, now = () => Date.now(), logger = console }) {
  const file = path.join(dataDir, 'users.json');
  let users = null;

  function load() {
    if (users) return users;
    users = new Map();
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        for (const [id, u] of Object.entries(raw)) users.set(id, { ...u, id, proUntil: Number(u?.proUntil) || 0 });
      }
    } catch (err) {
      if (err.code !== 'ENOENT') logger.warn(`[users] Couldn't read ${file}: ${err.message}`);
    }
    return users;
  }

  function persist() {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(Object.fromEntries(load()), null, 2)}\n`);
    fs.renameSync(tmp, file);
  }

  const get = (id) => load().get(id) || { id, proUntil: 0 };
  const isPro = (id) => get(id).proUntil > now();

  return {
    file,
    get,
    isPro,
    tier: (id) => (isPro(id) ? 'pro' : 'free'),
    setProUntil(id, proUntil) {
      load().set(id, { ...get(id), id, proUntil });
      persist();
      return get(id);
    },
    // Pro for `days` more days, from now or from the current end date, whichever is later.
    extendPro(id, days) {
      const from = Math.max(now(), get(id).proUntil || 0);
      load().set(id, { ...get(id), id, proUntil: from + days * 86_400_000 });
      persist();
      return get(id);
    },
    setWallet(id, wallet) {
      load().set(id, { ...get(id), id, wallet });
      persist();
      return get(id);
    },
  };
}
