// Timesheet tracking UI: a red dot rides with the blue cursor while tracking, and the panel that
// opens when tracking stops shows today's time by project, with Approve and Export CSV.
(function () {
  'use strict';

  const ui = window.GOATUI;
  const goat = window.goat || {};
  if (!ui) return;

  const dot = ui.el('span', 'track-dot');
  ui.cursorEl.append(dot);
  let current = null;

  ui.onEvent('tracking', (msg) => {
    ui.cursorEl.classList.toggle('tracking', Boolean(msg.on));
    ui.toast(msg.on ? `Tracking on. ${ui.hotkey('track')} again to stop and see today's timesheet.` : 'Tracking off.');
  });
  ui.onEvent('open-timesheet', (msg) => openSheet(msg.timesheet));

  const hours = (minutes) => (Number(minutes || 0) / 60).toFixed(2);
  function prettyDate(date) {
    const d = new Date(`${date}T12:00:00`);
    return Number.isNaN(d.getTime()) ? String(date || '') : d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  }

  const HTML =
    '<div class="ts">' +
    '<div class="form-head"><strong>Today\'s timesheet</strong><span class="ts-status"></span></div>' +
    '<div class="form-sub ts-date"></div>' +
    '<table class="ts-table"><thead><tr><th>Project</th><th class="num">Hours</th><th>Apps</th></tr></thead><tbody></tbody></table>' +
    '<div class="ts-empty" hidden></div><div class="ts-note"></div>' +
    '<div class="form-error" role="alert" hidden></div>' +
    '<div class="form-actions"><button type="button" data-action="close">Close</button><span class="spacer"></span>' +
    '<button type="button" data-action="csv">Export CSV</button><button type="button" class="primary" data-action="approve">Approve</button></div>' +
    '</div>';

  function openSheet(timesheet) {
    current = timesheet;
    const p = ui.openPanel({
      name: 'timesheet',
      html: HTML,
      onclick: (event) => {
        const button = event.target.closest('[data-action]');
        if (!button) return;
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

  function render(p, t) {
    const approveButton = p.querySelector('[data-action="approve"]');
    const csvButton = p.querySelector('[data-action="csv"]');
    if (!t || t.error) {
      p.querySelector('.ts-table').hidden = true;
      showError(p, (t && t.message) || "Couldn't load the timesheet.");
      approveButton.disabled = true;
      csvButton.disabled = true;
      return;
    }
    p.querySelector('.ts-date').textContent = prettyDate(t.date);
    const tbody = p.querySelector('tbody');
    tbody.replaceChildren();
    for (const e of t.entries || []) row(tbody, { code: e.code, name: e.name, hrs: e.hours.toFixed(2), apps: (e.apps || []).join(', ') });
    if (t.unassignedMinutes > 0) row(tbody, { name: 'Unassigned', hrs: hours(t.unassignedMinutes) });
    const empty = !(t.entries || []).length && !(t.unassignedMinutes > 0);
    if (!empty) row(tbody, { name: 'Total', hrs: hours(t.totalMinutes), total: true });
    p.querySelector('.ts-table').hidden = empty;
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
  }

  async function approve(p) {
    if (!current || !goat.approveTimesheet) return;
    const reply = await goat.approveTimesheet(current.date);
    if (!reply || reply.error) return showError(p, (reply && reply.message) || 'Approving failed.');
    current = reply;
    showError(p, '');
    render(p, reply);
    ui.toast('Timesheet approved.');
  }

  async function exportCsv(p) {
    if (!current || !goat.exportTimesheetCsv) return;
    const reply = await goat.exportTimesheetCsv(current.date);
    if (!reply || reply.error) return showError(p, (reply && reply.message) || 'Export failed.');
    ui.toast('Opened the CSV in your browser.');
  }
})();
