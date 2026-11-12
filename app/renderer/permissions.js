// "Before you start": the downloaded app asks for every permission GOAT needs when it starts, before
// sign-in, so a first question never stops at a system prompt (main decides what's needed, in
// lib/permissions.js). A docked card like sign-in; it refreshes while it's open, so each row turns
// on as you switch it on in System Settings, and it closes by itself once everything is on.
(function () {
  'use strict';

  const ui = window.GOATUI;
  const goat = window.goat || {};
  if (!ui) return;

  const HTML =
    '<div class="card-head"><div class="card-title">Before you <mark>start</mark></div>' +
    '<button type="button" class="x" data-action="later" aria-label="Close">×</button></div>' +
    '<p class="card-lead">Allow these now, so GOAT can see, hear and point the moment you ask.</p>' +
    '<ol class="perm-list"></ol>' +
    '<p class="perm-note" hidden></p>' +
    '<div class="welcome-actions"><button type="button" class="primary" data-action="all"><span>Allow all</span></button></div>' +
    '<div class="form-error" role="alert" hidden></div>' +
    '<div class="card-foot"><button type="button" class="link quiet" data-action="later">Not now</button>' +
    '<span class="spacer"></span><button type="button" class="link" data-action="done">Continue</button></div>';

  let poll = null;
  let then = null;
  let busy = false;
  let last = null;
  const isOpen = () => (ui.state().panel || {}).name === 'permissions';

  function showError(p, text) {
    const box = p.querySelector('.form-error');
    box.textContent = text || '';
    box.hidden = !text;
  }

  function render(p, s) {
    last = s;
    p.querySelector('.perm-list').replaceChildren(
      ...s.items.map((item) => {
        const li = ui.el('li', 'perm-row');
        li.dataset.id = item.id;
        li.dataset.state = item.state;
        const text = ui.el('div', 'perm-text');
        text.append(ui.el('div', 'perm-name', item.label), ui.el('div', 'perm-why', item.why));
        li.append(text);
        if (item.state === 'granted') {
          li.append(ui.el('span', 'perm-on', 'On'));
        } else {
          const button = ui.el('button', '', item.state === 'ask' ? 'Allow' : 'Open Settings');
          button.type = 'button';
          if (item.state === 'ask') button.dataset.allow = item.id;
          else button.dataset.settings = item.id;
          button.disabled = busy;
          li.append(button);
        }
        return li;
      }),
    );
    const note = p.querySelector('.perm-note');
    note.textContent = s.note || '';
    note.hidden = !s.note;
    const all = p.querySelector('[data-action="all"]');
    all.disabled = busy;
    all.querySelector('span').textContent = busy ? 'Answer the prompts…' : s.items.some((i) => i.state === 'ask') ? 'Allow all' : 'Open System Settings';
  }

  function finish(allSet) {
    clearInterval(poll);
    poll = null;
    if (isOpen()) ui.closePanel();
    if (allSet) ui.toast('All set: GOAT can see, hear and point', { ms: 3000 });
    const next = then;
    then = null;
    if (next) next();
  }

  // s: what main says (goat.permissions()); next: what comes after (the sign-in card).
  function open(s, next) {
    then = typeof next === 'function' ? next : null;
    busy = false;
    const p = ui.openPanel({
      name: 'permissions',
      html: HTML,
      keyboard: false,
      dock: 'right',
      onclick: async (event) => {
        const target = event.target.closest('[data-action], [data-allow], [data-settings]');
        if (!target || target.disabled) return;
        showError(p, '');
        if (target.dataset.settings) {
          if (goat.permissionSettings) await goat.permissionSettings(target.dataset.settings);
          return;
        }
        const action = target.dataset.action;
        if (action === 'later' || action === 'done') {
          finish(false);
          return;
        }
        // Allow all, or one row's Allow: macOS shows its prompts one after another.
        busy = true;
        render(p, last);
        const r = goat.allowPermissions ? await goat.allowPermissions(target.dataset.allow || null) : null;
        busy = false;
        if (!isOpen()) return;
        if (!r || r.error) {
          render(p, last);
          showError(p, (r && r.message) || "Couldn't ask for that. Try Open Settings.");
          return;
        }
        if (!r.needed) finish(true);
        else render(p, r);
      },
    });
    render(p, s);
    clearInterval(poll);
    poll = setInterval(async () => {
      if (!isOpen()) {
        clearInterval(poll);
        poll = null;
        return;
      }
      if (busy || !goat.permissions) return;
      const fresh = await goat.permissions();
      if (!isOpen() || busy || !fresh || fresh.error) return;
      if (!fresh.needed) finish(true);
      else render(p, fresh);
    }, 1500);
    return p;
  }

  // What to ask for now, or null: nothing missing, or not a downloaded app (main decides).
  async function check() {
    try {
      const s = goat.permissions ? await goat.permissions() : null;
      return s && !s.error && s.ask && s.needed && Array.isArray(s.items) ? s : null;
    } catch {
      return null;
    }
  }

  window.GOATPermissions = { check, open };
})();
