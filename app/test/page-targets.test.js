// The script GOAT runs in a browser page to list its controls, run in a real (headless) Chromium:
// controls inside open shadow roots and same-origin frames are found, at the right place.
// Skipped when Playwright's Chromium isn't installed (npx playwright install chromium).
import assert from 'node:assert/strict';
import test from 'node:test';
import { pageAtJs, PAGE_TARGETS_JS } from '../lib/screen-targets.js';

const PAGE = `<body style="margin:0">
  <button id="plain" style="position:absolute;left:40px;top:30px;width:100px;height:30px">Plain</button>
  <x-box id="host" style="position:absolute;left:200px;top:100px;display:block"></x-box>
  <iframe id="frame" style="position:absolute;left:300px;top:250px;width:300px;height:120px;border:4px solid #000"
    srcdoc="<body style='margin:0'><button style='position:absolute;left:20px;top:10px;width:120px;height:40px'>In frame</button></body>"></iframe>
  <button style="position:absolute;left:40px;top:5000px;width:100px;height:30px">Far below</button>
  <script>
    const root = document.getElementById('host').attachShadow({ mode: 'open' });
    root.innerHTML = '<input placeholder="Enter your search term" style="width:300px;height:40px"><button style="width:60px;height:40px">Search</button><y-box></y-box>';
    root.querySelector('y-box').attachShadow({ mode: 'open' }).innerHTML = '<a href="#x" style="display:inline-block;width:80px;height:20px">Deep link</a>';
  </script>
</body>`;

test('the page script finds controls in shadow roots and same-origin frames, where they are on screen', async (t) => {
  let browser;
  try {
    const { chromium } = await import('playwright');
    browser = await chromium.launch();
  } catch (err) {
    t.skip(`Chromium isn't available: ${String(err.message).split('\n')[0]}`);
    return;
  }
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 600 } });
    await page.setContent(PAGE);
    await page.waitForFunction(() => document.getElementById('frame').contentDocument?.querySelector('button'));
    const read = JSON.parse(await page.evaluate(PAGE_TARGETS_JS));
    const by = Object.fromEntries(read.elements.map((e) => [e.label, e]));
    assert.deepEqual(Object.keys(by).sort(), ['Deep link', 'Enter your search term', 'In frame', 'Plain', 'Search'], 'the control far below the window stays out');
    assert.deepEqual([by.Plain.role, by['Enter your search term'].role, by.Search.role, by['Deep link'].role, by['In frame'].role], ['button', 'field', 'button', 'link', 'button']);

    // Where each control really is, from the page itself, turned into screen points the same way.
    const real = await page.evaluate(() => {
      const zoom = outerWidth / innerWidth;
      const top = screenY + (outerHeight - innerHeight * zoom);
      const left = screenX + (outerWidth - innerWidth * zoom) / 2;
      const host = document.getElementById('host').shadowRoot;
      const frame = document.getElementById('frame');
      const fr = frame.getBoundingClientRect();
      const at = (el, dx = 0, dy = 0) => {
        const r = el.getBoundingClientRect();
        return { x: Math.round(left + (r.left + dx) * zoom), y: Math.round(top + (r.top + dy) * zoom), w: Math.round(r.width * zoom), h: Math.round(r.height * zoom) };
      };
      return {
        zoom,
        top: Math.round(top),
        Plain: at(document.getElementById('plain')),
        'Enter your search term': at(host.querySelector('input')),
        Search: at(host.querySelector('button')),
        'Deep link': at(host.querySelector('y-box').shadowRoot.querySelector('a')),
        'In frame': at(frame.contentDocument.querySelector('button'), fr.left + frame.clientLeft, fr.top + frame.clientTop),
      };
    });
    assert.ok(real.zoom > 0);
    assert.equal(read.top, real.top);
    for (const label of ['Plain', 'Enter your search term', 'Search', 'Deep link', 'In frame']) {
      const { x, y, w, h } = by[label];
      assert.deepEqual({ x, y, w, h }, real[label], label);
    }
    assert.ok(real['In frame'].x >= real.Plain.x + 280 && real['In frame'].y >= real.Plain.y + 230, 'the frame button sits inside the frame, not at the corner of the page');

    // The control under a point, for the recorder: through shadow roots and frames too.
    const under = async (label, dx = 5, dy = 5) => JSON.parse(await page.evaluate(pageAtJs(real[label].x + dx, real[label].y + dy)));
    assert.deepEqual(await under('Search'), { role: 'button', label: 'Search' });
    assert.deepEqual(await under('Deep link'), { role: 'link', label: 'Deep link' });
    assert.deepEqual(await under('In frame'), { role: 'button', label: 'In frame' });
    assert.deepEqual(await under('Plain'), { role: 'button', label: 'Plain' });
    assert.deepEqual(await under('Plain', 400, 300), {}, 'nothing there');
  } finally {
    await browser.close();
  }
});
