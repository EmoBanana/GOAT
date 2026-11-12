import fs from 'node:fs';
import path from 'node:path';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { wrapFetchWithPayment, wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

// The x402 default cap is $1 per payment, too low for the $1.00 Pro upgrade.
export const SPEND_CAP = '$2';

// The local wallet behind the wallet abstraction: a key created on first run in userData/wallet.json (mode 0600).
// Only the main process ever sees it.
export function loadLocalWallet(dir) {
  const file = path.join(dir, 'wallet.json');
  let privateKey;
  try {
    privateKey = JSON.parse(fs.readFileSync(file, 'utf8')).privateKey;
  } catch {
    privateKey = null;
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey || '')) {
    privateKey = generatePrivateKey();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ privateKey, createdAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  }
  const account = privateKeyToAccount(privateKey);
  return { account, address: account.address, file };
}

// A fetch that answers 402s by paying with x402. mode: auto (CDP if its keys are set) | local |
// cdp | none. Users never see an address; the server shows them ringgit.
export async function createPayer({ mode = 'auto', dir, env = process.env, network = 'eip155:84532', fetchImpl = globalThis.fetch, logger = console }) {
  if (mode === 'none') return { kind: 'none', address: null, fetch: fetchImpl };
  const hasCdp = Boolean(env.CDP_API_KEY_ID && env.CDP_API_KEY_SECRET && env.CDP_WALLET_SECRET);
  if (mode === 'cdp' || (mode === 'auto' && hasCdp)) {
    try {
      const { CdpX402Client } = await import('@coinbase/cdp-sdk/x402');
      const client = new CdpX402Client({
        apiKeyId: env.CDP_API_KEY_ID,
        apiKeySecret: env.CDP_API_KEY_SECRET,
        walletSecret: env.CDP_WALLET_SECRET,
        environment: 'development', // Base Sepolia
        spendControls: { maxAmountPerPayment: SPEND_CAP },
      });
      const { evmAddress } = await client.getAddresses();
      return { kind: 'cdp', address: evmAddress, fetch: wrapFetchWithPayment(fetchImpl, client) };
    } catch (err) {
      logger.warn(`[wallet] The CDP wallet isn't available (${err.message}); using the local wallet.`);
    }
  }
  const wallet = loadLocalWallet(dir);
  const paidFetch = wrapFetchWithPaymentFromConfig(fetchImpl, {
    schemes: [{ network, client: new ExactEvmScheme(wallet.account) }],
    spendControls: { maxAmountPerPayment: SPEND_CAP },
  });
  return { kind: 'local', address: wallet.address, fetch: paidFetch };
}
