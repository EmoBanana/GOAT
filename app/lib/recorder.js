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
    return { x: s.x, y: s.y, label, say: String(s.say ?? '').trim() || `${label}.` };
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
