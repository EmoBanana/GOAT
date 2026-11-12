import { tokens } from '../text.js';

export const THRESHOLD = 0.6;
export const APP_BONUS = 0.15;
export const RELATED_MIN = 0.34;

// These always go to the model, even when a guide would match.
const EXPLAIN = /^\s*(why\b|what\s+is\b|what['’]?s\b|explain\b|summari[sz]e\b|describe\b)/i;

export function wantsExplanation(question) {
  return EXPLAIN.test(String(question ?? ''));
}

const round = (n) => Math.round(n * 1000) / 1000;

// 1 if the whole normalised trigger appears in the question, else the share of its tokens.
export function triggerScore(questionTokens, trigger) {
  const t = tokens(trigger);
  if (!t.length) return 0;
  if (` ${questionTokens.join(' ')} `.includes(` ${t.join(' ')} `)) return 1;
  const have = new Set(questionTokens);
  return t.filter((x) => have.has(x)).length / t.length;
}

export function appMatches(guide, context = {}) {
  const hay = [context.app, context.title, context.url].filter(Boolean).join('\n').toLowerCase();
  if (!hay) return false;
  return (guide.apps || []).some((a) => a && hay.includes(String(a).toLowerCase()));
}

export function scoreGuide(question, guide, context = {}) {
  const q = tokens(question);
  let best = { base: 0, trigger: null };
  for (const trigger of guide.triggers || []) {
    const base = triggerScore(q, trigger);
    if (base > best.base) best = { base, trigger };
  }
  const appMatch = appMatches(guide, context);
  return {
    guide,
    base: round(best.base),
    score: round(best.base + (appMatch ? APP_BONUS : 0)),
    trigger: best.trigger,
    appMatch,
  };
}

// Best guide at or above the threshold. Ties go to the most recently recorded guide.
export function matchGuide(question, guides, context = {}, threshold = THRESHOLD) {
  let best = null;
  for (const guide of guides) {
    const s = scoreGuide(question, guide, context);
    if (s.base === 0 || s.score < threshold) continue;
    const newer = (guide.createdAt || 0) > (best?.guide.createdAt || 0);
    if (!best || s.score > best.score || (s.score === best.score && newer)) best = s;
  }
  return best;
}

// Guides worth showing the model as context: same app, or a partial trigger match.
export function relatedGuides(question, guides, context = {}, limit = 2) {
  return guides
    .map((g) => scoreGuide(question, g, context))
    .filter((s) => s.appMatch || s.score >= RELATED_MIN)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
