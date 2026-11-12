// HTTP client for the GOAT server, used only by the main process.
// Never throws: failures come back as { error, message } so they cross IPC intact.
export function createApi({ baseUrl, userId, fetchImpl = globalThis.fetch, timeoutMs = 130_000 }) {
  async function request(method, path, body, timeout = timeoutMs) {
    let res;
    try {
      res = await fetchImpl(new URL(path, baseUrl), {
        method,
        headers: {
          accept: 'application/json',
          'x-goat-user': userId,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeout),
      });
    } catch (err) {
      if (err?.name === 'TimeoutError') {
        return { error: 'server_timeout', message: 'The GOAT server took too long to answer. Try again in a moment.' };
      }
      return { error: 'server_unreachable', message: `Can't reach the GOAT server at ${baseUrl}. Start it with: npm start` };
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!res.ok) {
      return {
        ...(data && typeof data === 'object' ? data : {}),
        error: data?.error || `http_${res.status}`,
        message: data?.message || `The GOAT server answered ${res.status}.`,
        status: res.status,
      };
    }
    return data ?? {};
  }

  return {
    baseUrl,
    userId,
    request,
    assist: ({ question, context, image }) => request('POST', '/api/assist', { question, context, ...(image ? { image } : {}) }),
    health: () => request('GET', '/api/health', undefined, 3000),
    me: () => request('GET', '/api/me', undefined, 5000),
    saveGuide: (guide) => request('POST', '/api/guides', guide, 10_000),
    timesheetConfig: () => request('GET', '/api/timesheet/config', undefined, 5000),
    postActivity: (samples) => request('POST', '/api/activity', { samples }, 10_000),
    timesheet: (date) => request('GET', `/api/timesheet?date=${encodeURIComponent(date)}`, undefined, 10_000),
    approveTimesheet: (date) => request('POST', '/api/timesheet/approve', { date }, 10_000),
  };
}
