import crypto from 'node:crypto';

// A browser tab's site: the host name only, never the address
// ("https://www.canva.com/design/x/edit?y=1" -> "canva.com"). Anything else gives ''.
export function siteOf(value) {
  const v = String(value || '').trim().toLowerCase();
  if (!v) return '';
  let host = v;
  if (/^[a-z][a-z0-9+.-]*:/.test(v)) {
    try {
      const u = new URL(v);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
      host = u.hostname;
    } catch {
      return '';
    }
  }
  host = host.replace(/^www\./, '');
  return host.length <= 253 && /^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(host) ? host : '';
}

const MAX_TITLES = 6;
const GUIDE_REACH_MS = 5 * 60_000;
const secOf = (r) => (Number(r.sec) > 0 ? Number(r.sec) : 10);
const keyOf = (b) => crypto.createHash('sha256').update(JSON.stringify([b.app, b.site, b.titles, b.guides])).digest('hex').slice(0, 16);

// A guide belongs to the stretch it was used in, else the nearest one within five minutes; on a
// tie, the one in the same app, then the later one (the user had just switched to it).
function blockFor(blocks, g) {
  const compare = (x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  let best = null;
  let bestRank = null;
  for (const b of blocks) {
    const gap = g.t < b.start ? b.start - g.t : g.t > b.end ? g.t - b.end : 0;
    if (gap > GUIDE_REACH_MS) continue;
    const rank = [gap, g.app && b.app === g.app ? 0 : 1, -b.start];
    if (!bestRank || compare(rank, bestRank) < 0) {
      best = b;
      bestRank = rank;
    }
  }
  return best;
}

// The day's samples as activities: stretches of time in one app or website, with the window
// titles seen there and the GOAT guides used. A stretch ends when the app or site changes, at
// idle time, or when samples stop for longer than two missed ones (time in apps that aren't
// tracked). Its project is the one most of its time went to.
export function buildTimeline(records) {
  const timed = (records || []).filter((r) => r && Number.isFinite(Date.parse(r.ts))).sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const blocks = [];
  const guides = [];
  let open = null;
  for (const r of timed) {
    const t = Date.parse(r.ts);
    if (r.kind === 'guide') {
      if (r.guide) guides.push({ t, guide: String(r.guide), app: r.app || '' });
      continue;
    }
    if (r.kind) continue;
    if (r.idle) {
      open = null;
      continue;
    }
    const sec = secOf(r);
    const site = r.site || '';
    if (!(open && open.app === r.app && open.site === site && t - open.last <= open.lastSec * 3000)) {
      open = { app: r.app, site, start: t, end: t, sec: 0, titles: [], guides: [], codes: new Map() };
      blocks.push(open);
    }
    open.sec += sec;
    open.end = Math.max(open.end, t + sec * 1000);
    open.last = t;
    open.lastSec = sec;
    if (r.title && !open.titles.includes(r.title) && open.titles.length < MAX_TITLES) open.titles.push(r.title);
    if (r.code) {
      const c = open.codes.get(r.code) || { code: r.code, name: r.name || r.code, sec: 0 };
      c.sec += sec;
      open.codes.set(r.code, c);
    }
  }
  for (const g of guides) {
    const b = blockFor(blocks, g);
    if (b && !b.guides.includes(g.guide)) b.guides.push(g.guide);
  }
  return blocks.map((b) => {
    const project = [...b.codes.values()].sort((x, y) => y.sec - x.sec)[0] || null;
    return {
      key: keyOf(b),
      start: new Date(b.start).toISOString(),
      end: new Date(b.end).toISOString(),
      minutes: Math.round((b.sec / 60) * 10) / 10,
      app: b.app,
      site: b.site,
      titles: b.titles,
      guides: b.guides,
      code: project ? project.code : null,
      name: project ? project.name : null,
    };
  });
}
