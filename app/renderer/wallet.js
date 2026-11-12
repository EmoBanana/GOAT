// The wallet abstraction in the UI: a ringgit chip in the ask panel, a wallet panel with Top up and
// Upgrade to Pro, and a coin flying off the cursor with "1¢ paid via x402" after each paid ask.
// Users never see an address.
(function () {
  'use strict';

  const ui = window.GOATUI;
  const goat = window.goat || {};
  if (!ui) return;

  let wallet = null;
  const rm = (v) => (v === null || v === undefined ? 'RM –' : `RM ${Number(v).toFixed(2)}`);
  const cents = () => Math.max(1, Math.round(((wallet && wallet.priceUsd) || 0.01) * 100));

  function chipText() {
    if (!wallet || wallet.error || wallet.mode === 'off') return null;
    return wallet.pro ? 'Pro' : rm(wallet.balanceMyr);
  }

  function updateChip() {
    const chip = document.querySelector('#goat-panel .wallet-chip');
    if (!chip) return;
    const text = chipText();
    chip.hidden = !text;
    chip.textContent = text || '';
    chip.classList.toggle('pro', Boolean(wallet && wallet.pro));
    const low = Boolean(wallet && !wallet.pro && wallet.balanceMyr !== null && wallet.balanceMyr < (wallet.priceMyr || 0.04) * 3);
    chip.classList.toggle('low', low);
  }

  async function refresh() {
    if (!goat.wallet) return null;
    const w = await goat.wallet();
    if (w && !w.error) wallet = w;
    updateChip();
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
    ui.toast(`${cents()}¢ paid via x402`, { ms: 4500, link: onChain ? `${wallet.explorer}${receipt.transaction}` : null });
  }

  const HTML =
    '<div class="wallet">' +
    '<div class="form-head"><strong>GOAT wallet</strong><span class="form-sub wallet-mode"></span></div>' +
    '<div class="wallet-balance"></div><div class="wallet-sub"></div>' +
    '<div class="wallet-pro"></div>' +
    '<div class="form-error" role="alert" hidden></div>' +
    '<div class="form-actions"><button type="button" data-action="close">Close</button><span class="spacer"></span>' +
    '<button type="button" data-action="topup">Top up RM 10</button><button type="button" class="primary" data-action="upgrade">Upgrade to Pro</button></div>' +
    '</div>';

  function showError(p, text) {
    const box = p.querySelector('.form-error');
    box.textContent = text;
    box.hidden = !text;
  }

  function render(p) {
    const w = wallet || {};
    const modes = { 'x402-local': 'x402 · local ledger', x402: 'x402 · Base Sepolia', off: 'payments off' };
    p.querySelector('.wallet-mode').textContent = modes[w.mode] || '';
    p.querySelector('.wallet-balance').textContent = w.mode === 'off' ? 'Free' : rm(w.balanceMyr);
    p.querySelector('.wallet-sub').textContent =
      w.mode === 'off' ? 'Payments are switched off on this server.' : `About $${(w.balanceUsd || 0).toFixed(2)} in USDC. Each assist costs ${rm(w.priceMyr)} (${cents()}¢).`;
    const until = w.proUntil ? new Date(w.proUntil).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '';
    p.querySelector('.wallet-pro').textContent = w.pro
      ? `GOAT Pro until ${until}: no per-assist charge, the better model and voice mode.`
      : `GOAT Pro: no per-assist charge, the better model and voice mode, ${rm(w.proPriceMyr)} for ${w.proDays || 30} days, paid with x402.`;
    p.querySelector('[data-action="upgrade"]').textContent = w.pro ? 'Extend Pro' : 'Upgrade to Pro';
    p.querySelector('[data-action="topup"]').disabled = w.mode === 'off';
  }

  async function openWallet() {
    const p = ui.openPanel({
      name: 'wallet',
      html: HTML,
      onclick: async (event) => {
        const button = event.target.closest('[data-action]');
        if (!button) return;
        const action = button.dataset.action;
        if (action === 'close') {
          ui.closePanel();
          return;
        }
        button.disabled = true;
        showError(p, '');
        if (action === 'topup') {
          const r = goat.topup ? await goat.topup(10) : { error: 'unavailable', message: 'Top-ups are not available.' };
          if (r && !r.error) {
            wallet = r;
            ui.toast('Topped up RM 10. Pay in ringgit, settle on-chain.');
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
            ui.toast(`You're on GOAT Pro until ${until}.`, { ms: 5000 });
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
