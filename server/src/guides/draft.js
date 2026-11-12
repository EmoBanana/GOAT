import { HttpError } from '../errors.js';

// GOAT-compatible: vendor docs -> a drafted guide (title, triggers, intro, steps with label and say).
// The recorder then supplies the coordinates, one drafted step at a time.
export const DRAFT_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    triggers: { type: 'array', items: { type: 'string' } },
    intro: { type: 'string' },
    steps: {
      type: 'array',
      items: { type: 'object', properties: { label: { type: 'string' }, say: { type: 'string' } }, required: ['label', 'say'] },
    },
  },
  required: ['title', 'triggers', 'intro', 'steps'],
};

export const DRAFT_PROMPT = [
  'You turn software documentation into a GOAT guide: a short list of clicks that a blue cursor will point at, one at a time.',
  'Each step is one click or one field. label: the button or field name exactly as it appears on screen (2 to 4 words). say: one short instruction, under 15 words.',
  'Use 3 to 10 steps. title: like "Export a PDF in Bluebeam". triggers: 3 to 5 short phrases people would type, like "export a pdf".',
  'intro: one sentence that ends with "Follow the blue cursor." Reply with JSON only.',
].join(' ');

const text = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

export function cleanDraft(raw) {
  const d = raw && typeof raw === 'object' ? raw : {};
  const triggers = [...new Set((Array.isArray(d.triggers) ? d.triggers : []).map((t) => text(t, 60).toLowerCase()).filter(Boolean))].slice(0, 5);
  const steps = (Array.isArray(d.steps) ? d.steps : [])
    .map((s) => ({ label: text(s?.label, 40), say: text(s?.say, 160) }))
    .filter((s) => s.label || s.say)
    .slice(0, 12)
    .map((s, i) => ({ label: s.label || `Step ${i + 1}`, say: s.say || `${s.label}.` }));
  return { title: text(d.title, 80), triggers, intro: text(d.intro, 200), steps };
}

function parseJson(reply) {
  try {
    return JSON.parse(reply);
  } catch {
    const m = /\{[\s\S]*\}/.exec(reply);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
}

export function mountDrafts(app, { config, llm }) {
  app.post('/api/guides/draft', async (req, res) => {
    const docs = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!docs) throw new HttpError(400, 'empty_docs', 'Paste the instructions you want to turn into a guide.');
    if (docs.length > 12_000) throw new HttpError(413, 'docs_too_long', 'Paste at most about 12,000 characters (one procedure).');
    const started = Date.now();
    const r = await llm.chat({
      model: config.model,
      temperature: 0.2,
      format: DRAFT_SCHEMA,
      messages: [
        { role: 'system', content: DRAFT_PROMPT },
        { role: 'user', content: `Documentation:\n${docs}` },
      ],
    });
    const draft = cleanDraft(parseJson(r.text));
    if (!draft.steps.length) throw new HttpError(502, 'draft_failed', "Gemma couldn't draft steps from that text. Try pasting just one procedure.");
    res.json({ draft, model: r.model, latencyMs: Date.now() - started });
  });
}
