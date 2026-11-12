// Live steps for an ask in flight ("Checking the guides", "Thinking it through"…), so the
// overlay can show what GOAT is doing while it waits. The app names the ask with an id
// (header x-goat-progress) and polls GET /api/progress/:id. Memory only, gone after two minutes.
const ID = /^[A-Za-z0-9-]{8,64}$/;

export const progressId = (raw) => (ID.test(String(raw ?? '')) ? String(raw) : null);

export function createProgress({ ttlMs = 120_000, now = () => Date.now() } = {}) {
  const runs = new Map(); // id -> { at, steps, done }

  function sweep() {
    for (const [id, run] of runs) if (now() - run.at > ttlMs) runs.delete(id);
  }

  return {
    step(id, text) {
      const t = String(text ?? '').trim().slice(0, 80);
      if (!progressId(id) || !t) return;
      sweep();
      const run = runs.get(id) || { at: now(), steps: [], done: false };
      if (run.steps[run.steps.length - 1] !== t) run.steps.push(t);
      run.at = now();
      runs.set(id, run);
    },
    done(id) {
      const run = runs.get(id);
      if (run) {
        run.done = true;
        run.at = now();
      }
    },
    get(id) {
      sweep();
      const run = progressId(id) ? runs.get(id) : null;
      return run ? { steps: run.steps.slice(), done: run.done } : { steps: [], done: false };
    },
  };
}

// Free, like every route but the paid ones: it only says what an ask is doing.
export function mountProgress(app, { progress }) {
  app.get('/api/progress/:id', (req, res) => {
    res.json(progress.get(req.params.id));
  });
}
