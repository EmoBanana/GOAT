// Hold Ctrl+Option+G and drag: highlight part of the screen to scope the ask.
// Global shortcuts only report key-down, so the drag is the "hold" signal: while the ask panel is
// open the backdrop shows a crosshair, and a drag of 6 px or more (before typing) draws the
// rectangle. Letting go locks it and brings the panel back. A plain click still closes the panel.
(function () {
  'use strict';

  const ui = window.GOATUI;
  if (!ui) return;
  const backdrop = document.getElementById('goat-backdrop');
  const panel = document.getElementById('goat-panel');
  const box = ui.el('div', 'hl-rect');
  box.hidden = true;
  document.body.append(box);

  const MIN_DRAG = 6;
  let start = null; // pointer-down point while a drag may begin
  let dragging = false;
  let region = null; // locked rectangle, window coordinates
  let asking = false;
  let swallowClick = false;

  const askOpen = () => {
    const s = ui.state();
    return Boolean(s.panel && s.panel.name === 'ask');
  };
  const typed = () => {
    const input = document.getElementById('goat-ask-input');
    return Boolean(input && input.value.trim());
  };
  const rectFrom = (a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) });

  function draw(r) {
    box.style.left = `${r.x}px`;
    box.style.top = `${r.y}px`;
    box.style.width = `${r.width}px`;
    box.style.height = `${r.height}px`;
    box.hidden = false;
  }

  function clear() {
    region = null;
    start = null;
    dragging = false;
    box.hidden = true;
    box.classList.remove('locked');
    panel.classList.remove('hl-hidden');
  }

  function toScreen(r) {
    const { origin } = ui.state();
    return { x: Math.round(r.x + origin.x), y: Math.round(r.y + origin.y), width: Math.round(r.width), height: Math.round(r.height) };
  }

  backdrop.addEventListener('pointerdown', (e) => {
    // On a Mac, holding Ctrl turns a click into a secondary click; accept both.
    if (!askOpen() || typed() || !(e.button === 0 || (e.button === 2 && e.ctrlKey))) return;
    start = { x: e.clientX, y: e.clientY };
    dragging = false;
    backdrop.setPointerCapture(e.pointerId);
  });

  backdrop.addEventListener('pointermove', (e) => {
    if (!start) return;
    if (!dragging && Math.hypot(e.clientX - start.x, e.clientY - start.y) < MIN_DRAG) return;
    if (!dragging) {
      dragging = true;
      region = null;
      box.classList.remove('locked');
      panel.classList.add('hl-hidden');
      ui.emit('highlight:start', {});
    }
    draw(rectFrom(start, { x: e.clientX, y: e.clientY }));
  });

  backdrop.addEventListener('pointerup', (e) => {
    if (!start) return;
    const wasDragging = dragging;
    const r = rectFrom(start, { x: e.clientX, y: e.clientY });
    start = null;
    dragging = false;
    if (!wasDragging) return; // a plain click: the backdrop closes the panel as usual
    swallowClick = true;
    panel.classList.remove('hl-hidden');
    if (r.width < 8 || r.height < 8) {
      box.hidden = true;
      return;
    }
    region = r;
    draw(r);
    box.classList.add('locked');
    const where = panel.querySelector('.ask-context');
    if (where) {
      where.textContent = 'Asking about the highlighted area';
      where.classList.add('scoped');
    }
    const input = document.getElementById('goat-ask-input');
    if (input) {
      input.placeholder = 'What is this?';
      input.focus();
    }
    ui.emit('highlight:locked', { region: toScreen(r) });
  });

  // The click that ends a drag mustn't close the panel.
  backdrop.addEventListener(
    'click',
    (e) => {
      if (!swallowClick) return;
      swallowClick = false;
      e.stopImmediatePropagation();
    },
    true,
  );
  backdrop.addEventListener('contextmenu', (e) => e.preventDefault());

  // Called on submit, just before the panel closes: from here on the rectangle belongs to the ask.
  ui.addAskExtra(() => {
    if (!region) return null;
    asking = true;
    return { region: toScreen(region) };
  });

  ui.onEvent('panel:open', (m) => backdrop.classList.toggle('crosshair', m.name === 'ask'));
  // Keep the locked rectangle up while GOAT looks at it; drop it on cancel or on the answer.
  // (No timers here: a late timer from one panel once wiped the next panel's drag.)
  ui.onEvent('panel:close', (m) => {
    backdrop.classList.remove('crosshair');
    if (m.name === 'ask' && !asking) clear();
  });
  ui.onEvent('reply', () => {
    asking = false;
    clear();
  });
})();
