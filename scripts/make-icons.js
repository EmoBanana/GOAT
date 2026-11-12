// Renders the macOS tray template icons from the cursor SVG. Run once after changing the art:
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

const browser = await chromium.launch();
try {
  for (const [scale, name] of [
    [1, 'trayTemplate.png'],
    [2, 'trayTemplate@2x.png'],
  ]) {
    const page = await browser.newPage({ viewport: { width: 18, height: 18 }, deviceScaleFactor: scale });
    await page.setContent('<!doctype html><html><body style="margin:0;background:transparent"></body></html>');
    await page.addScriptTag({ content: art });
    // Template images are black plus alpha; macOS tints them for light and dark menu bars.
    await page.evaluate(() => {
      document.body.innerHTML = window.GOATArt.cursorSvg({ fill: '#000000', stroke: '', size: 18, viewBox: '-1.25 1.25 21 21' });
    });
    await page.screenshot({ path: path.join(outDir, name), omitBackground: true, clip: { x: 0, y: 0, width: 18, height: 18 } });
    await page.close();
  }
} finally {
  await browser.close();
}
console.log('Wrote app/assets/trayTemplate.png and app/assets/trayTemplate@2x.png');
