import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { ROOT } from '../src/config.js';
import { localDate } from '../src/timesheet/activity.js';
import { loadProjects } from '../src/timesheet/projects.js';
import { summarize, toCsv } from '../src/timesheet/summary.js';
import { sanitizeUserId } from '../src/users.js';
import { startTestServer } from './helpers/test-server.js';

const projects = loadProjects(path.join(ROOT, 'config', 'projects.json'));

test('project codes come from config patterns first, then ISO 19650 file names', () => {
  assert.deepEqual(projects.projectFor('ALP-GAM-ZZ-XX-M3-S-0001.rvt - Revit'), { code: 'ALPHA', name: 'Sample: Alpha Viaduct' });
  assert.deepEqual(projects.projectFor('Bravo station steel.xlsx'), { code: 'BRAVO', name: 'Sample: Bravo Station' });
  assert.deepEqual(projects.projectFor('DLT-GAM-ZZ-XX-M3-S-0042.rvt'), { code: 'DLT', name: 'DLT (from the file name)' });
  assert.deepEqual(projects.projectFor('', 'https://docs.example.com/hackathon/plan'), { code: 'GOAT', name: 'GOAT hackathon' });
  assert.equal(projects.projectFor('Book1.xlsx'), null);
  assert.equal(projects.isTracked('revit'), true);
  assert.equal(projects.isTracked('Spotify'), false);
  assert.equal(projects.isBrowser('Google Chrome'), true);
});

test('the summary bills project time, keeps unassigned apart and never bills idle time', () => {
  const s = summarize([
    { app: 'Revit', code: 'ALPHA', name: 'Alpha', sec: 600 },
    { app: 'Google Chrome', code: 'ALPHA', name: 'Alpha', sec: 300 },
    { app: 'Keynote', code: 'GOAT', name: 'GOAT', sec: 1200 },
    { app: 'Microsoft Excel', code: null, sec: 120 },
    { app: 'Revit', code: 'ALPHA', name: 'Alpha', sec: 900, idle: true },
  ]);
  assert.deepEqual(s.entries, [
    { code: 'GOAT', name: 'GOAT', minutes: 20, hours: 0.33, apps: ['Keynote'] },
    { code: 'ALPHA', name: 'Alpha', minutes: 15, hours: 0.25, apps: ['Google Chrome', 'Revit'] },
  ]);
  assert.equal(s.totalMinutes, 37);
  assert.equal(s.unassignedMinutes, 2);
  assert.equal(s.idleMinutes, 15);
  const csv = toCsv({ user: 'pat', date: '2026-11-12', summary: { ...s, entries: [...s.entries, { code: 'X', name: '=HYPERLINK("x")', minutes: 1, hours: 0.02, apps: [] }] }, approved: true });
  const lines = csv.trim().split('\r\n');
  assert.equal(lines[0], 'Date,User,Project code,Project,Hours,Minutes,Apps,Approved');
  assert.equal(lines[2], '2026-11-12,pat,ALPHA,Alpha,0.25,15,Google Chrome; Revit,yes');
  assert.match(lines[3], /,"'=HYPERLINK\(""x""\)",/, 'formulas are defused');
  assert.equal(lines.at(-1), '2026-11-12,pat,,Unassigned,0.03,2,,yes');
});

test('user ids that would walk out of data/ are refused', () => {
  assert.equal(sanitizeUserId('..'), 'anonymous');
  assert.equal(sanitizeUserId('.'), 'anonymous');
  assert.equal(sanitizeUserId('a.b'), 'a.b');
});

describe('timesheet API', () => {
  let srv;
  const today = localDate();
  const at = (min) => new Date(Date.now() - min * 60_000).toISOString();
  before(async () => {
    srv = await startTestServer();
  });
  after(async () => {
    await srv.close();
  });

  test('GET /api/timesheet/config gives the client its allowlist', async () => {
    const r = await srv.request('GET', '/api/timesheet/config');
    assert.ok(r.body.trackedApps.includes('Revit'));
    assert.ok(r.body.browserApps.includes('Safari'));
  });

  test('POST /api/activity keeps allowlisted project work and drops the rest', async () => {
    const samples = [
      { ts: at(3), app: 'Revit', title: 'ALP-GAM-ZZ-XX-M3-S-0001.rvt', sec: 10 },
      { ts: at(3), app: 'Revit', title: 'ALP-GAM-ZZ-XX-M3-S-0001.rvt', sec: 10, idle: true },
      { ts: at(2), app: 'Google Chrome', title: 'BRAVO - Forma Build', url: 'https://acc.autodesk.com/issues?token=secret#x', sec: 10 },
      { ts: at(2), app: 'Google Chrome', title: 'YouTube', url: 'https://youtube.com/watch?v=1', sec: 10 },
      { ts: at(1), app: 'Spotify', title: 'Song', sec: 10 },
      { ts: at(1), app: 'Microsoft Excel', title: 'Book1.xlsx', sec: 10 },
      { ts: 'not a date', app: 'Revit', title: 'x' },
    ];
    const r = await srv.request('POST', '/api/activity', { user: 'pat', body: { samples } });
    assert.deepEqual(r.body, { stored: 4, dropped: 3 });
    const file = path.join(srv.dataDir, 'activity', 'pat', `${today}.jsonl`);
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => [l.app, l.code]), [['Revit', 'ALPHA'], ['Revit', 'ALPHA'], ['Google Chrome', 'BRAVO'], ['Microsoft Excel', null]]);
    assert.equal(lines[2].url, 'https://acc.autodesk.com/issues', 'query strings are stripped');
    const text = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /Spotify|YouTube|secret/);
  });

  test('GET /api/timesheet summarises the day by project', async () => {
    const r = await srv.request('GET', '/api/timesheet', { user: 'pat' });
    assert.equal(r.body.date, today);
    assert.deepEqual(
      r.body.entries.map((e) => [e.code, e.minutes]),
      [['ALPHA', 0.2], ['BRAVO', 0.2]],
    );
    assert.equal(r.body.unassignedMinutes, 0.2);
    assert.equal(r.body.idleMinutes, 0.2);
    assert.equal(r.body.approved, false);
    const other = await srv.request('GET', '/api/timesheet', { user: 'someone-else' });
    assert.deepEqual(other.body.entries, []);
    const bad = await srv.request('GET', '/api/timesheet?date=yesterday');
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, 'bad_date');
  });

  test('approve writes data/timesheets/<user>/<date>.json; the CSV works with ?user=', async () => {
    const none = await srv.request('POST', '/api/timesheet/approve', { user: 'nobody', body: {} });
    assert.equal(none.status, 400);
    const r = await srv.request('POST', '/api/timesheet/approve', { user: 'pat', body: { date: today } });
    assert.equal(r.status, 200);
    assert.ok(r.body.approved.at);
    const saved = JSON.parse(fs.readFileSync(path.join(srv.dataDir, 'timesheets', 'pat', `${today}.json`), 'utf8'));
    assert.equal(saved.user, 'pat');
    assert.equal(saved.entries.length, 2);
    assert.ok((await srv.request('GET', '/api/timesheet', { user: 'pat' })).body.approved.at);

    const csv = await srv.request('GET', `/api/timesheet.csv?user=pat&date=${today}`);
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-type'), /text\/csv/);
    assert.match(csv.headers.get('content-disposition'), new RegExp(`goat-timesheet-pat-${today}\\.csv`));
    assert.match(csv.text, /ALPHA,Sample: Alpha Viaduct,0\.00,0\.2,Revit,yes/);
  });
});
