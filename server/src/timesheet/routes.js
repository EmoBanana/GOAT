import { stripQuery } from '../assist.js';
import { HttpError } from '../errors.js';
import { sanitizeUserId } from '../users.js';
import { localDate } from './activity.js';
import { summarize, toCsv } from './summary.js';

const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function dateFrom(value) {
  const date = value === undefined || value === '' ? localDate() : String(value);
  if (!DATE.test(date)) throw new HttpError(400, 'bad_date', 'Dates look like 2026-11-12.');
  return date;
}

// Timesheet routes. Privacy: only allowlisted apps are stored, browser windows only when they
// show project work, and URL query strings are stripped.
export function mountTimesheet(app, { projects, activity }) {
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
      const title = text(s?.title, 300);
      const url = stripQuery(text(s?.url, 500));
      const ts = new Date(s?.ts);
      if (!appName || Number.isNaN(ts.getTime()) || !projects.isTracked(appName)) {
        dropped += 1;
        continue;
      }
      const project = projects.projectFor(title, url);
      if (projects.isBrowser(appName) && !project) {
        dropped += 1;
        continue;
      }
      kept.push({
        ts: ts.toISOString(),
        app: appName,
        title,
        ...(url ? { url } : {}),
        idle: Boolean(s.idle),
        sec: Math.min(300, Math.max(1, Number(s.sec) || 10)),
        code: project ? project.code : null,
        name: project ? project.name : null,
      });
    }
    if (kept.length) activity.append(req.userId, kept);
    res.json({ stored: kept.length, dropped });
  });

  function timesheet(user, date) {
    const summary = summarize(activity.read(user, date));
    const approval = activity.approval(user, date);
    return { user, date, ...summary, approved: approval ? { at: approval.approvedAt } : false };
  }

  app.get('/api/timesheet', (req, res) => {
    res.json(timesheet(req.userId, dateFrom(req.query.date)));
  });

  // Opened in the browser, which can't send x-goat-user, so ?user= works too.
  app.get('/api/timesheet.csv', (req, res) => {
    const user = req.query.user ? sanitizeUserId(String(req.query.user)) : req.userId;
    const t = timesheet(user, dateFrom(req.query.date));
    res.type('text/csv').attachment(`goat-timesheet-${user}-${t.date}.csv`).send(toCsv({ user, date: t.date, summary: t, approved: Boolean(t.approved) }));
  });

  app.post('/api/timesheet/approve', (req, res) => {
    const date = dateFrom(req.body?.date);
    const summary = summarize(activity.read(req.userId, date));
    if (!summary.entries.length && !summary.unassignedMinutes) throw new HttpError(400, 'nothing_to_approve', 'Nothing was tracked on that day.');
    const record = activity.approve(req.userId, date, summary);
    res.json({ ...timesheet(req.userId, date), approved: { at: record.approvedAt } });
  });
}
