import fs from 'node:fs';
import path from 'node:path';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { createPublicClient, createWalletClient, erc20Abi, http } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { HttpError } from '../errors.js';
import { createLedger } from './ledger.js';
import { createLocalFacilitator } from './local-facilitator.js';
import { usdToAtomic } from './money.js';

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

// x402 pay-per-assist. x402-local: real handshake and signatures, settled on data/ledger.json.
// x402: settled on Base Sepolia by X402_FACILITATOR_URL. Pro users ask for free.
export function createPayments({ config, users, logger = console }) {
  const mode = config.payments;
  if (mode === 'off') return null;
  const ledger = createLedger({ dataDir: config.dataDir });
  const payTo = config.payTo || ensureTreasury(config.dataDir).address;
  const facilitator =
    mode === 'x402' ? new HTTPFacilitatorClient({ url: config.facilitatorUrl }) : createLocalFacilitator({ network: config.network, ledger });
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
  const middleware = (req, res, next) => (req.path === '/api/assist' && users.isPro(req.userId) ? next() : paid(req, res, next));

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

// Ringgit top-ups. mock: credit the local ledger (simulated card). cdp-faucet: Coinbase's
// test-USDC faucet. treasury: send test USDC from TREASURY_PRIVATE_KEY.
export function createTopups({ config, payments }) {
  async function topup({ address, myr }) {
    const amountMyr = Number(myr);
    if (!Number.isFinite(amountMyr) || amountMyr < 1 || amountMyr > 500) throw new HttpError(400, 'bad_amount', 'Top up between RM 1 and RM 500.');
    const usd = amountMyr / config.myrPerUsd;
    if (config.topupMode === 'mock') {
      if (config.payments !== 'x402-local') {
        throw new HttpError(400, 'topup_unavailable', 'Simulated top-ups only work with GOAT_PAYMENTS=x402-local. Use TOPUP_MODE=cdp-faucet or treasury on Base Sepolia.');
      }
      payments.ledger.credit(address, usdToAtomic(usd), `top-up RM ${amountMyr} (simulated card)`);
      return { mode: 'mock', usd };
    }
    if (config.topupMode === 'cdp-faucet') {
      const { CdpClient } = await import('@coinbase/cdp-sdk');
      const cdp = new CdpClient({ apiKeyId: config.cdp.apiKeyId, apiKeySecret: config.cdp.apiKeySecret, walletSecret: config.cdp.walletSecret });
      const { transactionHash } = await cdp.evm.requestFaucet({ address, network: 'base-sepolia', token: 'usdc' });
      return { mode: 'cdp-faucet', transaction: transactionHash };
    }
    if (config.topupMode === 'treasury') {
      if (!config.treasuryKey) throw new HttpError(400, 'topup_unavailable', 'Set TREASURY_PRIVATE_KEY to top up from the treasury.');
      const account = privateKeyToAccount(config.treasuryKey);
      const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(config.rpcUrl) });
      const transaction = await wallet.writeContract({ address: USDC_BASE_SEPOLIA, abi: erc20Abi, functionName: 'transfer', args: [address, usdToAtomic(usd)] });
      return { mode: 'treasury', transaction };
    }
    throw new HttpError(400, 'topup_unavailable', `Unknown TOPUP_MODE "${config.topupMode}".`);
  }
  return { topup };
}
