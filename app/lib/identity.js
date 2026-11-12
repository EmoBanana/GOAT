import os from 'node:os';

// Same rule as the server: [A-Za-z0-9._@-]{1,80}.
export function cleanUserId(raw) {
  const id = String(raw ?? '')
    .trim()
    .replace(/[^A-Za-z0-9._@-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return id || '';
}

// The user is GOAT_USER if set, else the macOS/Windows login name.
export function getUserId(env = process.env, username = safeUsername) {
  return cleanUserId(env.GOAT_USER) || cleanUserId(username()) || 'anonymous';
}

function safeUsername() {
  try {
    return os.userInfo().username;
  } catch {
    return '';
  }
}
