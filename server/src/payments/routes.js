import { HttpError } from '../errors.js';
import { atomicToUsd, isAddress, roundMoney, roundPrice, usdToAtomic } from './money.js';

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
      topupMode: config.topupMode,
      explorer: config.payments === 'x402' ? 'https://sepolia.basescan.org/tx/' : null,
    };
  }

  app.get('/api/wallet', async (req, res) => {
    res.json(await walletView(req.userId));
  });

  app.post('/api/wallet/topup', async (req, res) => {
    if (!payments) throw new HttpError(400, 'payments_off', 'Payments are off (GOAT_PAYMENTS=off).');
    const address = users.get(req.userId).wallet;
    if (!address) throw new HttpError(400, 'no_wallet', 'GOAT has no wallet for you yet. Restart the app.');
    const topup = await topups.topup({ address, myr: req.body?.myr ?? 10 });
    res.json({ ...(await walletView(req.userId)), topup });
  });

  // Paid with x402 ($GOAT_PRO_PRICE_USD) by the payments middleware; free when payments are off.
  app.post('/api/pro/upgrade', (req, res) => {
    const user = users.extendPro(req.userId, config.proDays);
    res.json({ tier: 'pro', pro: true, proUntil: user.proUntil });
  });
}
