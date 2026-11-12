import fs from 'node:fs';
import path from 'node:path';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { ExactEvmScheme as ExactEvmClient } from '@x402/evm/exact/client';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { createPublicClient, erc20Abi, http } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { HttpError } from '../errors.js';
import { createLedger } from './ledger.js';
import { createLocalFacilitator } from './local-facilitator.js';
import { atomicToUsd, usdToAtomic } from './money.js';

export const USDC_BASE_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

// payTo is X402_PAY_TO, else a treasury key created once in data/treasury.json (mode 0600).
export function ensureTreasury(dataDir) {
  const file = path.join(dataDir, 'treasury.json');
  try {
    const t = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (t.address) return t;
  } catch {
    // create it below
  }
  const privateKey = generatePrivateKey();
  const treasury = { address: privateKeyToAccount(privateKey).address, privateKey, createdAt: new Date().toISOString() };
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(treasury, null, 2)}\n`, { mode: 0o600 });
  return treasury;
}

// The public facilitator (x402.org) fails settlements that reach it at the same moment: its own
// transactions collide and come back as invalid_exact_evm_transaction_failed ("Missing or invalid
// parameters" from eth_sendRawTransaction). Measured on 12 Nov: four asks settled at once, three
// failed; one at a time, none did. So GOAT settles one payment at a time and tries a failed
// submission again. An earlier try that landed after all shows up as its nonce being used, which
// counts as paid. Everything else goes straight to the facilitator.
const RETRY_SETTLE = new Set(['invalid_exact_evm_transaction_failed', 'unexpected_settle_error']);
export function steadyFacilitator(inner, { tries = 3, waitMs = 700, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), logger = console } = {}) {
  let queue = Promise.resolve();
  async function settleWithRetries(payload, requirements) {
    for (let attempt = 1; ; attempt += 1) {
      let result;
      let error = null;
      try {
        result = await inner.settle(payload, requirements);
      } catch (err) {
        error = err;
        result = { success: false, errorReason: err.errorReason || 'unexpected_settle_error' };
      }
      if (result.success) return result;
      if (attempt > 1 && result.errorReason === 'invalid_exact_evm_nonce_already_used') {
        return { success: true, transaction: '', network: requirements.network, payer: payload?.payload?.authorization?.from };
      }
      if (!RETRY_SETTLE.has(result.errorReason) || attempt >= tries) {
        if (error) throw error;
        return result;
      }
      logger.warn(`[payments] Settlement failed (${result.errorReason}); trying again (${attempt + 1} of ${tries})`);
      await sleep(waitMs * attempt);
    }
  }
  function settle(payload, requirements) {
    const run = queue.then(() => settleWithRetries(payload, requirements));
    queue = run.catch(() => {});
    return run;
  }
  return new Proxy(inner, {
    get(target, prop) {
      if (prop === 'settle') return settle;
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

// x402 pay-per-assist. x402-local: real handshake and signatures, settled on data/ledger.json.
// x402: settled on Base Sepolia by X402_FACILITATOR_URL. Every assist is paid, Pro included: Pro
// buys the better model and voice, not free asks.
export function createPayments({ config, users, logger = console }) {
  const mode = config.payments;
  if (mode === 'off') return null;
  const ledger = createLedger({ dataDir: config.dataDir });
  const payTo = config.payTo || ensureTreasury(config.dataDir).address;
  const facilitator =
    mode === 'x402' ? steadyFacilitator(new HTTPFacilitatorClient({ url: config.facilitatorUrl }), { logger }) : createLocalFacilitator({ network: config.network, ledger });
  const server = new x402ResourceServer(facilitator).register(config.network, new ExactEvmScheme());
  server.onAfterSettle(async ({ result, requirements }) => {
    if (mode === 'x402') {
      ledger.record({ type: 'settled', address: String(result.payer || '').toLowerCase(), amount: requirements.amount, transaction: result.transaction, network: result.network });
    }
  });
  const accepts = (usd) => [{ scheme: 'exact', price: `$${usd}`, network: config.network, payTo }];
  const paid = paymentMiddleware(
    {
      'POST /api/assist': { accepts: accepts(config.priceUsd), description: 'GOAT assist' },
      'POST /api/pro/upgrade': { accepts: accepts(config.proPriceUsd), description: 'GOAT Pro' },
    },
    server,
  );
  const middleware = paid;

  let chain = null;
  // Balance in atomic USDC, or null if the chain can't be reached.
  async function balance(address) {
    if (mode === 'x402-local') return ledger.balance(address);
    chain ||= createPublicClient({ chain: baseSepolia, transport: http(config.rpcUrl, { timeout: 4000 }) });
    try {
      return await chain.readContract({ address: USDC_BASE_SEPOLIA, abi: erc20Abi, functionName: 'balanceOf', args: [address] });
    } catch (err) {
      logger.warn(`[payments] Couldn't read the balance: ${err.shortMessage || err.message}`);
      return null;
    }
  }

  return { mode, payTo, ledger, facilitator, middleware, balance };
}

// A simulated card can't put USDC on Base Sepolia, so with GOAT_PAYMENTS=x402 a top-up asks
// Coinbase's test-USDC faucet even when TOPUP_MODE is left at mock. (Circle's faucet API,
// /v1/faucet/drips, needs a Circle account upgraded to mainnet; its web faucet has no API.)
export const topupModeFor = (config) => (config.topupMode === 'mock' && config.payments === 'x402' ? 'cdp-faucet' : config.topupMode);
// What one faucet request gives: 1 USDC (10 a day per address).
export const FAUCET_USDC = 1;

// The dev wallet that pays for top-ups: TREASURY_PRIVATE_KEY, else GOAT's own treasury
// (data/treasury.json), the payTo every assist pays into, so the money goes round.
export function devWallet(config) {
  if (config.treasuryKey) {
    try {
      return privateKeyToAccount(config.treasuryKey);
    } catch {
      throw new HttpError(400, 'topup_unavailable', 'TREASURY_PRIVATE_KEY is not a private key (0x and 64 hex digits).');
    }
  }
  return config.payTo ? null : privateKeyToAccount(ensureTreasury(config.dataDir).privateKey);
}

// Ringgit top-ups. mock: credit the local ledger (simulated card). cdp-faucet: Coinbase's
// test-USDC faucet. treasury: the dev wallet sends the USDC. It signs a transfer to the user's
// spending wallet (EIP-3009, like every assist) and the facilitator submits it and pays the
// gas, so the dev wallet needs test USDC only, no ETH.
export function createTopups({ config, payments, logger = console }) {
  async function fromDevWallet(address, usd, amountMyr) {
    const dev = devWallet(config);
    if (!dev) throw new HttpError(400, 'topup_unavailable', 'Set TREASURY_PRIVATE_KEY: the dev wallet that pays for top-ups (X402_PAY_TO is someone else’s address).');
    const amount = usdToAtomic(usd);
    const have = await payments.balance(dev.address);
    if (have !== null && have < amount) {
      logger.warn(`[payments] The dev wallet ${dev.address} has ${atomicToUsd(have)} USDC; a RM ${amountMyr} top-up needs ${atomicToUsd(amount)}.`);
      throw new HttpError(
        400,
        'dev_wallet_empty',
        `Top-ups come from the dev wallet, which has ${atomicToUsd(have).toFixed(2)} USDC; this one needs ${atomicToUsd(amount).toFixed(2)} USDC. Send it test USDC on Base Sepolia (faucet.circle.com): ${dev.address}`,
      );
    }
    const requirements = { scheme: 'exact', network: config.network, amount: String(amount), asset: USDC_BASE_SEPOLIA, payTo: address, maxTimeoutSeconds: 300, extra: { name: 'USDC', version: '2' } };
    const signed = await new ExactEvmClient(dev).createPaymentPayload(2, requirements);
    const payload = { x402Version: 2, resource: { url: 'http://localhost/api/wallet/topup', description: `GOAT top-up, RM ${amountMyr}`, mimeType: 'application/json' }, accepted: requirements, ...signed };
    const check = await payments.facilitator.verify(payload, requirements);
    if (!check.isValid) throw new HttpError(502, 'topup_failed', `The top-up was refused: ${check.invalidMessage || check.invalidReason}.`);
    const settled = await payments.facilitator.settle(payload, requirements);
    if (!settled.success) throw new HttpError(502, 'topup_failed', `The top-up didn't go through: ${settled.errorMessage || settled.errorReason}.`);
    // x402-local settles on the ledger, which takes the USDC from the dev wallet; give it to the user.
    if (payments.mode === 'x402-local') payments.ledger.credit(address, amount, `top-up RM ${amountMyr} from the dev wallet`);
    logger.log(`[payments] Top-up of ${atomicToUsd(amount)} USDC from the dev wallet ${dev.address} to ${address}: ${settled.transaction}`);
    return { mode: 'treasury', transaction: settled.transaction };
  }

  async function topup({ address, myr }) {
    const amountMyr = Number(myr);
    if (!Number.isFinite(amountMyr) || amountMyr < 1 || amountMyr > 500) throw new HttpError(400, 'bad_amount', 'Top up between RM 1 and RM 500.');
    const usd = amountMyr / config.myrPerUsd;
    const mode = topupModeFor(config);
    if (mode === 'mock') {
      if (config.payments !== 'x402-local') {
        throw new HttpError(400, 'topup_unavailable', 'Simulated top-ups only work with GOAT_PAYMENTS=x402-local. Use TOPUP_MODE=cdp-faucet or treasury on Base Sepolia.');
      }
      payments.ledger.credit(address, usdToAtomic(usd), `top-up RM ${amountMyr} (simulated card)`);
      return { mode: 'mock', usd, myr: amountMyr };
    }
    if (mode === 'cdp-faucet') {
      if (!config.cdp.apiKeyId || !config.cdp.apiKeySecret) {
        throw new HttpError(400, 'topup_unavailable', "Top-ups come from Coinbase's test-USDC faucet. Set CDP_API_KEY_ID and CDP_API_KEY_SECRET (a free key at portal.cdp.coinbase.com) and restart the server.");
      }
      const { CdpClient } = await import('@coinbase/cdp-sdk');
      const cdp = new CdpClient({ apiKeyId: config.cdp.apiKeyId, apiKeySecret: config.cdp.apiKeySecret, walletSecret: config.cdp.walletSecret || undefined });
      let transactionHash;
      try {
        ({ transactionHash } = await cdp.evm.requestFaucet({ address, network: 'base-sepolia', token: 'usdc' }));
      } catch (err) {
        throw new HttpError(502, 'topup_failed', `Coinbase's faucet said no: ${err.message} (it gives 1 USDC a time, 10 a day per wallet).`);
      }
      return { mode: 'cdp-faucet', transaction: transactionHash, usd: FAUCET_USDC, myr: FAUCET_USDC * config.myrPerUsd };
    }
    if (mode === 'treasury') return { ...(await fromDevWallet(address, usd, amountMyr)), usd, myr: amountMyr };
    throw new HttpError(400, 'topup_unavailable', `Unknown TOPUP_MODE "${config.topupMode}".`);
  }
  return { topup };
}
