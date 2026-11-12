import fs from 'node:fs';
import path from 'node:path';

// The laptop's local date, YYYY-MM-DD.
export function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// data/activity/<user>/<date>.jsonl and data/timesheets/<user>/<date>.json
export function createActivityStore({ dataDir }) {
  const activityFile = (user, date) => path.join(dataDir, 'activity', user, `${date}.jsonl`);
  const approvalFile = (user, date) => path.join(dataDir, 'timesheets', user, `${date}.json`);

  function append(user, records) {
    const byDate = new Map();
    for (const r of records) {
      const date = localDate(new Date(r.ts));
      byDate.set(date, [...(byDate.get(date) || []), r]);
    }
    for (const [date, list] of byDate) {
      const file = activityFile(user, date);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, list.map((r) => `${JSON.stringify(r)}\n`).join(''));
    }
  }

  function read(user, date) {
    let text;
    try {
      text = fs.readFileSync(activityFile(user, date), 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    const out = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // a half-written line; skip it
      }
    }
    return out;
  }

  function approve(user, date, summary) {
    const record = { user, date, approvedAt: new Date().toISOString(), ...summary };
    const file = approvalFile(user, date);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
    return record;
  }

  function approval(user, date) {
    try {
      return JSON.parse(fs.readFileSync(approvalFile(user, date), 'utf8'));
    } catch {
      return null;
    }
  }

  return { append, read, approve, approval, activityFile, approvalFile };
}
