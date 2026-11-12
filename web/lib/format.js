// A price under one sen (or cent) keeps up to four decimals, as the app shows it (RM 0.0042,
// US$0.001); two decimals would make it RM 0.00.
function money(n) {
  const v = Number(n);
  return v === 0 || Math.abs(v) >= 0.01 ? v.toFixed(2) : String(Number(v.toFixed(4)));
}
// A no-break space keeps "RM" and the amount on one line.
export const rm = (n) => `RM ${money(n)}`;
export const usd = (n) => `US$${money(n)}`;
export const mb = (bytes) => `${Math.round(bytes / 1e6)} MB`;
export const chip = (arch) => (arch === 'x64' ? 'Intel' : 'Apple silicon');

export function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

export function isLocal(url) {
  try {
    return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}
