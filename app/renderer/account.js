// Your account, balance and chats (Ctrl+Option+A), and the sign-in card shown when GOAT starts
// without an account. Both are small cards docked under the menu bar that leave the screen
// usable. Signing in happens in the browser (Reown AppKit); main waits for it.
(function () {
  'use strict';

  const ui = window.GOATUI;
  const goat = window.goat || {};
  if (!ui) return;

  let info = null; // { signedIn, account: { method, label, how, short }, userId }
  const rm = (v) => (v === null || v === undefined ? 'RM –' : `RM ${Number(v).toFixed(2)}`);
  const isOpen = (name) => (ui.state().panel || {}).name === name;

  function showError(p, text) {
    const box = p.querySelector('.form-error');
    if (!box) return;
    box.textContent = text || '';
    box.hidden = !text;
  }

  // ---------- welcome: sign in or continue offline ----------
  // A small card under the menu bar, not a modal: the apps around it keep working.
  const WELCOME_HTML =
    '<div class="card-head"><div class="card-title">Sign in to GOAT</div>' +
    '<button type="button" class="x" data-action="dismiss" aria-label="Close">×</button></div>' +
    '<p class="card-lead">Your balance, Pro and chats follow your account.</p>' +
    '<div class="welcome-actions">' +
    '<button type="button" class="primary" data-action="create">Create account</button>' +
    '<button type="button" data-action="connect">Connect wallet</button></div>' +
    '<p class="welcome-wait" hidden>Finish in your browser. GOAT carries on when you’re done.</p>' +
    '<div class="form-error" role="alert" hidden></div>' +
    '<div class="card-foot"><button type="button" class="link" data-action="offline">Continue offline</button></div>';

  function openWelcome() {
    const p = ui.openPanel({
      name: 'welcome',
      html: WELCOME_HTML,
      keyboard: false,
      dock: 'right',
      onclick: async (event) => {
        const button = event.target.closest('[data-action]');
        if (!button || button.disabled) return;
        const action = button.dataset.action;
        showError(p, '');
        if (action === 'dismiss') {
          ui.closePanel();
          return;
        }
        if (action === 'offline') {
          button.disabled = true;
          const r = goat.signInOffline ? await goat.signInOffline() : { error: 'unavailable' };
          if (r && r.error) showError(p, r.message || "Couldn't continue offline.");
          button.disabled = false;
          return;
        }
        // create | connect: the sign-in page opens in the browser
        const r = goat.signIn ? await goat.signIn(action) : { error: 'unavailable', message: 'Sign-in is not available.' };
        if (!r || r.error) {
          showError(p, (r && r.message) || "Couldn't start the sign-in.");
          return;
        }
        p.querySelector('.welcome-wait').hidden = false;
        p.querySelector('[data-action="create"]').textContent = action === 'create' ? 'Open sign-in again' : 'Create account';
        p.querySelector('[data-action="connect"]').textContent = action === 'connect' ? 'Open sign-in again' : 'Connect wallet';
        ui.emit('sign-in:started', { mode: action, url: r.url });
      },
    });
    return p;
  }

  // ---------- account panel ----------
  const ACCOUNT_HTML =
    '<div class="card-head"><div class="acct-who"><div class="card-title acct-label"></div><div class="card-sub acct-how"></div></div>' +
    '<button type="button" class="x" data-action="close" aria-label="Close">×</button></div>' +
    '<div class="acct-wallet"><div><div class="acct-balance">RM –</div><div class="acct-pro"></div></div>' +
    '<span class="spacer"></span><button type="button" data-action="wallet">Top up</button></div>' +
    '<div class="acct-chats-head"><span class="card-label">Chats</span><span class="spacer"></span>' +
    '<button type="button" class="link" data-action="new">New chat</button></div>' +
    '<ol class="acct-chats"></ol>' +
    '<p class="acct-empty" hidden></p>' +
    '<div class="form-error" role="alert" hidden></div>' +
    '<div class="card-foot"><button type="button" class="link" data-action="signout">Sign out</button>' +
    '<span class="spacer"></span><button type="button" class="link quiet" data-action="clear">Clear chats</button></div>';

  function ago(ms) {
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    if (s < 172800) return 'yesterday';
    return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }

  function renderWho(p) {
    const a = (info && info.account) || null;
    p.querySelector('.acct-label').textContent = a ? a.label : (info && info.userId) || 'This laptop';
    const short = a && a.short && a.label.indexOf(a.short) < 0 ? ` · ${a.short}` : '';
    p.querySelector('.acct-how').textContent = a ? `${a.how}${short}` : '';
  }

  function renderWallet(p, w) {
    if (!w || w.error) return;
    p.querySelector('.acct-balance').textContent = w.mode === 'off' ? 'Free' : rm(w.balanceMyr);
    const until = w.proUntil ? new Date(w.proUntil).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '';
    p.querySelector('.acct-pro').textContent = w.pro ? `Pro until ${until}` : w.mode === 'off' ? '' : `${rm(w.priceMyr)} per assist`;
  }

  function renderChats(p, chats) {
    const list = p.querySelector('.acct-chats');
    const empty = p.querySelector('.acct-empty');
    const current = ui.chat();
    list.replaceChildren(
      ...chats.map((c) => {
        // Titles are the user's own questions: text only.
        const li = ui.el('li', current && current.id === c.id ? 'current' : '');
        const open = ui.el('button', 'acct-chat');
        open.type = 'button';
        open.dataset.chat = c.id;
        open.append(ui.el('span', 'acct-chat-title', c.title || 'Untitled'));
        open.append(ui.el('span', 'acct-chat-meta', `${c.turns} ${c.turns === 1 ? 'question' : 'questions'} · ${ago(c.updatedAt)}`));
        const del = ui.el('button', 'acct-del', '×');
        del.type = 'button';
        del.dataset.delete = c.id;
        del.title = 'Delete this chat';
        del.setAttribute('aria-label', `Delete ${c.title || 'this chat'}`);
        li.append(open, del);
        return li;
      }),
    );
    empty.hidden = chats.length > 0;
    empty.textContent = `No chats yet. Press ${ui.hotkey('ask')} to ask something.`;
    p.querySelector('[data-action="clear"]').disabled = !chats.length;
  }

  async function loadChats(p) {
    const r = goat.chats ? await goat.chats() : { chats: [] };
    if (!isOpen('account')) return;
    if (r && r.error) {
      showError(p, r.message || "Couldn't load your chats.");
      return;
    }
    renderChats(p, (r && r.chats) || []);
  }

  let clearArmed = 0;
  function openAccountPanel() {
    const p = ui.openPanel({
      name: 'account',
      html: ACCOUNT_HTML,
      keyboard: false,
      dock: 'right',
      onclick: async (event) => {
        const target = event.target.closest('[data-action], [data-chat], [data-delete]');
        if (!target || target.disabled) return;
        showError(p, '');
        if (target.dataset.chat) {
          const chat = goat.chat ? await goat.chat(target.dataset.chat) : null;
          if (!chat || chat.error) {
            showError(p, (chat && chat.message) || "Couldn't open that chat.");
            return;
          }
          ui.setChat(chat);
          ui.openAsk({ showThread: true }); // you picked it to see it
          return;
        }
        if (target.dataset.delete) {
          const id = target.dataset.delete;
          const r = goat.deleteChat ? await goat.deleteChat(id) : { error: 'unavailable' };
          if (r && r.error) showError(p, r.message || "Couldn't delete that chat.");
          if ((ui.chat() || {}).id === id) ui.newChat();
          await loadChats(p);
          return;
        }
        const action = target.dataset.action;
        if (action === 'close') ui.closePanel();
        else if (action === 'new') {
          ui.newChat();
          ui.openAsk({});
        } else if (action === 'wallet') {
          if (window.GOATWallet) window.GOATWallet.open();
        } else if (action === 'signout') {
          target.disabled = true;
          if (goat.signOut) await goat.signOut();
          ui.newChat();
        } else if (action === 'clear') {
          // Two clicks: the first asks, the second clears.
          if (Date.now() - clearArmed > 4000) {
            clearArmed = Date.now();
            target.textContent = 'Clear all chats?';
            setTimeout(() => {
              if (target.isConnected && Date.now() - clearArmed >= 4000) target.textContent = 'Clear chats';
            }, 4100);
            return;
          }
          clearArmed = 0;
          target.textContent = 'Clear chats';
          const r = goat.clearChats ? await goat.clearChats() : { error: 'unavailable' };
          if (r && r.error) showError(p, r.message || "Couldn't clear your chats.");
          ui.newChat();
          await loadChats(p);
        }
      },
    });
    renderWho(p);
    renderChats(p, []);
    p.querySelector('.acct-empty').hidden = true;
    loadChats(p);
    if (window.GOATWallet) {
      const w = window.GOATWallet.get();
      if (w) renderWallet(p, w);
      window.GOATWallet.refresh().then((fresh) => {
        if (isOpen('account')) renderWallet(p, fresh);
      });
    }
    return p;
  }

  // ---------- events ----------
  const labelOf = (i) => (i && i.account ? i.account.label : '');

  // announce: main reports a sign-in, sign-out or a switch to another account.
  function update(next, announce = false) {
    if (!next || typeof next.signedIn !== 'boolean') return;
    const was = info;
    info = { signedIn: next.signedIn, account: next.account || null, userId: next.userId || '' };
    if (!info.signedIn) {
      if (!isOpen('welcome')) openWelcome();
      return;
    }
    if (isOpen('welcome')) ui.closePanel();
    if (announce && (!was || !was.signedIn || labelOf(was) !== labelOf(info))) {
      // Just signed in: say who, and how to start.
      ui.toast(info.account ? `Signed in: ${info.account.label}` : 'Signed in', { ms: 4000 });
      ui.showBubble({ kind: 'greeting', text: `You're all set. Press ${ui.hotkey('ask')} to ask me anything, or ${ui.hotkey('account')} for your account and chats.`, follow: true, ms: 9000 });
    }
    if (window.GOATWallet) window.GOATWallet.refresh();
  }

  ui.onEvent('account', (msg) => update(msg, true));
  ui.onEvent('open-welcome', (msg) => {
    update(msg);
    if (!isOpen('welcome')) openWelcome();
  });
  ui.onEvent('open-account', (msg) => {
    update(msg);
    openAccountPanel();
  });
  ui.onEvent('sign-in-expired', () => {
    const p = document.getElementById('goat-panel');
    if (isOpen('welcome')) {
      p.querySelector('.welcome-wait').hidden = true;
      showError(p, 'The sign-in page expired. Start again.');
    }
  });

  // On launch: no account yet means the welcome panel.
  Promise.resolve(goat.account ? goat.account() : null)
    .then((first) => {
      if (first && typeof first.signedIn === 'boolean') {
        info = { signedIn: first.signedIn, account: first.account || null, userId: first.userId || '' };
        if (!first.signedIn) openWelcome();
      }
    })
    .catch(() => {});

  window.GOATAccount = { info: () => info, openWelcome, open: openAccountPanel };
})();
