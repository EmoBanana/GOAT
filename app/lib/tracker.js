// Timesheet tracker (main process). Off until Ctrl+Option+T. While on, it samples the frontmost
// window every interval, keeps only allowlisted apps, flags idle time, sends batches to the
// server, flushes on stop and requeues anything the server didn't take. A browser sample carries
// its site name (canva.com), never the address. note() adds a GOAT guide used meanwhile.
const MAX_QUEUE = 2000;

export function createTracker({
  sample, // (allowlist) => Promise<{ app, title, site?, pid } | null>
  send, // (samples) => Promise<{ stored } | { error }>
  getConfig, // () => Promise<{ trackedApps }>
  intervalMs = 10_000,
  idleSec = 300,
  idleSeconds = () => 0,
  batchSize = 6,
  selfPid = process.pid,
  now = () => Date.now(),
  setTimer = setInterval,
  clearTimer = clearInterval,
  logger = console,
}) {
  let timer = null;
  let queue = [];
  let allow = null;
  let ticking = null;

  const isGoat = (s) => s.pid === selfPid || s.title === 'GOAT' || /^(GOAT|Electron)$/i.test(s.app);
  const isAllowed = (app) => !allow || allow.some((a) => a.toLowerCase() === String(app).toLowerCase());

  async function flush() {
    if (!queue.length) return { stored: 0 };
    const batch = queue;
    queue = [];
    let reply;
    try {
      reply = await send(batch);
    } catch (err) {
      reply = { error: 'send_failed', message: err.message };
    }
    if (!reply || reply.error) {
      queue = batch.concat(queue).slice(-MAX_QUEUE); // try again with the next batch
      logger.warn(`[tracker] couldn't send ${batch.length} samples: ${reply?.message || 'no reply'}`);
    }
    return reply;
  }

  async function tick() {
    if (ticking) return ticking;
    ticking = (async () => {
      const s = await sample(allow);
      if (!s || !s.app || isGoat(s) || !isAllowed(s.app)) return;
      queue.push({
        ts: new Date(now()).toISOString(),
        app: s.app,
        title: s.title || '',
        ...(s.site ? { site: s.site } : {}),
        idle: idleSeconds() >= idleSec,
        sec: intervalMs / 1000,
      });
      if (queue.length >= batchSize) await flush();
    })().finally(() => {
      ticking = null;
    });
    return ticking;
  }

  async function start() {
    if (timer) return false;
    const config = await getConfig();
    allow = Array.isArray(config?.trackedApps) ? config.trackedApps : null;
    if (!allow) logger.warn('[tracker] no allowlist from the server; the server still filters every sample');
    timer = setTimer(() => {
      tick();
    }, intervalMs);
    await tick(); // sample right away so short sessions count; resolves after the first sample
    return true;
  }

  // A GOAT guide played while tracking (event: { guide, app }): it rides with the next batch, and
  // the day's line for that stretch says the task was done with it. Ignored when not tracking.
  function note(event) {
    const guide = String(event?.guide || '').trim();
    if (!timer || !guide) return false;
    queue.push({ ts: new Date(now()).toISOString(), kind: 'guide', guide: guide.slice(0, 120), ...(event.app ? { app: String(event.app) } : {}) });
    return true;
  }

  async function stop() {
    if (!timer) return null;
    clearTimer(timer);
    timer = null;
    if (ticking) await ticking;
    return flush();
  }

  return {
    start,
    stop,
    tick,
    flush,
    note,
    get tracking() {
      return timer !== null;
    },
    get queued() {
      return queue.length;
    },
  };
}
