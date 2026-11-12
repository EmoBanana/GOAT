// The cursor: GOAT's kopitiam cup, the app icon's cup drawn small (no saucer or tile). It points
// with the left edge of its rim (TIP), so the cup sits just below-right of where it points and
// guides land the rim on the target. Classic script (also loaded by scripts/make-icons.js).
(function (root) {
  'use strict';

  const SIZE = 28;
  const TIP = { x: 3, y: 9 };
  // The cup in the icon's units (app/assets/icon.svg); the rim's left edge is at (14, 21).
  const SCALE = 0.58;
  const CUP = {
    body: 'M14 21 L17.5 40 Q18.5 44 23 44 L37 44 Q41.5 44 42.5 40 L46 21 Z',
    handle: 'M44.6 25.5 C53 24.5 54.5 36.5 43.4 35.8',
    band: 'M15.9 25.4 L44.1 25.4 L43.55 28.6 L16.45 28.6 Z',
    steam: 'M25 15.5 c-2.6 -2.6 2.6 -4.6 0 -7.6 M33.5 15.5 c-2.6 -2.6 2.6 -4.6 0 -7.6',
  };

  // Full colour (white cup, green band, kopi, black outline and hard shadow), or one colour for
  // a silhouette: `mono`, or the older { fill, no stroke } that macOS template icons use.
  function cursorSvg({ size = SIZE, viewBox = `0 0 ${SIZE} ${SIZE}`, mono = '', fill = '', stroke } = {}) {
    const one = mono || (fill && !stroke ? fill : '');
    const ink = one || '#0a0a0a';
    const parts = one
      ? [
          `<path d="${CUP.handle}" fill="none" stroke="${ink}" stroke-width="6.6"/>`,
          `<path d="${CUP.body}" fill="${ink}" stroke="${ink}" stroke-width="2.4"/>`,
          `<ellipse cx="30" cy="21" rx="16" ry="3.6" fill="${ink}" stroke="${ink}" stroke-width="2.4"/>`,
          `<path d="${CUP.steam}" fill="none" stroke="${ink}" stroke-width="2.6"/>`,
        ]
      : [
          // the hard shadow, then the cup; white edges keep the steam and outline legible on dark apps
          `<g transform="translate(2.4 2.4)" fill="${ink}" stroke="${ink}" stroke-width="2.4"><path d="${CUP.body}"/><path d="${CUP.handle}" fill="none" stroke-width="5"/></g>`,
          `<path d="${CUP.handle}" fill="none" stroke="${ink}" stroke-width="6.6"/>`,
          `<path d="${CUP.handle}" fill="none" stroke="#ffffff" stroke-width="2.6"/>`,
          `<path d="${CUP.body}" fill="#ffffff"/>`,
          `<path d="${CUP.band}" fill="#1f7a4d"/>`,
          `<path d="${CUP.body}" fill="none" stroke="${ink}" stroke-width="2.4"/>`,
          `<ellipse cx="30" cy="21" rx="16" ry="3.6" fill="#ffffff" stroke="${ink}" stroke-width="2.4"/>`,
          `<ellipse cx="30" cy="21.3" rx="13.1" ry="2.3" fill="#6b3f1d"/>`,
          `<path d="${CUP.steam}" fill="none" stroke="#ffffff" stroke-width="4.6"/>`,
          `<path d="${CUP.steam}" fill="none" stroke="${ink}" stroke-width="2.4"/>`,
        ];
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${viewBox}" aria-hidden="true">` +
      `<g transform="translate(${TIP.x} ${TIP.y}) scale(${SCALE}) translate(-14 -21)" stroke-linejoin="round" stroke-linecap="round">${parts.join('')}</g></svg>`
    );
  }

  root.GOATArt = { SIZE, TIP, CUP, cursorSvg };
})(typeof window !== 'undefined' ? window : globalThis);
