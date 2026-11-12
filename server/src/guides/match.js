import { stem, tokens } from '../text.js';

export const THRESHOLD = 0.6;
export const APP_BONUS = 0.15;
export const RELATED_MIN = 0.34;

// These always go to the model, even when a guide would match.
const EXPLAIN = /^\s*(why\b|what\s+is\b|what['’]?s\b|explain\b|summari[sz]e\b|describe\b)/i;

export function wantsExplanation(question) {
  return EXPLAIN.test(String(question ?? ''));
}

const round = (n) => Math.round(n * 1000) / 1000;

// "make a new issue" asks for "create an issue".
const SAME = new Map(['make', 'add'].map((w) => [stem(w), stem('create')]));
const same = (list) => list.map((t) => SAME.get(t) || t);
export const words = (text) => same(tokens(text));

// 1 if the whole normalised trigger appears in the question, else the share of its tokens.
export function triggerScore(questionTokens, trigger) {
  const t = words(trigger);
  if (!t.length) return 0;
  const q = same(questionTokens);
  if (` ${q.join(' ')} `.includes(` ${t.join(' ')} `)) return 1;
  const have = new Set(q);
  return t.filter((x) => have.has(x)).length / t.length;
}

export function appMatches(guide, context = {}) {
  const hay = [context.app, context.title, context.url].filter(Boolean).join('\n').toLowerCase();
  if (!hay) return false;
  return (guide.apps || []).some((a) => a && hay.includes(String(a).toLowerCase()));
}

export function scoreGuide(question, guide, context = {}) {
  const q = words(question);
  // A partial match needs two of the question's words among the guide's trigger words. One
  // shared word isn't enough: "filter issues" or "create a checklist" isn't "log an issue".
  const vocab = new Set((guide.triggers || []).flatMap((t) => words(t)));
  const shared = new Set(q.filter((w) => vocab.has(w))).size;
  let best = { base: 0, trigger: null };
  for (const trigger of guide.triggers || []) {
    const share = triggerScore(q, trigger);
    const base = share === 1 || shared >= 2 ? share : 0;
    if (base > best.base) best = { base, trigger };
  }
  const appMatch = appMatches(guide, context);
  // Does the question share any word with what the guide is about (title, triggers, step names)?
  const about = new Set([guide.title, ...(guide.triggers || []), ...(guide.steps || []).map((s) => s?.label)].flatMap((t) => words(t || '')));
  return {
    guide,
    base: round(best.base),
    score: round(best.base + (appMatch ? APP_BONUS : 0)),
    trigger: best.trigger,
    appMatch,
    overlap: q.some((w) => about.has(w)),
  };
}

// Shipped guides with placeholder positions (recordedOn "sample-…").
export const isSample = (guide) => /^sample/i.test(String(guide?.recordedOn || ''));

// Best guide at or above the threshold. A guide recorded on this Mac beats a sample guide that
// also matches (whatever the app bonus), so recording one replaces the placeholder. Otherwise
// ties go to the most recently recorded guide.
export function matchGuide(question, guides, context = {}, threshold = THRESHOLD) {
  let best = null;
  for (const guide of guides) {
    const s = scoreGuide(question, guide, context);
    if (s.base === 0 || s.score < threshold) continue;
    if (best && isSample(guide) !== isSample(best.guide)) {
      if (isSample(best.guide)) best = s;
      continue;
    }
    const newer = (guide.createdAt || 0) > (best?.guide.createdAt || 0);
    if (!best || s.score > best.score || (s.score === best.score && newer)) best = s;
  }
  return best;
}

// Guides worth showing the model as context: a partial trigger match, or a guide for the app in
// front that shares a word with the question. An app match alone isn't enough: a recorded IDE
// guide ("json: Click on the json file") as the only context made Gemma refuse a Revit question.
export function relatedGuides(question, guides, context = {}, limit = 2) {
  return guides
    .map((g) => scoreGuide(question, g, context))
    .filter((s) => s.score >= RELATED_MIN || (s.appMatch && s.overlap))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
