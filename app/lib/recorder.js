// Guide recorder state (main process). Steps are global screen points on the primary display.
export function createRecorder({ now = () => Date.now() } = {}) {
  let session = null;

  return {
    get recording() {
      return session !== null;
    },
    get steps() {
      return session ? session.steps.map((s) => ({ ...s })) : [];
    },
    get app() {
      return session ? session.app : '';
    },
    start({ app = '' } = {}) {
      if (session) return false;
      session = { app, startedAt: now(), steps: [] };
      return true;
    },
    capture({ x, y }) {
      if (!session || !Number.isFinite(x) || !Number.isFinite(y)) return null;
      const step = { n: session.steps.length + 1, x: Math.round(x), y: Math.round(y) };
      session.steps.push(step);
      return { ...step };
    },
    undo() {
      return session?.steps.pop() ?? null;
    },
    // The control under the pointer at that capture, found a moment later.
    setTarget(n, target) {
      const step = session?.steps[n - 1];
      if (step && target && typeof target.label === 'string') step.target = { label: target.label.slice(0, 80), role: String(target.role || '').slice(0, 20) };
      return Boolean(step);
    },
    stop() {
      if (!session) return null;
      const result = { app: session.app, steps: session.steps, startedAt: session.startedAt, stoppedAt: now() };
      session = null;
      return result;
    },
  };
}

// The save form plus the recording -> POST /api/guides body.
export function buildGuide(form, { app = '', recordedOn = '' } = {}) {
  const steps = (form.steps || []).map((s, i) => {
    const label = String(s.label ?? '').trim() || `Step ${i + 1}`;
    const step = { x: s.x, y: s.y, label, say: String(s.say ?? '').trim() || `${label}.` };
    if (s.target && typeof s.target.label === 'string' && s.target.label.trim()) step.target = { label: s.target.label.trim().slice(0, 80), role: String(s.target.role || '').slice(0, 20) };
    return step;
  });
  return {
    title: String(form.title ?? '').trim(),
    triggers: form.triggers ?? '',
    intro: String(form.intro ?? '').trim(),
    apps: app ? [app] : [],
    ...(recordedOn ? { recordedOn } : {}),
    steps,
  };
}
