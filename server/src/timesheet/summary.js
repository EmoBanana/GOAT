const minutes = (sec) => Math.round((sec / 60) * 10) / 10;
const hours = (sec) => Math.round((sec / 3600) * 100) / 100;

// Samples -> time per project. Idle time is reported but never billed.
export function summarize(records) {
  const byCode = new Map();
  let unassigned = 0;
  let idle = 0;
  for (const r of records) {
    if (r.kind) continue; // GOAT guides used: notes for the activity lines, not time
    const sec = Number(r.sec) > 0 ? Number(r.sec) : 10;
    if (r.idle) {
      idle += sec;
      continue;
    }
    if (!r.code) {
      unassigned += sec;
      continue;
    }
    const e = byCode.get(r.code) || { code: r.code, name: r.name || r.code, sec: 0, apps: new Set() };
    e.sec += sec;
    if (r.app) e.apps.add(r.app);
    byCode.set(r.code, e);
  }
  const entries = [...byCode.values()]
    .sort((a, b) => b.sec - a.sec)
    .map((e) => ({ code: e.code, name: e.name, minutes: minutes(e.sec), hours: hours(e.sec), apps: [...e.apps].sort() }));
  const assigned = [...byCode.values()].reduce((sum, e) => sum + e.sec, 0);
  return { entries, totalMinutes: minutes(assigned + unassigned), unassignedMinutes: minutes(unassigned), idleMinutes: minutes(idle) };
}

const cell = (value) => {
  let s = String(value ?? '');
  if (/^[=+\-@]/.test(s)) s = `'${s}`; // no spreadsheet formulas from window names
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// The laptop's local time, HH:MM.
export function clock(iso) {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// One row per activity, in order: when, how long, the project and what was done.
export function toCsv({ user, date, activities, approved }) {
  const yes = approved ? 'yes' : 'no';
  const rows = [['Date', 'User', 'Start', 'End', 'Minutes', 'Project code', 'Project', 'Activity', 'App', 'Website', 'Approved']];
  for (const a of activities) {
    rows.push([date, user, clock(a.start), clock(a.end), a.minutes, a.code || '', a.code ? a.name : 'Unassigned', a.summary, a.app, a.site || '', yes]);
  }
  return `${rows.map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`;
}
