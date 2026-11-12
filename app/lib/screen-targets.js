import { execFile } from 'node:child_process';
import { documentKind } from './doc-context.js';

// The controls on screen (buttons, links, tabs, fields) with their labels and exact positions in
// screen points, read live from the app in front. Guides point at a control by name and find it
// again right before each step, so resolution, window size and scrolling never move the cursor
// off target. Browsers: the page lists its own clickable elements (JavaScript from Apple Events,
// the same switch as whole-page reading), and the browser's own toolbar (address bar, back, new
// tab) comes from macOS Accessibility; other apps: Accessibility (AXUIElement) alone.
// Read only while asking or guiding, never stored.
export const MAX_TARGETS = 300;
// A browser's own controls carry this in front of their role ("toolbar textfield"), so the
// planner can tell the address bar from a search box on the page.
export const TOOLBAR = 'toolbar ';
const ROLES = /^(AXButton|AXLink|AXMenuItem|AXMenuButton|AXPopUpButton|AXRadioButton|AXCheckBox|AXTab|AXTextField|AXTextArea|AXComboBox|AXDisclosureTriangle|AXCell)$/;

// Runs in the page: clickable elements, CSS pixels turned into screen points (zoom, window
// position and the browser's toolbars). Checked against macOS Accessibility: within 1 pt.
const PAGE_SETUP = `
  var zoom = window.outerWidth / window.innerWidth;
  var top = window.screenY + (window.outerHeight - window.innerHeight * zoom);
  var left = window.screenX + (window.outerWidth - window.innerWidth * zoom) / 2;
  var SEL = 'a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=tab], [role=menuitem], [role=option], [role=checkbox], [role=switch], [role=combobox], [onclick], [tabindex]:not([tabindex="-1"])';
  function labelOf(el) {
    var root = el.getRootNode ? el.getRootNode() : document;
    var by = (el.getAttribute('aria-labelledby') || '').split(/\\s+/).map(function (id) { var t = id && root.getElementById ? root.getElementById(id) : null; return t ? t.innerText : ''; }).join(' ');
    var aria = el.getAttribute('aria-label') || by;
    var field = /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
    var own = field ? ((el.labels && el.labels[0] && el.labels[0].innerText) || el.getAttribute('placeholder') || el.getAttribute('name') || '') : (el.innerText || el.value || '');
    return String(aria || own || el.getAttribute('title') || el.getAttribute('alt') || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
  }
  function roleOf(el) { return el.getAttribute('role') || (el.tagName === 'A' ? 'link' : el.tagName === 'INPUT' ? 'field' : el.tagName.toLowerCase()); }
  // Every control in the page: the document, the open shadow roots inside it (web components keep
  // their buttons there: Edge's New Tab page has all 16 of its controls in them and none outside)
  // and same-origin frames. dx, dy: where that frame sits in the top window.
  function everyControl(visit) {
    (function into(root, dx, dy, depth) {
      var found = root.querySelectorAll(SEL);
      for (var i = 0; i < found.length; i++) visit(found[i], dx, dy);
      if (depth >= 8) return;
      var all = root.querySelectorAll('*');
      for (var j = 0; j < all.length; j++) {
        var el = all[j];
        if (el.shadowRoot) into(el.shadowRoot, dx, dy, depth + 1);
        else if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
          var doc = null;
          try { doc = el.contentDocument; } catch (e) {}
          if (doc && doc.documentElement) { var fr = el.getBoundingClientRect(); into(doc, dx + fr.left + el.clientLeft, dy + fr.top + el.clientTop, depth + 1); }
        }
      }
    })(document, 0, 0, 0);
  }
`;
export const PAGE_TARGETS_JS = `(function () {${PAGE_SETUP}
  var out = [], seen = {};
  everyControl(function (el, dx, dy) {
    if (out.length >= ${MAX_TARGETS}) return;
    var r = el.getBoundingClientRect(), x = r.left + dx, y = r.top + dy;
    if (r.width < 4 || r.height < 4 || y + r.height < 0 || x + r.width < 0 || y > innerHeight || x > innerWidth) return;
    var st = (el.ownerDocument.defaultView || window).getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) === 0) return;
    var label = labelOf(el);
    if (!label) return;
    var t = { role: roleOf(el), label: label, x: Math.round(left + x * zoom), y: Math.round(top + y * zoom), w: Math.round(r.width * zoom), h: Math.round(r.height * zoom) };
    var key = t.label + '@' + t.x + ',' + t.y;
    if (!seen[key]) { seen[key] = 1; out.push(t); }
  });
  return JSON.stringify({ source: 'page', top: Math.round(top), elements: out });
})()`;
// The control under a screen point: down through shadow roots and same-origin frames to the
// element there, then up (across shadow boundaries) to the nearest control.
export const pageAtJs = (x, y) => `(function () {${PAGE_SETUP}
  var px = (${Number(x)} - left) / zoom, py = (${Number(y)} - top) / zoom;
  var el = document.elementFromPoint(px, py);
  for (var guard = 0; el && guard < 12; guard++) {
    var inner = null;
    if (el.shadowRoot) inner = el.shadowRoot.elementFromPoint(px, py);
    else if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
      try { var doc = el.contentDocument; if (doc) { var fr = el.getBoundingClientRect(); px -= fr.left + el.clientLeft; py -= fr.top + el.clientTop; inner = doc.elementFromPoint(px, py); } } catch (e) {}
    }
    if (!inner || inner === el) break;
    el = inner;
  }
  var hit = null;
  for (var n = el; n && !hit; n = n.parentNode || n.host) if (n.nodeType === 1 && n.matches && n.matches(SEL)) hit = n;
  return JSON.stringify(hit ? { role: roleOf(hit), label: labelOf(hit) } : {});
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
// named: only a real name counts, not the help text (a browser's toolbar has buttons whose only
// text is a sentence of help).
function labelOf(el, role, named) {
  return (str(get(el, 'AXTitle')) || str(get(el, 'AXDescription')) || (/Text|Combo/.test(role) ? str(get(el, 'AXPlaceholderValue')) : '') || (named ? '' : str(get(el, 'AXHelp')))).replace(/\\s+/g, ' ').trim().slice(0, 80);
}
// manual: Electron apps build their tree once AXManualAccessibility is set; a browser is left as it is.
function appFor(pid, manual) {
  var app = $.AXUIElementCreateApplication(pid);
  if (manual) $.AXUIElementSetAttributeValue(app, $('AXManualAccessibility'), $.NSNumber.numberWithBool(true));
  return app;
}
// The running app with this name (when its pid isn't known).
function pidOf(name) {
  ObjC.import('AppKit');
  var apps = $.NSWorkspace.sharedWorkspace.runningApplications;
  for (var i = 0; i < apps.count; i++) {
    var a = apps.objectAtIndex(i);
    if (ObjC.unwrap(a.localizedName) === name && Number(a.activationPolicy) === 0) return Number(a.processIdentifier);
  }
  return 0;
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
// argv: pid, then for a browser's own toolbar 'toolbar' and the browser's name (used when the pid
// isn't known). The toolbar read leaves out the page (the page lists its own controls), the tabs
// (their names are the user's open pages) and the bookmarks.
const AX_TARGETS = `${AX_SETUP}
function run(argv) {
  var bar = argv[1] === 'toolbar';
  var pid = Number(argv[0]) || (argv[2] ? pidOf(argv[2]) : 0);
  if (!pid) return JSON.stringify({ error: 'no_window' });
  var app = appFor(pid, !bar);
  var win = windowOf(app);
  if (!win) return JSON.stringify({ error: 'no_window' });
  var out = [], visited = 0;
  function walk(el, depth) {
    if (!el || depth > 40 || visited > 5000 || out.length >= ${MAX_TARGETS}) return;
    visited++;
    var role = str(get(el, 'AXRole'));
    if (bar) {
      if (role === 'AXWebArea') return;
      if (/Group|Toolbar|List|Outline/.test(role) && /bookmark|favou?rite/i.test(str(get(el, 'AXTitle')) + ' ' + str(get(el, 'AXDescription')))) return;
    }
    if (${ROLES}.test(role) && !(bar && /^AX(RadioButton|Tab)$/.test(role))) {
      var label = labelOf(el, role, bar);
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
  var pid = Number(argv[0]) || (argv[3] ? pidOf(argv[3]) : 0);
  if (!pid) return '{}';
  var app = appFor(pid, !argv[3]);
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

// One read: { source, top?, elements } | { error }.
async function readWith(run, script, args, timeoutMs) {
  let raw;
  try {
    raw = JSON.parse(await run(script, args, timeoutMs));
  } catch (err) {
    return { error: /not authori[sz]ed|-1743/i.test(String(err?.message)) ? 'not_allowed' : 'unavailable' };
  }
  if (!raw || raw.error) return { error: raw?.error || 'unavailable' };
  return { source: raw.source, top: Number.isFinite(Number(raw.top)) ? Number(raw.top) : null, elements: cleanTargets(raw.elements) };
}

// { source, elements, pageError? } | { error } | null. pid: the app's process (for Accessibility).
// A browser gives its page's controls and then its own toolbar's (role "toolbar …"); when the
// page can't be read, the toolbar alone comes back with pageError saying why.
// GOAT_FAKE_TARGETS (JSON { elements }) stands in for the screen in tests, and nothing real is
// read while GOAT_FAKE_WINDOW fakes the front window.
export async function readTargets({ app, pid, env = process.env, run = runJxa, timeoutMs = 5000 } = {}) {
  if ('GOAT_FAKE_TARGETS' in env) {
    const fake = fakeTargets(env);
    return fake ? { source: 'fake', elements: cleanTargets(fake.elements) } : null;
  }
  if (env.GOAT_FAKE_WINDOW || !app) return null;
  if (documentKind(app) !== 'page') {
    if (!(pid > 0)) return null;
    const read = await readWith(run, AX_TARGETS, [pid], timeoutMs);
    return read.error ? read : { source: read.source, elements: read.elements };
  }
  const [page, bar] = await Promise.all([
    readWith(run, app === 'Safari' ? SAFARI_RUN(PAGE_TARGETS_JS) : CHROMIUM_RUN(PAGE_TARGETS_JS), app === 'Safari' ? [] : [app], timeoutMs),
    readWith(run, AX_TARGETS, [pid > 0 ? pid : 0, 'toolbar', app], Math.min(timeoutMs, 2500)),
  ]);
  // The toolbar is what sits above the page; anything lower is the page's own (when the browser
  // also exposes the page to Accessibility, the page has listed it already).
  const toolbar = (bar.elements || []).filter((t) => page.top == null || t.y + t.h / 2 < page.top).map((t) => ({ ...t, role: `${TOOLBAR}${t.role}`.slice(0, 20) }));
  if (page.error) return toolbar.length ? { source: 'ax', elements: toolbar, pageError: page.error } : { error: page.error };
  return { source: 'page', elements: [...page.elements.slice(0, MAX_TARGETS - toolbar.length), ...toolbar] };
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
  const named = (raw, prefix = '') => (raw && typeof raw.label === 'string' && raw.label ? { role: `${prefix}${String(raw.role || '')}`.slice(0, 20), label: raw.label.slice(0, 80) } : null);
  const ask = async (script, args) => {
    try {
      return JSON.parse(await run(script, args, timeoutMs));
    } catch {
      return null;
    }
  };
  if (!browser) return named(await ask(AX_AT, [pid, x, y]));
  // In a browser: the page's control there, else (above the page) the browser's own.
  return named(await ask(app === 'Safari' ? SAFARI_RUN(pageAtJs(x, y)) : CHROMIUM_RUN(pageAtJs(x, y)), app === 'Safari' ? [] : [app])) || named(await ask(AX_AT, [pid > 0 ? pid : 0, x, y, app]), TOOLBAR);
}
