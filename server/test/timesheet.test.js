import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { ROOT } from '../src/config.js';
import { localDate } from '../src/timesheet/activity.js';
import { ACTIVITY_SYSTEM, activityPrompt, createDescriber, parseLines, plainLine } from '../src/timesheet/describe.js';
import { loadProjects } from '../src/timesheet/projects.js';
import { summarize, toCsv } from '../src/timesheet/summary.js';
import { buildTimeline, siteOf } from '../src/timesheet/timeline.js';
import { sanitizeUserId } from '../src/users.js';
import { startMockOllama } from './helpers/mock-ollama.js';
import { startTestServer } from './helpers/test-server.js';

const projects = loadProjects(path.join(ROOT, 'config', 'projects.json'));

test('project codes come from config patterns first, then ISO 19650 file names', () => {
  assert.deepEqual(projects.projectFor('ALP-GAM-ZZ-XX-M3-S-0001.rvt - Revit'), { code: 'ALPHA', name: 'Sample: Alpha Viaduct' });
  assert.deepEqual(projects.projectFor('Bravo station steel.xlsx'), { code: 'BRAVO', name: 'Sample: Bravo Station' });
  assert.deepEqual(projects.projectFor('DLT-GAM-ZZ-XX-M3-S-0042.rvt'), { code: 'DLT', name: 'DLT (from the file name)' });
  assert.deepEqual(projects.projectFor('', 'https://docs.example.com/hackathon/plan'), { code: 'GOAT', name: 'GOAT hackathon' });
  assert.equal(projects.projectFor('Book1.xlsx'), null);
  assert.equal(projects.isTracked('revit'), true);
  assert.equal(projects.isTracked('Canva'), true);
  assert.equal(projects.isTracked('Spotify'), false);
  assert.equal(projects.isBrowser('Google Chrome'), true);
  assert.equal(projects.isBrowser('Brave Browser'), true);
});

test('the summary bills project time, keeps unassigned apart and never bills idle time or guide notes', () => {
  const s = summarize([
    { app: 'Revit', code: 'ALPHA', name: 'Alpha', sec: 600 },
    { app: 'Google Chrome', code: 'ALPHA', name: 'Alpha', sec: 300 },
    { app: 'Keynote', code: 'GOAT', name: 'GOAT', sec: 1200 },
    { app: 'Microsoft Excel', code: null, sec: 120 },
    { app: 'Revit', code: 'ALPHA', name: 'Alpha', sec: 900, idle: true },
    { kind: 'guide', guide: 'Create a form', app: 'Google Chrome' },
  ]);
  assert.deepEqual(s.entries, [
    { code: 'GOAT', name: 'GOAT', minutes: 20, hours: 0.33, apps: ['Keynote'] },
    { code: 'ALPHA', name: 'Alpha', minutes: 15, hours: 0.25, apps: ['Google Chrome', 'Revit'] },
  ]);
  assert.equal(s.totalMinutes, 37);
  assert.equal(s.unassignedMinutes, 2);
  assert.equal(s.idleMinutes, 15);
});

test('the CSV has one row per activity with its times, and defuses formulas', () => {
  const local = (h, m) => new Date(2026, 10, 12, h, m).toISOString();
  const csv = toCsv({
    user: 'pat',
    date: '2026-11-12',
    approved: true,
    activities: [
      { start: local(10, 2), end: local(10, 6), minutes: 4, code: 'GOAT', name: 'GOAT hackathon', summary: 'Worked on the pitch deck in Canva.', app: 'Google Chrome', site: 'canva.com' },
      { start: local(10, 6), end: local(10, 9), minutes: 3, code: null, name: null, summary: '=HYPERLINK("x")', app: 'Microsoft Excel', site: '' },
    ],
  });
  const lines = csv.trim().split('\r\n');
  assert.equal(lines[0], 'Date,User,Start,End,Minutes,Project code,Project,Activity,App,Website,Approved');
  assert.equal(lines[1], '2026-11-12,pat,10:02,10:06,4,GOAT,GOAT hackathon,Worked on the pitch deck in Canva.,Google Chrome,canva.com,yes');
  assert.equal(lines[2], `2026-11-12,pat,10:06,10:09,3,,Unassigned,"'=HYPERLINK(""x"")",Microsoft Excel,,yes`);
});

test('a site is the host name only, never the address', () => {
  assert.equal(siteOf('https://www.canva.com/design/DAF1/edit?ui=x#y'), 'canva.com');
  assert.equal(siteOf('acc.autodesk.com'), 'acc.autodesk.com');
  assert.equal(siteOf('WWW.Example.COM'), 'example.com');
  assert.equal(siteOf('http://127.0.0.1:8402/account/?code=1'), '127.0.0.1');
  assert.equal(siteOf('chrome://newtab/'), '');
  assert.equal(siteOf('file:///Users/me/drawing.pdf'), '');
  assert.equal(siteOf('acc.autodesk.com/build/forms'), '');
  assert.equal(siteOf(''), '');
});

describe('the timeline', () => {
  const t0 = Date.parse('2026-11-12T02:00:00Z');
  const at = (s) => new Date(t0 + s * 1000).toISOString();
  const run = (from, n, fields) => Array.from({ length: n }, (_, i) => ({ ts: at(from + i * 10), sec: 10, idle: false, code: null, name: null, ...fields }));

  test('stretches in one app or site become activities with start, end and minutes', () => {
    const records = [
      ...run(0, 6, { app: 'Google Chrome', site: 'canva.com', title: 'Pitch - Presentation', code: 'GOAT', name: 'GOAT hackathon' }),
      ...run(60, 3, { app: 'Google Chrome', site: 'acc.autodesk.com', title: 'Forms - ALPHA Viaduct', code: 'ALPHA', name: 'Alpha' }),
      ...run(90, 2, { app: 'Google Chrome', site: 'acc.autodesk.com', title: 'New form', code: null }),
      ...run(110, 3, { app: 'Revit', title: 'ALP-GAM-ZZ-XX-M3-S-0001.rvt', code: 'ALPHA', name: 'Alpha' }),
    ];
    const t = buildTimeline(records.reverse()); // order on disk doesn't matter
    assert.deepEqual(
      t.map((a) => [a.app, a.site, a.start, a.end, a.minutes, a.code, a.titles]),
      [
        ['Google Chrome', 'canva.com', at(0), at(60), 1, 'GOAT', ['Pitch - Presentation']],
        ['Google Chrome', 'acc.autodesk.com', at(60), at(110), 0.8, 'ALPHA', ['Forms - ALPHA Viaduct', 'New form']],
        ['Revit', '', at(110), at(140), 0.5, 'ALPHA', ['ALP-GAM-ZZ-XX-M3-S-0001.rvt']],
      ],
    );
  });

  test('idle time and a gap of more than two missed samples end a stretch', () => {
    const records = [
      ...run(0, 3, { app: 'Revit', title: 'A.rvt' }),
      { ts: at(30), app: 'Revit', title: 'A.rvt', sec: 10, idle: true },
      ...run(40, 2, { app: 'Revit', title: 'A.rvt' }),
      ...run(100, 2, { app: 'Revit', title: 'A.rvt' }), // 50 s without a sample: time in an untracked app
    ];
    assert.deepEqual(
      buildTimeline(records).map((a) => [a.start, a.end, a.minutes]),
      [
        [at(0), at(30), 0.5],
        [at(40), at(60), 0.3],
        [at(100), at(120), 0.3],
      ],
    );
  });

  test('a GOAT guide joins the stretch it was used in; one far from any stretch is left out', () => {
    const records = [
      ...run(0, 6, { app: 'Google Chrome', site: 'canva.com', title: 'Pitch' }),
      ...run(60, 6, { app: 'Google Chrome', site: 'acc.autodesk.com', title: 'Forms' }),
      { ts: at(75), kind: 'guide', guide: 'Create a form', app: 'Google Chrome' },
      { ts: at(75), kind: 'guide', guide: 'Create a form', app: 'Google Chrome' },
      { ts: at(3600), kind: 'guide', guide: 'Much later', app: 'Google Chrome' },
    ];
    const t = buildTimeline(records);
    assert.deepEqual(t.map((a) => a.guides), [[], ['Create a form']]);
  });

  test('a guide used just after switching sites joins the new site, not the one before', () => {
    // Seconds-long stretches: the guide comes 2 s into ACC, 3 s after Canva's last sample ended.
    const quick = (from, n, fields) => Array.from({ length: n }, (_, i) => ({ ts: at(from + i), sec: 1, ...fields }));
    const records = [
      ...quick(0, 6, { app: 'Google Chrome', site: 'canva.com', title: 'Pitch' }),
      ...quick(6, 6, { app: 'Google Chrome', site: 'acc.autodesk.com', title: 'Forms' }),
      { ts: at(8), kind: 'guide', guide: 'Create a form', app: 'Google Chrome' },
      { ts: at(30), kind: 'guide', guide: 'Asked after', app: 'Google Chrome' }, // after both: the nearer one
    ];
    assert.deepEqual(buildTimeline(records).map((a) => a.guides), [[], ['Create a form', 'Asked after']]);
  });

  test('an activity keeps its key while only its time grows, and gets a new one when what it shows changes', () => {
    const base = run(0, 3, { app: 'Revit', title: 'A.rvt' });
    const [a] = buildTimeline(base);
    const [longer] = buildTimeline([...base, ...run(30, 3, { app: 'Revit', title: 'A.rvt' })]);
    const [other] = buildTimeline([...base, ...run(30, 1, { app: 'Revit', title: 'B.rvt' })]);
    assert.equal(longer.key, a.key);
    assert.notEqual(other.key, a.key);
  });
});

describe('activity lines', () => {
  const act = (over) => ({ key: 'k1', app: 'Google Chrome', site: 'canva.com', titles: ['Pitch - Presentation'], guides: [], ...over });

  test('the prompt names apps, sites, titles and guides', () => {
    const prompt = activityPrompt([act(), act({ site: 'acc.autodesk.com', titles: ['Forms'], guides: ['Create a form'] }), act({ app: 'Revit', site: '', titles: [] })]);
    assert.equal(
      prompt,
      'Activities:\n' +
        '- id a1: Google Chrome, website canva.com. window titles: “Pitch - Presentation”.\n' +
        '- id a2: Google Chrome, website acc.autodesk.com. window titles: “Forms”. done with the GOAT guide “Create a form”.\n' +
        '- id a3: Revit.',
    );
    assert.match(ACTIVITY_SYSTEM, /a1: <line>/);
  });

  test('the model’s lines are read by id, tidied, and junk is ignored', () => {
    const text = 'Here you go:\na2: Created a form in Autodesk Construction Cloud.\n- a1 - "Worked on the pitch in Canva.com."\na9: out of range\na1: a second a1';
    assert.deepEqual(parseLines(text, 3), ['Worked on the pitch in Canva.', 'Created a form in Autodesk Construction Cloud.', '']);
    assert.deepEqual(parseLines('', 2), ['', '']);
  });

  test('lines are written once and kept; the guide stays in the line; without the model, plain lines', async () => {
    let notes = {};
    const store = { readNotes: () => ({ ...notes }), writeNotes: (_u, _d, n) => (notes = n) };
    const calls = [];
    const chat = async (opts) => {
      calls.push(opts);
      return { text: 'a1: Worked on the pitch in Canva.\na2: Created a form in Autodesk Construction Cloud.' };
    };
    const describe = createDescriber({ chat, activity: store, logger: { warn() {} } });
    const acts = [act(), act({ key: 'k2', site: 'acc.autodesk.com', titles: ['Forms'], guides: ['Create a form'] })];
    const out = await describe('pat', '2026-11-12', acts);
    assert.deepEqual(out.map((a) => [a.summary, a.described]), [
      ['Worked on the pitch in Canva.', true],
      ['Created a form in Autodesk Construction Cloud, with a GOAT guide.', true],
    ]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].timeoutMs, 40_000);
    await describe('pat', '2026-11-12', acts);
    assert.equal(calls.length, 1, 'kept, not written again');

    const offline = createDescriber({ chat: async () => { throw new Error('offline'); }, activity: { readNotes: () => ({}), writeNotes() {} }, logger: { warn() {} } });
    const plain = await offline('pat', '2026-11-12', acts);
    assert.deepEqual(plain.map((a) => [a.summary, a.described]), [
      ['canva.com: Pitch - Presentation', false],
      ['acc.autodesk.com: Forms (GOAT guide “Create a form”)', false],
    ]);
    assert.equal(plainLine({ app: 'Revit', site: '', titles: [], guides: [] }), 'Used Revit');
  });
});

test('user ids that would walk out of data/ are refused', () => {
  assert.equal(sanitizeUserId('..'), 'anonymous');
  assert.equal(sanitizeUserId('.'), 'anonymous');
  assert.equal(sanitizeUserId('a.b'), 'a.b');
});

describe('timesheet API', () => {
  let srv;
  // A fixed day: samples taken "a few minutes ago" just after midnight land on yesterday's file,
  // while a request without a date reads today's.
  const day = '2026-11-12';
  const at = (min) => new Date(2026, 10, 12, 10, 30 - min).toISOString();
  before(async () => {
    srv = await startTestServer(); // no model: activities get plain lines
  });
  after(async () => {
    await srv.close();
  });

  test('GET /api/timesheet/config gives the client its allowlist', async () => {
    const r = await srv.request('GET', '/api/timesheet/config');
    assert.ok(r.body.trackedApps.includes('Revit'));
    assert.ok(r.body.browserApps.includes('Safari'));
  });

  test('POST /api/activity keeps allowlisted apps, a browser tab as its site name only, and GOAT guides by name', async () => {
    const samples = [
      { ts: at(3), app: 'Revit', title: 'ALP-GAM-ZZ-XX-M3-S-0001.rvt', sec: 10 },
      { ts: at(3), app: 'Revit', title: 'ALP-GAM-ZZ-XX-M3-S-0001.rvt', sec: 10, idle: true },
      { ts: at(2), app: 'Google Chrome', title: 'BRAVO - Forma Build', url: 'https://acc.autodesk.com/issues?token=secret#x', sec: 10 },
      { ts: at(2), app: 'Google Chrome', title: 'Holiday ideas', site: 'www.YouTube.com', sec: 10 },
      { ts: at(2), kind: 'guide', guide: 'Log an issue in Forma Build', app: 'Google Chrome' },
      { ts: at(1), app: 'Spotify', title: 'Song', site: 'open.spotify.com', sec: 10 },
      { ts: at(1), app: 'Microsoft Excel', title: 'Book1.xlsx', sec: 10 },
      { ts: at(1), kind: 'guide', guide: '  ' },
      { ts: at(1), kind: 'keys', app: 'Revit' },
      { ts: 'not a date', app: 'Revit', title: 'x' },
    ];
    const r = await srv.request('POST', '/api/activity', { user: 'pat', body: { samples } });
    assert.deepEqual(r.body, { stored: 6, dropped: 4 });
    const file = path.join(srv.dataDir, 'activity', 'pat', `${day}.jsonl`);
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(
      lines.map((l) => [l.kind || l.app, l.code ?? null, l.site ?? '']),
      [
        ['Revit', 'ALPHA', ''],
        ['Revit', 'ALPHA', ''],
        ['Google Chrome', 'BRAVO', 'acc.autodesk.com'],
        ['Google Chrome', null, 'youtube.com'],
        ['guide', null, ''],
        ['Microsoft Excel', null, ''],
      ],
    );
    assert.deepEqual(lines[4], { ts: lines[4].ts, kind: 'guide', guide: 'Log an issue in Forma Build', app: 'Google Chrome' });
    const text = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /Spotify|spotify|secret|token|\/issues|https?:|"url"|keys/, 'no addresses, no untracked apps');
  });

  test('GET /api/timesheet gives the day by project and as activities with times', async () => {
    const r = await srv.request('GET', `/api/timesheet?date=${day}`, { user: 'pat' });
    assert.equal(r.body.date, day);
    assert.deepEqual(
      r.body.entries.map((e) => [e.code, e.minutes]),
      [['ALPHA', 0.2], ['BRAVO', 0.2]],
    );
    assert.equal(r.body.unassignedMinutes, 0.3);
    assert.equal(r.body.idleMinutes, 0.2);
    assert.equal(r.body.approved, false);
    assert.deepEqual(
      r.body.activities.map((a) => [a.app, a.site, a.code, a.guides, a.summary, a.described]),
      [
        ['Revit', '', 'ALPHA', [], 'Revit: ALP-GAM-ZZ-XX-M3-S-0001.rvt', false],
        ['Google Chrome', 'acc.autodesk.com', 'BRAVO', ['Log an issue in Forma Build'], 'acc.autodesk.com: BRAVO - Forma Build (GOAT guide “Log an issue in Forma Build”)', false],
        ['Google Chrome', 'youtube.com', null, [], 'youtube.com: Holiday ideas', false],
        ['Microsoft Excel', '', null, [], 'Microsoft Excel: Book1.xlsx', false],
      ],
    );
    for (const a of r.body.activities) assert.ok(Date.parse(a.start) < Date.parse(a.end));
    const other = await srv.request('GET', `/api/timesheet?date=${day}`, { user: 'someone-else' });
    assert.deepEqual(other.body.entries, []);
    assert.deepEqual(other.body.activities, []);
    const today = localDate();
    const plain = await srv.request('GET', '/api/timesheet', { user: 'pat' });
    assert.ok([today, localDate()].includes(plain.body.date), 'no date means today on the laptop');
    const bad = await srv.request('GET', '/api/timesheet?date=yesterday');
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, 'bad_date');
  });

  test('approve writes data/timesheets/<user>/<date>.json with the activities; the CSV works with ?user=', async () => {
    const none = await srv.request('POST', '/api/timesheet/approve', { user: 'nobody', body: {} });
    assert.equal(none.status, 400);
    const r = await srv.request('POST', '/api/timesheet/approve', { user: 'pat', body: { date: day } });
    assert.equal(r.status, 200);
    assert.ok(r.body.approved.at);
    const saved = JSON.parse(fs.readFileSync(path.join(srv.dataDir, 'timesheets', 'pat', `${day}.json`), 'utf8'));
    assert.equal(saved.user, 'pat');
    assert.equal(saved.entries.length, 2);
    assert.equal(saved.activities.length, 4);
    assert.ok((await srv.request('GET', `/api/timesheet?date=${day}`, { user: 'pat' })).body.approved.at);

    const csv = await srv.request('GET', `/api/timesheet.csv?user=pat&date=${day}`);
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-type'), /text\/csv/);
    assert.match(csv.headers.get('content-disposition'), new RegExp(`goat-timesheet-pat-${day}\\.csv`));
    assert.match(csv.text, /^Date,User,Start,End,Minutes,Project code,Project,Activity,App,Website,Approved\r\n/);
    assert.match(csv.text, /,\d\d:\d\d,\d\d:\d\d,0\.2,BRAVO,Sample: Bravo Station,acc\.autodesk\.com: BRAVO - Forma Build \(GOAT guide “Log an issue in Forma Build”\),Google Chrome,acc\.autodesk\.com,yes\r\n/);
  });
});

describe('the day, described by the model', () => {
  let srv;
  let ollama;
  // The mock writes "aN: Worked in <site or app>." for each activity in the prompt.
  const lines = (body) =>
    [...String(body.messages?.at(-1)?.content || '').matchAll(/- id (a\d+): ([^,.\n]+)(?:, website ([a-z0-9.-]+?)\.(?=\s|$))?/gm)].map((m) => `${m[1]}: Worked in ${m[3] || m[2]}.`).join('\n');
  before(async () => {
    ollama = await startMockOllama({ reply: (body) => (body.messages?.[0]?.content === ACTIVITY_SYSTEM ? lines(body) : 'Mock answer.') });
    srv = await startTestServer({ ollamaUrl: ollama.url });
  });
  after(async () => {
    await srv.close();
    await ollama.close();
  });

  test('each activity gets a line from the model, once; the model sees sites and titles, never addresses', async () => {
    // 10:00 on a fixed day, so a run just after midnight doesn't put the samples on yesterday.
    const t0 = new Date(2026, 10, 12, 10, 0).getTime();
    const day = localDate(new Date(t0));
    const at = (s) => new Date(t0 + s * 1000).toISOString();
    const samples = [];
    for (let i = 0; i < 6; i += 1) samples.push({ ts: at(i * 10), app: 'Google Chrome', title: 'GOAT pitch - Presentation', url: 'https://www.canva.com/design/DAF1/edit?ui=x', sec: 10 });
    for (let i = 0; i < 6; i += 1) samples.push({ ts: at(60 + i * 10), app: 'Google Chrome', title: 'Forms - ALPHA Viaduct', site: 'acc.autodesk.com', sec: 10 });
    samples.push({ ts: at(75), kind: 'guide', guide: 'Create a form', app: 'Google Chrome' });
    await srv.request('POST', '/api/activity', { user: 'ana', body: { samples } });

    const r = await srv.request('GET', `/api/timesheet?date=${day}`, { user: 'ana' });
    assert.deepEqual(
      r.body.activities.map((a) => [a.site, a.code, a.start, a.end, a.minutes, a.summary, a.described]),
      [
        ['canva.com', 'GOAT', at(0), at(60), 1, 'Worked in canva.com.', true],
        ['acc.autodesk.com', 'ALPHA', at(60), at(120), 1, 'Worked in acc.autodesk.com, with a GOAT guide.', true],
      ],
    );
    const asked = ollama.chats().filter((c) => c.body.messages?.[0]?.content === ACTIVITY_SYSTEM);
    assert.equal(asked.length, 1);
    assert.equal(asked[0].body.think, false);
    const prompt = asked[0].body.messages[1].content;
    assert.match(prompt, /website canva\.com\. window titles: “GOAT pitch - Presentation”/);
    assert.match(prompt, /done with the GOAT guide “Create a form”/);
    assert.doesNotMatch(prompt, /DAF1|edit|ui=x|https?:/);

    await srv.request('GET', `/api/timesheet?date=${day}`, { user: 'ana' });
    const csv = await srv.request('GET', `/api/timesheet.csv?user=ana&date=${day}`);
    assert.match(csv.text, /,Worked in acc\.autodesk\.com\, with a GOAT guide\.,|,"Worked in acc\.autodesk\.com, with a GOAT guide\.",/);
    assert.equal(ollama.chats().filter((c) => c.body.messages?.[0]?.content === ACTIVITY_SYSTEM).length, 1, 'kept, not written again');

    // A new stretch: only it goes to the model.
    await srv.request('POST', '/api/activity', { user: 'ana', body: { samples: [{ ts: at(200), app: 'Revit', title: 'ALP-GAM-ZZ-XX-M3-S-0001.rvt', sec: 10 }] } });
    const again = await srv.request('GET', `/api/timesheet?date=${day}`, { user: 'ana' });
    assert.equal(again.body.activities.at(-1).summary, 'Worked in Revit.');
    const second = ollama.chats().filter((c) => c.body.messages?.[0]?.content === ACTIVITY_SYSTEM).at(-1);
    assert.equal((second.body.messages[1].content.match(/- id a/g) || []).length, 1);
  });
});
