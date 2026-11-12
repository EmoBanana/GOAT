// GOAT overlay renderer. Classic script (file:// plus sandbox): no modules and no network.
// It talks to main only through window.goat (preload) and exposes window.GOATUI so each
// later feature can be its own script.
(function () {
  'use strict';

  const goat = window.goat || {};
  const ART = window.GOATArt;
  const FOLLOW = { x: 14, y: 16 }; // blue tip sits this far below-right of the real tip
  const DWELL_MS = 450;
  const DWELL_RADIUS = 28;
  const DEFAULT_WAIT_MS = 9000;
  const HOTKEY_KEYS = { ask: 'G', record: 'R', capture: 'C', track: 'T', voice: 'V', account: 'A' };
  const CHAT_FRESH_MS = 30 * 60_000; // after this long, the ask panel starts a new chat
  const THREAD_TURNS = 3; // turns of the current chat shown above the input

  const els = {
    cursor: document.getElementById('goat-cursor'),
    ring: document.getElementById('goat-ring'),
    bubble: document.getElementById('goat-bubble'),
    backdrop: document.getElementById('goat-backdrop'),
    panel: document.getElementById('goat-panel'),
    toasts: document.getElementById('goat-toasts'),
  };

  const state = {
    origin: { x: 0, y: 0 }, // window origin in screen points
    sys: null, // system cursor, window coordinates
    pos: { x: 0, y: 0 }, // blue cursor tip
    mode: 'follow', // follow | flying | parked
    thinking: false,
    panel: null, // { name, keyboard }
    guide: null, // { id, index, total, landed }
    bubble: null, // { kind }
    clickThrough: true,
    voice: false,
    heard: '',
    info: { platform: 'darwin', hotkeys: { ask: 'Ctrl+Option+G' } },
    chat: null, // the chat being continued: { id, title, turns: [{ question, answer, source, guide }] }
    chatAt: 0, // when it was last used
    threadOpen: false, // the ask panel lists the chat's turns (else one line)
  };

  // ---------- event bus ----------
  const listeners = new Map();
  function onEvent(type, callback) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(callback);
    return () => listeners.get(type).delete(callback);
  }
  function emit(type, data) {
    for (const key of [type, '*']) {
      for (const callback of listeners.get(key) || []) {
        try {
          callback(data, type);
        } catch (err) {
          console.error(err);
        }
      }
    }
  }

  // ---------- helpers ----------
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }
  const toLocal = (p) => ({ x: Number(p.x) - state.origin.x, y: Number(p.y) - state.origin.y });
  const onScreen = (p) => ({ x: clamp(p.x, 4, window.innerWidth - 4), y: clamp(p.y, 4, window.innerHeight - 4) });

  // ---------- blue cursor ----------
  // While GOAT works, a small readout beside the cursor shows what it's doing, step by step.
  els.cursor.innerHTML = `${ART.cursorSvg()}<div class="readout" aria-live="polite"><ol></ol></div>`;
  const readout = els.cursor.querySelector('.readout ol');
  let drawn = { x: NaN, y: NaN };
  function renderCursor() {
    if (drawn.x === state.pos.x && drawn.y === state.pos.y) return;
    drawn = { ...state.pos };
    els.cursor.style.transform = `translate3d(${state.pos.x}px, ${state.pos.y}px, 0)`;
  }
  function showCursor() {
    if (els.cursor.classList.contains('ready')) return;
    if (!state.sys) state.pos = { x: window.innerWidth / 2, y: window.innerHeight / 3 };
    renderCursor();
    els.cursor.classList.add('ready');
  }
  // Steps come from main and the server ("Reading the deck", "Checking the guides"…). When one
  // runs long, a short filler line says GOAT is still on it.
  const STEPS_SHOWN = 3;
  const FILLER_MS = 5000;
  const FILLERS = ['Still working on it', 'Nearly there'];
  let steps = [];
  let fillerTimer = null;
  function renderSteps() {
    readout.replaceChildren(
      ...steps.slice(-STEPS_SHOWN).map((text, i, shown) => {
        const li = el('li', i === shown.length - 1 ? 'now' : 'done');
        li.append(el('span', null, text));
        return li;
      }),
    );
  }
  function armFiller(n = 0) {
    clearTimeout(fillerTimer);
    if (!state.thinking || n >= FILLERS.length) return;
    fillerTimer = setTimeout(() => {
      steps.push(FILLERS[n]);
      renderSteps();
      armFiller(n + 1);
    }, FILLER_MS);
  }
  function addStep(text) {
    const t = String(text || '').trim().slice(0, 80);
    if (!state.thinking || !t || steps[steps.length - 1] === t) return;
    steps = steps.filter((s) => !FILLERS.includes(s)).concat(t);
    renderSteps();
    armFiller();
    emit('step', { text: t });
  }
  function setThinking(on, first = 'Working on it') {
    state.thinking = Boolean(on);
    els.cursor.classList.toggle('thinking', state.thinking);
    clearTimeout(fillerTimer);
    steps = state.thinking ? [first] : [];
    renderSteps();
    if (state.thinking) armFiller();
  }

  function onCursor(p) {
    const first = !state.sys;
    state.sys = { x: Number(p.x), y: Number(p.y) };
    if (first && state.mode === 'follow') {
      state.pos = { x: state.sys.x + FOLLOW.x, y: state.sys.y + FOLLOW.y };
      renderCursor();
    }
    showCursor();
    updateClickThrough();
  }

  // Idle: ease towards the spot just below-right of the system cursor.
  let lastFrame = performance.now();
  function frame(now) {
    const dt = Math.min(64, now - lastFrame);
    lastFrame = now;
    if (state.mode === 'follow' && state.sys) {
      const tx = state.sys.x + FOLLOW.x;
      const ty = state.sys.y + FOLLOW.y;
      const k = 1 - Math.pow(0.62, dt / 16.7);
      const nx = state.pos.x + (tx - state.pos.x) * k;
      const ny = state.pos.y + (ty - state.pos.y) * k;
      state.pos = { x: Math.abs(tx - nx) < 0.1 ? tx : nx, y: Math.abs(ty - ny) < 0.1 ? ty : ny };
      renderCursor();
    }
    trackBubble();
    requestAnimationFrame(frame);
  }

  // Fly along a quadratic Bézier arc and land with the tip on (x, y). Resolves false if cancelled.
  let flight = null;
  function cancelFlight() {
    if (!flight) return;
    const f = flight;
    flight = null;
    f.resolve(false);
  }
  function flyTo(x, y, opts = {}) {
    cancelFlight();
    showCursor();
    state.mode = 'flying';
    const from = { ...state.pos };
    const to = { x, y };
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dist = Math.hypot(dx, dy);
    const ms = opts.duration ?? clamp(320 + dist * 0.6, 320, 1100);
    let nx = -dy / (dist || 1);
    let ny = dx / (dist || 1);
    if (ny > 0 || (ny === 0 && nx > 0)) {
      nx = -nx; // bow the arc upwards
      ny = -ny;
    }
    const lift = Math.min(140, dist * 0.2);
    const c = { x: (from.x + to.x) / 2 + nx * lift, y: (from.y + to.y) / 2 + ny * lift };
    emit('fly', { from, to, ms });
    return new Promise((resolve) => {
      const me = { resolve };
      flight = me;
      const start = performance.now();
      function step(now) {
        if (flight !== me) return;
        const t = Math.min(1, (now - start) / ms);
        const e = easeInOut(t);
        const u = 1 - e;
        state.pos = { x: u * u * from.x + 2 * u * e * c.x + e * e * to.x, y: u * u * from.y + 2 * u * e * c.y + e * e * to.y };
        if (t >= 1) {
          state.pos = { ...to };
          flight = null;
          state.mode = 'parked';
          renderCursor();
          resolve(true);
          return;
        }
        renderCursor();
        requestAnimationFrame(step);
      }
      requestAnimationFrame(step);
    });
  }

  // Back to riding beside the system cursor (unless a guide owns the cursor).
  function resumeFollow() {
    if (run) return;
    cancelFlight();
    state.mode = 'follow';
  }

  // ---------- ring ----------
  function showRing(x, y) {
    els.ring.style.left = `${x}px`;
    els.ring.style.top = `${y}px`;
    els.ring.hidden = false;
  }
  function hideRing() {
    els.ring.hidden = true;
  }

  // ---------- bubble ----------
  let bubbleTimer = null;
  let bubbleFollow = false;
  let bubbleSize = { w: 0, h: 0 };
  let bubbleAt = { x: NaN, y: NaN };
  const readingMs = (text) => clamp(5000 + String(text || '').length * 55, 7000, 30000);

  function placeBubble(at) {
    const b = els.bubble;
    const { w, h } = bubbleSize;
    let x = at.x + 24;
    let y = at.y + 22;
    if (x + w > window.innerWidth - 8) x = at.x - w - 16;
    if (y + h > window.innerHeight - 8) y = at.y - h - 12;
    b.style.left = `${clamp(x, 8, Math.max(8, window.innerWidth - w - 8))}px`;
    b.style.top = `${clamp(y, 8, Math.max(8, window.innerHeight - h - 8))}px`;
    bubbleAt = { x: at.x, y: at.y };
  }

  // Following bubbles ride beside the blue cursor; called every frame.
  function trackBubble() {
    if (!bubbleFollow || els.bubble.hidden) return;
    if (bubbleAt.x === state.pos.x && bubbleAt.y === state.pos.y) return;
    placeBubble(state.pos);
  }

  // opts: { kind, text, intro, meta, sources, step, total, next, nextLabel, at, ms, follow, onAction }
  // follow: ride beside the blue cursor. A following bubble can't be reached with the mouse, so
  // it lets clicks through, has no Close button and hides after a reading time (or Esc).
  function showBubble(opts = {}) {
    const b = els.bubble;
    const follow = Boolean(opts.follow);
    clearTimeout(bubbleTimer);
    b.className = `bubble ${follow ? 'following' : 'interactive'}${opts.kind ? ` ${opts.kind}` : ''}`;
    b.replaceChildren();
    if (!follow) {
      const close = el('button', 'close', '×');
      close.type = 'button';
      close.dataset.action = 'close';
      close.setAttribute('aria-label', 'Close');
      b.append(close);
    }
    if (opts.intro) b.append(el('div', 'intro', opts.intro));
    const textEl = el('div', 'text', opts.reveal ? '' : opts.text || '');
    b.append(textEl);
    if (opts.reveal) revealWords(textEl, opts.text || '');
    else clearInterval(revealTimer);
    if (opts.meta) b.append(el('div', 'meta', opts.meta));
    if (opts.sources) b.append(el('div', 'sources', opts.sources));
    if (opts.step || opts.next) {
      const row = el('div', 'row');
      row.append(el('span', 'step', opts.step ? `Step ${opts.step} of ${opts.total}` : ''));
      if (opts.next) {
        const next = el('button', 'next', opts.nextLabel || 'Next');
        next.type = 'button';
        next.dataset.action = 'next';
        row.append(next);
      }
      b.append(row);
    }
    b.onclick = (event) => {
      const button = event.target.closest('[data-action]');
      if (!button) return;
      if (opts.onAction) opts.onAction(button.dataset.action);
      else if (button.dataset.action === 'close') hideBubble();
    };
    b.hidden = false;
    bubbleSize = { w: b.offsetWidth, h: b.offsetHeight };
    bubbleFollow = follow;
    placeBubble(follow ? state.pos : opts.at || state.pos);
    const ms = opts.ms ?? (follow ? readingMs(opts.text) : 0);
    if (ms) bubbleTimer = setTimeout(hideBubble, ms);
    state.bubble = { kind: opts.kind || 'info', follow, ms };
    updateClickThrough();
    emit('bubble', { kind: opts.kind || 'info', text: opts.text || '' });
    return b;
  }
  function hideBubble() {
    clearTimeout(bubbleTimer);
    bubbleFollow = false;
    els.bubble.hidden = true;
    els.bubble.onclick = null;
    state.bubble = null;
    updateClickThrough();
  }

  // ---------- guides ----------
  let run = null;

  function waitForAdvance(me, step) {
    return new Promise((resolve) => {
      const waitMs = Number(step.waitMs) > 0 ? Number(step.waitMs) : DEFAULT_WAIT_MS;
      let nearSince = null;
      const finish = (how) => {
        clearTimeout(timer);
        clearInterval(poll);
        me.advance = null;
        me.cancel = null;
        resolve(how);
      };
      const timer = setTimeout(() => finish('timeout'), waitMs);
      // Hovering the target for 450 ms within 28 px counts as "done".
      const poll = setInterval(() => {
        const p = state.sys;
        if (p && Math.hypot(p.x - step.x, p.y - step.y) <= DWELL_RADIUS) {
          nearSince = nearSince ?? performance.now();
          if (performance.now() - nearSince >= DWELL_MS) finish('dwell');
        } else {
          nearSince = null;
        }
      }, 25);
      me.advance = finish;
      me.cancel = () => finish('stopped');
    });
  }

  function endGuide(me, reason) {
    if (!me || run !== me) return;
    me.stopped = true;
    if (me.cancel) me.cancel();
    run = null;
    state.guide = null;
    cancelFlight();
    hideRing();
    hideBubble();
    state.mode = 'follow';
    emit('guide:end', { id: me.id, reason, index: me.index });
  }
  function stopGuide(reason = 'stopped') {
    if (run) endGuide(run, reason);
  }

  // A step can name its control (target: a label, or { label, role }). Right before the step,
  // main finds that control on screen as it is now, so the cursor lands on it whatever the
  // resolution, window size or scroll. Not found, a recorded step falls back to its screen points;
  // a sample or planned step says what to look for instead of pointing at the wrong place.
  const targetOf = (s) =>
    typeof s.target === 'string' && s.target.trim()
      ? { label: s.target.trim() }
      : s.target && typeof s.target.label === 'string' && s.target.label.trim()
        ? { label: s.target.label.trim(), role: String(s.target.role || '') }
        : null;
  const hasPoint = (s) => Number.isFinite(Number(s.x)) && Number.isFinite(Number(s.y)) && s.x !== null && s.y !== null;

  async function locateStep(step, sampleOnly) {
    const target = targetOf(step);
    if (target && goat.locate) {
      let hit = null;
      try {
        hit = await goat.locate(target);
      } catch {
        hit = null;
      }
      if (hit && Number.isFinite(hit.x) && Number.isFinite(hit.y)) return { x: hit.x + (Number(hit.w) || 0) / 2, y: hit.y + (Number(hit.h) || 0) / 2, how: 'live', target };
    }
    if (hasPoint(step) && !(target && sampleOnly)) return { x: Number(step.x), y: Number(step.y), how: 'recorded', target };
    return { x: NaN, y: NaN, how: 'none', target };
  }

  async function playGuide(guide) {
    stopGuide('replaced');
    const steps = guide && Array.isArray(guide.steps) ? guide.steps : [];
    if (!steps.length) return;
    hideBubble();
    const sampleOnly = /^sample/i.test(String(guide.recordedOn || ''));
    const me = { id: guide.id, index: -1, stopped: false, advance: null, cancel: null };
    run = me;
    emit('guide:start', { id: guide.id, total: steps.length, intro: guide.intro });
    for (let i = 0; i < steps.length; i += 1) {
      me.index = i;
      state.guide = { id: guide.id, index: i, total: steps.length, landed: false, located: null };
      hideRing();
      const found = await locateStep(steps[i], sampleOnly);
      if (me.stopped) return;
      state.guide.located = found.how;
      let s;
      if (found.how === 'none') {
        // Nothing to point at: the instruction beside the cursor, naming what to look for.
        s = { ...steps[i], x: NaN, y: NaN };
        state.guide.landed = true;
      } else {
        s = { ...steps[i], ...onScreen(toLocal(found)) };
        const landed = await flyTo(s.x, s.y);
        if (me.stopped || !landed) return;
        state.guide.landed = true;
        showRing(s.x, s.y);
      }
      const lookFor = found.how === 'none' && found.target ? ` Look for “${found.target.label}”.` : '';
      showBubble({
        kind: 'step',
        intro: i === 0 ? guide.intro : '',
        text: `${s.say || ''}${lookFor}`,
        step: i + 1,
        total: steps.length,
        next: true,
        nextLabel: i === steps.length - 1 ? 'Done' : 'Next',
        at: found.how === 'none' ? { x: state.pos.x + 20, y: state.pos.y + 24 } : s,
        onAction: (action) => (action === 'next' ? me.advance && me.advance('next') : stopGuide('closed')),
      });
      emit('guide:step', { id: guide.id, index: i, total: steps.length, label: s.label, say: s.say, intro: guide.intro, located: found.how });
      const how = await waitForAdvance(me, s);
      if (me.stopped) return;
      emit('guide:advance', { id: guide.id, index: i, how });
    }
    endGuide(me, 'done');
  }

  // ---------- panel (one shared element) ----------
  // Handlers are assigned (panel.onclick = …), never added, and cleared on close.
  function focusSoon(selector) {
    if (!selector) return;
    const focus = () => {
      const target = els.panel.querySelector(selector);
      if (target) target.focus();
    };
    focus();
    setTimeout(focus, 60); // Electron focuses the window late
  }
  // opts: { name, html, keyboard, focus, onclick, onsubmit, oninput, backdropCloses, onEscape, dock }
  // dock: 'right' puts a small card under the menu bar on the right; without the keyboard it has
  // no backdrop, so the apps around it keep working.
  let panelEscape = null;
  function openPanel(opts = {}) {
    closePanel();
    const p = els.panel;
    const keyboard = opts.keyboard !== false;
    panelEscape = opts.onEscape || null;
    p.className = `panel interactive${opts.name ? ` panel-${opts.name}` : ''}${opts.dock === 'right' ? ' dock-right' : ''}`;
    p.innerHTML = opts.html || '';
    placeSaved(p, opts.name);
    p.onclick = opts.onclick || null;
    p.onsubmit = opts.onsubmit || null;
    p.oninput = opts.oninput || null;
    p.hidden = false;
    els.backdrop.hidden = !keyboard;
    els.backdrop.onclick = keyboard && opts.backdropCloses !== false ? () => closePanel() : null;
    state.panel = { name: opts.name || 'panel', keyboard };
    if (keyboard && goat.focus) goat.focus();
    if (keyboard) focusSoon(opts.focus);
    updateClickThrough();
    emit('panel:open', { name: state.panel.name });
    return p;
  }
  function closePanel() {
    if (!state.panel) return;
    const { name } = state.panel;
    const p = els.panel;
    p.hidden = true;
    p.innerHTML = '';
    p.onclick = null;
    p.onsubmit = null;
    p.oninput = null;
    Object.assign(p.style, { left: '', top: '', right: '', transform: '' });
    els.backdrop.hidden = true;
    els.backdrop.onclick = null;
    panelEscape = null;
    state.panel = null;
    updateClickThrough();
    emit('panel:close', { name });
  }

  // ---------- moving panels ----------
  // Drag a panel by any empty part of it; each panel opens where you last left it.
  const NO_DRAG = 'button, input, textarea, select, a, label, [contenteditable], .thread-turns, .acct-chats, .rec-steps, .ts-table, .draft-result';
  const spotKey = (name) => `goat.panel.${name}`;
  function movePanel(p, x, y) {
    const w = p.offsetWidth || 320;
    const left = clamp(Math.round(x), 80 - w, window.innerWidth - 80); // a corner always stays reachable
    const top = clamp(Math.round(y), 32, window.innerHeight - 48); // never under the menu bar
    Object.assign(p.style, { left: `${left}px`, top: `${top}px`, right: 'auto', transform: 'none' });
    p.classList.add('moved');
  }
  function placeSaved(p, name) {
    let spot = null;
    try {
      spot = JSON.parse(localStorage.getItem(spotKey(name)) || 'null');
    } catch {
      spot = null;
    }
    if (spot && Number.isFinite(spot.x) && Number.isFinite(spot.y)) movePanel(p, spot.x, spot.y);
  }
  let drag = null;
  els.panel.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || !state.panel || event.target.closest(NO_DRAG)) return;
    const r = els.panel.getBoundingClientRect();
    drag = { id: event.pointerId, x0: event.clientX, y0: event.clientY, dx: event.clientX - r.left, dy: event.clientY - r.top, name: state.panel.name, moved: false };
    els.panel.setPointerCapture(event.pointerId);
    event.preventDefault(); // no text selection while dragging
  });
  els.panel.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    if (!drag.moved) {
      if (Math.hypot(event.clientX - drag.x0, event.clientY - drag.y0) < 3) return;
      drag.moved = true;
      state.dragging = true;
      els.panel.classList.add('dragging');
    }
    movePanel(els.panel, event.clientX - drag.dx, event.clientY - drag.dy);
  });
  function endDrag(event) {
    if (!drag || event.pointerId !== drag.id) return;
    if (drag.moved) {
      const r = els.panel.getBoundingClientRect();
      try {
        localStorage.setItem(spotKey(drag.name), JSON.stringify({ x: r.left, y: r.top }));
      } catch {
        // the panel still moved; it just won't be remembered
      }
      emit('panel:moved', { name: drag.name, x: r.left, y: r.top });
    }
    drag = null;
    state.dragging = false;
    els.panel.classList.remove('dragging');
    updateClickThrough();
  }
  els.panel.addEventListener('pointerup', endDrag);
  els.panel.addEventListener('pointercancel', endDrag);

  // ---------- ask ----------
  // Feature scripts add data to the next ask (e.g. the highlighted region).
  const askExtras = [];
  function addAskExtra(provider) {
    askExtras.push(provider);
  }
  function collectAskExtras() {
    const extra = {};
    for (const provider of askExtras) {
      try {
        Object.assign(extra, provider() || {});
      } catch (err) {
        console.error(err);
      }
    }
    return Object.keys(extra).length ? extra : undefined;
  }

  const ASK_PLACEHOLDER = 'Ask GOAT… e.g. how do I log an issue?';
  const ASK_HTML =
    '<form class="ask-form" autocomplete="off">' +
    '<div class="ask-thread" hidden><div class="thread-head"><span class="thread-title">This chat</span><span class="thread-last"></span>' +
    '<button type="button" class="thread-toggle" data-action="toggle-thread" aria-expanded="false">Show</button>' +
    '<button type="button" class="thread-new" data-action="new-chat">New chat</button></div><ol class="thread-turns" hidden></ol></div>' +
    `<div class="ask-row"><span class="ask-icon">${ART.cursorSvg()}</span>` +
    `<input id="goat-ask-input" class="ask-input" type="text" maxlength="1000" spellcheck="false" placeholder="${ASK_PLACEHOLDER}"></div>` +
    '<div class="ask-meta"><span class="ask-context"></span><span class="ask-hint">Enter to ask · Esc to close</span></div>' +
    '</form>';

  // ---------- chats ----------
  // Every ask joins a chat on the server; the ask panel shows the current one so a question can
  // be continued, and the account panel (Ctrl+Option+A) reopens older ones.
  function setChat(chat) {
    state.chat = chat && chat.id ? { id: chat.id, title: chat.title || '', turns: Array.isArray(chat.turns) ? chat.turns.slice(-50) : [] } : null;
    state.chatAt = Date.now();
    emit('chat', { chat: state.chat });
  }
  function rememberTurn(question, reply) {
    if (!reply || reply.error || !reply.chatId) return;
    if (!state.chat || state.chat.id !== reply.chatId) state.chat = { id: reply.chatId, title: reply.chatTitle || question, turns: [] };
    state.chat.turns.push({
      question,
      answer: reply.source === 'guide' && reply.guide ? reply.guide.intro || '' : reply.say || '',
      source: reply.source,
      ...(reply.guide ? { guide: { id: reply.guide.id, title: reply.guide.title } } : {}),
    });
    state.chatAt = Date.now();
    emit('chat', { chat: state.chat });
  }
  const currentChatId = () => (state.chat ? state.chat.id : null);

  // Folded, the chat is one line above the input (its last question), so the panel covers
  // little more than a plain ask. Show lists its last turns.
  function renderThread(p) {
    const box = p.querySelector('.ask-thread');
    const turns = state.chat ? state.chat.turns.slice(-THREAD_TURNS) : [];
    box.hidden = !turns.length;
    p.querySelector('#goat-ask-input').placeholder = turns.length ? 'Ask a follow-up…' : ASK_PLACEHOLDER;
    if (!turns.length) return;
    const open = state.threadOpen;
    box.classList.toggle('open', open);
    const toggle = p.querySelector('[data-action="toggle-thread"]');
    toggle.textContent = open ? 'Hide' : 'Show';
    toggle.setAttribute('aria-expanded', String(open));
    // Chat text comes from the model and the user: text only, never HTML.
    p.querySelector('.thread-last').textContent = open ? '' : turns[turns.length - 1].question;
    const list = p.querySelector('.thread-turns');
    list.replaceChildren(
      ...turns.map((t) => {
        const li = el('li', 'turn');
        li.append(el('div', 'turn-q', t.question));
        li.append(el('div', 'turn-a', t.source === 'guide' && t.guide ? `Showed the guide “${t.guide.title}”.` : t.answer));
        return li;
      }),
    );
    list.hidden = !open;
    if (open) list.scrollTop = list.scrollHeight;
  }

  // opts.showThread: open with the chat's turns listed (a chat picked in the account panel).
  function openAsk(opts = {}) {
    stopGuide('ask');
    hideBubble();
    if (state.chat && Date.now() - state.chatAt > CHAT_FRESH_MS) setChat(null);
    state.threadOpen = Boolean(opts.showThread);
    const p = openPanel({
      name: 'ask',
      html: ASK_HTML,
      focus: '#goat-ask-input',
      onclick: (event) => {
        const button = event.target.closest('[data-action]');
        if (!button) return;
        if (button.dataset.action === 'toggle-thread') state.threadOpen = !state.threadOpen;
        else if (button.dataset.action === 'new-chat') setChat(null);
        else return;
        renderThread(p);
        p.querySelector('#goat-ask-input').focus();
      },
      onsubmit: (event) => {
        event.preventDefault();
        const question = p.querySelector('#goat-ask-input').value.trim();
        if (!question) return;
        const extra = collectAskExtras(); // before closing: closing clears the highlight
        closePanel();
        ask(question, extra);
      },
    });
    const ctx = opts.context || {};
    const where = ctx.app ? `In ${ctx.app}${ctx.title ? ` · ${ctx.title}` : ''}` : '';
    p.querySelector('.ask-context').textContent = where; // window titles are untrusted: text only
    renderThread(p);
    emit('ask:open', { context: ctx });
    return p;
  }

  // The best installed English voice: Premium, then Enhanced, then the familiar Mac voices.
  let bestVoice = null;
  function pickVoice() {
    if (!('speechSynthesis' in window)) return null;
    const score = (v) =>
      (/premium/i.test(v.name) ? 8 : /enhanced/i.test(v.name) ? 6 : /siri/i.test(v.name) ? 4 : /samantha|ava|zoe|daniel|karen|moira|serena|allison/i.test(v.name) ? 2 : 0) +
      (v.localService ? 1 : 0);
    const english = window.speechSynthesis.getVoices().filter((v) => /^en([-_]|$)/i.test(v.lang));
    return english.sort((a, b) => score(b) - score(a))[0] || null;
  }
  if ('speechSynthesis' in window) window.speechSynthesis.addEventListener?.('voiceschanged', () => (bestVoice = pickVoice()));

  // Speaks while voice mode is on (opts.force: always, e.g. guide steps of a spoken question).
  function speak(text, opts = {}) {
    if ((!state.voice && !opts.force) || !text || !('speechSynthesis' in window)) return false;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    bestVoice = bestVoice || pickVoice();
    if (bestVoice) u.voice = bestVoice;
    u.rate = 1.05;
    u.onstart = () => emit('speak:start', { text });
    u.onend = () => emit('speak:end', { text });
    u.onerror = () => emit('speak:end', { text });
    window.speechSynthesis.speak(u);
    return true;
  }
  function stopSpeaking() {
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  }

  // Spoken answers appear word by word, about as fast as they're read out.
  let revealTimer = null;
  function revealWords(container, text, ms = 190) {
    clearInterval(revealTimer);
    container.replaceChildren();
    const words = String(text).split(/(\s+)/).map((w) => {
      const span = document.createElement('span');
      span.className = 'w';
      span.textContent = w;
      container.append(span);
      return span;
    });
    let i = 0;
    revealTimer = setInterval(() => {
      while (i < words.length && !words[i].textContent.trim()) words[i++].classList.add('on');
      if (i < words.length) words[i++].classList.add('on');
      if (i >= words.length) clearInterval(revealTimer);
    }, ms);
  }

  function handleReply(reply) {
    emit('reply', reply);
    if (!reply || reply.error) {
      showBubble({ kind: 'error', text: (reply && reply.message) || 'Something went wrong.', follow: true });
      return;
    }
    if (reply.source === 'guide' && reply.guide && Array.isArray(reply.guide.steps) && reply.guide.steps.length) {
      playGuide(reply.guide);
      return;
    }
    // The answer speaks for itself: the readout already showed what GOAT did, and web sources
    // are the one footnote worth keeping.
    const hosts = (reply.sources || [])
      .filter((s) => s.type === 'web')
      .map((s) => {
        try {
          return new URL(s.url).hostname.replace(/^www\./, '');
        } catch {
          return '';
        }
      })
      .filter(Boolean);
    const spoken = state.voice;
    showBubble({
      kind: 'answer',
      intro: spoken && state.heard ? `You said “${state.heard}”` : '',
      text: reply.say || '…',
      sources: hosts.length ? `Sources: ${hosts.join(', ')}` : '',
      follow: true,
      reveal: spoken,
    });
    speak(reply.say);
  }

  async function ask(question, extra) {
    setThinking(true);
    emit('ask', { question });
    let reply;
    try {
      reply = await goat.ask(question, { ...(extra || {}), chatId: currentChatId() });
    } catch (err) {
      reply = { error: 'ipc_error', message: String((err && err.message) || err) };
    } finally {
      setThinking(false);
    }
    rememberTurn(question, reply);
    handleReply(reply || { error: 'empty_reply', message: 'No answer came back.' });
    return reply;
  }

  // ---------- toast ----------
  function toast(text, opts = {}) {
    const t = el('div', `toast${opts.kind ? ` ${opts.kind}` : ''}`, text);
    if (opts.link) {
      // e.g. the transaction on the Base Sepolia explorer; main only opens those links
      t.classList.add('interactive', 'link');
      t.title = 'Open the transaction';
      t.onclick = () => goat.openLink && goat.openLink(opts.link);
    }
    els.toasts.append(t);
    setTimeout(() => {
      t.classList.add('out');
      setTimeout(() => t.remove(), 350);
    }, opts.ms || 3200);
    emit('toast', { text });
    return t;
  }

  // ---------- click-through ----------
  // Take the mouse only over visible controls, or while a panel needs the keyboard.
  function updateClickThrough() {
    let capture = Boolean(state.panel && state.panel.keyboard) || Boolean(state.dragging);
    if (!capture && state.sys) {
      const hit = document.elementFromPoint(state.sys.x, state.sys.y);
      capture = Boolean(hit && hit.closest('.interactive'));
    }
    const through = !capture;
    if (through === state.clickThrough) return;
    state.clickThrough = through;
    if (goat.setClickThrough) goat.setClickThrough(through);
    emit('click-through', { on: through });
  }

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    stopSpeaking();
    if (state.panel) {
      if (panelEscape) panelEscape();
      else closePanel();
    } else if (run) stopGuide('escape');
    else hideBubble();
  });

  function greet() {
    if (state.bubble || state.panel || run) return; // never cover something the user asked for
    const key = (state.info.hotkeys && state.info.hotkeys.ask) || 'Ctrl+Option+G';
    const text = `Hi, I'm GOAT. Press ${key} to ask me anything.`;
    if (state.sys) showBubble({ kind: 'greeting', text, follow: true, ms: 8000 });
    else showBubble({ kind: 'greeting', text, at: { x: window.innerWidth / 2 - 160, y: 90 }, ms: 8000 });
  }

  window.GOATUI = {
    ready: false,
    onEvent,
    emit,
    showBubble,
    hideBubble,
    flyTo,
    playGuide,
    stopGuide,
    openPanel,
    closePanel,
    openAsk,
    ask,
    handleReply,
    toast,
    speak,
    showRing,
    hideRing,
    setThinking,
    addStep,
    steps: () => steps.slice(),
    toLocal,
    updateClickThrough,
    // Voice turn on/off; heard is the transcript shown above the spoken answer.
    setVoice: (on, heard = '') => {
      state.voice = Boolean(on);
      state.heard = on ? String(heard) : '';
    },
    stopSpeaking,
    resumeFollow,
    addAskExtra,
    chat: () => (state.chat ? JSON.parse(JSON.stringify(state.chat)) : null),
    setChat,
    newChat: () => setChat(null),
    el,
    cursorEl: els.cursor,
    info: () => state.info,
    hotkey: (name) => (state.info.hotkeys && state.info.hotkeys[name]) || `${state.info.platform === 'win32' ? 'Ctrl+Alt' : 'Ctrl+Option'}+${HOTKEY_KEYS[name] || '?'}`,
    state: () =>
      JSON.parse(
        JSON.stringify({
          origin: state.origin,
          sys: state.sys,
          pos: state.pos,
          mode: state.mode,
          thinking: state.thinking,
          panel: state.panel,
          guide: state.guide,
          bubble: state.bubble,
          clickThrough: state.clickThrough,
          voice: state.voice,
        }),
      ),
  };

  // ---------- start ----------
  if (goat.onEvent) {
    goat.onEvent((message) => {
      if (!message || typeof message.type !== 'string') return;
      if (message.type === 'cursor') onCursor(message);
      else if (message.type === 'origin') state.origin = { x: Number(message.x) || 0, y: Number(message.y) || 0 };
      else if (message.type === 'open-ask') openAsk(message);
      else if (message.type === 'progress') addStep(message.step);
      else if (message.type === 'notice' && message.text) toast(String(message.text), { ms: 9000 });
      emit(message.type, message);
    });
  }
  requestAnimationFrame(frame);
  Promise.resolve(goat.info ? goat.info() : null)
    .then((info) => {
      if (info && typeof info === 'object') state.info = { ...state.info, ...info };
    })
    .catch(() => {})
    .finally(() => {
      let greeted = false;
      const once = () => {
        if (greeted) return;
        greeted = true;
        greet();
      };
      if (state.sys) once();
      else {
        const off = onEvent('cursor', () => {
          off();
          once();
        });
        setTimeout(once, 1200);
      }
    });
  window.GOATUI.ready = true;
  emit('ready', {});
})();
