// The blue cursor: a classic arrow pointer in a 24x24 box with its tip at (3, 2).
// Classic script (also loaded by scripts/make-icons.js to render the tray icon).
(function (root) {
  'use strict';

  const SIZE = 24;
  const TIP = { x: 3, y: 2 };
  const ARROW = 'M3 2 L3 19 L7 15 L10 21.5 L12.8 20.3 L9.9 14 L15.5 14 Z';

  function cursorSvg({ fill = '#2563eb', stroke = '#ffffff', strokeWidth = 1.5, size = SIZE, viewBox = `0 0 ${SIZE} ${SIZE}` } = {}) {
    const outline = stroke ? ` stroke="${stroke}" stroke-width="${strokeWidth}" stroke-linejoin="round"` : '';
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${viewBox}" aria-hidden="true">` +
      `<path d="${ARROW}" fill="${fill}"${outline}/></svg>`
    );
  }

  root.GOATArt = { SIZE, TIP, ARROW, cursorSvg };
})(typeof window !== 'undefined' ? window : globalThis);
