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
    info: { platform: 'darwin', hotkeys: { ask: 'Ctrl+Option+G' } },
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
  els.cursor.innerHTML = `${ART.cursorSvg()}<span class="pill">Thinking…</span>`;
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
  function setThinking(on) {
    state.thinking = Boolean(on);
    els.cursor.classList.toggle('thinking', state.thinking);
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

  // opts: { kind, text, intro, meta, step, total, next, nextLabel, at, ms, follow, onAction }
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
    b.append(el('div', 'text', opts.text || ''));
    if (opts.meta) b.append(el('div', 'meta', opts.meta));
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

  // Steps arrive in screen points; fly to each, show the ring and bubble, wait to advance.
  async function playGuide(guide) {
    stopGuide('replaced');
    const steps = (guide && Array.isArray(guide.steps) ? guide.steps : []).map((s) => ({ ...s, ...onScreen(toLocal(s)) }));
    if (!steps.length) return;
    hideBubble();
    const me = { id: guide.id, index: -1, stopped: false, advance: null, cancel: null };
    run = me;
    emit('guide:start', { id: guide.id, total: steps.length });
    for (let i = 0; i < steps.length; i += 1) {
      const s = steps[i];
      me.index = i;
      state.guide = { id: guide.id, index: i, total: steps.length, landed: false };
      hideRing();
      const landed = await flyTo(s.x, s.y);
      if (me.stopped || !landed) return;
      state.guide.landed = true;
      showRing(s.x, s.y);
      showBubble({
        kind: 'step',
        intro: i === 0 ? guide.intro : '',
        text: s.say,
        step: i + 1,
        total: steps.length,
        next: true,
        nextLabel: i === steps.length - 1 ? 'Done' : 'Next',
        at: s,
        onAction: (action) => (action === 'next' ? me.advance && me.advance('next') : stopGuide('closed')),
      });
      emit('guide:step', { id: guide.id, index: i, total: steps.length, label: s.label });
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
  function openPanel(opts = {}) {
    closePanel();
    const p = els.panel;
    const keyboard = opts.keyboard !== false;
    p.className = `panel interactive${opts.name ? ` panel-${opts.name}` : ''}`;
    p.innerHTML = opts.html || '';
    p.onclick = opts.onclick || null;
    p.onsubmit = opts.onsubmit || null;
    p.oninput = opts.oninput || null;
    p.hidden = false;
    els.backdrop.hidden = !keyboard;
    els.backdrop.onclick = keyboard ? () => closePanel() : null;
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
    els.backdrop.hidden = true;
    els.backdrop.onclick = null;
    state.panel = null;
    updateClickThrough();
    emit('panel:close', { name });
  }

  // ---------- ask ----------
  const ASK_HTML =
    '<form class="ask-form" autocomplete="off">' +
    `<div class="ask-row"><span class="ask-icon">${ART.cursorSvg()}</span>` +
    '<input id="goat-ask-input" class="ask-input" type="text" maxlength="1000" spellcheck="false" placeholder="Ask GOAT… e.g. how do I log an issue?"></div>' +
    '<div class="ask-meta"><span class="ask-context"></span><span class="ask-hint">Enter to ask · Esc to close</span></div>' +
    '</form>';

  function openAsk(opts = {}) {
    stopGuide('ask');
    hideBubble();
    const p = openPanel({
      name: 'ask',
      html: ASK_HTML,
      focus: '#goat-ask-input',
      onsubmit: (event) => {
        event.preventDefault();
        const question = p.querySelector('#goat-ask-input').value.trim();
        if (!question) return;
        closePanel();
        ask(question);
      },
    });
    const ctx = opts.context || {};
    const where = ctx.app ? `In ${ctx.app}${ctx.title ? ` · ${ctx.title}` : ''}` : '';
    p.querySelector('.ask-context').textContent = where; // window titles are untrusted: text only
    emit('ask:open', { context: ctx });
    return p;
  }

  function speak(text) {
    if (!state.voice || !text || !('speechSynthesis' in window)) return false;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
    return true;
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
    showBubble({ kind: 'answer', text: reply.say || '…', meta: reply.model ? `${reply.model} · running on this laptop` : '', follow: true });
    speak(reply.say);
  }

  async function ask(question, extra) {
    setThinking(true);
    emit('ask', { question });
    let reply;
    try {
      reply = await goat.ask(question, extra);
    } catch (err) {
      reply = { error: 'ipc_error', message: String((err && err.message) || err) };
    } finally {
      setThinking(false);
    }
    handleReply(reply || { error: 'empty_reply', message: 'No answer came back.' });
    return reply;
  }

  // ---------- toast ----------
  function toast(text, opts = {}) {
    const t = el('div', `toast${opts.kind ? ` ${opts.kind}` : ''}`, text);
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
    let capture = Boolean(state.panel && state.panel.keyboard);
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
    if (state.panel) closePanel();
    else if (run) stopGuide('escape');
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
    toLocal,
    updateClickThrough,
    setVoice: (on) => {
      state.voice = Boolean(on);
    },
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
