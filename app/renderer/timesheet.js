// Timesheet tracking UI: a red dot rides with the blue cursor while tracking, and the panel that
// opens when tracking stops shows the day as activities (when, what was done, the project) and
// the time by project, with Approve and Export CSV.
(function () {
  'use strict';

  const ui = window.GOATUI;
  const goat = window.goat || {};
  if (!ui) return;

  const dot = ui.el('span', 'track-dot');
  ui.cursorEl.append(dot);
  let current = null;
  // Main opens the panel at once (loading), then sends the day once its lines are written. If
  // the panel is closed meanwhile, it stays closed.
  let phase = 'idle'; // idle | loading | dismissed
  const isOpen = () => (ui.state().panel || {}).name === 'timesheet';

  ui.onEvent('tracking', (msg) => {
    ui.cursorEl.classList.toggle('tracking', Boolean(msg.on));
    ui.toast(msg.on ? `Tracking on. ${ui.hotkey('track')} again to stop and see today's timesheet.` : 'Tracking off.');
  });
  ui.onEvent('open-timesheet', (msg) => {
    if (msg.loading) {
      openSheet(null);
      phase = 'loading';
      return;
    }
    if (isOpen()) render(document.getElementById('goat-panel'), msg.timesheet);
    else if (phase !== 'dismissed') openSheet(msg.timesheet);
    phase = 'idle';
  });
  ui.onEvent('panel:close', (msg) => {
    if (msg.name === 'timesheet' && phase === 'loading') phase = 'dismissed';
  });

  const hours = (minutes) => (Number(minutes || 0) / 60).toFixed(2);
  function prettyDate(date) {
    const d = new Date(`${date}T12:00:00`);
    return Number.isNaN(d.getTime()) ? String(date || '') : d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  }
  const pad = (n) => String(n).padStart(2, '0');
  function clock(iso) {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function span(a) {
    const from = clock(a.start);
    const to = clock(a.end);
    return from === to ? from : `${from}–${to}`;
  }
  function duration(minutes) {
    const m = Number(minutes) || 0;
    if (m < 1) return `${Math.max(1, Math.round(m * 60))} s`;
    if (m < 60) return `${Math.round(m)} min`;
    return `${Math.floor(m / 60)} h ${pad(Math.round(m % 60))} min`;
  }

  const HTML =
    '<div class="ts">' +
    '<div class="form-head"><strong>Today\'s timesheet</strong><span class="ts-status"></span></div>' +
    '<div class="form-sub ts-date"></div>' +
    '<p class="ts-loading" hidden>Writing up your day…</p>' +
    '<ol class="ts-acts" hidden></ol>' +
    '<div class="card-label ts-by" hidden>By project</div>' +
    '<table class="ts-table"><thead><tr><th>Project</th><th class="num">Hours</th><th>Apps</th></tr></thead><tbody></tbody></table>' +
    '<div class="ts-empty" hidden></div><div class="ts-note"></div>' +
    '<div class="form-error" role="alert" hidden></div>' +
    '<div class="form-actions"><button type="button" data-action="close">Close</button><span class="spacer"></span>' +
    '<button type="button" data-action="csv">Export CSV</button><button type="button" class="primary" data-action="approve">Approve</button></div>' +
    '</div>';

  function openSheet(timesheet) {
    current = timesheet;
    // Docked at the bottom right like the account cards: the apps stay usable while it's open.
    const p = ui.openPanel({
      name: 'timesheet',
      html: HTML,
      keyboard: false,
      dock: 'right',
      onclick: (event) => {
        const button = event.target.closest('[data-action]');
        if (!button || button.disabled) return;
        if (button.dataset.action === 'close') ui.closePanel();
        if (button.dataset.action === 'approve') approve(p);
        if (button.dataset.action === 'csv') exportCsv(p);
      },
    });
    render(p, timesheet);
  }

  function showError(p, text) {
    const box = p.querySelector('.form-error');
    box.textContent = text;
    box.hidden = !text;
  }

  function row(tbody, { code, name, hrs, apps, total }) {
    const tr = document.createElement('tr');
    if (total) tr.className = 'total';
    const project = document.createElement('td');
    if (code) project.append(ui.el('span', 'ts-code', code));
    project.append(name); // text node: names come from config and window titles
    tr.append(project, ui.el('td', 'num', hrs), ui.el('td', 'ts-apps', apps || ''));
    tbody.append(tr);
  }

  // One line per activity: when, what was done (written by the model from the window titles and
  // the GOAT guides used), the project and how long. Text only: titles come from other apps.
  function activityItem(a) {
    const li = ui.el('li', 'ts-act');
    li.title = [a.site || a.app, ...(a.titles || [])].filter(Boolean).join('\n'); // what GOAT saw
    li.append(ui.el('span', 'ts-when', span(a)), ui.el('span', 'ts-what', a.summary || ''));
    li.append(a.code ? ui.el('span', 'ts-code', a.code) : ui.el('span', 'ts-code none', '—'));
    li.append(ui.el('span', 'ts-dur', duration(a.minutes)));
    return li;
  }

  function render(p, t) {
    current = t;
    const approveButton = p.querySelector('[data-action="approve"]');
    const csvButton = p.querySelector('[data-action="csv"]');
    const loading = t === null;
    p.querySelector('.ts-loading').hidden = !loading;
    if (loading || !t || t.error) {
      for (const sel of ['.ts-acts', '.ts-by', '.ts-table', '.ts-empty']) p.querySelector(sel).hidden = true;
      const now = new Date();
      p.querySelector('.ts-date').textContent = loading ? prettyDate(`${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`) : '';
      if (!loading) showError(p, (t && t.message) || "Couldn't load the timesheet.");
      approveButton.disabled = true;
      csvButton.disabled = true;
      return;
    }
    showError(p, '');
    p.querySelector('.ts-date').textContent = prettyDate(t.date);
    const acts = Array.isArray(t.activities) ? t.activities : [];
    const list = p.querySelector('.ts-acts');
    list.replaceChildren(...acts.map(activityItem));
    list.hidden = !acts.length;
    const tbody = p.querySelector('tbody');
    tbody.replaceChildren();
    for (const e of t.entries || []) row(tbody, { code: e.code, name: e.name, hrs: e.hours.toFixed(2), apps: (e.apps || []).join(', ') });
    if (t.unassignedMinutes > 0) row(tbody, { name: 'Unassigned', hrs: hours(t.unassignedMinutes) });
    const empty = !(t.entries || []).length && !(t.unassignedMinutes > 0);
    if (!empty) row(tbody, { name: 'Total', hrs: hours(t.totalMinutes), total: true });
    p.querySelector('.ts-table').hidden = empty;
    p.querySelector('.ts-by').hidden = empty || !acts.length;
    const emptyBox = p.querySelector('.ts-empty');
    emptyBox.hidden = !empty;
    emptyBox.textContent = empty ? `Nothing tracked yet today. Press ${ui.hotkey('track')} to start.` : '';
    p.querySelector('.ts-note').textContent = t.idleMinutes > 0 ? `${hours(t.idleMinutes)} h idle, not counted.` : '';
    const status = p.querySelector('.ts-status');
    status.textContent = t.approved ? 'Approved' : 'Draft';
    status.className = `ts-status${t.approved ? ' approved' : ''}`;
    approveButton.disabled = empty;
    approveButton.textContent = t.approved ? 'Approve again' : 'Approve';
    csvButton.disabled = empty;
    if (acts.length) list.scrollTop = list.scrollHeight;
  }

  async function approve(p) {
    if (!current || !goat.approveTimesheet) return;
    const reply = await goat.approveTimesheet(current.date);
    if (!reply || reply.error) return showError(p, (reply && reply.message) || 'Approving failed.');
    render(p, reply);
    ui.toast('Timesheet approved.');
  }

  async function exportCsv(p) {
    if (!current || !goat.exportTimesheetCsv) return;
    const reply = await goat.exportTimesheetCsv(current.date);
    if (!reply || reply.error) return showError(p, (reply && reply.message) || 'Export failed.');
    ui.toast('Opened the CSV in your browser.');
  }

  // Today's timesheet without stopping tracking (the account card opens it): the same panel,
  // open at once and filled in when the day's lines are written.
  async function openToday() {
    ui.emit('open-timesheet', { loading: true });
    let t = null;
    try {
      t = goat.getTimesheet ? await goat.getTimesheet() : null;
    } catch (err) {
      t = { error: 'ipc_error', message: String((err && err.message) || err) };
    }
    ui.emit('open-timesheet', { timesheet: t || { error: 'unavailable', message: "Couldn't load the timesheet." } });
  }
  window.GOATTimesheet = { open: openToday, tracking: () => ui.cursorEl.classList.contains('tracking') };
})();
