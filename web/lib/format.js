export const rm = (n) => `RM ${Number(n).toFixed(2)}`;
export const usd = (n) => `US$${Number(n).toFixed(2)}`;
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
