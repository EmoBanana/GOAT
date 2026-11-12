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

// The cursor is GOAT's kopitiam cup. macOS template images are one colour plus alpha, and macOS
// tints them for light and dark menu bars; Windows shows its tray icon as it is, so it gets the
// cup in colour. The viewBox frames the cup (steam to shadow) in its 28-unit box.
const CUP_BOX = '1.6 0.6 26.4 26.4';
const template = { mono: '#000000', size: 18, viewBox: CUP_BOX };
const colour = { size: 16, viewBox: CUP_BOX };
const ICONS = [
  { name: 'trayTemplate.png', scale: 1, options: template },
  { name: 'trayTemplate@2x.png', scale: 2, options: template },
  { name: 'tray.png', scale: 1, options: colour },
  { name: 'tray@2x.png', scale: 2, options: colour },
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
