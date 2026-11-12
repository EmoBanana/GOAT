import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApi } from '../lib/api.js';
import { createPayer, loadLocalWallet } from '../lib/wallet.js';
import { startMockOllama } from '../../server/test/helpers/mock-ollama.js';
import { startTestServer } from '../../server/test/helpers/test-server.js';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'goat-wallet-'));

test('the local wallet is created once and only its owner can read it', () => {
  const dir = tmpDir();
  const a = loadLocalWallet(dir);
  const b = loadLocalWallet(dir);
  assert.equal(a.address, b.address);
  assert.match(a.address, /^0x[0-9a-fA-F]{40}$/);
  assert.equal(fs.statSync(a.file).mode & 0o777, 0o600);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('wallet modes: none pays nothing; auto without CDP keys uses the local wallet', async () => {
  const none = await createPayer({ mode: 'none', dir: tmpDir() });
  assert.deepEqual({ kind: none.kind, address: none.address }, { kind: 'none', address: null });
  const dir = tmpDir();
  const auto = await createPayer({ mode: 'auto', dir, env: {} });
  assert.equal(auto.kind, 'local');
  assert.equal(auto.address, loadLocalWallet(dir).address);
});

test('the app pays for asks with x402, shows receipts, tops up and upgrades to Pro', async () => {
  const ollama = await startMockOllama();
  const srv = await startTestServer({ ollamaUrl: ollama.url, env: { GOAT_PAYMENTS: 'x402-local', GOAT_WELCOME_CREDIT_MYR: '2', MYR_PER_USD: '4.20' } });
  try {
    const payer = await createPayer({ mode: 'local', dir: tmpDir(), env: {} });
    const api = createApi({ baseUrl: srv.url, userId: 'app-user', walletAddress: payer.address, fetchImpl: payer.fetch });

    const wallet = await api.wallet();
    assert.equal(wallet.balanceMyr, 2);
    assert.equal(wallet.address, payer.address);

    const reply = await api.assist({ question: 'how do I log an issue', context: {} });
    assert.equal(reply.source, 'guide');
    assert.equal(reply.payment.success, true);
    assert.equal(reply.payment.payer, payer.address);

    const tooPoor = await api.upgradePro();
    assert.equal(tooPoor.error, 'payment_required', 'RM 2 is not enough for $1.00');
    assert.match(tooPoor.message, /Top up/);

    const topped = await api.topup(10);
    assert.equal(topped.balanceMyr, 11.96);
    const pro = await api.upgradePro();
    assert.equal(pro.tier, 'pro');
    assert.equal(pro.payment.success, true);
    assert.equal((await api.me()).tier, 'pro');
    const proAsk = await api.assist({ question: 'how do I log an issue', context: {} });
    assert.equal(proAsk.tier, 'pro');
    assert.equal(proAsk.payment.success, true, 'Pro still pays for each assist');
  } finally {
    await srv.close();
    await ollama.close();
  }
});
