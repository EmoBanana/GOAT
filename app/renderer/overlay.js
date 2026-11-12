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
  // A step that asks for a click waits for it: Next stays off, hovering and waiting don't count.
  // A click verb leads a sentence ("Click Filters.", "Then open Issues"); "…or click Search"
  // after typing is not one. step.click (true or false) says so outright.
  const CLICK_STEP = /(?:^|[.!?]\s+|\b(?:then|and|now|first|next|please)\s+)(?:click|double-click|right-click|tap|select|choose|pick|open|hit|toggle|tick)\b/i;
  const CLICK_SLOP = 10; // points around the control that still count
  const CLICK_RADIUS = 36; // around a recorded point, when there's no control to measure
  const CLICK_SETTLE_MS = 450; // the app gets a moment to react before the next step looks for its control
  const isClickStep = (step) => (typeof step?.click === 'boolean' ? step.click : CLICK_STEP.test(String(step?.say || '')));
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
  // While GOAT works, the cursor pulses and a small pill beside it says "Thinking…".
  els.cursor.innerHTML = `${ART.cursorSvg()}<span class="pill" aria-live="polite">Thinking…</span>`;
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
    b.append(el('div', 'text', opts.text || ''));
    if (opts.meta) b.append(el('div', 'meta', opts.meta));
    if (opts.sources) b.append(el('div', 'sources', opts.sources));
    if (opts.step || opts.next) {
      const row = el('div', 'row');
      row.append(el('span', 'step', opts.step ? `Step ${opts.step} of ${opts.total}${opts.nextDisabled ? ' · click it to go on' : ''}` : ''));
      if (opts.next) {
        const next = el('button', 'next', opts.nextLabel || 'Next');
        next.type = 'button';
        next.dataset.action = 'next';
        if (opts.nextDisabled) {
          next.disabled = true;
          next.title = 'Click it on screen to go on';
        }
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

  function waitForAdvance(me, step, click = false) {
    return new Promise((resolve) => {
      let timer = null;
      let poll = null;
      const finish = (how) => {
        clearTimeout(timer);
        clearInterval(poll);
        me.advance = null;
        me.cancel = null;
        resolve(how);
      };
      // A click step moves on only with the user's click on its control (onUserClick).
      if (!click) {
        const waitMs = Number(step.waitMs) > 0 ? Number(step.waitMs) : DEFAULT_WAIT_MS;
        let nearSince = null;
        timer = setTimeout(() => finish('timeout'), waitMs);
        // Hovering the target for 450 ms within 28 px counts as "done".
        poll = setInterval(() => {
          const p = state.sys;
          if (p && Math.hypot(p.x - step.x, p.y - step.y) <= DWELL_RADIUS) {
            nearSince = nearSince ?? performance.now();
            if (performance.now() - nearSince >= DWELL_MS) finish('dwell');
          } else {
            nearSince = null;
          }
        }, 25);
      }
      me.advance = finish;
      me.cancel = () => finish('stopped');
    });
  }

  // Watching the user's clicks (main's click helper), from the guide's first click step to its
  // end. False when it can't (not a Mac, GOAT_CLICK_STEPS=off): steps then move on as before.
  async function watchClicks(me) {
    if (me.watching === undefined) {
      try {
        me.watching = Boolean(goat.watchClicks && (await goat.watchClicks(true)));
      } catch {
        me.watching = false;
      }
    }
    return me.watching;
  }
  // The user clicked at a screen point. On the control a click step points at (or, when it
  // couldn't be found, anywhere but GOAT's own bubble), the guide moves on once the app has
  // had a moment to react, so the next step finds what the click opened.
  function onUserClick(p) {
    const me = run;
    const want = me && me.clickStep;
    if (!want || !me.advance) return;
    const x = Number(p.x);
    const y = Number(p.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const local = toLocal({ x, y });
    const onGoat = document.elementFromPoint(local.x, local.y);
    if (onGoat && onGoat.closest('.interactive')) return;
    const r = want.rect;
    if (r && (x < r.x - CLICK_SLOP || x > r.x + r.w + CLICK_SLOP || y < r.y - CLICK_SLOP || y > r.y + r.h + CLICK_SLOP)) return;
    me.clickStep = null;
    emit('guide:clicked', { id: me.id, index: me.index });
    setTimeout(() => {
      if (run === me && me.advance) me.advance('click');
    }, CLICK_SETTLE_MS);
  }

  function endGuide(me, reason) {
    if (!me || run !== me) return;
    me.stopped = true;
    if (me.cancel) me.cancel();
    if (me.watching && goat.watchClicks) Promise.resolve(goat.watchClicks(false)).catch(() => {});
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
      if (hit && Number.isFinite(hit.x) && Number.isFinite(hit.y)) {
        const w = Number(hit.w) || 0;
        const h = Number(hit.h) || 0;
        return { x: hit.x + w / 2, y: hit.y + h / 2, how: 'live', target, rect: { x: hit.x, y: hit.y, w, h } };
      }
    }
    if (hasPoint(step) && !(target && sampleOnly)) {
      const x = Number(step.x);
      const y = Number(step.y);
      return { x, y, how: 'recorded', target, rect: { x: x - CLICK_RADIUS, y: y - CLICK_RADIUS, w: CLICK_RADIUS * 2, h: CLICK_RADIUS * 2 } };
    }
    return { x: NaN, y: NaN, how: 'none', target, rect: null };
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
      const click = isClickStep(steps[i]) && (await watchClicks(me));
      if (me.stopped) return;
      const found = await locateStep(steps[i], sampleOnly);
      if (me.stopped) return;
      state.guide.located = found.how;
      state.guide.click = click;
      me.clickStep = click ? { rect: found.rect } : null;
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
        nextDisabled: click,
        at: found.how === 'none' ? { x: state.pos.x + 20, y: state.pos.y + 24 } : s,
        onAction: (action) => {
          if (action !== 'next') stopGuide('closed');
          else if (!me.clickStep && me.advance) me.advance('next');
        },
      });
      emit('guide:step', { id: guide.id, index: i, total: steps.length, label: s.label, say: s.say, intro: guide.intro, located: found.how, click });
      const how = await waitForAdvance(me, s, click);
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
  // opts: { name, html, keyboard, focus, onclick, onsubmit, oninput, backdropCloses, onEscape, dock, back }
  // dock: 'right' puts a small card at the bottom right, above the Dock; without the keyboard it
  // has no backdrop, so the apps around it keep working.
  // back: { label, go } puts "← label" on top, for a card opened from another one (the account
  // card's chats, timesheet and wallet go back to it).
  const BACK_ARROW = '<svg viewBox="0 0 14 14" aria-hidden="true"><path d="M12.5 7 H2.5 M6.5 3 L2.5 7 L6.5 11" fill="none" stroke="currentColor" stroke-width="2.2"/></svg>';
  let panelEscape = null;
  // The menu bar and the Dock draw above the overlay; main says how far they reach in.
  function setInsets(insets) {
    const at = insets || {};
    for (const side of ['top', 'right', 'bottom', 'left']) {
      document.documentElement.style.setProperty(`--safe-${side}`, `${Math.max(0, Math.round(Number(at[side]) || 0))}px`);
    }
  }
  function openPanel(opts = {}) {
    closePanel();
    const p = els.panel;
    const keyboard = opts.keyboard !== false;
    panelEscape = opts.onEscape || null;
    p.className = `panel interactive${opts.name ? ` panel-${opts.name}` : ''}${opts.dock === 'right' ? ' dock-right' : ''}`;
    p.innerHTML = opts.html || '';
    const back = opts.back && typeof opts.back.go === 'function' ? opts.back : null;
    if (back) {
      const button = el('button', 'back');
      button.type = 'button';
      button.dataset.back = '';
      button.innerHTML = BACK_ARROW;
      button.append(el('span', '', back.label || 'Back'));
      const row = el('div', 'panel-back');
      row.append(button);
      p.prepend(row);
    }
    placeSaved(p, opts.name);
    p.onclick = back
      ? (event) => (event.target.closest('[data-back]') ? back.go() : opts.onclick && opts.onclick(event))
      : opts.onclick || null;
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
    Object.assign(p.style, { left: '', top: '', right: '', bottom: '', transform: '' });
    els.backdrop.hidden = true;
    els.backdrop.onclick = null;
    panelEscape = null;
    state.panel = null;
    updateClickThrough();
    emit('panel:close', { name });
  }

  // ---------- moving panels ----------
  // Drag a panel by any empty part of it; each panel opens where you last left it.
  const NO_DRAG = 'button, input, textarea, select, a, label, [contenteditable], .thread-turns, .acct-chats, .rec-steps, .ts-acts, .ts-table, .draft-result';
  // Docked cards moved from the top right to the bottom right; they keep their spots under a new
  // key, so one dragged while they docked at the top doesn't hold them there.
  const spotKey = (name, p) => (p && p.classList.contains('dock-right') ? `goat.dock.${name}` : `goat.panel.${name}`);
  function movePanel(p, x, y) {
    const w = p.offsetWidth || 320;
    const left = clamp(Math.round(x), 80 - w, window.innerWidth - 80); // a corner always stays reachable
    const top = clamp(Math.round(y), 32, window.innerHeight - 48); // never under the menu bar
    Object.assign(p.style, { left: `${left}px`, top: `${top}px`, right: 'auto', bottom: 'auto', transform: 'none' });
    p.classList.add('moved');
  }
  function placeSaved(p, name) {
    let spot = null;
    try {
      spot = JSON.parse(localStorage.getItem(spotKey(name, p)) || 'null');
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
        localStorage.setItem(spotKey(drag.name, els.panel), JSON.stringify({ x: r.left, y: r.top }));
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
  // opts.back: opened from the account card, so it docks in that card's place with a way back.
  function openAsk(opts = {}) {
    stopGuide('ask');
    hideBubble();
    if (state.chat && Date.now() - state.chatAt > CHAT_FRESH_MS) setChat(null);
    state.threadOpen = Boolean(opts.showThread);
    const p = openPanel({
      name: 'ask',
      html: ASK_HTML,
      focus: '#goat-ask-input',
      dock: opts.back ? 'right' : undefined,
      back: opts.back,
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

  // The Mac's own voice: it starts at once, and it's what GOAT falls back to.
  // ---------- the words of a spoken answer ----------
  // Words as the server splits them (on whitespace): where each starts in the text, and roughly
  // when it's said, as a share of the whole (its letters, plus a pause after a comma or a full stop).
  function wordOffsets(text) {
    const at = [];
    String(text).replace(/\S+/g, (w, i) => {
      at.push(i);
      return w;
    });
    return at;
  }
  function wordStarts(text) {
    const weights = (String(text).match(/\S+/g) || []).map((w) => w.replace(/[^\p{L}\p{N}]/gu, '').length + 2 + (/[.!?]$/.test(w) ? 5 : /[,;:]$/.test(w) ? 3 : 0));
    const total = weights.reduce((a, b) => a + b, 0) || 1;
    let sum = 0;
    return weights.map((x) => {
      const start = sum / total;
      sum += x;
      return start;
    });
  }
  // The last word that has started by `at` (same units as `starts`).
  function indexAt(starts, at) {
    let i = 0;
    while (i + 1 < starts.length && starts[i + 1] <= at) i += 1;
    return i;
  }
  // Puts the text in as one span per word (spaces kept), for markWords to mark.
  function layWords(container, text) {
    container.replaceChildren();
    const words = [];
    for (const part of String(text).split(/(\s+)/)) {
      if (!part) continue;
      if (/^\s+$/.test(part)) {
        container.append(part);
        continue;
      }
      const w = el('span', 'w', part);
      container.append(w);
      words.push(w);
    }
    return words;
  }
  // Words before `i` are said, word `i` is being said; `i` = words.length: all said.
  function markWords(words, i) {
    words.forEach((w, k) => {
      w.classList.toggle('said', k < i);
      w.classList.toggle('now', k === i);
    });
  }

  function speakWithMac(text, opts) {
    if (!('speechSynthesis' in window)) return false;
    const u = new SpeechSynthesisUtterance(text);
    bestVoice = bestVoice || pickVoice();
    if (bestVoice) u.voice = bestVoice;
    u.rate = 1.05;
    // The word being said: from the voice's own word events, else estimated (about 15 characters
    // a second) from when it started.
    const offsets = wordOffsets(text);
    const starts = wordStarts(text);
    const guessMs = Math.max(1200, ((text.length / 15) * 1000) / u.rate);
    let began = performance.now();
    let byEvents = false;
    let over = false;
    const finish = () => {
      if (over) return;
      over = true;
      if (opts.onWord) opts.onWord(offsets.length);
    };
    u.onstart = () => {
      began = performance.now();
      emit('speak:start', { text, voice: 'system' });
    };
    u.onboundary = (e) => {
      if (over || (e.name && e.name !== 'word')) return;
      byEvents = true;
      if (opts.onWord) opts.onWord(indexAt(offsets, e.charIndex));
    };
    u.onend = () => {
      finish();
      emit('speak:end', { text });
    };
    u.onerror = u.onend;
    try {
      window.speechSynthesis.speak(u);
    } catch {
      return false; // no voice to speak with
    }
    if (opts.onWord) {
      let last = -1;
      const tick = () => {
        if (over) return;
        if (!byEvents) {
          const f = (performance.now() - began) / guessMs;
          if (f >= 1) return finish();
          const i = indexAt(starts, f);
          if (i !== last) opts.onWord((last = i));
        }
        requestAnimationFrame(tick);
      };
      tick();
    }
    return true;
  }

  // GOAT's own voice comes from the server as audio (through main, so this page still makes no
  // requests) and plays through Web Audio.
  let audioCtx = null;
  let speech = null; // the line on its way or playing: { text, node }
  async function decodeClip(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    audioCtx = audioCtx || new AudioContext();
    // A context that isn't allowed to make sound stays suspended: don't wait on it for long.
    await Promise.race([audioCtx.resume(), new Promise((resolve) => setTimeout(resolve, 300))]);
    return audioCtx.state === 'running' ? audioCtx.decodeAudioData(bytes.buffer) : null;
  }

  // Speaks while voice mode is on (opts.force: always, e.g. guide steps of a spoken question):
  // in GOAT's voice when the server has one, else, or if that fails, in the Mac's.
  // opts.onSilent() runs when neither could say it, so the words can be shown instead.
  // opts.onWord(i) says which word is being said (as the text splits on whitespace), and the
  // number of words once it's all said.
  // { buffer, marks }: the audio, and when each word starts (seconds) if the server knows.
  function fetchVoice(text) {
    return Promise.resolve()
      .then(() => goat.speak(text))
      .then(async (reply) => {
        if (!reply || typeof reply.audio !== 'string' || !reply.audio) return null;
        const buffer = await decodeClip(reply.audio);
        const marks = Array.isArray(reply.marks) && reply.marks.every(Number.isFinite) ? reply.marks : null;
        return buffer ? { buffer, marks } : null;
      })
      .catch(() => null);
  }
  // An answer that waits (for a clip to end) gets its voice fetched meanwhile, so it starts at once.
  let prepared = null; // { text, clip: Promise<{ buffer, marks } | null> }
  function prepareSpeech(text) {
    if (goat.speak && text) prepared = { text, clip: fetchVoice(text) };
  }
  function speak(text, opts = {}) {
    if ((!state.voice && !opts.force) || !text) return false;
    silence();
    if (!goat.speak) return speakWithMac(text, opts);
    const mine = (speech = { text, node: null });
    emit('speak:wait', { text });
    const voice = prepared && prepared.text === text ? prepared.clip : fetchVoice(text);
    prepared = null;
    voice.then((got) => {
      if (speech !== mine) return; // stopped meanwhile, or something newer is being said
      if (!got) {
        speech = null;
        emit('speak:end', { text }); // the wait is over; the Mac's voice starts its own turn
        if (!speakWithMac(text, opts) && opts.onSilent) opts.onSilent();
        return;
      }
      const { buffer, marks } = got;
      const count = wordOffsets(text).length;
      const node = audioCtx.createBufferSource();
      node.buffer = buffer;
      node.connect(audioCtx.destination);
      node.onended = () => {
        if (speech !== mine) return;
        speech = null;
        if (opts.onWord) opts.onWord(count);
        emit('speak:end', { text });
      };
      mine.node = node;
      node.start();
      const began = audioCtx.currentTime;
      emit('speak:start', { text, voice: 'elevenlabs', ms: Math.round(buffer.duration * 1000) });
      if (opts.onWord) {
        // The word being said: from the server's timings, else estimated over the clip's length.
        const starts = marks && marks.length === count ? null : wordStarts(text);
        let last = -1;
        const tick = () => {
          if (speech !== mine) return;
          const t = audioCtx.currentTime - began;
          const i = starts ? indexAt(starts, t / buffer.duration) : indexAt(marks, t);
          if (i !== last) opts.onWord((last = i));
          requestAnimationFrame(tick);
        };
        tick();
      }
    });
    return true;
  }
  function silence() {
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    const was = speech;
    speech = null;
    if (!was) return;
    if (was.node) {
      was.node.onended = null;
      try {
        was.node.stop();
      } catch {
        // it had already finished
      }
    }
    emit('speak:end', { text: was.text });
  }
  function stopSpeaking() {
    silence();
    stopClip('cancelled');
  }

  // ---------- clip before a spoken answer ----------
  // "What's MCP?" asked aloud: a short video plays in the middle of a foggy screen while GOAT
  // works out the answer, and the answer is spoken once it ends. A click skips to the answer;
  // talking over it or Esc cancels both; a clip that can't play is skipped at once.
  let shownClip = null; // { finish(how) }

  function playClip(url) {
    stopClip('cancelled');
    return new Promise((resolve) => {
      const layer = el('div', 'clip interactive');
      for (const puff of ['a', 'b', 'c', 'd']) layer.append(el('div', `clip-cloud ${puff}`));
      const frame = el('div', 'clip-frame');
      const video = document.createElement('video');
      video.src = url;
      video.playsInline = true;
      video.preload = 'auto';
      frame.append(video);
      layer.append(frame);
      let timer = null;
      const me = {
        finish(how) {
          if (shownClip !== me) return;
          shownClip = null;
          clearTimeout(timer);
          video.pause();
          layer.classList.add('out');
          setTimeout(() => layer.remove(), 400);
          updateClickThrough();
          emit('clip:end', { how });
          resolve(how);
        },
      };
      shownClip = me;
      video.addEventListener('ended', () => me.finish('ended'));
      video.addEventListener('error', () => me.finish('error'));
      layer.addEventListener('click', () => me.finish('skipped'));
      // Never longer than the clip and a little, even if it stalls; 8 s if it never starts.
      timer = setTimeout(() => me.finish('timeout'), 8000);
      video.addEventListener('loadedmetadata', () => {
        clearTimeout(timer);
        timer = setTimeout(() => me.finish('timeout'), (Number.isFinite(video.duration) ? video.duration : 30) * 1000 + 3000);
      });
      document.body.append(layer);
      updateClickThrough();
      emit('clip:start', { url });
      Promise.resolve()
        .then(() => video.play())
        .catch(() => me.finish('error'));
    });
  }
  function stopClip(how = 'skipped') {
    if (shownClip) shownClip.finish(how);
  }
  // The clip for a spoken question, if this Mac has one: resolves when it's over (how it ended), or null.
  async function clipFor(question) {
    let found = null;
    try {
      found = goat.clipFor ? await goat.clipFor(question) : null;
    } catch {
      found = null;
    }
    return found && typeof found.url === 'string' ? playClip(found.url) : null;
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
    // The answer speaks for itself: web sources are the one footnote worth keeping.
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
    const say = reply.say || '…';
    const inWords = (ms) => showBubble({ kind: 'answer', text: say, sources: hosts.length ? `Sources: ${hosts.join(', ')}` : '', follow: true, ms });
    if (!state.voice) {
      inWords();
      return;
    }
    // Spoken: the answer shows as it's said, with the word being said marked. It stays up while
    // GOAT talks and a few seconds after; if nothing can speak, it stays for a reading time.
    const b = inWords(0);
    const shown = state.bubble;
    const words = layWords(b.querySelector('.text'), say);
    const settle = (ms) => {
      if (state.bubble !== shown) return;
      markWords(words, words.length);
      clearTimeout(bubbleTimer);
      bubbleTimer = setTimeout(hideBubble, ms);
    };
    const said = speak(reply.say, {
      onWord: (i) => {
        if (state.bubble !== shown) return;
        if (i >= words.length) settle(5000);
        else markWords(words, i);
      },
      onSilent: () => settle(readingMs(say)),
    });
    if (!said) settle(readingMs(say));
  }

  async function ask(question, extra) {
    stopClip('cancelled');
    setThinking(true);
    emit('ask', { question });
    // Asked aloud, with a clip of its own ("What's MCP?"): the clip plays while GOAT works.
    const clipOver = extra && extra.voice ? clipFor(question) : null;
    let reply;
    try {
      reply = await goat.ask(question, { ...(extra || {}), chatId: currentChatId() });
    } catch (err) {
      reply = { error: 'ipc_error', message: String((err && err.message) || err) };
    } finally {
      setThinking(false);
    }
    rememberTurn(question, reply);
    if (clipOver) {
      // The answer is spoken once the clip ends; its voice is fetched meanwhile.
      if (reply && !reply.error && reply.source !== 'guide' && state.voice) prepareSpeech(reply.say);
      if ((await clipOver) === 'cancelled') return reply;
    }
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
    toLocal,
    updateClickThrough,
    // Voice turn on/off: while it's on, answers are spoken.
    setVoice: (on) => {
      state.voice = Boolean(on);
    },
    stopSpeaking,
    speechPending: () => Boolean(speech && !speech.node), // GOAT's voice is on its way
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
      else if (message.type === 'origin') {
        state.origin = { x: Number(message.x) || 0, y: Number(message.y) || 0 };
        setInsets(message.insets);
      }
      else if (message.type === 'open-ask') openAsk(message);
      else if (message.type === 'click') onUserClick(message);
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
