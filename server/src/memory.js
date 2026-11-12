// Recent exchanges per user, so follow-ups ("and then?", "what about the other one?") make
// sense. Memory only: never written to disk, gone after ttlMs or a restart.
export function createMemory({ maxTurns = 4, ttlMs = 10 * 60_000, now = () => Date.now() } = {}) {
  const byUser = new Map();

  function recent(userId) {
    const fresh = (byUser.get(userId) || []).filter((t) => now() - t.at < ttlMs);
    if (fresh.length) byUser.set(userId, fresh);
    else byUser.delete(userId);
    return fresh.map(({ question, answer }) => ({ question, answer }));
  }

  function add(userId, question, answer) {
    const list = (byUser.get(userId) || []).filter((t) => now() - t.at < ttlMs);
    list.push({ at: now(), question: String(question).slice(0, 500), answer: String(answer).slice(0, 600) });
    byUser.set(userId, list.slice(-maxTurns));
  }

  return { recent, add, clear: (userId) => byUser.delete(userId) };
}
