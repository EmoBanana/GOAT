// "Show me how to search on Google" with the IDE in front: GOAT opens the app or website the
// question names, waits until it's up, and then plans the steps on its controls, so the cursor
// shows the way instead of GOAT answering in words.
import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { documentKind } from './doc-context.js';

// Asking to be shown on screen, wherever it comes in the question ("how do I search on Google?
// show me", a spoken "okay, can you show me…").
export const SHOW_ME = /\b(?:show (?:me|us|it|how)|guide me|walk me through|take me (?:to|through)|point (?:me )?(?:to|at)|point (?:it |that )?out|visual guide|demonstrate)\b/i;
// How-to questions, the ones GOAT can guide: these openings, or a show-me anywhere. The server
// has the same pattern (server/src/guides/plan.js).
const HOW_TO_START =
  /^\s*(?:(?:hey\s+)?goat[,!]?\s+)?(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?|please\s+)?(?:how (?:do|can|should|would) (?:i|we|you)|how to|where (?:do|can|should) i|where (?:is|are|to)|where's|help me (?:find|get|do|set)|what do i (?:click|press))\b/i;
export const HOW_TO = new RegExp(`${HOW_TO_START.source}|${SHOW_ME.source}`, 'i');

const browser = (s) => documentKind(s?.app) === 'page';
// A website is in front when a browser shows it: by its address when that's known (the browser's
// own report, or a test), else by the window title.
const site = (host, title) => (s) => browser(s) && (host.test(String(s.url || '')) || title.test(String(s.title || '')));
const app = (name) => (s) => name.test(String(s?.app || ''));
const NOT_GOOGLE = '(?!\\s+(?:docs?|sheets?|slides?|drive|maps|chrome|calendar|translate|gemini)\\b)';

// Most specific first: "Google Docs" and "Google Chrome" before "Google".
export const PLACES = [
  { name: 'Google Docs', asked: /\bgoogle docs?\b/i, url: 'https://docs.google.com/document/', here: site(/\/\/docs\.google\.com\/document/i, /google docs/i) },
  { name: 'Google Sheets', asked: /\bgoogle sheets?\b/i, url: 'https://docs.google.com/spreadsheets/', here: site(/\/\/docs\.google\.com\/spreadsheets/i, /google sheets/i) },
  { name: 'Google Slides', asked: /\bgoogle slides?\b/i, url: 'https://docs.google.com/presentation/', here: site(/\/\/docs\.google\.com\/presentation/i, /google slides/i) },
  { name: 'Google Drive', asked: /\bgoogle drive\b/i, url: 'https://drive.google.com/', here: site(/\/\/drive\.google\.com/i, /google drive/i) },
  { name: 'Google Maps', asked: /\bgoogle maps\b/i, url: 'https://www.google.com/maps', here: site(/\/\/(www\.)?google\.[a-z.]+\/maps/i, /google maps/i) },
  { name: 'Google Calendar', asked: /\bgoogle calendar\b/i, url: 'https://calendar.google.com/', here: site(/\/\/calendar\.google\.com/i, /google calendar/i) },
  { name: 'Google Translate', asked: /\bgoogle translate\b/i, url: 'https://translate.google.com/', here: site(/\/\/translate\.google\./i, /google translate/i) },
  { name: 'Gemini', asked: /\bgemini\b/i, url: 'https://gemini.google.com/', here: site(/\/\/gemini\.google\.com/i, /gemini/i) },
  { name: 'Gmail', asked: /\bgmail\b/i, url: 'https://mail.google.com/', here: site(/\/\/mail\.google\.com/i, /gmail/i) },
  { name: 'YouTube', asked: /\byou ?tube\b/i, url: 'https://www.youtube.com/', here: site(/\/\/(www\.)?youtube\.com/i, /youtube/i) },
  { name: 'GitHub', asked: /\bgithub\b/i, url: 'https://github.com/', here: site(/\/\/github\.com/i, /github/i) },
  { name: 'Canva', asked: /\bcanva\b/i, url: 'https://www.canva.com/', here: site(/\/\/(www\.)?canva\.com/i, /canva/i) },
  { name: 'Google Chrome', asked: /\b(?:google )?chrome\b/i, app: 'Google Chrome', here: app(/^google chrome$/i) },
  { name: 'Microsoft Edge', asked: /\bmicrosoft edge\b|\bin edge\b|\bedge browser\b/i, app: 'Microsoft Edge', here: app(/^microsoft edge$/i) },
  { name: 'Safari', asked: /\bsafari\b/i, app: 'Safari', here: app(/^safari$/i) },
  {
    name: 'Google',
    asked: new RegExp(`\\bgoogle\\b${NOT_GOOGLE}`, 'i'),
    url: 'https://www.google.com/',
    here: site(/\/\/(www\.)?google\.[a-z.]+\/(?:search|webhp)?(?:[?#]|$)/i, new RegExp(`^google\\b${NOT_GOOGLE}|google search`, 'i')),
  },
  { name: 'Autodesk Build', asked: /\bforma\b|\bautodesk build\b/i, url: 'https://acc.autodesk.com/', here: site(/\/\/acc\.autodesk\.com/i, /autodesk build|forma/i) },
  { name: 'Excel', asked: /\bexcel\b/i, app: 'Microsoft Excel', here: app(/excel/i) },
  { name: 'Word', asked: /\bin word\b|\bmicrosoft word\b/i, app: 'Microsoft Word', here: app(/^microsoft word$/i) },
  { name: 'PowerPoint', asked: /\bpower ?point\b/i, app: 'Microsoft PowerPoint', here: app(/powerpoint/i) },
  { name: 'Outlook', asked: /\boutlook\b/i, app: 'Microsoft Outlook', here: app(/outlook/i) },
  { name: 'Teams', asked: /\bmicrosoft teams\b|\bin teams\b/i, app: 'Microsoft Teams', here: app(/teams/i) },
  { name: 'Keynote', asked: /\bkeynote\b/i, app: 'Keynote', here: app(/^keynote$/i) },
  { name: 'Finder', asked: /\bfinder\b/i, app: 'Finder', here: app(/^finder$/i) },
  { name: 'System Settings', asked: /\bsystem (?:settings|preferences)\b/i, app: 'System Settings', here: app(/^system (?:settings|preferences)$/i) },
];

export const isHere = (place, sample) => Boolean(sample) && place.here(sample);

// The app or website to open first, or null: only for show-me questions that name one which
// isn't already in front (`ctx` is the window the user was in when they asked).
export function placeToOpen(question, ctx = {}) {
  const q = String(question || '');
  if (!SHOW_ME.test(q)) return null;
  const place = PLACES.find((p) => p.asked.test(q));
  return place && !isHere(place, ctx) ? place : null;
}

// The default browser's front tab, asked of the browser itself: { app, title, url (no query),
// loading? } or null. Read only right after GOAT opened a website there, never stored. Tests read
// nothing real.
const FRONT_TAB = `function run() {
  try {
    ObjC.import('AppKit');
    var u = $.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL($.NSURL.URLWithString('https://example.com/'));
    var name = String(ObjC.unwrap(u.lastPathComponent) || '').replace(/\\.app$/, '');
    var out = { app: name, url: '', title: '' };
    if (name === 'Safari') {
      var s = Application('Safari');
      if (s.documents.length) { out.url = s.documents[0].url() || ''; out.title = s.documents[0].name() || ''; }
    } else {
      var b = Application(name);
      if (b.windows.length) { var t = b.windows[0].activeTab(); out.url = t.url() || ''; out.title = t.title() || ''; out.loading = t.loading(); }
    }
    return JSON.stringify(out);
  } catch (e) { return '{}'; }
}`;
function runJxa(script, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-l', 'JavaScript', '-e', script, ...args.map(String)], { timeout: timeoutMs }, (err, stdout) => (err ? reject(err) : resolve(String(stdout).trim())));
  });
}
export async function frontTab({ env = process.env, platform = process.platform, run = runJxa, timeoutMs = 1500 } = {}) {
  if (platform !== 'darwin' || env.GOAT_FAKE_WINDOW || 'GOAT_FAKE_OPENS' in env) return null;
  try {
    const raw = JSON.parse(await run(FRONT_TAB, [], timeoutMs));
    if (!browser(raw) || !raw.url) return null;
    return { app: raw.app, title: String(raw.title || ''), url: String(raw.url).replace(/[?#].*$/, ''), loading: raw.loading === true, pid: 0 };
  } catch {
    return null;
  }
}

// Opens it, then waits until it's up (about 12 s at most) and gives it a moment to draw its
// controls. Up means in front, by the window macOS names; for a website also when the browser's
// own front tab shows it. That second way doesn't depend on which app macOS says is in front
// (after a typed ask that is GOAT's own overlay), and it brings the browser forward if it isn't.
// Returns the window to plan on ({ app, title, url?, pid }), or null if it never came up.
export async function bringUp(place, { open, sample, tab = null, activate = null, tries = 24, everyMs = 250, settleMs = 700, sleep = delay } = {}) {
  const quiet = (fn) =>
    Promise.resolve()
      .then(fn)
      .catch(() => null);
  try {
    await open(place);
  } catch {
    return null;
  }
  for (let i = 0; i < tries; i++) {
    await sleep(everyMs);
    const front = await quiet(sample);
    if (isHere(place, front)) {
      await sleep(settleMs);
      return front;
    }
    const page = place.url && tab ? await quiet(tab) : null;
    // The page has a title once it has loaded enough to read; don't wait for a slow page forever.
    if (isHere(place, page) && page.title && (!page.loading || i >= 8)) {
      if (activate && front?.app !== page.app) await quiet(() => activate(page.app));
      await sleep(settleMs);
      return { app: page.app, title: page.title, url: page.url, pid: 0 };
    }
  }
  return null;
}
