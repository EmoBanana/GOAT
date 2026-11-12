import { execFile } from 'node:child_process';

// The whole deck or page in front, read when you ask, so GOAT can answer about all of it and not
// just what's on screen: every slide of a Keynote deck (text and presenter notes), or the text of
// the page in Chrome, Edge, Brave, Arc or Safari. Only the frontmost app, only on ask, never
// stored. macOS asks once to let GOAT control the app (Automation); browsers also need "Allow
// JavaScript from Apple Events" switched on.
export const MAX_TEXT = 9000;
const CHROMIUM = ['Google Chrome', 'Microsoft Edge', 'Brave Browser', 'Arc', 'Chromium'];

export function documentKind(app) {
  if (app === 'Keynote') return 'deck';
  if (CHROMIUM.includes(app) || app === 'Safari') return 'page';
  return null;
}

// Keynote: one Apple event per property across all slides where it can, slide by slide where a
// slide has no title or body placeholder.
const KEYNOTE_JXA = `function run() {
  var k = Application('Keynote');
  if (!k.running() || k.documents.length === 0) return JSON.stringify({ error: 'no_document' });
  var d = k.documents[0];
  var n = Math.min(d.slides.length, 150);
  var current = 0;
  try { current = d.currentSlide().slideNumber(); } catch (e) {}
  function all(fn) { try { return fn(); } catch (e) { return null; } }
  var titles = all(function () { return d.slides.defaultTitleItem.objectText(); });
  var bodies = all(function () { return d.slides.defaultBodyItem.objectText(); });
  var items = all(function () { return d.slides.textItems.objectText(); });
  var notes = all(function () { return d.slides.presenterNotes(); });
  var skipped = all(function () { return d.slides.skipped(); });
  var slides = [];
  for (var i = 0; i < n; i++) {
    var s = d.slides[i];
    slides.push({
      title: titles ? titles[i] : all(function () { return s.defaultTitleItem().objectText(); }) || '',
      body: bodies ? bodies[i] : all(function () { return s.defaultBodyItem().objectText(); }) || '',
      texts: items ? items[i] : all(function () { return s.textItems.objectText(); }) || [],
      notes: notes ? notes[i] : all(function () { return s.presenterNotes(); }) || '',
      skipped: skipped ? skipped[i] : false
    });
  }
  return JSON.stringify({ title: d.name(), current: current, total: d.slides.length, slides: slides });
}`;

const JS = "document.body ? document.body.innerText : ''";
const CHROMIUM_JXA = `function run(argv) {
  var b = Application(argv[0]);
  if (b.windows.length === 0) return JSON.stringify({ error: 'no_document' });
  var tab = b.windows[0].activeTab();
  var out = { title: tab.title(), url: tab.url() };
  try { out.text = tab.execute({ javascript: ${JSON.stringify(JS)} }); }
  catch (e) { out.error = /JavaScript/i.test(String(e)) ? 'js_off' : 'unavailable'; }
  return JSON.stringify(out);
}`;
const SAFARI_JXA = `function run() {
  var s = Application('Safari');
  if (s.documents.length === 0) return JSON.stringify({ error: 'no_document' });
  var d = s.documents[0];
  var out = { title: d.name(), url: d.url() };
  try { out.text = s.doJavaScript(${JSON.stringify(JS)}, { in: d }); }
  catch (e) { out.error = /JavaScript/i.test(String(e)) ? 'js_off' : 'unavailable'; }
  return JSON.stringify(out);
}`;

function runJxa(script, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-l', 'JavaScript', '-e', script, ...args], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).trim().slice(0, 300)));
      else resolve(String(stdout).trim());
    });
  });
}

const tidy = (text) =>
  String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

function stripQuery(url) {
  try {
    const u = new URL(url);
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return String(url || '').split(/[?#]/)[0];
  }
}

// Slides as text, the one on screen marked. Over the limit, the slides furthest from the one on
// screen go first.
export function deckText(slides, current = 0, max = MAX_TEXT) {
  const blocks = slides.map((s, i) => {
    const n = i + 1;
    const title = tidy(s.title);
    const lines = [s.body, ...(Array.isArray(s.texts) ? s.texts : [])].map(tidy).filter((t) => t && t !== title);
    const unique = [...new Set(lines)];
    const head = `Slide ${n}${n === current ? ' (on screen)' : ''}${s.skipped ? ' (skipped)' : ''}${title ? `: ${title}` : ''}`;
    const notes = tidy(s.notes);
    return { n, text: [head, ...unique, notes && `Notes: ${notes}`].filter(Boolean).join('\n') };
  });
  const keep = [...blocks];
  const size = () => keep.reduce((sum, b) => sum + b.text.length + 2, 0);
  while (keep.length > 1 && size() > max) {
    const far = keep.reduce((a, b) => (Math.abs(b.n - current) >= Math.abs(a.n - current) ? b : a));
    keep.splice(keep.indexOf(far), 1);
  }
  return keep.map((b) => b.text).join('\n\n').slice(0, max);
}

export function deckDocument(raw, app = 'Keynote') {
  const slides = Array.isArray(raw?.slides) ? raw.slides : [];
  const current = Number.isInteger(raw?.current) && raw.current > 0 ? raw.current : null;
  return { kind: 'deck', app, title: tidy(raw?.title).slice(0, 200), slides: Number(raw?.total) || slides.length, current, text: deckText(slides, current || 0) };
}

export function pageDocument(raw, app) {
  return { kind: 'page', app, title: tidy(raw?.title).slice(0, 200), url: stripQuery(raw?.url), text: tidy(raw?.text).slice(0, MAX_TEXT) };
}

// What to tell the user when GOAT can't read the document (shown once per app).
export function documentHint(result) {
  if (!result || !result.error) return '';
  const app = result.app || 'the app';
  if (result.error === 'not_allowed') return `To let GOAT read the whole ${result.kind === 'deck' ? 'deck' : 'page'}, allow it to control ${app} in System Settings › Privacy & Security › Automation.`;
  if (result.error === 'js_off') {
    return app === 'Safari'
      ? 'To let GOAT read whole pages in Safari, turn on Develop › Allow JavaScript from Apple Events.'
      : `To let GOAT read whole pages in ${app}, turn on View › Developer › Allow JavaScript from Apple Events.`;
  }
  return '';
}

// { kind, app, title, url?, slides?, current?, text } | { kind, app, error } | null.
// GOAT_FAKE_DOC (JSON, or empty for none) stands in for the real app in tests, and nothing real is
// read while GOAT_FAKE_WINDOW fakes the frontmost window.
export async function readDocument({ app, env = process.env, run = runJxa, timeoutMs = 4000 } = {}) {
  const kind = documentKind(app);
  if (!kind) return null;
  if ('GOAT_FAKE_DOC' in env) {
    if (!env.GOAT_FAKE_DOC) return null;
    try {
      const fake = JSON.parse(env.GOAT_FAKE_DOC);
      return fake.kind === 'deck' ? deckDocument(fake, app) : pageDocument(fake, app);
    } catch {
      return null;
    }
  }
  if (env.GOAT_FAKE_WINDOW) return null;
  let raw;
  try {
    const script = kind === 'deck' ? KEYNOTE_JXA : app === 'Safari' ? SAFARI_JXA : CHROMIUM_JXA;
    raw = JSON.parse(await run(script, kind === 'page' && app !== 'Safari' ? [app] : [], timeoutMs));
  } catch (err) {
    return { kind, app, error: /not authori[sz]ed|-1743/i.test(String(err?.message)) ? 'not_allowed' : 'unavailable' };
  }
  if (!raw || raw.error) return { kind, app, error: raw?.error || 'unavailable' };
  const doc = kind === 'deck' ? deckDocument(raw, app) : pageDocument(raw, app);
  return doc.text ? doc : null;
}
