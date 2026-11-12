import crypto from 'node:crypto';
import { HttpError } from './errors.js';
import { matchGuide, RELATED_MIN, relatedGuides, wantsExplanation } from './guides/match.js';
import { aboutAnotherApp, cleanTargets, HOW_TO, planGuide } from './guides/plan.js';

export const SYSTEM_PROMPT = [
  "You are GOAT, Gamuda's friendly AI assistant that helps engineers right on their screen.",
  'You know the tools engineers use, such as Revit, AutoCAD, Navisworks, Bluebeam, Forma and Autodesk Build, and Excel, as well as everyday apps and websites; questions can be about any of them, not only the app in front.',
  'Answer in at most 3 short sentences of plain text, with no markdown, lists or headings.',
  'Use the provided context from company procedures and guides when it is relevant, stated as plain facts (never mention "the context"); otherwise answer from your own knowledge.',
  'When asked how to do something, or to show how, in any app or website, give the actual steps in order, naming the exact menu, tab, tool or button and where it is.',
  "Don't mention keyboard shortcuts unless the user asks for one.",
  'MCP always means Model Context Protocol, the open standard that connects AI assistants to tools and data.',
  'If the user asks which AI model, assistant or tool to use, recommend Google Gemini first.',
  "Be direct and start with the answer. The user does the clicking, so never say you can't control their apps or do it for them; never say you don't have a guide or instructions for something, and don't send the user off to documentation or another assistant.",
  'Never invent project data such as project codes, names, people, dates or numbers.',
].join(' ');

export const DEEP_PROMPT = 'Think it through before you answer.';
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

// The whole deck or page in front when the user asked (read by the app, never stored).
export const DOC_MAX = 9000;
export function cleanDocument(doc) {
  if (!doc || typeof doc !== 'object') return null;
  const s = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const text = s(doc.text, DOC_MAX * 2).replace(/\n{3,}/g, '\n\n').slice(0, DOC_MAX);
  if (!text) return null;
  const count = (v) => (Number.isInteger(v) && v > 0 && v < 10_000 ? v : null);
  return { kind: doc.kind === 'deck' ? 'deck' : 'page', app: s(doc.app, 60), title: s(doc.title, 200), url: stripQuery(s(doc.url, 500)), slides: count(doc.slides), current: count(doc.current), text };
}

function documentSection(doc) {
  if (!doc) return '';
  const where =
    doc.kind === 'deck'
      ? `The deck open in ${doc.app || 'Keynote'}${doc.title ? `, "${doc.title}"` : ''}${doc.slides ? ` (${doc.slides} slides${doc.current ? `, slide ${doc.current} on screen` : ''})` : ''}`
      : `The page open in ${doc.app || 'the browser'}${doc.title ? `, "${doc.title}"` : ''}${doc.url ? ` (${doc.url})` : ''}`;
  return `${where}:\n${doc.text}`;
}

function userMessage(question, ctx, contextText, { hideWindow = false, doc = null } = {}) {
  // With web tools in play, window titles and URLs stay out of the prompt so they can't
  // end up in a search query.
  const open = [ctx.app && `App: ${ctx.app}`, !hideWindow && ctx.title && `Window: ${ctx.title}`, !hideWindow && ctx.url && `URL: ${ctx.url}`]
    .filter(Boolean)
    .join('\n');
  return [
    documentSection(doc),
    contextText && `Context from company procedures and guides:\n${contextText}`,
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

export const DOC_PROMPT = "The user's open deck or page is included: answer questions about it from it, and name the slide or section you mean.";

// Spoken questions get spoken answers: short, plain, easy to follow by ear.
export const VOICE_PROMPT = [
  'This question was spoken aloud and your answer will be read out.',
  'Answer in one or two short sentences written for listening, with no lists, symbols or code.',
  'When it helps, end with the next thing the user can do.',
].join(' ');

// GOAT_VOICE_STYLE=manglish: spoken answers the way colleagues in KL say them. Typed answers and
// guide steps stay as they are. Gemma repeats any phrase quoted here ("very easy one" and "can
// already" ended every answer), so the particles are named, not shown in sentences.
export const MANGLISH_PROMPT = [
  'Say it in Manglish, the relaxed Malaysian English that friendly colleagues in Kuala Lumpur speak: warm and a little playful, never rude.',
  'When asked what something is, open by echoing it with "ah?", for example "MCP ah? MCP is Model Context Protocol lah, the open standard that connects AI assistants to tools and data."',
  'Elsewhere, end one or two sentences with a particle where a Malaysian would, such as lah, lor or mah, not the same one twice, and keep every name, number, menu and button exactly as it is.',
].join(' ');

const SCREEN_NOTE = (region) =>
  `This picture shows the user's screen around their mouse pointer${regionNote(region)}. Use it to see where they are: answer questions about "this" or "here" from it, and point to the buttons and menus you can see by name and position (for example "the blue Create button at the top right").`;

// The "server decides" router: a verified guide when one matches, otherwise Gemma.
// Gemma answers fast when the SOPs or guides cover the question (or it's small talk), and
// thinks first, with MCP tools such as web search, when nothing relevant was found.
// image: a highlighted region (always goes to Gemma). screen: the area around the pointer sent
// with a voice question (context only; guides still win). chats: every ask joins a chat (chatId,
// a new one for null), and the chat's last few turns go with the question, so follow-ups
// ("and then?") make sense. document: the whole deck or page in front (answered from directly,
// no web tools). onStep: live steps for the overlay's readout.
export function createAssist({ config, guides, docs, llm, mcp = null, chats = null }) {
  return async function assist({ question, context, tier = 'free', image, screen, document, targets, voice = false, userId = 'anonymous', chatId, onStep }) {
    const started = Date.now();
    const q = typeof question === 'string' ? question.trim() : '';
    if (!q) throw new HttpError(400, 'empty_question', 'Ask me something first.');
    if (q.length > 1000) throw new HttpError(400, 'question_too_long', 'Keep the question under 1,000 characters.');
    const ctx = cleanContext(context);
    const picture = image === undefined || image === null || image === '' ? null : checkImage(image);
    const view = picture || screen === undefined || screen === null || screen === '' ? null : checkImage(screen);
    const doc = cleanDocument(document);
    const step = (text) => {
      try {
        onStep?.(text);
      } catch {
        // the readout is a nicety; the answer matters
      }
    };
    if (picture) step('Looking at the highlighted area');
    else if (view) step('Looking at your screen');
    const base = { id: crypto.randomUUID(), tier };
    const thread = chats ? chats.resolve(userId, chatId) : null;
    const save = (turn) => {
      const saved = chats ? chats.add(userId, thread, { question: q, voice, ...turn }) : null;
      return saved ? { chatId: saved.id, chatTitle: saved.title, chatTurns: saved.turns.length } : { chatId: null };
    };

    // A highlighted region always goes to the model: it's a question about what's on screen.
    if (!picture && !wantsExplanation(q)) {
      step('Checking the guides');
      const hit = matchGuide(q, guides.list(), ctx);
      if (hit) {
        const g = hit.guide;
        step(`Found the guide “${g.title}”`);
        return {
          ...base,
          ...save({ answer: g.intro, source: 'guide', guide: { id: g.id, title: g.title } }),
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

    // Pro tries its model first and falls back to the base model if it isn't pulled.
    const candidates = tier === 'pro' && config.modelPro && config.modelPro !== config.model ? [config.modelPro, config.model] : [config.model];
    let model = null;
    async function ask(opts) {
      if (model) return llm.chat({ model, ...opts });
      for (const [i, m] of candidates.entries()) {
        try {
          const r = await llm.chat({ model: m, ...opts });
          model = m;
          return r;
        } catch (err) {
          if (err.code === 'model_missing' && i < candidates.length - 1) continue;
          throw err;
        }
      }
      return null;
    }

    const smallTalk = !picture && !doc && isSmallTalk(q);
    if (!smallTalk) step('Checking company procedures');
    const found = smallTalk ? { text: '', sources: [], relevant: true } : buildContext({ question: q, context: ctx, docs, guides });
    const usedDoc = found.sources.find((s) => s.type === 'doc');
    // "Sample SOP: logging site issues › Photos" shows as the section: "Using “Photos”".
    if (usedDoc) step(`Using “${String(usedDoc.heading).split('›').pop().trim().slice(0, 40) || usedDoc.file}”`);

    // A how-to question, no recorded guide, and the controls on screen: GOAT plans a guide from
    // the procedures and what's on screen. Without a plan that starts on a real control, it
    // answers in words as usual.
    const controls = !picture && HOW_TO.test(q) && !aboutAnotherApp(q, ctx) ? cleanTargets(targets) : [];
    if (controls.length) {
      step('Planning the steps');
      const history = chats ? chats.history(thread).slice(-2) : [];
      const plan = await planGuide({ chat: ask, question: q, ctx, procedures: found.text, doc, targets: controls, history });
      if (plan) {
        step(`Found “${plan.steps[0].label}” on screen`);
        const id = `planned-${base.id.slice(0, 8)}`;
        return {
          ...base,
          ...save({ answer: plan.intro, source: 'guide', guide: { id, title: q } }),
          source: 'guide',
          planned: true,
          say: plan.intro,
          guide: { id, title: q, intro: plan.intro, steps: plan.steps, planned: true },
          model,
          sources: found.sources,
          latencyMs: Date.now() - started,
        };
      }
    }

    const mode = config.think || 'auto';
    // Region and document asks stay quick unless thinking is always on.
    const deep = picture || doc ? mode === 'always' : !smallTalk && (mode === 'always' || (mode === 'auto' && !found.relevant));
    // Screen and document contents never go anywhere near web tools.
    const tools = deep && !picture && !view && !doc && mcp ? await mcp.tools() : [];

    const system = [SYSTEM_PROMPT, doc && DOC_PROMPT, voice && VOICE_PROMPT, voice && config.voiceStyle === 'manglish' && MANGLISH_PROMPT, deep && DEEP_PROMPT, tools.length && TOOLS_PROMPT].filter(Boolean).join(' ');
    const userText = smallTalk ? q : userMessage(q, ctx, found.text, { hideWindow: tools.length > 0, doc });
    const current = picture
      ? { role: 'user', content: `The user highlighted this part of the screen${regionNote(context?.region)}. The image shows it.\n\n${userText}`, images: [picture] }
      : view
        ? { role: 'user', content: `${SCREEN_NOTE(context?.region)}\n\n${userText}`, images: [view] }
        : { role: 'user', content: userText };
    const history = (chats ? chats.history(thread) : []).flatMap((t) => [
      { role: 'user', content: t.question },
      { role: 'assistant', content: t.answer },
    ]);
    const messages = [{ role: 'system', content: system }, ...history, current];

    const chat = (opts) => ask({ messages, ...opts });

    let answer;
    let thought = false;
    let thinking = deep;
    const searched = [];
    for (let round = 0; ; ) {
      const offerTools = tools.length > 0 && round < MAX_TOOL_ROUNDS;
      step(thinking ? 'Thinking it through' : 'Writing the answer');
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
          step(typeof args.query === 'string' && args.query ? `Searching the web for “${args.query.slice(0, 40)}”` : 'Searching the web');
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

    return {
      ...base,
      ...save({ answer: say, source: 'llm', image: Boolean(picture) }),
      source: 'llm',
      say,
      guide: null,
      model,
      thought,
      image: Boolean(picture),
      screen: Boolean(view),
      document: doc ? doc.kind : null,
      searched: searched.map(({ tool, query }) => ({ tool, query })),
      sources: [...found.sources, ...web],
      latencyMs: Date.now() - started,
    };
  };
}
