import assert from 'node:assert/strict';
import test from 'node:test';
import { steadyFacilitator } from '../src/payments/index.js';

// What the public facilitator throws for a failed settlement (SettleError carries errorReason).
class FakeSettleError extends Error {
  constructor(errorReason) {
    super(errorReason);
    this.errorReason = errorReason;
  }
}
const requirements = { network: 'eip155:84532' };
const payload = (from = '0xpayer') => ({ payload: { authorization: { from } } });
const opts = { sleep: async () => {}, logger: { warn() {} } };
const TX_FAILED = 'invalid_exact_evm_transaction_failed';

// Like x402.org on 12 Nov: a settlement that arrives while another is in flight fails.
function collidingFacilitator() {
  let inFlight = 0;
  const state = { calls: 0, most: 0 };
  return {
    state,
    url: 'https://x402.org/facilitator',
    async settle() {
      state.calls += 1;
      inFlight += 1;
      state.most = Math.max(state.most, inFlight);
      try {
        await new Promise((resolve) => setTimeout(resolve, 10));
        if (inFlight > 1) throw new FakeSettleError(TX_FAILED);
        return { success: true, transaction: `0x${state.calls}`, network: requirements.network };
      } finally {
        inFlight -= 1;
      }
    },
    async verify() {
      return { isValid: true };
    },
  };
}

test('settlements reach the facilitator one at a time, so four asks at once all get paid', async () => {
  const raw = collidingFacilitator();
  const direct = await Promise.allSettled([1, 2, 3, 4].map(() => raw.settle(payload(), requirements)));
  assert.equal(direct.filter((r) => r.status === 'rejected').length, 3, 'straight to it, three of four collide (as measured on Base Sepolia)');

  const inner = collidingFacilitator();
  const facilitator = steadyFacilitator(inner, opts);
  const results = await Promise.all([1, 2, 3, 4].map(() => facilitator.settle(payload(), requirements)));
  assert.ok(results.every((r) => r.success), 'all four paid');
  assert.equal(inner.state.most, 1, 'one at a time');
  assert.equal(inner.state.calls, 4, 'and none needed a second try');
  assert.deepEqual(await facilitator.verify(), { isValid: true }, 'verify goes straight through');
  assert.equal(facilitator.url, 'https://x402.org/facilitator');
});

function scripted(...steps) {
  let i = 0;
  return {
    calls: () => i,
    async settle() {
      const step = steps[Math.min(i, steps.length - 1)];
      i += 1;
      if (step instanceof Error) throw step;
      return step;
    },
  };
}

test('a failed submission is tried again; one that landed after all counts as paid; a shortfall is not retried', async () => {
  const paid = { success: true, transaction: '0xabc', network: requirements.network };
  let inner = scripted(new FakeSettleError(TX_FAILED), paid);
  assert.deepEqual(await steadyFacilitator(inner, opts).settle(payload(), requirements), paid);
  assert.equal(inner.calls(), 2);

  inner = scripted(new FakeSettleError(TX_FAILED), new FakeSettleError('invalid_exact_evm_nonce_already_used'));
  const landed = await steadyFacilitator(inner, opts).settle(payload('0xme'), requirements);
  assert.deepEqual(landed, { success: true, transaction: '', network: requirements.network, payer: '0xme' });

  const short = { success: false, errorReason: 'invalid_exact_evm_insufficient_balance' };
  inner = scripted(short);
  assert.deepEqual(await steadyFacilitator(inner, opts).settle(payload(), requirements), short);
  assert.equal(inner.calls(), 1, 'a real shortfall is returned at once');

  const last = new FakeSettleError(TX_FAILED);
  inner = scripted(new FakeSettleError(TX_FAILED), new FakeSettleError(TX_FAILED), last);
  await assert.rejects(steadyFacilitator(inner, opts).settle(payload(), requirements), (err) => err === last, 'the last error goes up as it was');
  assert.equal(inner.calls(), 3);
});

test('a settlement that failed for good does not hold up the next one', async () => {
  let n = 0;
  const inner = {
    async settle() {
      n += 1;
      if (n <= 3) throw new FakeSettleError(TX_FAILED);
      return { success: true, transaction: '0x1', network: requirements.network };
    },
  };
  const facilitator = steadyFacilitator(inner, opts);
  await assert.rejects(facilitator.settle(payload(), requirements));
  assert.equal((await facilitator.settle(payload(), requirements)).success, true);
});
