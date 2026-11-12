// Renders the tray icons from the cursor SVG. Run once after changing the art:
//   node scripts/make-icons.js
// The PNGs are committed, so the app never needs Playwright at runtime.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = path.join(root, 'app', 'assets');
fs.mkdirSync(outDir, { recursive: true });
const art = fs.readFileSync(path.join(root, 'app', 'renderer', 'cursor-art.js'), 'utf8');

// macOS template images are black plus alpha, and macOS tints them for light and dark menu bars.
// Windows shows its tray icon as it is, so it gets the blue cursor with its white outline.
const template = { fill: '#000000', stroke: '', size: 18, viewBox: '-1.25 1.25 21 21' };
const blue = { fill: '#2563eb', stroke: '#ffffff', strokeWidth: 1.5, size: 16, viewBox: '-1.5 1 22 22' };
const ICONS = [
  { name: 'trayTemplate.png', scale: 1, options: template },
  { name: 'trayTemplate@2x.png', scale: 2, options: template },
  { name: 'tray.png', scale: 1, options: blue },
  { name: 'tray@2x.png', scale: 2, options: blue },
];

const browser = await chromium.launch();
try {
  for (const { name, scale, options } of ICONS) {
    const page = await browser.newPage({ viewport: { width: options.size, height: options.size }, deviceScaleFactor: scale });
    await page.setContent('<!doctype html><html><body style="margin:0;background:transparent"></body></html>');
    await page.addScriptTag({ content: art });
    await page.evaluate((opts) => {
      document.body.innerHTML = window.GOATArt.cursorSvg(opts);
    }, options);
    await page.screenshot({ path: path.join(outDir, name), omitBackground: true, clip: { x: 0, y: 0, width: options.size, height: options.size } });
    await page.close();
  }
} finally {
  await browser.close();
}
console.log(`Wrote ${ICONS.map((i) => `app/assets/${i.name}`).join(', ')}`);
