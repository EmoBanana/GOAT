import { execFile } from 'node:child_process';
import { documentKind } from './doc-context.js';

// The controls on screen (buttons, links, tabs, fields) with their labels and exact positions in
// screen points, read live from the app in front. Guides point at a control by name and find it
// again right before each step, so resolution, window size and scrolling never move the cursor
// off target. Browsers: the page lists its own clickable elements (JavaScript from Apple Events,
// the same switch as whole-page reading); other apps: macOS Accessibility (AXUIElement).
// Read only while asking or guiding, never stored.
export const MAX_TARGETS = 300;
const ROLES = /^(AXButton|AXLink|AXMenuItem|AXMenuButton|AXPopUpButton|AXRadioButton|AXCheckBox|AXTab|AXTextField|AXTextArea|AXComboBox|AXDisclosureTriangle|AXCell)$/;

// Runs in the page: clickable elements, CSS pixels turned into screen points (zoom, window
// position and the browser's toolbars). Checked against macOS Accessibility: within 1 pt.
const PAGE_SETUP = `
  var zoom = window.outerWidth / window.innerWidth;
  var top = window.screenY + (window.outerHeight - window.innerHeight * zoom);
  var left = window.screenX + (window.outerWidth - window.innerWidth * zoom) / 2;
  var SEL = 'a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=tab], [role=menuitem], [role=option], [role=checkbox], [role=switch], [role=combobox], [onclick], [tabindex]:not([tabindex="-1"])';
  function labelOf(el) {
    var by = (el.getAttribute('aria-labelledby') || '').split(/\\s+/).map(function (id) { var t = id && document.getElementById(id); return t ? t.innerText : ''; }).join(' ');
    var aria = el.getAttribute('aria-label') || by;
    var field = /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
    var own = field ? ((el.labels && el.labels[0] && el.labels[0].innerText) || el.getAttribute('placeholder') || el.getAttribute('name') || '') : (el.innerText || el.value || '');
    return String(aria || own || el.getAttribute('title') || el.getAttribute('alt') || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
  }
  function roleOf(el) { return el.getAttribute('role') || (el.tagName === 'A' ? 'link' : el.tagName === 'INPUT' ? 'field' : el.tagName.toLowerCase()); }
`;
export const PAGE_TARGETS_JS = `(function () {${PAGE_SETUP}
  var out = [], seen = {};
  var all = document.querySelectorAll(SEL);
  for (var i = 0; i < all.length && out.length < ${MAX_TARGETS}; i++) {
    var el = all[i], r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4 || r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) continue;
    var st = getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) === 0) continue;
    var label = labelOf(el);
    if (!label) continue;
    var t = { role: roleOf(el), label: label, x: Math.round(left + r.left * zoom), y: Math.round(top + r.top * zoom), w: Math.round(r.width * zoom), h: Math.round(r.height * zoom) };
    var key = t.label + '@' + t.x + ',' + t.y;
    if (!seen[key]) { seen[key] = 1; out.push(t); }
  }
  return JSON.stringify({ source: 'page', elements: out });
})()`;
const pageAtJs = (x, y) => `(function () {${PAGE_SETUP}
  var el = document.elementFromPoint((${Number(x)} - left) / zoom, (${Number(y)} - top) / zoom);
  el = el && el.closest(SEL);
  return JSON.stringify(el ? { role: roleOf(el), label: labelOf(el) } : {});
})()`;

const CHROMIUM_RUN = (js) => `function run(argv) {
  var b = Application(argv[0]);
  if (b.windows.length === 0) return JSON.stringify({ error: 'no_window' });
  try { return b.windows[0].activeTab().execute({ javascript: ${JSON.stringify(js)} }); }
  catch (e) { return JSON.stringify({ error: /JavaScript/i.test(String(e)) ? 'js_off' : 'unavailable' }); }
}`;
const SAFARI_RUN = (js) => `function run() {
  var s = Application('Safari');
  if (s.documents.length === 0) return JSON.stringify({ error: 'no_window' });
  try { return s.doJavaScript(${JSON.stringify(js)}, { in: s.documents[0] }); }
  catch (e) { return JSON.stringify({ error: /JavaScript/i.test(String(e)) ? 'js_off' : 'unavailable' }); }
}`;

// macOS Accessibility through JXA. The AX functions have no bridge metadata, so their signatures
// are declared with ObjC.bindFunction. Positions come back as AXValues, read from their
// description. Electron apps build their tree once AXManualAccessibility is set.
const AX_SETUP = `ObjC.import('ApplicationServices');
ObjC.import('Foundation');
ObjC.bindFunction('AXUIElementCreateApplication', ['id', ['int']]);
ObjC.bindFunction('AXUIElementCopyAttributeValue', ['int', ['id', 'id', 'id*']]);
ObjC.bindFunction('AXUIElementSetAttributeValue', ['int', ['id', 'id', 'id']]);
ObjC.bindFunction('AXUIElementCopyElementAtPosition', ['int', ['id', 'float', 'float', 'id*']]);
ObjC.bindFunction('CFCopyDescription', ['id', ['id']]);
function get(el, name) { var r = Ref(); return $.AXUIElementCopyAttributeValue(el, $(name), r) === 0 ? r[0] : null; }
function str(v) { if (!v) return ''; try { var u = ObjC.unwrap(v); return typeof u === 'string' ? u : ''; } catch (e) { return ''; } }
function pair(v, a, b) {
  if (!v) return null;
  var m = new RegExp(a + ':(-?[\\\\d.]+) ' + b + ':(-?[\\\\d.]+)').exec(String(ObjC.unwrap($.CFCopyDescription(v))));
  return m ? [Number(m[1]), Number(m[2])] : null;
}
function labelOf(el, role) {
  return (str(get(el, 'AXTitle')) || str(get(el, 'AXDescription')) || (/Text|Combo/.test(role) ? str(get(el, 'AXPlaceholderValue')) : '') || str(get(el, 'AXHelp'))).replace(/\\s+/g, ' ').trim().slice(0, 80);
}
function appFor(pid) {
  var app = $.AXUIElementCreateApplication(pid);
  $.AXUIElementSetAttributeValue(app, $('AXManualAccessibility'), $.NSNumber.numberWithBool(true));
  return app;
}
// The app's front window. For an app that isn't active, AXFocusedWindow and AXMainWindow can
// hand back the application itself, so the first element whose role really is AXWindow wins.
function windowOf(app) {
  var list = [get(app, 'AXFocusedWindow'), get(app, 'AXMainWindow')];
  var all = get(app, 'AXWindows');
  if (all) for (var i = 0; i < Number(all.count); i++) list.push(all.objectAtIndex(i));
  for (var j = 0; j < list.length; j++) if (list[j] && str(get(list[j], 'AXRole')) === 'AXWindow') return list[j];
  return null;
}`;
const AX_TARGETS = `${AX_SETUP}
function run(argv) {
  var app = appFor(Number(argv[0]));
  var win = windowOf(app);
  if (!win) return JSON.stringify({ error: 'no_window' });
  var out = [], visited = 0;
  function walk(el, depth) {
    if (!el || depth > 40 || visited > 5000 || out.length >= ${MAX_TARGETS}) return;
    visited++;
    var role = str(get(el, 'AXRole'));
    if (${ROLES}.test(role)) {
      var label = labelOf(el, role);
      if (label) {
        var p = pair(get(el, 'AXPosition'), 'x', 'y'), s = pair(get(el, 'AXSize'), 'w', 'h');
        if (p && s && s[0] >= 4 && s[1] >= 4) out.push({ role: role.slice(2).toLowerCase(), label: label, x: Math.round(p[0]), y: Math.round(p[1]), w: Math.round(s[0]), h: Math.round(s[1]) });
      }
    }
    var kids = get(el, 'AXChildren');
    if (kids) { var n = kids.count; for (var i = 0; i < n; i++) walk(kids.objectAtIndex(i), depth + 1); }
  }
  walk(win, 0);
  return JSON.stringify({ source: 'ax', elements: out });
}`;
const AX_AT = `${AX_SETUP}
function run(argv) {
  var app = appFor(Number(argv[0]));
  var r = Ref();
  if ($.AXUIElementCopyElementAtPosition(app, Number(argv[1]), Number(argv[2]), r) !== 0) return '{}';
  var el = r[0];
  for (var i = 0; el && i < 6; i++) {
    var role = str(get(el, 'AXRole'));
    var label = labelOf(el, role);
    if (label && ${ROLES}.test(role)) return JSON.stringify({ role: role.slice(2).toLowerCase(), label: label });
    el = get(el, 'AXParent');
  }
  return '{}';
}`;

function runJxa(script, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-l', 'JavaScript', '-e', script, ...args.map(String)], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).trim().slice(0, 300)));
      else resolve(String(stdout).trim());
    });
  });
}

const num = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);
export function cleanTargets(list) {
  const out = [];
  for (const t of Array.isArray(list) ? list : []) {
    const label = typeof t?.label === 'string' ? t.label.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
    const [x, y, w, h] = [num(t?.x), num(t?.y), num(t?.w), num(t?.h)];
    if (!label || x === null || y === null || !(w > 0) || !(h > 0)) continue;
    out.push({ role: typeof t.role === 'string' ? t.role.slice(0, 20) : '', label, x, y, w, h });
    if (out.length >= MAX_TARGETS) break;
  }
  return out;
}

// Words of a label: lowercase, no punctuation (icons like "⊕" drop out).
const words = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// The control best matching a name: exact, then the same words, then one name inside the other,
// then most shared words (at least two thirds of the name's). Ties go to the first on screen.
export function findTarget(targets, name, role = '') {
  const want = words(name);
  if (!want) return null;
  const wantWords = want.split(' ');
  let best = null;
  for (const t of targets || []) {
    const have = words(t.label);
    if (!have) continue;
    let score = 0;
    if (t.label === name) score = 100;
    else if (have === want) score = 90;
    else if (have.startsWith(`${want} `) || want.startsWith(`${have} `)) score = 70;
    else if (` ${have} `.includes(` ${want} `) || ` ${want} `.includes(` ${have} `)) score = 60;
    else {
      const haveWords = new Set(have.split(' '));
      const shared = wantWords.filter((w) => haveWords.has(w)).length;
      if (shared / wantWords.length >= 2 / 3) score = 40 * (shared / wantWords.length);
    }
    if (score && role && t.role === role) score += 5;
    if (score > (best?.score || 0)) best = { score, target: t };
  }
  return best ? best.target : null;
}

export const centre = (t) => ({ x: Math.round(t.x + t.w / 2), y: Math.round(t.y + t.h / 2) });

function fakeTargets(env) {
  try {
    return JSON.parse(env.GOAT_FAKE_TARGETS);
  } catch {
    return null;
  }
}

// { source, elements } | { error } | null. pid: the app's process (for Accessibility).
// GOAT_FAKE_TARGETS (JSON { elements }) stands in for the screen in tests, and nothing real is
// read while GOAT_FAKE_WINDOW fakes the front window.
export async function readTargets({ app, pid, env = process.env, run = runJxa, timeoutMs = 5000 } = {}) {
  if ('GOAT_FAKE_TARGETS' in env) {
    const fake = fakeTargets(env);
    return fake ? { source: 'fake', elements: cleanTargets(fake.elements) } : null;
  }
  if (env.GOAT_FAKE_WINDOW || !app) return null;
  const browser = documentKind(app) === 'page';
  if (!browser && !(pid > 0)) return null;
  let raw;
  try {
    const script = browser ? (app === 'Safari' ? SAFARI_RUN(PAGE_TARGETS_JS) : CHROMIUM_RUN(PAGE_TARGETS_JS)) : AX_TARGETS;
    raw = JSON.parse(await run(script, browser ? (app === 'Safari' ? [] : [app]) : [pid], timeoutMs));
  } catch (err) {
    return { error: /not authori[sz]ed|-1743/i.test(String(err?.message)) ? 'not_allowed' : 'unavailable' };
  }
  if (!raw || raw.error) return { error: raw?.error || 'unavailable' };
  return { source: raw.source, elements: cleanTargets(raw.elements) };
}

// The control under a screen point, for the recorder: { role, label } or null.
export async function targetAt({ app, pid, x, y, env = process.env, run = runJxa, timeoutMs = 3000 } = {}) {
  if ('GOAT_FAKE_TARGETS' in env) {
    const hit = cleanTargets(fakeTargets(env)?.elements).find((t) => x >= t.x && x <= t.x + t.w && y >= t.y && y <= t.y + t.h);
    return hit ? { role: hit.role, label: hit.label } : null;
  }
  if (env.GOAT_FAKE_WINDOW || !app) return null;
  const browser = documentKind(app) === 'page';
  if (!browser && !(pid > 0)) return null;
  try {
    const script = browser ? (app === 'Safari' ? SAFARI_RUN(pageAtJs(x, y)) : CHROMIUM_RUN(pageAtJs(x, y))) : AX_AT;
    const raw = JSON.parse(await run(script, browser ? (app === 'Safari' ? [] : [app]) : [pid, x, y], timeoutMs));
    return raw && typeof raw.label === 'string' && raw.label ? { role: String(raw.role || '').slice(0, 20), label: raw.label.slice(0, 80) } : null;
  } catch {
    return null;
  }
}
