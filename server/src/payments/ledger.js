import fs from 'node:fs';
import path from 'node:path';

// The x402-local ledger in data/ledger.json: balances per wallet address (atomic USDC),
// used EIP-3009 nonces (no replays) and a short history.
export function createLedger({ dataDir, now = () => Date.now() }) {
  const file = path.join(dataDir, 'ledger.json');
  let state;
  try {
    state = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    state = {};
  }
  state.balances ||= {};
  state.nonces ||= {};
  state.welcomed ||= {};
  state.history ||= [];

  function save() {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
    fs.renameSync(tmp, file);
  }
  const key = (address) => String(address).toLowerCase();
  const log = (entry) => {
    state.history.push({ at: new Date(now()).toISOString(), ...entry });
    if (state.history.length > 500) state.history = state.history.slice(-500);
  };

  return {
    file,
    balance: (address) => BigInt(state.balances[key(address)] || '0'),
    credit(address, atomic, reason) {
      const next = BigInt(state.balances[key(address)] || '0') + BigInt(atomic);
      state.balances[key(address)] = next.toString();
      log({ type: 'credit', address: key(address), amount: BigInt(atomic).toString(), reason });
      save();
      return next;
    },
    debit(address, atomic, ref = {}) {
      const have = BigInt(state.balances[key(address)] || '0');
      if (have < BigInt(atomic)) throw new Error('insufficient_funds');
      state.balances[key(address)] = (have - BigInt(atomic)).toString();
      log({ type: 'debit', address: key(address), amount: BigInt(atomic).toString(), ...ref });
      save();
      return have - BigInt(atomic);
    },
    nonceUsed: (nonce) => Boolean(state.nonces[String(nonce).toLowerCase()]),
    useNonce(nonce) {
      state.nonces[String(nonce).toLowerCase()] = new Date(now()).toISOString();
      save();
    },
    // Welcome credit goes to each wallet once.
    welcome(address, atomic) {
      if (state.welcomed[key(address)]) return false;
      state.welcomed[key(address)] = new Date(now()).toISOString();
      if (BigInt(atomic) > 0n) this.credit(address, atomic, 'welcome credit');
      else save();
      return true;
    },
    record(entry) {
      log(entry);
      save();
    },
    history: (address, limit = 20) => state.history.filter((h) => !address || h.address === key(address)).slice(-limit),
  };
}
