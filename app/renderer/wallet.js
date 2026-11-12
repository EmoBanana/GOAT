// The wallet abstraction in the UI: a ringgit chip in the ask panel, a wallet card with Top up and
// Upgrade to Pro, and a coin flying off the cursor after each paid ask (x402 underneath). The
// card shows the USDC behind the ringgit and the rate; users never see an address.
(function () {
  'use strict';

  const ui = window.GOATUI;
  const goat = window.goat || {};
  if (!ui) return;

  let wallet = null;
  const rm = (v) => (v === null || v === undefined ? 'RM –' : `RM ${Number(v).toFixed(2)}`);
  // Prices can be under a cent or a sen: "Paid 0.1¢", "RM 0.0042 per assist".
  const price = (v) => (v > 0 && v < 0.01 ? `RM ${Number(Number(v).toFixed(4))}` : rm(v));
  const cents = () => Number((((wallet && wallet.priceUsd) || 0.01) * 100).toFixed(2));
  const usdc = (v) => (v === null || v === undefined ? '– USDC' : `${Number(v).toFixed(2)} USDC`);
  // What "Top up" adds, from the server: RM 10, or one faucet request (1 USDC) on Base Sepolia.
  const TOPUP_MYR = 10;
  const topupMyr = (w) => (w && Number(w.topupMyr) > 0 ? Number(w.topupMyr) : TOPUP_MYR);
  const topupUsd = (w) => (w && Number(w.topupUsd) > 0 ? Number(w.topupUsd) : w && Number(w.myrPerUsd) > 0 ? topupMyr(w) / Number(w.myrPerUsd) : null);
  // A transaction's amount: "−0.001 USDC", "+1 USDC"; and when: "22:31" today, else "12 Nov".
  const signedUsdc = (v) => `${v < 0 ? '−' : '+'}${Number(Math.abs(v).toFixed(4))} USDC`;
  const when = (iso) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  };

  function chipText() {
    if (!wallet || wallet.error || wallet.mode === 'off') return null;
    return wallet.pro ? `${rm(wallet.balanceMyr)} · Pro` : rm(wallet.balanceMyr); // Pro still pays per assist
  }

  function updateChip() {
    const chip = document.querySelector('#goat-panel .wallet-chip');
    if (!chip) return;
    const text = chipText();
    chip.hidden = !text;
    chip.textContent = text || '';
    chip.classList.toggle('pro', Boolean(wallet && wallet.pro));
    chip.title = wallet && wallet.balanceUsd !== null && wallet.balanceUsd !== undefined ? `${usdc(wallet.balanceUsd)} in your GOAT wallet` : 'Your GOAT wallet';
    const low = Boolean(wallet && !wallet.pro && wallet.balanceMyr !== null && wallet.balanceMyr < (wallet.priceMyr || 0.04) * 3);
    chip.classList.toggle('low', low);
  }

  async function refresh() {
    if (!goat.wallet) return null;
    const w = await goat.wallet();
    if (w && !w.error) wallet = w;
    updateChip();
    // An open wallet card shows the new balance and the payment that just went through.
    const s = ui.state();
    if (s.panel && s.panel.name === 'wallet') {
      const p = document.getElementById('goat-panel');
      if (p && p.querySelector('.wallet-tx')) render(p);
    }
    return wallet;
  }

  ui.onEvent('ask:open', () => {
    const row = document.querySelector('#goat-panel .ask-row');
    if (!row || row.querySelector('.wallet-chip')) return;
    const chip = ui.el('button', 'wallet-chip', chipText() || '');
    chip.type = 'button';
    chip.title = 'Your GOAT wallet';
    chip.hidden = !chipText();
    chip.onclick = () => openWallet();
    row.append(chip);
    refresh();
  });
  ui.onEvent('open-wallet', () => openWallet());
  ui.onEvent('reply', (reply) => {
    if (reply && reply.payment && reply.payment.success) paid(reply.payment);
  });

  function coinFly() {
    const { pos } = ui.state();
    const to = { x: window.innerWidth - 70, y: 64 };
    const coin = ui.el('div', 'coin', '¢');
    document.body.append(coin);
    const at = (x, y, s) => `translate(${x}px, ${y}px) scale(${s})`;
    const anim = coin.animate(
      [
        { transform: at(pos.x, pos.y, 0.6), opacity: 0 },
        { transform: at(pos.x, pos.y - 24, 1.1), opacity: 1, offset: 0.15 },
        { transform: at((pos.x + to.x) / 2, Math.min(pos.y, to.y) - 60, 1), opacity: 1, offset: 0.6 },
        { transform: at(to.x, to.y, 0.5), opacity: 0 },
      ],
      { duration: 1000, easing: 'ease-in-out' },
    );
    anim.onfinish = () => coin.remove();
  }

  async function paid(receipt) {
    coinFly();
    await refresh();
    const onChain = wallet && wallet.explorer && wallet.mode === 'x402' && /^0x[0-9a-f]{64}$/i.test(receipt.transaction || '');
    ui.toast(`Paid ${cents()}¢`, { ms: 3500, link: onChain ? `${wallet.explorer}${receipt.transaction}` : null });
  }

  const HTML =
    '<div class="card-head"><div class="card-title">Wallet</div>' +
    '<button type="button" class="x" data-action="close" aria-label="Close">×</button></div>' +
    '<div class="wallet-balance"></div><div class="wallet-usdc"></div><div class="wallet-sub"></div>' +
    '<div class="wallet-pro"></div>' +
    '<div class="form-error" role="alert" hidden></div>' +
    '<div class="form-actions"><button type="button" data-action="topup">Top up RM 10</button><span class="spacer"></span>' +
    '<button type="button" class="primary" data-action="upgrade">Upgrade to Pro</button></div>' +
    '<div class="wallet-tx-head" hidden><span class="card-label">Transactions</span></div><ul class="wallet-tx"></ul>';

  function showError(p, text) {
    const box = p.querySelector('.form-error');
    box.textContent = text;
    box.hidden = !text;
  }

  function render(p) {
    const w = wallet || {};
    p.querySelector('.wallet-balance').textContent = w.mode === 'off' ? 'Free' : rm(w.balanceMyr);
    // The same money in USDC, the coin it's paid in, and the rate it's shown at.
    const coins = w.mode === 'off' || w.balanceUsd === null || w.balanceUsd === undefined ? '' : `${usdc(w.balanceUsd)}${w.mode === 'x402' ? ' on Base Sepolia' : ''}`;
    p.querySelector('.wallet-usdc').textContent = coins && w.myrPerUsd ? `${coins} · 1 USDC = ${rm(w.myrPerUsd)}` : coins;
    p.querySelector('.wallet-sub').textContent = w.mode === 'off' ? 'Assists are free on this server.' : `${price(w.priceMyr)} per assist`;
    const until = w.proUntil ? new Date(w.proUntil).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '';
    p.querySelector('.wallet-pro').textContent = w.pro
      ? `Pro until ${until}: the better model and voice mode. Each assist is still ${price(w.priceMyr)}.`
      : `Pro: the better model and voice mode, ${price(w.proPriceMyr)} for ${w.proDays || 30} days. Each assist is still ${price(w.priceMyr)}.`;
    p.querySelector('[data-action="upgrade"]').textContent = w.pro ? 'Extend Pro' : 'Upgrade to Pro';
    const top = p.querySelector('[data-action="topup"]');
    top.disabled = w.mode === 'off';
    top.replaceChildren(`Top up ${rm(topupMyr(w))}`); // and, under it, what that is in USDC
    if (topupUsd(w)) top.append(ui.el('small', 'topup-usdc', usdc(topupUsd(w))));
    renderTransactions(p, w);
  }

  // Recent payments and top-ups, newest first. On Base Sepolia a row opens its transaction on the
  // explorer; the card itself never shows a hash or an address.
  function renderTransactions(p, w) {
    const rows = Array.isArray(w.transactions) ? w.transactions : [];
    p.querySelector('.wallet-tx-head').hidden = !rows.length;
    p.querySelector('.wallet-tx').replaceChildren(
      ...rows.map((t) => {
        const row = ui.el(t.link ? 'button' : 'div', 'wallet-tx-row');
        if (t.link) {
          row.type = 'button';
          row.dataset.action = 'tx';
          row.dataset.link = t.link;
          row.title = 'Open on the Base Sepolia explorer';
        }
        const what = ui.el('span', 'wallet-tx-what');
        const myr = Number(w.myrPerUsd) > 0 ? `${price(Math.abs(t.usd) * Number(w.myrPerUsd))} · ` : '';
        what.append(ui.el('span', 'wallet-tx-label', t.label), ui.el('span', 'wallet-tx-meta', `${myr}${when(t.at)}`));
        row.append(what, ui.el('span', `wallet-tx-amount${t.usd < 0 ? '' : ' in'}`, signedUsdc(t.usd)));
        if (t.link) row.append(ui.el('span', 'wallet-tx-open', '↗'));
        const li = ui.el('li');
        li.append(row);
        return li;
      }),
    );
  }

  // opts.back: opened from the account card ("← Account").
  async function openWallet(opts = {}) {
    const p = ui.openPanel({
      name: 'wallet',
      html: HTML,
      keyboard: false,
      dock: 'right',
      back: opts.back,
      onclick: async (event) => {
        const button = event.target.closest('[data-action]');
        if (!button) return;
        const action = button.dataset.action;
        if (action === 'close') {
          ui.closePanel();
          return;
        }
        if (action === 'tx') {
          if (goat.openLink) goat.openLink(button.dataset.link); // main opens only Base Sepolia transactions
          return;
        }
        button.disabled = true;
        showError(p, '');
        if (action === 'topup') {
          const r = goat.topup ? await goat.topup(topupMyr(wallet)) : { error: 'unavailable', message: 'Top-ups are not available.' };
          if (r && !r.error) {
            wallet = r;
            // "Topped up 2.38 USDC (RM 10.00)"; on Base Sepolia it opens the transfer.
            const t = r.topup || {};
            const usd = t.usd ?? topupUsd(r);
            const myr = t.myr ?? topupMyr(r);
            const onChain = Boolean(r.explorer) && /^0x[0-9a-f]{64}$/i.test(t.transaction || '');
            ui.toast(usd ? `Topped up ${usdc(usd)} (${rm(myr)})` : `Topped up ${rm(myr)}`, { ms: 4500, link: onChain ? `${r.explorer}${t.transaction}` : null });
          } else {
            showError(p, (r && r.message) || 'The top-up failed.');
          }
        }
        if (action === 'upgrade') {
          const r = goat.upgradePro ? await goat.upgradePro() : { error: 'unavailable', message: 'Upgrades are not available.' };
          if (r && !r.error) {
            await refresh();
            if (r.payment && r.payment.success) coinFly();
            const until = new Date(r.proUntil).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
            ui.toast(`Pro until ${until}`, { ms: 4000 });
            ui.emit('pro', { pro: true, proUntil: r.proUntil });
          } else {
            showError(p, (r && r.message) || 'The upgrade failed.');
          }
        }
        button.disabled = false;
        render(p);
      },
    });
    render(p);
    await refresh();
    const s = ui.state();
    if (s.panel && s.panel.name === 'wallet') render(p);
  }

  window.GOATWallet = { refresh, open: openWallet, get: () => wallet };
})();
