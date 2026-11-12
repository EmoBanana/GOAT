// Guide recorder UI: HUD, numbered markers, the save form and Preview. Classic script on GOATUI.
// Main sends record:start / record:step / record:stop; steps are global screen points.
(function () {
  'use strict';

  const ui = window.GOATUI;
  const goat = window.goat || {};
  if (!ui) return;

  const hud = ui.el('div', 'rec-hud');
  hud.hidden = true;
  const markers = ui.el('div', 'rec-markers');
  document.body.append(markers, hud);

  let session = null; // { app, steps: [{ x, y }] } while recording
  let draft = null; // save-form values once recording stops
  let escArmed = false;

  function renderHud() {
    hud.replaceChildren();
    const head = ui.el('div', 'rec-head');
    head.append(ui.el('span', 'rec-dot'), ui.el('span', null, session.app ? `Recording a guide in ${session.app}` : 'Recording a guide'));
    hud.append(head);
    if (session.steps.length) {
      const list = ui.el('ol', 'rec-list');
      for (const s of session.steps) list.append(ui.el('li', null, `(${s.x}, ${s.y})`));
      hud.append(list);
    }
    hud.append(ui.el('div', 'rec-hint', `Hover a button and press ${ui.hotkey('capture')}. ${ui.hotkey('record')} to finish.`));
    hud.hidden = false;
  }

  function addMarker(step, n) {
    const p = ui.toLocal(step);
    const marker = ui.el('div', 'rec-marker', String(n));
    marker.style.left = `${p.x}px`;
    marker.style.top = `${p.y}px`;
    markers.append(marker);
  }
  const clearMarkers = () => markers.replaceChildren();

  ui.onEvent('record:start', (msg) => {
    ui.stopGuide('record');
    ui.closePanel();
    ui.hideBubble();
    session = { app: msg.app || '', steps: [] };
    draft = null;
    clearMarkers();
    renderHud();
  });

  ui.onEvent('record:step', (msg) => {
    if (!session || !msg.step) return;
    const step = { x: msg.step.x, y: msg.step.y };
    session.steps.push(step);
    addMarker(step, session.steps.length);
    renderHud();
    // The blue cursor hops to each capture, then goes back to the mouse.
    const p = ui.toLocal(step);
    ui.flyTo(p.x, p.y, { duration: 320 }).then((landed) => {
      if (landed) setTimeout(() => ui.resumeFollow(), 450);
    });
  });

  ui.onEvent('record:stop', (msg) => {
    hud.hidden = true;
    const steps = (msg.steps || (session && session.steps) || []).map((s) => ({ x: s.x, y: s.y }));
    const app = msg.app || (session && session.app) || '';
    session = null;
    if (!steps.length) {
      clearMarkers();
      ui.toast('Recording stopped: no steps captured.');
      return;
    }
    draft = { app, title: '', triggers: '', intro: '', steps: steps.map((s) => ({ ...s, label: '', say: '' })) };
    openForm();
  });

  // Static markup only (numbers); every value is set through .value, never as HTML.
  function formHtml(count) {
    const rows = Array.from(
      { length: count },
      (_, i) =>
        `<div class="rec-step"><span class="num">${i + 1}</span>` +
        `<input name="label-${i}" placeholder="Button name" spellcheck="false">` +
        `<input name="say-${i}" placeholder="What should GOAT say?"></div>`,
    ).join('');
    return (
      '<form class="rec-form" autocomplete="off" novalidate>' +
      '<div class="form-head"><strong>Save this guide</strong><span class="form-sub"></span></div>' +
      '<label class="field"><span>Title</span><input name="title" placeholder="e.g. Export a PDF in Bluebeam"></label>' +
      '<label class="field"><span>Trigger phrases</span><input name="triggers" placeholder="comma-separated, e.g. export a pdf, save as pdf"></label>' +
      '<label class="field"><span>Intro</span><input name="intro" placeholder="Optional, e.g. Two clicks. Follow the blue cursor."></label>' +
      `<div class="rec-steps">${rows}</div>` +
      '<div class="form-error" role="alert" hidden></div>' +
      '<div class="form-actions"><button type="button" data-action="discard">Discard</button><span class="spacer"></span>' +
      '<button type="button" data-action="preview">Preview</button><button type="submit" class="primary">Save</button></div>' +
      '</form>'
    );
  }

  const field = (p, name) => p.querySelector(`[name="${name}"]`);

  function readForm(p) {
    if (!draft) return;
    draft.title = field(p, 'title').value;
    draft.triggers = field(p, 'triggers').value;
    draft.intro = field(p, 'intro').value;
    draft.steps.forEach((s, i) => {
      s.label = field(p, `label-${i}`).value;
      s.say = field(p, `say-${i}`).value;
    });
  }

  function showError(p, text) {
    const box = p.querySelector('.form-error');
    box.textContent = text;
    box.hidden = !text;
  }

  function openForm() {
    escArmed = false;
    const p = ui.openPanel({
      name: 'record',
      html: formHtml(draft.steps.length),
      focus: 'input[name="title"]',
      backdropCloses: false, // a stray click mustn't lose the recording
      oninput: () => {
        readForm(p);
        escArmed = false;
        showError(p, '');
      },
      onclick: (event) => {
        const button = event.target.closest('[data-action]');
        if (!button) return;
        if (button.dataset.action === 'discard') discard();
        if (button.dataset.action === 'preview') preview(p);
      },
      onsubmit: (event) => {
        event.preventDefault();
        save(p);
      },
      onEscape: () => {
        if (escArmed) discard();
        else {
          escArmed = true;
          showError(p, 'Press Esc again to discard this recording.');
        }
      },
    });
    const n = draft.steps.length;
    p.querySelector('.form-sub').textContent = `${n} step${n === 1 ? '' : 's'}${draft.app ? ` · recorded in ${draft.app}` : ''}`;
    field(p, 'title').value = draft.title;
    field(p, 'triggers').value = draft.triggers;
    field(p, 'intro').value = draft.intro;
    draft.steps.forEach((s, i) => {
      field(p, `label-${i}`).value = s.label;
      field(p, `say-${i}`).value = s.say;
    });
  }

  function guideFromDraft() {
    return {
      id: 'preview',
      title: draft.title.trim() || 'Preview',
      intro: draft.intro.trim() || 'Preview. Follow the blue cursor.',
      steps: draft.steps.map((s, i) => {
        const label = s.label.trim() || `Step ${i + 1}`;
        return { x: s.x, y: s.y, label, say: s.say.trim() || `${label}.` };
      }),
    };
  }

  // Preview plays the guide locally, then brings the form back with everything kept.
  function preview(p) {
    readForm(p);
    ui.closePanel();
    const off = ui.onEvent('guide:end', () => {
      off();
      if (draft) openForm();
    });
    ui.playGuide(guideFromDraft());
  }

  async function save(p) {
    readForm(p);
    const triggers = draft.triggers.split(',').map((t) => t.trim()).filter(Boolean);
    if (!draft.title.trim()) return showError(p, 'Add a title.');
    if (!triggers.length) return showError(p, 'Add at least one trigger phrase.');
    showError(p, '');
    const button = p.querySelector('button[type="submit"]');
    button.disabled = true;
    button.textContent = 'Saving…';
    const reply = goat.saveGuide
      ? await goat.saveGuide({ title: draft.title, triggers: draft.triggers, intro: draft.intro, steps: draft.steps })
      : { error: 'unavailable', message: 'Saving is not available.' };
    if (!reply || reply.error) {
      button.disabled = false;
      button.textContent = 'Save';
      return showError(p, (reply && reply.message) || 'Saving failed.');
    }
    const first = (reply.triggers && reply.triggers[0]) || triggers[0];
    draft = null;
    clearMarkers();
    ui.closePanel();
    ui.toast(`Saved "${reply.title}". Try ${ui.hotkey('ask')}, then "${first}".`, { ms: 7000 });
    ui.emit('guide:saved', reply);
    return reply;
  }

  function discard() {
    draft = null;
    clearMarkers();
    ui.closePanel();
    ui.toast('Recording discarded.');
  }
})();
