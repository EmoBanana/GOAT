import { decodePaymentResponseHeader } from '@x402/fetch';

// HTTP client for the GOAT server, used only by the main process.
// Never throws: failures come back as { error, message } so they cross IPC intact.
// fetchImpl is the x402 paying fetch; walletAddress (never a key) links the wallet to the user.
export function createApi({ baseUrl, userId, walletAddress = null, fetchImpl = globalThis.fetch, timeoutMs = 130_000 }) {
  async function request(method, path, body, timeout = timeoutMs) {
    let res;
    try {
      res = await fetchImpl(new URL(path, baseUrl), {
        method,
        headers: {
          accept: 'application/json',
          'x-goat-user': userId,
          ...(walletAddress ? { 'x-goat-wallet': walletAddress } : {}),
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
    if (res.status === 402) {
      const reason = typeof data?.error === 'string' ? data.error : '';
      return {
        error: 'payment_required',
        message: !reason || /insufficient/i.test(reason)
          ? 'Your GOAT balance is too low. Top up from the RM chip in the ask panel.'
          : `The payment didn't go through (${reason}).`,
        status: 402,
      };
    }
    if (!res.ok) {
      return {
        ...(data && typeof data === 'object' ? data : {}),
        error: data?.error || `http_${res.status}`,
        message: data?.message || `The GOAT server answered ${res.status}.`,
        status: res.status,
      };
    }
    const receipt = res.headers.get('payment-response');
    if (receipt && data && typeof data === 'object') {
      try {
        data.payment = decodePaymentResponseHeader(receipt);
      } catch {
        // a receipt we can't read doesn't spoil the answer
      }
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
    wallet: () => request('GET', '/api/wallet', undefined, 8000),
    topup: (myr) => request('POST', '/api/wallet/topup', { myr }, 30_000),
    upgradePro: () => request('POST', '/api/pro/upgrade', {}, 30_000),
  };
}
