import crypto from 'node:crypto';
import { HttpError } from './errors.js';
import { matchGuide, relatedGuides, wantsExplanation } from './guides/match.js';

export const SYSTEM_PROMPT = [
  'You are GOAT, a friendly senior engineer at Gamuda who helps colleagues right on their screen.',
  'Answer in at most 3 short sentences of plain text, with no markdown, lists or headings.',
  'Use the provided context from company procedures and guides when it is relevant.',
  "If the user wants click-by-click steps and the context has no guide for it, say plainly that you don't have a guide for that yet, then give your best short advice.",
  'Never invent project data such as project codes, names, people, dates or numbers.',
].join(' ');

export const CONTEXT_CAP = 2600;

export function stripQuery(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return url.split(/[?#]/)[0];
  }
}

export function cleanContext(context) {
  const c = context && typeof context === 'object' ? context : {};
  const s = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  return { app: s(c.app, 120), title: s(c.title, 300), url: stripQuery(s(c.url, 500)) };
}

export function renderGuide(g) {
  const steps = g.steps.map((s, i) => `${i + 1}. ${s.label}: ${s.say}`).join('\n');
  return `Guide "${g.title}" (GOAT can play it with the blue cursor)\n${g.context ? `${g.context}\n` : ''}${steps}`;
}

// Top doc chunks plus related guides, as plain text capped at about CONTEXT_CAP chars.
export function buildContext({ question, context, docs, guides }) {
  const parts = [];
  const sources = [];
  let used = 0;
  const add = (text, source) => {
    const room = CONTEXT_CAP - used;
    if (room < 200) return;
    const t = text.length > room ? `${text.slice(0, room - 1).trimEnd()}…` : text;
    parts.push(t);
    used += t.length + 2;
    sources.push(source);
  };
  for (const d of docs.search(question)) {
    add(`[${d.file} › ${d.heading}]\n${d.text}`, { type: 'doc', file: d.file, heading: d.heading });
  }
  for (const r of relatedGuides(question, guides.list(), context)) {
    add(renderGuide(r.guide), { type: 'guide', id: r.guide.id, title: r.guide.title });
  }
  return { text: parts.join('\n\n'), sources };
}

function userMessage(question, ctx, contextText) {
  const open = [ctx.app && `App: ${ctx.app}`, ctx.title && `Window: ${ctx.title}`, ctx.url && `URL: ${ctx.url}`]
    .filter(Boolean)
    .join('\n');
  return [
    contextText ? `Context from company procedures and guides:\n${contextText}` : 'No company procedure or guide matched this question.',
    open && `What the user has open:\n${open}`,
    `Question: ${question}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

// The "server decides" router: a verified guide when one matches, otherwise Gemma.
export function createAssist({ config, guides, docs, llm }) {
  return async function assist({ question, context, tier = 'free' }) {
    const started = Date.now();
    const q = typeof question === 'string' ? question.trim() : '';
    if (!q) throw new HttpError(400, 'empty_question', 'Ask me something first.');
    if (q.length > 1000) throw new HttpError(400, 'question_too_long', 'Keep the question under 1,000 characters.');
    const ctx = cleanContext(context);
    const base = { id: crypto.randomUUID(), tier };

    if (!wantsExplanation(q)) {
      const hit = matchGuide(q, guides.list(), ctx);
      if (hit) {
        const g = hit.guide;
        return {
          ...base,
          source: 'guide',
          say: g.intro,
          guide: { id: g.id, title: g.title, intro: g.intro, steps: g.steps },
          model: null,
          sources: [{ type: 'guide', id: g.id, title: g.title }],
          match: { score: hit.score, trigger: hit.trigger },
          latencyMs: Date.now() - started,
        };
      }
    }

    const { text, sources } = buildContext({ question: q, context: ctx, docs, guides });
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMessage(q, ctx, text) },
    ];
    const models = tier === 'pro' && config.modelPro && config.modelPro !== config.model ? [config.modelPro, config.model] : [config.model];

    let answer;
    for (const [i, model] of models.entries()) {
      try {
        answer = await llm.chat({ model, messages });
        break;
      } catch (err) {
        // Pro model not pulled: fall back to the base model.
        if (err.code === 'model_missing' && i < models.length - 1) continue;
        throw err;
      }
    }

    return {
      ...base,
      source: 'llm',
      say: answer.text || "Sorry, I couldn't come up with an answer. Try asking another way.",
      guide: null,
      model: answer.model,
      sources,
      latencyMs: Date.now() - started,
    };
  };
}
