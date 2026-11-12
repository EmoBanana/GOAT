import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { decodePaymentResponseHeader, wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createLocalFacilitator } from '../src/payments/local-facilitator.js';
import { closedPortUrl, startMockOllama } from './helpers/mock-ollama.js';
import { startTestServer } from './helpers/test-server.js';

const NETWORK = 'eip155:84532';
const PAID = { GOAT_PAYMENTS: 'x402-local', MYR_PER_USD: '4.20', GOAT_WELCOME_CREDIT_MYR: '2' };

// An app-side wallet: a random key and an x402 paying fetch, like app/lib/wallet.js.
function wallet(user) {
  const account = privateKeyToAccount(generatePrivateKey());
  const headers = { 'content-type': 'application/json', 'x-goat-user': user, 'x-goat-wallet': account.address };
  const paidFetch = wrapFetchWithPaymentFromConfig(fetch, {
    schemes: [{ network: NETWORK, client: new ExactEvmScheme(account) }],
    spendControls: { maxAmountPerPayment: '$2' },
  });
  const call = (f) => async (url, body) => {
    const res = await f(url, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) };
  };
  return { account, headers, paid: call(paidFetch), plain: call(fetch) };
}

describe('x402 pay-per-assist (x402-local)', () => {
  let ollama;
  let srv;
  before(async () => {
    ollama = await startMockOllama();
    srv = await startTestServer({ ollamaUrl: ollama.url, env: PAID });
  });
  after(async () => {
    await srv.close();
    await ollama.close();
  });

  test('an unpaid ask is a 402 with payment-required', async () => {
    const w = wallet('unpaid');
    const r = await w.plain(`${srv.url}/api/assist`, { question: 'how do I log an issue' });
    assert.equal(r.status, 402);
    const required = JSON.parse(Buffer.from(r.headers.get('payment-required'), 'base64').toString());
    assert.equal(required.x402Version, 2);
    assert.deepEqual(
      { ...required.accepts[0], payTo: 'x' },
      { scheme: 'exact', network: NETWORK, amount: '10000', asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', payTo: 'x', maxTimeoutSeconds: 300, extra: { name: 'USDC', version: '2' } },
    );
    assert.equal(required.accepts[0].payTo, srv.payments.payTo);
  });

  test('a new wallet gets the welcome credit; a paid ask answers with a receipt and costs 1¢', async () => {
    const w = wallet('pat');
    const before = await w.plain(`${srv.url}/api/wallet`);
    assert.equal(before.body.address, w.account.address);
    assert.equal(before.body.balanceMyr, 2);
    assert.equal(before.body.priceMyr, 0.04);
    const r = await w.paid(`${srv.url}/api/assist`, { question: 'how do I log an issue' });
    assert.equal(r.status, 200);
    assert.equal(r.body.source, 'guide');
    const receipt = decodePaymentResponseHeader(r.headers.get('payment-response'));
    assert.equal(receipt.success, true);
    assert.equal(receipt.payer, w.account.address);
    assert.match(receipt.transaction, /^0x[0-9a-f]{64}$/);
    const afterPay = await w.plain(`${srv.url}/api/wallet`);
    assert.equal(afterPay.body.balanceUsd, Math.round((2 / 4.2 - 0.01) * 10_000) / 10_000);
    const again = await w.plain(`${srv.url}/api/wallet`);
    assert.equal(again.body.balanceUsd, afterPay.body.balanceUsd, 'the welcome credit is given once');
  });

  test('a replayed payment signature is refused', async () => {
    const w = wallet('replay');
    await w.plain(`${srv.url}/api/wallet`);
    let signature;
    const spy = async (url, init) => {
      const sig = new Headers(init?.headers).get('payment-signature');
      if (sig) signature = sig;
      return fetch(url, init);
    };
    const paidFetch = wrapFetchWithPaymentFromConfig(spy, { schemes: [{ network: NETWORK, client: new ExactEvmScheme(w.account) }] });
    const first = await paidFetch(`${srv.url}/api/assist`, { method: 'POST', headers: w.headers, body: JSON.stringify({ question: 'how do I log an issue' }) });
    assert.equal(first.status, 200);
    const replay = await fetch(`${srv.url}/api/assist`, { method: 'POST', headers: { ...w.headers, 'payment-signature': signature }, body: JSON.stringify({ question: 'how do I log an issue' }) });
    assert.equal(replay.status, 402);
  });

  test('top-up in ringgit, then asking works again', async () => {
    const empty = await startTestServer({ ollamaUrl: ollama.url, env: { ...PAID, GOAT_WELCOME_CREDIT_MYR: '0' } });
    try {
      const w = wallet('broke');
      const zero = await w.plain(`${empty.url}/api/wallet`);
      assert.equal(zero.body.balanceMyr, 0);
      const refused = await w.paid(`${empty.url}/api/assist`, { question: 'how do I log an issue' });
      assert.equal(refused.status, 402, 'a zero balance cannot pay');
      const top = await w.plain(`${empty.url}/api/wallet/topup`, { myr: 10 });
      assert.equal(top.status, 200);
      assert.equal(top.body.balanceMyr, 10);
      assert.equal(top.body.topup.mode, 'mock');
      const ok = await w.paid(`${empty.url}/api/assist`, { question: 'how do I log an issue' });
      assert.equal(ok.status, 200);
      const bad = await w.plain(`${empty.url}/api/wallet/topup`, { myr: 0 });
      assert.equal(bad.body.error, 'bad_amount');
    } finally {
      await empty.close();
    }
  });

  test('Pro users ask without paying, and the upgrade itself is paid with x402', async () => {
    const w = wallet('upgrader');
    await w.plain(`${srv.url}/api/wallet/topup`, { myr: 10 });
    const unpaid = await w.plain(`${srv.url}/api/pro/upgrade`, {});
    assert.equal(unpaid.status, 402);
    const required = JSON.parse(Buffer.from(unpaid.headers.get('payment-required'), 'base64').toString());
    assert.equal(required.accepts[0].amount, '1000000', '$1.00');
    const up = await w.paid(`${srv.url}/api/pro/upgrade`, {});
    assert.equal(up.status, 200);
    assert.equal(up.body.tier, 'pro');
    assert.ok(up.body.proUntil > Date.now() + 29 * 86_400_000);
    const me = await w.plain(`${srv.url}/api/me`);
    assert.equal(me.body.tier, 'pro');
    const free = await w.plain(`${srv.url}/api/assist`, { question: 'how do I log an issue' });
    assert.equal(free.status, 200, 'no payment needed once Pro');
    assert.equal(free.headers.get('payment-response'), null);
  });

  test('a 503 from the model is not settled', async () => {
    const offline = await startTestServer({ ollamaUrl: await closedPortUrl(), env: PAID });
    try {
      const w = wallet('unlucky');
      const before = (await w.plain(`${offline.url}/api/wallet`)).body.balanceUsd;
      const r = await w.paid(`${offline.url}/api/assist`, { question: 'Why do issues need a photo?' });
      assert.equal(r.status, 503);
      assert.equal(r.headers.get('payment-response'), null);
      assert.equal((await w.plain(`${offline.url}/api/wallet`)).body.balanceUsd, before);
    } finally {
      await offline.close();
    }
  });
});

test('prices under a cent: a tenth of a cent per assist, and the ringgit price keeps its decimals', async () => {
  const ollama = await startMockOllama();
  const srv = await startTestServer({ ollamaUrl: ollama.url, env: { ...PAID, GOAT_PRICE_USD: '0.001', GOAT_PRO_PRICE_USD: '0.1' } });
  try {
    const w = wallet('cheap');
    const view = (await w.plain(`${srv.url}/api/wallet`)).body;
    assert.equal(view.priceUsd, 0.001);
    assert.equal(view.priceMyr, 0.0042, 'not RM 0.00');
    assert.equal(view.proPriceMyr, 0.42);
    const amount = async (route, body) => {
      const r = await w.plain(`${srv.url}${route}`, body);
      assert.equal(r.status, 402);
      return JSON.parse(Buffer.from(r.headers.get('payment-required'), 'base64').toString()).accepts[0].amount;
    };
    assert.equal(await amount('/api/assist', { question: 'how do I log an issue' }), '1000', '$0.001');
    assert.equal(await amount('/api/pro/upgrade', {}), '100000', '$0.10');
    const r = await w.paid(`${srv.url}/api/assist`, { question: 'how do I log an issue' });
    assert.equal(r.status, 200);
    assert.equal((await w.plain(`${srv.url}/api/wallet`)).body.balanceUsd, Math.round((2 / 4.2 - 0.001) * 10_000) / 10_000);
  } finally {
    await srv.close();
    await ollama.close();
  }
});

test('the local facilitator checks the signature, recipient, amount and expiry', async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const payTo = privateKeyToAccount(generatePrivateKey()).address;
  const ledger = { balance: () => 10n ** 9n, nonceUsed: () => false };
  const facilitator = createLocalFacilitator({ network: NETWORK, ledger });
  const requirements = { scheme: 'exact', network: NETWORK, amount: '10000', asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', payTo, maxTimeoutSeconds: 300, extra: { name: 'USDC', version: '2' } };
  const payload = await new ExactEvmScheme(account).createPaymentPayload(2, requirements);
  const signed = { x402Version: 2, accepted: requirements, ...payload };
  assert.deepEqual(await facilitator.verify(signed, requirements), { isValid: true, payer: account.address });
  const otherRecipient = { ...requirements, payTo: account.address };
  assert.equal((await facilitator.verify(signed, otherRecipient)).isValid, false);
  const dearer = { ...requirements, amount: '20000' };
  assert.equal((await facilitator.verify(signed, dearer)).invalidReason, 'invalid_exact_evm_payload_authorization_value');
  const tampered = { ...signed, payload: { ...signed.payload, authorization: { ...signed.payload.authorization, value: '1' } } };
  assert.equal((await facilitator.verify(tampered, requirements)).invalidReason, 'invalid_exact_evm_payload_signature');
  const later = createLocalFacilitator({ network: NETWORK, ledger, now: () => Date.now() + 10 * 60_000 });
  assert.match((await later.verify(signed, requirements)).invalidReason, /valid_before/);
  assert.deepEqual(await facilitator.getSupported(), { kinds: [{ x402Version: 2, scheme: 'exact', network: NETWORK }], extensions: [], signers: {} });
});
