// Gemma writes one timesheet line per activity, on the laptop. Lines are kept per day
// (data/activity/<user>/<date>.notes.json), so an activity is described once; without the
// model, a plain line from the site or app and its first window title stands in.
// Plain "a1: …" lines, not JSON: on the M4 they came back in 3-4.5 s against 6.5-7.5 s for the
// same lines as structured output (the JSON's whitespace costs tokens).
export const ACTIVITY_SYSTEM = [
  "You turn an engineer's tracked screen time into timesheet lines.",
  'Each activity is one stretch of time in one app or website: the window titles seen there, and any GOAT guide followed (GOAT shows the steps of a task with an on-screen cursor).',
  'For each activity write one line in the past tense, at most 14 words, saying what the engineer did, e.g. "Reviewed the level 3 slab drawings in Bluebeam Revu."',
  'Each line names the app or website, in plain words: canva.com is Canva, acc.autodesk.com is Autodesk Construction Cloud.',
  'When an activity lists a GOAT guide, its line must say the task was done with a GOAT guide. Never mention a guide otherwise.',
  'Use only what the titles, website and guides show. Never invent names, numbers or results.',
  'Reply with one line per activity, as "a1: <line>".',
].join('\n');

const CHUNK = 20;
const TIMEOUT_MS = 40_000;

export function plainLine(a) {
  const place = a.site || a.app || 'An app';
  const what = a.titles && a.titles[0] ? `${place}: ${a.titles[0]}` : `Used ${place}`;
  return a.guides && a.guides.length ? `${what} (GOAT guide “${a.guides[0]}”)` : what;
}

export function activityPrompt(items) {
  const lines = items.map((a, i) => {
    const parts = [`- id a${i + 1}: ${a.app}${a.site ? `, website ${a.site}` : ''}`];
    if (a.titles.length) parts.push(`window titles: ${a.titles.map((t) => `“${t}”`).join('; ')}`);
    if (a.guides.length) parts.push(`done with the GOAT guide ${a.guides.map((g) => `“${g}”`).join('; ')}`);
    return `${parts.join('. ')}.`;
  });
  return `Activities:\n${lines.join('\n')}`;
}

const tidy = (s) =>
  String(s || '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["“'`*]+|["”'`*]+$/g, '')
    .replace(/\b([A-Z][A-Za-z]+)\.com\b/g, '$1') // "in Canva.com" reads "in Canva"
    .trim()
    .slice(0, 160);

// The model's "a1: …" lines -> one line per activity (a1 is the first), '' where it gave none.
export function parseLines(text, n) {
  const out = new Array(n).fill('');
  for (const raw of String(text || '').split('\n')) {
    const m = /^\s*[-*]?\s*(?:id\s+)?a(\d+)\s*[:.)\-–]\s*(.+)$/i.exec(raw);
    const i = m ? Number(m[1]) - 1 : -1;
    if (i >= 0 && i < n && !out[i]) out[i] = tidy(m[2]);
  }
  return out;
}

// The guide was the point of the line, so it stays even when the model leaves it out.
function withGuide(line, a) {
  if (!line || !a.guides.length || /\bguide\b/i.test(line)) return line;
  return `${line.replace(/[.\s]+$/, '')}, with a GOAT guide.`;
}

// chat: ({ messages, temperature, timeoutMs }) => { text }, or null (plain lines only).
export function createDescriber({ chat, activity, logger = console }) {
  return async function describe(user, date, activities) {
    const notes = activity.readNotes(user, date);
    const todo = activities.filter((a) => !notes[a.key]);
    if (todo.length && chat) {
      try {
        for (let i = 0; i < todo.length; i += CHUNK) {
          const part = todo.slice(i, i + CHUNK);
          const r = await chat({
            messages: [
              { role: 'system', content: ACTIVITY_SYSTEM },
              { role: 'user', content: activityPrompt(part) },
            ],
            temperature: 0.2,
            timeoutMs: TIMEOUT_MS,
          });
          parseLines(r?.text, part.length).forEach((line, j) => {
            if (line) notes[part[j].key] = withGuide(line, part[j]);
          });
        }
      } catch (err) {
        logger.warn(`[timesheet] activities not described: ${err.message}`);
      }
      // Keep only lines for activities that still exist (a growing stretch gets a new key).
      const keys = new Set(activities.map((a) => a.key));
      activity.writeNotes(user, date, Object.fromEntries(Object.entries(notes).filter(([k]) => keys.has(k))));
    }
    return activities.map((a) => ({ ...a, summary: notes[a.key] || plainLine(a), described: Boolean(notes[a.key]) }));
  };
}
