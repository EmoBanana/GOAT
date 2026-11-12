import { HttpError } from '../errors.js';
import { sanitizeUserId } from '../users.js';
import { localDate } from './activity.js';
import { createDescriber } from './describe.js';
import { summarize, toCsv } from './summary.js';
import { buildTimeline, siteOf } from './timeline.js';

const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function dateFrom(value) {
  const date = value === undefined || value === '' ? localDate() : String(value);
  if (!DATE.test(date)) throw new HttpError(400, 'bad_date', 'Dates look like 2026-11-12.');
  return date;
}

// Timesheet routes. Privacy: only allowlisted apps are stored; a browser tab is kept as its site
// name (canva.com), never its address; GOAT guides used while tracking are noted by name. The
// day's activity lines are written by the model on this laptop.
export function mountTimesheet(app, { projects, activity, llm = null, config = {}, logger = console }) {
  const describe = createDescriber({
    chat: llm ? (opts) => llm.chat({ model: config.model, ...opts }) : null,
    activity,
    logger,
  });

  app.get('/api/timesheet/config', (_req, res) => {
    res.json({ trackedApps: projects.trackedApps, browserApps: projects.browserApps });
  });

  app.post('/api/activity', (req, res) => {
    const samples = req.body?.samples;
    if (!Array.isArray(samples)) throw new HttpError(400, 'bad_activity', 'Send { samples: [...] }.');
    if (samples.length > 500) throw new HttpError(413, 'too_many_samples', 'Send at most 500 samples at a time.');
    const kept = [];
    let dropped = 0;
    for (const s of samples) {
      const appName = text(s?.app, 120);
      const ts = new Date(s?.ts);
      const tracked = Boolean(appName) && projects.isTracked(appName);
      const site = tracked ? siteOf(s?.site || s?.url) : '';
      if (Number.isNaN(ts.getTime()) || (s?.kind !== undefined && s.kind !== 'guide')) {
        dropped += 1;
        continue;
      }
      // A GOAT guide used while tracking: its name goes into the activity's line.
      if (s.kind === 'guide') {
        const guide = text(s.guide, 120);
        if (!guide) {
          dropped += 1;
          continue;
        }
        kept.push({ ts: ts.toISOString(), kind: 'guide', guide, ...(tracked ? { app: appName } : {}), ...(site ? { site } : {}) });
        continue;
      }
      if (!tracked) {
        dropped += 1;
        continue;
      }
      const title = text(s?.title, 300);
      const project = projects.projectFor(title, site);
      kept.push({
        ts: ts.toISOString(),
        app: appName,
        title,
        ...(site ? { site } : {}),
        idle: Boolean(s.idle),
        sec: Math.min(300, Math.max(1, Number(s.sec) || 10)),
        code: project ? project.code : null,
        name: project ? project.name : null,
      });
    }
    if (kept.length) activity.append(req.userId, kept);
    res.json({ stored: kept.length, dropped });
  });

  async function timesheet(user, date) {
    const records = activity.read(user, date);
    const summary = summarize(records);
    const activities = await describe(user, date, buildTimeline(records));
    const approval = activity.approval(user, date);
    return { user, date, ...summary, activities, approved: approval ? { at: approval.approvedAt } : false };
  }

  app.get('/api/timesheet', async (req, res) => {
    res.json(await timesheet(req.userId, dateFrom(req.query.date)));
  });

  // Opened in the browser, which can't send x-goat-user, so ?user= works too.
  app.get('/api/timesheet.csv', async (req, res) => {
    const user = req.query.user ? sanitizeUserId(String(req.query.user)) : req.userId;
    const t = await timesheet(user, dateFrom(req.query.date));
    res.type('text/csv').attachment(`goat-timesheet-${user}-${t.date}.csv`).send(toCsv({ user, date: t.date, activities: t.activities, approved: Boolean(t.approved) }));
  });

  app.post('/api/timesheet/approve', async (req, res) => {
    const date = dateFrom(req.body?.date);
    const t = await timesheet(req.userId, date);
    if (!t.entries.length && !t.unassignedMinutes) throw new HttpError(400, 'nothing_to_approve', 'Nothing was tracked on that day.');
    const { entries, totalMinutes, unassignedMinutes, idleMinutes, activities } = t;
    const record = activity.approve(req.userId, date, { entries, totalMinutes, unassignedMinutes, idleMinutes, activities });
    res.json({ ...t, approved: { at: record.approvedAt } });
  });
}
