// GOAT's sign-in page. The app opens it in the browser with a one-time code. Reown AppKit
// creates an account (email or social login, with a wallet made for you) or connects a wallet
// you have, and the connected account goes back to GOAT through the server on this laptop.
const APPKIT = 'https://cdn.jsdelivr.net/npm/@reown/appkit-cdn@1.8.24/dist/appkit.js';
const BASE_SEPOLIA = 84532;

const params = new URLSearchParams(location.search);
const code = params.get('code') || '';
const mode = params.get('mode') === 'connect' ? 'connect' : 'create';
const $ = (id) => document.getElementById(id);
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function show(state, text = '') {
  document.body.dataset.state = state;
  $('status').textContent = text;
}

// What GOAT keeps: the address, and how you signed in (no tokens, no keys).
function accountFrom(state, modal) {
  const embedded = state.embeddedWalletInfo || null;
  const provider = String(embedded?.authProvider || '');
  const method = embedded ? (provider === 'email' ? 'email' : 'social') : 'wallet';
  let wallet = '';
  try {
    wallet = method === 'wallet' ? modal.getWalletInfo?.()?.name || '' : '';
  } catch {
    wallet = '';
  }
  return { code, address: state.address, method, provider, email: embedded?.user?.email || '', wallet };
}

async function link(account) {
  show('loading', 'Finishing sign-in…');
  try {
    const res = await fetch('/api/account/link', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(account) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return show('error', data.message || "GOAT couldn't finish the sign-in. Start again from GOAT.");
  } catch {
    return show('error', "Can't reach GOAT on this laptop. Is it still running?");
  }
  $('who').textContent = account.email || short(account.address);
  return show('done');
}

async function main() {
  if (!/^[A-Za-z0-9_-]{24}$/.test(code)) return show('error', 'Open this page from GOAT: press Ctrl+Option+A, then Sign in.');

  let config;
  try {
    config = await (await fetch('/api/account/config')).json();
  } catch {
    return show('error', "Can't reach GOAT on this laptop. Is it running?");
  }
  if (!config.projectId) {
    return show('error', "Sign-in isn't set up on this GOAT yet: add REOWN_PROJECT_ID (a free project ID from dashboard.reown.com) to GOAT's .env and restart it.");
  }

  let kit;
  try {
    kit = await import(APPKIT);
  } catch {
    return show('error', "Couldn't load the sign-in service. Check the internet connection, or go back to GOAT and choose Continue offline.");
  }
  const { createAppKit, WagmiAdapter, networks } = kit;
  const chain = networks.baseSepolia || Object.values(networks).find((n) => n && n.id === BASE_SEPOLIA);
  const modal = createAppKit({
    adapters: [new WagmiAdapter({ projectId: config.projectId, networks: [chain] })],
    networks: [chain],
    defaultNetwork: chain,
    projectId: config.projectId,
    metadata: { name: 'GOAT', description: 'Sign in to GOAT', url: location.origin, icons: [`${location.origin}/account/icon.svg`] },
    // Email and social login need switching on for the project at dashboard.reown.com; the
    // dashboard settings win over these when AppKit can read them.
    features: { analytics: false, email: true, socials: ['google', 'github', 'apple', 'x', 'discord'], emailShowWallets: true, swaps: false, onramp: false, send: false, history: false },
    connectMethodsOrder: mode === 'connect' ? ['wallet', 'email', 'social'] : ['email', 'social', 'wallet'],
    defaultAccountTypes: { eip155: 'eoa' },
    enableNetworkSwitch: false,
    // The page's look in the AppKit popup too: GOAT blue, square corners, the page's font.
    themeMode: 'light',
    themeVariables: { '--w3m-accent': '#2563eb', '--w3m-border-radius-master': '0px', '--w3m-font-family': "'Archivo', 'Helvetica Neue', Arial, sans-serif" },
  });

  // starting: AppKit may restore a session from an earlier sign-in in this browser, which we
  // offer rather than use. choosing: the next connection is the one to send to GOAT.
  let phase = 'starting';
  let last = null;
  const choose = () => {
    phase = 'choosing';
    show('ready');
    modal.open({ view: 'Connect' });
  };
  modal.subscribeAccount((state) => {
    if (!state?.isConnected || !state.address) return;
    last = state;
    if (phase === 'starting') {
      phase = 'restored';
      $('was').textContent = accountFrom(state, modal).email || short(state.address);
      $('was-short').textContent = accountFrom(state, modal).email || short(state.address);
      show('restored');
    } else if (phase === 'choosing') {
      phase = 'linking';
      modal.close?.();
      link(accountFrom(state, modal));
    }
  });

  $('create').onclick = choose;
  $('connect').onclick = choose;
  $('continue').onclick = () => {
    phase = 'linking';
    link(accountFrom(last, modal));
  };
  $('other').onclick = async () => {
    await modal.disconnect().catch(() => {});
    choose();
  };
  show('loading');
  setTimeout(() => {
    if (phase === 'starting') choose();
  }, 1200);
  return undefined;
}

main();
