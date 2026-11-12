import { decodePaymentResponseHeader } from '@x402/fetch';

// HTTP client for the GOAT server, used only by the main process.
// Never throws: failures come back as { error, message } so they cross IPC intact.
// fetchImpl is the x402 paying fetch; walletAddress (never a key) links the wallet to the user.
// unreachableMessage replaces "Can't reach the GOAT server at … Start it with: npm start", which
// only helps someone running GOAT from its repo (a packaged app passes SERVER_OFFLINE).
export function createApi({ baseUrl, userId, walletAddress = null, fetchImpl = globalThis.fetch, timeoutMs = 130_000, unreachableMessage = null }) {
  async function request(method, path, body, timeout = timeoutMs, headers = {}) {
    let res;
    try {
      res = await fetchImpl(new URL(path, baseUrl), {
        method,
        headers: {
          accept: 'application/json',
          'x-goat-user': userId,
          ...(walletAddress ? { 'x-goat-wallet': walletAddress } : {}),
          ...headers,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeout),
      });
    } catch (err) {
      if (err?.name === 'TimeoutError') {
        return { error: 'server_timeout', message: 'The GOAT server took too long to answer. Try again in a moment.' };
      }
      return { error: 'server_unreachable', message: unreachableMessage || `Can't reach the GOAT server at ${baseUrl}. Start it with: npm start` };
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (res.status === 402) {
      // Why: the body's error when the payment check failed, the payment-response header when
      // settling it failed (that body has no error). Only a real shortfall is "too low"; anything
      // else (e.g. the facilitator's transaction failing) charged nothing and can be asked again.
      let reason = typeof data?.error === 'string' ? data.error : '';
      const receipt = res.headers.get('payment-response');
      if (receipt) {
        try {
          reason = decodePaymentResponseHeader(receipt).errorReason || reason;
        } catch {
          // keep the body's reason
        }
      }
      return {
        error: 'payment_required',
        reason,
        message: /insufficient/i.test(reason)
          ? 'Your GOAT balance is too low. Top up from the RM chip in the ask panel.'
          : "The payment didn't go through just then, so nothing was charged. Ask again.",
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
    assist: ({ question, context, image, screen, voice, chatId, document, targets }) =>
      request('POST', '/api/assist', {
        question,
        context,
        ...(image ? { image } : {}),
        ...(screen ? { screen } : {}),
        ...(voice ? { voice: true } : {}),
        ...(typeof chatId === 'string' || chatId === null ? { chatId } : {}),
        ...(document ? { document } : {}),
        ...(Array.isArray(targets) && targets.length ? { targets } : {}),
      }),
    health: () => request('GET', '/api/health', undefined, 3000),
    me: () => request('GET', '/api/me', undefined, 5000),
    saveGuide: (guide) => request('POST', '/api/guides', guide, 10_000),
    draftGuide: (text) => request('POST', '/api/guides/draft', { text }, 120_000),
    timesheetConfig: () => request('GET', '/api/timesheet/config', undefined, 5000),
    postActivity: (samples) => request('POST', '/api/activity', { samples }, 10_000),
    // The model writes the day's activity lines the first time (a few seconds), so these wait longer.
    timesheet: (date) => request('GET', `/api/timesheet?date=${encodeURIComponent(date)}`, undefined, 60_000),
    approveTimesheet: (date) => request('POST', '/api/timesheet/approve', { date }, 60_000),
    wallet: () => request('GET', '/api/wallet', undefined, 8000),
    topup: (myr) => request('POST', '/api/wallet/topup', { myr }, 30_000),
    upgradePro: () => request('POST', '/api/pro/upgrade', {}, 30_000),
    transcribe: (audio) => request('POST', '/api/voice/transcribe', { audio }, 90_000),
    // GOAT's voice for a spoken answer: { audio: base64 MP3 }. Any error means: use the Mac's voice.
    speak: (text) => request('POST', '/api/voice/speak', { text }, 12_000),
    chats: () => request('GET', '/api/chats', undefined, 8000),
    chat: (id) => request('GET', `/api/chats/${encodeURIComponent(id)}`, undefined, 8000),
    deleteChat: (id) => request('DELETE', `/api/chats/${encodeURIComponent(id)}`, undefined, 8000),
    clearChats: () => request('DELETE', '/api/chats', undefined, 8000),
    startSignIn: () => request('POST', '/api/account/start', {}, 8000),
    signInResult: (code) => request('GET', `/api/account/link/${encodeURIComponent(code)}`, undefined, 8000),
  };
}
