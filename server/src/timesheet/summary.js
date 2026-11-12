const minutes = (sec) => Math.round((sec / 60) * 10) / 10;
const hours = (sec) => Math.round((sec / 3600) * 100) / 100;

// Samples -> time per project. Idle time is reported but never billed.
export function summarize(records) {
  const byCode = new Map();
  let unassigned = 0;
  let idle = 0;
  for (const r of records) {
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

export function toCsv({ user, date, summary, approved }) {
  const yes = approved ? 'yes' : 'no';
  const rows = [['Date', 'User', 'Project code', 'Project', 'Hours', 'Minutes', 'Apps', 'Approved']];
  for (const e of summary.entries) rows.push([date, user, e.code, e.name, e.hours.toFixed(2), e.minutes, e.apps.join('; '), yes]);
  if (summary.unassignedMinutes > 0) {
    rows.push([date, user, '', 'Unassigned', (summary.unassignedMinutes / 60).toFixed(2), summary.unassignedMinutes, '', yes]);
  }
  return `${rows.map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`;
}
