import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from '../errors.js';

export function slugify(title) {
  const slug = String(title ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return slug || 'guide';
}

const text = (v) => (typeof v === 'string' ? v.trim() : '');

// Triggers and apps arrive as an array or a comma-separated string.
export function toList(value) {
  if (Array.isArray(value)) return value.map((v) => text(String(v ?? ''))).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}

function joinList(items) {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

// Returns a clean guide or throws a 400 that says what's missing.
// The id is slugified from opts.id when given (files on disk), else from the title.
export function validateGuide(input, opts = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new HttpError(400, 'invalid_guide', 'Send the guide as a JSON object.');
  }
  const problems = [];
  const title = text(input.title);
  if (!title) problems.push('a title');
  const triggers = toList(input.triggers);
  if (!triggers.length) problems.push('at least one trigger phrase');
  const rawSteps = Array.isArray(input.steps) ? input.steps : [];
  if (!rawSteps.length) problems.push('at least one step');

  const steps = [];
  rawSteps.forEach((s, i) => {
    const x = Number(s?.x);
    const y = Number(s?.y);
    if (s?.x === '' || s?.y === '' || s?.x == null || s?.y == null || !Number.isFinite(x) || !Number.isFinite(y)) {
      problems.push(`numeric x and y on step ${i + 1}`);
      return;
    }
    const label = text(s.label) || `Step ${i + 1}`;
    const step = { x: Math.round(x), y: Math.round(y), label, say: text(s.say) || `${label}.` };
    const waitMs = Number(s.waitMs);
    if (Number.isFinite(waitMs) && waitMs > 0) step.waitMs = Math.round(waitMs);
    // The control to find on screen at play time (its points above are the fallback).
    const target = typeof s.target === 'string' ? text(s.target) : text(s.target?.label);
    if (target) step.target = { label: target.slice(0, 80), role: text(s.target?.role).slice(0, 20) };
    steps.push(step);
  });
  if (problems.length) throw new HttpError(400, 'invalid_guide', `A guide needs ${joinList(problems)}.`);

  const guide = {
    id: slugify(opts.id || title),
    title,
    intro: text(input.intro) || `Let's ${title.charAt(0).toLowerCase()}${title.slice(1)}. Follow the blue cursor.`,
    triggers,
    apps: toList(input.apps),
    steps,
  };
  if (text(input.context)) guide.context = text(input.context);
  if (text(input.recordedOn)) guide.recordedOn = text(input.recordedOn);
  return guide;
}

export function publicGuide(g) {
  const { createdAt, file, ...rest } = g;
  return rest;
}

export function guideSummary(g) {
  return { id: g.id, title: g.title, triggers: g.triggers, apps: g.apps, steps: g.steps.length };
}

export function createGuideStore({ dir, logger = console }) {
  const guides = new Map();

  function load() {
    guides.clear();
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    for (const file of files) {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
        const guide = validateGuide(raw, { id: raw?.id || path.basename(file, '.json') });
        guides.set(guide.id, { ...guide, createdAt: Number(raw.createdAt) || 0, file });
      } catch (err) {
        logger.warn(`[guides] Skipped ${file}: ${err.message}`);
      }
    }
  }

  // Recorder saves: the id comes from the title; saving the same title again replaces it.
  function save(input) {
    const guide = validateGuide(input);
    const record = { ...guide, createdAt: Date.now() };
    fs.mkdirSync(dir, { recursive: true });
    const file = `${guide.id}.json`;
    fs.writeFileSync(path.join(dir, file), `${JSON.stringify(record, null, 2)}\n`);
    guides.set(guide.id, { ...record, file });
    return record;
  }

  load();
  return {
    dir,
    list: () => [...guides.values()],
    get: (id) => guides.get(id) || null,
    count: () => guides.size,
    save,
    reload: load,
  };
}
