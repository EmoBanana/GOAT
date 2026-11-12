// GOAT works out a guide itself when no recorded one fits a how-to question: Gemma plans the
// clicks from the company procedures, the open page or deck, and the controls on screen right now
// (labels and positions read by the app). Steps name controls by label; the app finds each one on
// screen right before its step, so resolution and window size don't matter. The first step must
// be a control that is on screen now, or there's no guide (GOAT answers in words instead).
// A polite "can you" or "please" in front is fine ("can you show me how to search on Google?").
export const HOW_TO =
  /^\s*(?:(?:hey\s+)?goat[,!]?\s+)?(?:(?:can|could|would|will)\s+you\s+|please\s+)?(how (do|can|should|would) (i|we|you)|how to|where (do|can) i|where is|where are|where's|show me|guide me|walk me through|take me|point (me )?(to|at)|help me (find|get|do|set)|what do i (click|press))\b/i;
export const MAX_PLAN_STEPS = 6;
const MAX_LISTED = 120;

export const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    possible: { type: 'boolean' },
    intro: { type: 'string' },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: { target: { type: 'string' }, say: { type: 'string' } },
        required: ['target', 'say'],
      },
    },
  },
  required: ['possible', 'intro', 'steps'],
};

export const PLAN_PROMPT = [
  "You are GOAT, Gamuda's AI assistant. You guide an engineer through the app on their screen by moving a blue cursor to each control in turn.",
  'Plan the clicks for what they ask, following the company procedure when one applies.',
  'Reply in JSON: possible; intro, one short sentence such as "Here\'s how to export the issue list."; steps, at most 6, in order, each with target and say.',
  'Set possible to false, with no steps, only when the task is about another app or website, or makes no sense in this app. Otherwise set it to true and plan it with the controls on screen, never with an unrelated control.',
  'target is the exact label of the control to click or type into, copied from inside the quotes in the list of controls on screen when it is there, otherwise the label it will have once it appears.',
  'say is one short instruction for that step.',
  "The first step's target must be a control from the list.",
].join(' ');

const num = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);

// The controls the app sent: [{ role, label, x, y, w, h }] in screen points.
export function cleanTargets(list) {
  const out = [];
  for (const t of Array.isArray(list) ? list : []) {
    const label = typeof t?.label === 'string' ? t.label.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
    const [x, y, w, h] = [num(t?.x), num(t?.y), num(t?.w), num(t?.h)];
    if (!label || x === null || y === null || !(w > 0) || !(h > 0)) continue;
    out.push({ role: typeof t.role === 'string' ? t.role.slice(0, 20) : '', label, x, y, w, h });
    if (out.length >= 300) break;
  }
  return out;
}

const words = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// The control best matching a name (same rules as the app's): exact, same words, one inside the
// other, then most shared words (at least two thirds).
export function findTarget(targets, name) {
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
    if (score > (best?.score || 0)) best = { score, target: t };
  }
  return best ? best.target : null;
}

export function planMessages({ question, ctx = {}, procedures = '', doc = null, targets, history = [] }) {
  const seen = new Set();
  const listed = [];
  for (const t of targets) {
    const key = t.label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    listed.push(`- "${t.label}"${t.role ? ` ${t.role}` : ''}`);
    if (listed.length >= MAX_LISTED) break;
  }
  const where = [ctx.app && `App: ${ctx.app}`, ctx.title && `Window: ${ctx.title}`].filter(Boolean).join(' · ');
  const user = [
    where,
    `Controls on screen now:\n${listed.join('\n')}`,
    procedures && `Company procedures:\n${procedures}`,
    doc && doc.text && `The ${doc.kind === 'deck' ? 'deck' : 'page'} open now:\n${doc.text.slice(0, 2500)}`,
    history.length && `Earlier in this chat:\n${history.map((t) => `Q: ${t.question}\nA: ${t.answer}`).join('\n')}`,
    `Task: ${question}`,
  ]
    .filter(Boolean)
    .join('\n\n');
  return [
    { role: 'system', content: PLAN_PROMPT },
    { role: 'user', content: user },
  ];
}

// A checked plan: { intro, steps: [{ target, label, say, x?, y? }] } or null. Steps whose control is
// on screen now carry its centre, so the first one can fly at once.
export function checkPlan(raw, targets) {
  let plan = raw;
  if (typeof raw === 'string') {
    try {
      plan = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!plan || plan.possible === false) return null;
  const text = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
  // Gemma sometimes copies the quotes or the kind of control along with the label.
  const label = (v) =>
    ((/["“]([^"”]+)["”]/.exec(text(v, 120)) || [])[1] || text(v, 120))
      .replace(/^["“'‘]+|["”'’]+$/g, '')
      .replace(/\s*\((?![\d\s]+\))[^)]*\)$/, '') // "(link)", "(assumed)"; a count like "(12)" stays
      .replace(/\s+(radio ?button|button|link|tab|field|text ?field|combo ?box|row|check ?box|menu ?item|option)$/i, '')
      .slice(0, 80);
  const steps = (Array.isArray(plan?.steps) ? plan.steps : [])
    .map((s) => ({ target: label(s?.target), say: text(s?.say, 200) }))
    .filter((s) => s.say)
    .slice(0, MAX_PLAN_STEPS);
  if (!steps.length) return null;
  const first = findTarget(targets, steps[0].target);
  if (!first) return null;
  return {
    intro: text(plan.intro, 200) || 'Follow the blue cursor.',
    steps: steps.map((s) => {
      const hit = s.target ? findTarget(targets, s.target) : null;
      const step = { target: s.target, label: hit ? hit.label : s.target || 'Step', say: s.say };
      if (hit) Object.assign(step, { x: Math.round(hit.x + hit.w / 2), y: Math.round(hit.y + hit.h / 2) });
      return step;
    }),
  };
}

// A question about another app or website than the one in front ("search in Google" while the
// IDE is in front) is never planned on this app's controls: GOAT answers in words instead.
const APPS = [
  ['google', /\bgoogle\b(?! (docs|sheets|slides|drive))/i, /google|chrome/i],
  ['chrome', /\bchrome\b/i, /chrome/i],
  ['edge', /\bedge\b/i, /edge/i],
  ['safari', /\bsafari\b/i, /safari/i],
  ['excel', /\bexcel\b/i, /excel/i],
  ['word', /\bin word\b|\bmicrosoft word\b/i, /word/i],
  ['powerpoint', /\bpower ?point\b/i, /powerpnt|powerpoint/i],
  ['keynote', /\bkeynote\b/i, /keynote/i],
  ['outlook', /\boutlook\b/i, /outlook/i],
  ['teams', /\bteams\b/i, /teams/i],
  ['revit', /\brevit\b/i, /revit/i],
  ['autocad', /\bautocad\b/i, /autocad|acad/i],
  ['bluebeam', /\bbluebeam\b/i, /bluebeam/i],
  ['navisworks', /\bnavisworks\b/i, /navisworks/i],
  ['forma', /\bforma\b|\bautodesk build\b/i, /forma|autodesk|acc\.autodesk/i],
  ['finder', /\bfinder\b/i, /finder/i],
];
export function aboutAnotherApp(question, ctx = {}) {
  const here = [ctx.app, ctx.title, ctx.url].filter(Boolean).join(' ');
  return APPS.some(([, asked, open]) => asked.test(question) && !open.test(here));
}

export async function planGuide({ chat, question, ctx, procedures, doc, targets, history = [] }) {
  const r = await chat({ messages: planMessages({ question, ctx, procedures, doc, targets, history }), format: PLAN_SCHEMA, temperature: 0.2 });
  return checkPlan(r?.text, targets);
}
