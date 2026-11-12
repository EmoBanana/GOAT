import crypto from 'node:crypto';
import { HttpError } from './errors.js';
import { matchGuide, RELATED_MIN, relatedGuides, wantsExplanation } from './guides/match.js';

export const SYSTEM_PROMPT = [
  'You are GOAT, a friendly senior engineer at Gamuda who helps colleagues right on their screen.',
  'Answer in at most 3 short sentences of plain text, with no markdown, lists or headings.',
  'Use the provided context from company procedures and guides when it is relevant.',
  "If the user wants click-by-click steps and the context has no guide for it, say plainly that you don't have a guide for that yet, then give your best short advice.",
  'Never invent project data such as project codes, names, people, dates or numbers.',
].join(' ');

export const DEEP_PROMPT = 'No company procedure or guide covers this question, so think it through before you answer.';
export const TOOLS_PROMPT = [
  'You can use the tools provided, such as web search.',
  'Search when the answer depends on facts you are not sure of, then answer from what you found.',
  'Never put project names, file names, people or window titles in a search query.',
].join(' ');

export const CONTEXT_CAP = 2600;
export const MAX_TOOL_ROUNDS = 2;
export const IMAGE_MAX_BYTES = 2 * 1024 * 1024;

// A highlighted region arrives as a base64 PNG (or JPEG), at most 2 MB.
export function checkImage(image) {
  if (typeof image !== 'string') throw new HttpError(400, 'bad_image', 'The image must be a base64 PNG.');
  const b64 = image.replace(/^data:image\/[a-z]+;base64,/i, '').replace(/\s+/g, '');
  if (!b64 || !/^[A-Za-z0-9+/]+=*$/.test(b64)) throw new HttpError(400, 'bad_image', 'The image must be a base64 PNG.');
  const bytes = Buffer.from(b64, 'base64');
  if (bytes.length > IMAGE_MAX_BYTES) throw new HttpError(413, 'image_too_large', 'Highlight a smaller area (the image must be under 2 MB).');
  const png = bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (!png && !jpeg) throw new HttpError(400, 'bad_image', 'The image must be a PNG or JPEG.');
  return b64;
}

function regionNote(region) {
  const w = Math.round(Number(region?.width));
  const h = Math.round(Number(region?.height));
  return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 ? ` (${w}×${h} points)` : '';
}

// Greetings and thanks get a quick answer: no context, no thinking, no tools.
const SMALL_TALK =
  /^(hi+|hello|hey+|hiya|yo|thanks|thank you|thx|cheers|ok|okay|cool|nice|great|good (morning|afternoon|evening|night)|bye|goodbye|how are you)(\s+(goat|there|everyone|all|again))?[\s!.?,]*$/i;
export const isSmallTalk = (question) => SMALL_TALK.test(String(question).trim());

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

// Bubbles are plain text, so drop any markdown the model slips in.
export function plainText(text) {
  return String(text ?? '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function renderGuide(g) {
  const steps = g.steps.map((s, i) => `${i + 1}. ${s.label}: ${s.say}`).join('\n');
  return `Guide "${g.title}" (GOAT can play it with the blue cursor)\n${g.context ? `${g.context}\n` : ''}${steps}`;
}

// Top doc chunks plus related guides, as plain text capped at about CONTEXT_CAP chars.
// `relevant` is false when nothing matched the question itself (an app match alone doesn't count).
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
  const docHits = docs.search(question);
  const guideHits = relatedGuides(question, guides.list(), context);
  for (const d of docHits) add(`[${d.file} › ${d.heading}]\n${d.text}`, { type: 'doc', file: d.file, heading: d.heading });
  for (const r of guideHits) add(renderGuide(r.guide), { type: 'guide', id: r.guide.id, title: r.guide.title });
  const relevant = docHits.length > 0 || guideHits.some((r) => r.base >= RELATED_MIN);
  return { text: parts.join('\n\n'), sources, relevant };
}

function userMessage(question, ctx, contextText, { hideWindow = false } = {}) {
  // With web tools in play, window titles and URLs stay out of the prompt so they can't
  // end up in a search query.
  const open = [ctx.app && `App: ${ctx.app}`, !hideWindow && ctx.title && `Window: ${ctx.title}`, !hideWindow && ctx.url && `URL: ${ctx.url}`]
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

function toolArgs(call) {
  const args = call?.function?.arguments;
  if (typeof args !== 'string') return args && typeof args === 'object' ? args : {};
  try {
    return JSON.parse(args);
  } catch {
    return {};
  }
}

// Spoken questions get spoken answers: short, plain, easy to follow by ear.
export const VOICE_PROMPT = [
  'This question was spoken aloud and your answer will be read out.',
  'Answer in one or two short sentences written for listening, with no lists, symbols or code.',
  'When it helps, end with the next thing the user can do.',
].join(' ');

const SCREEN_NOTE = (region) =>
  `This picture shows the user's screen around their mouse pointer${regionNote(region)}. Use it when the question is about something on screen ("this", "here").`;

// The "server decides" router: a verified guide when one matches, otherwise Gemma.
// Gemma answers fast when the SOPs or guides cover the question (or it's small talk), and
// thinks first, with MCP tools such as web search, when nothing relevant was found.
// image: a highlighted region (always goes to Gemma). screen: the area around the pointer sent
// with a voice question (context only; guides still win). memory: recent exchanges, so
// follow-ups ("and then?") make sense.
export function createAssist({ config, guides, docs, llm, mcp = null, memory = null }) {
  return async function assist({ question, context, tier = 'free', image, screen, voice = false, userId = 'anonymous' }) {
    const started = Date.now();
    const q = typeof question === 'string' ? question.trim() : '';
    if (!q) throw new HttpError(400, 'empty_question', 'Ask me something first.');
    if (q.length > 1000) throw new HttpError(400, 'question_too_long', 'Keep the question under 1,000 characters.');
    const ctx = cleanContext(context);
    const picture = image === undefined || image === null || image === '' ? null : checkImage(image);
    const view = picture || screen === undefined || screen === null || screen === '' ? null : checkImage(screen);
    const base = { id: crypto.randomUUID(), tier };

    // A highlighted region always goes to the model: it's a question about what's on screen.
    if (!picture && !wantsExplanation(q)) {
      const hit = matchGuide(q, guides.list(), ctx);
      if (hit) {
        const g = hit.guide;
        memory?.add(userId, q, `(GOAT played the guide "${g.title}".)`);
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

    const smallTalk = !picture && isSmallTalk(q);
    const found = smallTalk ? { text: '', sources: [], relevant: true } : buildContext({ question: q, context: ctx, docs, guides });
    const mode = config.think || 'auto';
    // Region asks stay quick unless thinking is always on.
    const deep = picture ? mode === 'always' : !smallTalk && (mode === 'always' || (mode === 'auto' && !found.relevant));
    // Screen contents never go anywhere near web tools.
    const tools = deep && !picture && !view && mcp ? await mcp.tools() : [];

    const system = [SYSTEM_PROMPT, voice && VOICE_PROMPT, deep && DEEP_PROMPT, tools.length && TOOLS_PROMPT].filter(Boolean).join(' ');
    const userText = smallTalk ? q : userMessage(q, ctx, found.text, { hideWindow: tools.length > 0 });
    const current = picture
      ? { role: 'user', content: `The user highlighted this part of the screen${regionNote(context?.region)}. The image shows it.\n\n${userText}`, images: [picture] }
      : view
        ? { role: 'user', content: `${SCREEN_NOTE(context?.region)}\n\n${userText}`, images: [view] }
        : { role: 'user', content: userText };
    const history = (memory?.recent(userId) || []).flatMap((t) => [
      { role: 'user', content: t.question },
      { role: 'assistant', content: t.answer },
    ]);
    const messages = [{ role: 'system', content: system }, ...history, current];

    // Pro tries its model first and falls back to the base model if it isn't pulled.
    const candidates = tier === 'pro' && config.modelPro && config.modelPro !== config.model ? [config.modelPro, config.model] : [config.model];
    let model = null;
    async function chat(opts) {
      if (model) return llm.chat({ model, messages, ...opts });
      for (const [i, m] of candidates.entries()) {
        try {
          const r = await llm.chat({ model: m, messages, ...opts });
          model = m;
          return r;
        } catch (err) {
          if (err.code === 'model_missing' && i < candidates.length - 1) continue;
          throw err;
        }
      }
      return null;
    }

    let answer;
    let thought = false;
    let thinking = deep;
    const searched = [];
    for (let round = 0; ; ) {
      const offerTools = tools.length > 0 && round < MAX_TOOL_ROUNDS;
      const r = await chat({ think: thinking, tools: offerTools ? tools : undefined, thinkBudgetMs: thinking ? config.thinkBudgetMs : 0 });
      thought ||= Boolean(r.thinking);
      if (r.cut) {
        // Out of thinking time: answer straight away, with what Gemma had worked out as notes.
        thinking = false;
        const notes = r.thinking.trim().slice(-1500);
        if (notes) current.content += `\n\nYour notes so far (unfinished):\n${notes}\n\nAnswer now, in at most 3 short sentences.`;
        continue;
      }
      round += 1;
      if (offerTools && r.toolCalls.length) {
        messages.push({ role: 'assistant', content: r.text || '', tool_calls: r.toolCalls });
        for (const call of r.toolCalls.slice(0, 2)) {
          const name = call.function?.name;
          const args = toolArgs(call);
          const result = await mcp.call(name, args);
          searched.push({ tool: name, query: typeof args.query === 'string' ? args.query : '', urls: result.urls });
          messages.push({ role: 'tool', tool_name: name, content: result.text });
        }
        continue;
      }
      answer = r;
      break;
    }

    const seen = new Set();
    const web = searched
      .flatMap((s) => s.urls)
      .filter((url) => !seen.has(url) && seen.add(url))
      .slice(0, 3)
      .map((url) => ({ type: 'web', url }));
    const say = plainText(answer.text) || "Sorry, I couldn't come up with an answer. Try asking another way.";
    memory?.add(userId, q, say);

    return {
      ...base,
      source: 'llm',
      say,
      guide: null,
      model,
      thought,
      image: Boolean(picture),
      screen: Boolean(view),
      searched: searched.map(({ tool, query }) => ({ tool, query })),
      sources: [...found.sources, ...web],
      latencyMs: Date.now() - started,
    };
  };
}
