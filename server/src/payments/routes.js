import { HttpError } from '../errors.js';
import { FAUCET_USDC, topupModeFor } from './index.js';
import { atomicToUsd, isAddress, roundMoney, roundPrice, usdToAtomic } from './money.js';

export const EXPLORER_TX = 'https://sepolia.basescan.org/tx/';
const TX_HASH = /^0x[0-9a-f]{64}$/i;

// The wallet's recent payments and top-ups for the wallet card, newest first. On Base Sepolia
// (x402) only what went on chain, each with its explorer link; in x402-local the ledger's own
// entries, which have no link. history: the ledger's entries for this wallet, oldest first.
export function walletTransactions(history, { mode, proPriceUsd, limit = 8 }) {
  const onChain = mode === 'x402';
  const proAmount = usdToAtomic(proPriceUsd).toString();
  const rows = [];
  for (const e of [...history].reverse()) {
    if (rows.length >= limit) break;
    if (!(onChain ? ['settled', 'topup'] : ['debit', 'credit']).includes(e.type)) continue;
    const out = e.type === 'settled' || e.type === 'debit';
    const usd = atomicToUsd(e.amount || '0');
    const label = out ? (String(e.amount) === proAmount ? 'Pro upgrade' : 'Assist') : /welcome/i.test(e.reason || '') ? 'Welcome credit' : 'Top-up';
    const transaction = onChain && TX_HASH.test(e.transaction || '') ? e.transaction : null;
    rows.push({ at: e.at, label, usd: out ? -usd : usd, transaction, link: transaction ? `${EXPLORER_TX}${transaction}` : null });
  }
  return rows;
}

// The app sends its wallet address (never a key) in x-goat-wallet. The server links it to the
// user, and in x402-local a new wallet gets the welcome credit once.
export function walletLinker({ config, users, payments }) {
  return (req, _res, next) => {
    const address = req.get('x-goat-wallet');
    if (payments && isAddress(address)) {
      if ((users.get(req.userId).wallet || '').toLowerCase() !== address.toLowerCase()) users.setWallet(req.userId, address);
      if (payments.mode === 'x402-local') payments.ledger.welcome(address, usdToAtomic(config.welcomeCreditMyr / config.myrPerUsd));
    }
    next();
  };
}

export function mountWallet(app, { config, users, payments, topups }) {
  async function walletView(userId) {
    const user = users.get(userId);
    const atomic = user.wallet && payments ? await payments.balance(user.wallet) : null;
    const usd = atomic === null ? null : atomicToUsd(atomic);
    const myr = (v) => roundMoney(v * config.myrPerUsd);
    const price = (v) => roundPrice(v * config.myrPerUsd);
    return {
      mode: config.payments,
      network: config.network,
      address: user.wallet || null,
      balanceUsd: usd === null ? null : Math.round(usd * 10_000) / 10_000,
      balanceMyr: usd === null ? null : myr(usd),
      myrPerUsd: config.myrPerUsd,
      priceUsd: config.priceUsd,
      priceMyr: price(config.priceUsd),
      proPriceUsd: config.proPriceUsd,
      proPriceMyr: price(config.proPriceUsd),
      proDays: config.proDays,
      pro: users.isPro(userId),
      proUntil: user.proUntil || null,
      topupMode: topupModeFor(config),
      // What "Top up" adds: RM 10, or one faucet request (1 USDC) on Base Sepolia.
      ...(topupModeFor(config) === 'cdp-faucet' ? { topupUsd: FAUCET_USDC, topupMyr: roundMoney(FAUCET_USDC * config.myrPerUsd) } : { topupMyr: 10, topupUsd: Math.round((10 / config.myrPerUsd) * 10_000) / 10_000 }),
      explorer: config.payments === 'x402' ? EXPLORER_TX : null,
      transactions: payments && user.wallet ? walletTransactions(payments.ledger.history(user.wallet, 500), { mode: payments.mode, proPriceUsd: config.proPriceUsd }) : [],
    };
  }

  app.get('/api/wallet', async (req, res) => {
    res.json(await walletView(req.userId));
  });

  app.post('/api/wallet/topup', async (req, res) => {
    if (!payments) throw new HttpError(400, 'payments_off', 'Payments are off (GOAT_PAYMENTS=off).');
    const address = users.get(req.userId).wallet;
    if (!address) throw new HttpError(400, 'no_wallet', 'GOAT has no wallet for you yet. Restart the app.');
    const before = payments.mode === 'x402' ? await payments.balance(address) : null;
    const topup = await topups.topup({ address, myr: req.body?.myr ?? 10 });
    // On Base Sepolia the top-up joins the wallet's transactions with its explorer link.
    if (payments.mode === 'x402' && TX_HASH.test(topup.transaction || '') && Number(topup.usd) > 0) {
      payments.ledger.record({ type: 'topup', address: address.toLowerCase(), amount: usdToAtomic(topup.usd).toString(), transaction: topup.transaction, network: config.network, source: topup.mode });
    }
    // On Base Sepolia the new balance shows once the transfer is in a block (a second or two).
    for (let i = 0; before !== null && i < 8; i += 1) {
      const now = await payments.balance(address);
      if (now === null || now > before) break;
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
    res.json({ ...(await walletView(req.userId)), topup });
  });

  // Paid with x402 ($GOAT_PRO_PRICE_USD) by the payments middleware; free when payments are off.
  app.post('/api/pro/upgrade', (req, res) => {
    const user = users.extendPro(req.userId, config.proDays);
    res.json({ tier: 'pro', pro: true, proUntil: user.proUntil });
  });
}
