// "Show me how to search on Google" with the IDE in front: GOAT opens the app or website the
// question names, waits until it's in front, and then plans the steps on its controls, so the
// cursor shows the way instead of GOAT answering in words.
import { setTimeout as delay } from 'node:timers/promises';
import { documentKind } from './doc-context.js';

// Questions that ask to be shown on screen; a polite "can you" or "please" in front is fine.
export const SHOW_ME =
  /^\s*(?:(?:hey\s+)?goat[,!]?\s+)?(?:(?:can|could|would|will)\s+you\s+|please\s+)?(?:show me|guide me|walk me through|take me|point (?:me )?(?:to|at)|help me find|where (?:is|are|do i|can i)|where's)\b/i;

const browser = (s) => documentKind(s?.app) === 'page';
// A website is in front when a browser shows it: its address (only known in tests) or its title.
const site = (host, title) => (s) => browser(s) && (host.test(String(s.url || '')) || title.test(String(s.title || '')));
const app = (name) => (s) => name.test(String(s?.app || ''));
const NOT_GOOGLE = '(?!\\s+(?:docs?|sheets?|slides?|drive|maps|chrome)\\b)';

// Most specific first: "Google Docs" and "Google Chrome" before "Google".
export const PLACES = [
  { name: 'Google Docs', asked: /\bgoogle docs?\b/i, url: 'https://docs.google.com/document/', here: site(/\/\/docs\.google\.com\/document/i, /google docs/i) },
  { name: 'Google Sheets', asked: /\bgoogle sheets?\b/i, url: 'https://docs.google.com/spreadsheets/', here: site(/\/\/docs\.google\.com\/spreadsheets/i, /google sheets/i) },
  { name: 'Google Slides', asked: /\bgoogle slides?\b/i, url: 'https://docs.google.com/presentation/', here: site(/\/\/docs\.google\.com\/presentation/i, /google slides/i) },
  { name: 'Google Drive', asked: /\bgoogle drive\b/i, url: 'https://drive.google.com/', here: site(/\/\/drive\.google\.com/i, /google drive/i) },
  { name: 'Google Maps', asked: /\bgoogle maps\b/i, url: 'https://www.google.com/maps', here: site(/\/\/(www\.)?google\.[a-z.]+\/maps/i, /google maps/i) },
  { name: 'Gmail', asked: /\bgmail\b/i, url: 'https://mail.google.com/', here: site(/\/\/mail\.google\.com/i, /gmail/i) },
  { name: 'YouTube', asked: /\byou ?tube\b/i, url: 'https://www.youtube.com/', here: site(/\/\/(www\.)?youtube\.com/i, /youtube/i) },
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

// Opens it, then samples the front window until it's there (about 8 s at most) and gives the page
// a moment to draw its controls. Returns that window, or null if it never came up.
export async function bringUp(place, { open, sample, tries = 32, everyMs = 250, settleMs = 700, sleep = delay } = {}) {
  try {
    await open(place);
  } catch {
    return null;
  }
  for (let i = 0; i < tries; i++) {
    await sleep(everyMs);
    const front = await Promise.resolve()
      .then(sample)
      .catch(() => null);
    if (isHere(place, front)) {
      await sleep(settleMs);
      return front;
    }
  }
  return null;
}
