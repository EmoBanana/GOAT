import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { cleanAccount } from '../src/account.js';
import { startTestServer } from './helpers/test-server.js';

const ADDRESS = `0x${'ab'.repeat(20)}`;

describe('sign-in with a one-time code', () => {
  test('the app starts a sign-in, the page links the account, and the app collects it once', async () => {
    const srv = await startTestServer({ env: { REOWN_PROJECT_ID: 'test-project' } });
    try {
      const start = await srv.request('POST', '/api/account/start', { body: {} });
      const { code } = start.body;
      assert.match(code, /^[A-Za-z0-9_-]{24}$/);
      assert.equal(start.body.path, `/account/?code=${code}`);
      assert.deepEqual((await srv.request('GET', `/api/account/link/${code}`)).body, { linked: false });
      assert.equal((await srv.request('GET', '/api/account/config')).body.projectId, 'test-project');

      const link = await srv.request('POST', '/api/account/link', { body: { code, address: ADDRESS, method: 'email', email: 'pat@example.com', provider: 'email' } });
      assert.equal(link.status, 200);
      const got = await srv.request('GET', `/api/account/link/${code}`);
      assert.equal(got.body.linked, true);
      assert.deepEqual({ ...got.body.account, linkedAt: 'x' }, { address: ADDRESS, method: 'email', email: 'pat@example.com', provider: 'email', linkedAt: 'x' });
      assert.deepEqual((await srv.request('GET', `/api/account/link/${code}`)).body, { linked: false, expired: true }, 'handed over only once');
    } finally {
      await srv.close();
    }
  });

  test('only a code the app started can link, only once, and only with a real address', async () => {
    const srv = await startTestServer();
    try {
      const unknown = await srv.request('POST', '/api/account/link', { body: { code: 'A'.repeat(24), address: ADDRESS } });
      assert.equal(unknown.status, 404);
      assert.equal(unknown.body.error, 'link_expired');
      const { code } = (await srv.request('POST', '/api/account/start', { body: {} })).body;
      const bad = await srv.request('POST', '/api/account/link', { body: { code, address: '0x123' } });
      assert.equal(bad.status, 400);
      assert.equal(bad.body.error, 'bad_address');
      assert.equal((await srv.request('POST', '/api/account/link', { body: { code, address: ADDRESS } })).status, 200);
      assert.equal((await srv.request('POST', '/api/account/link', { body: { code, address: ADDRESS } })).status, 404, 'a code links once');
    } finally {
      await srv.close();
    }
  });

  test('the sign-in page is served by the GOAT server', async () => {
    const srv = await startTestServer();
    try {
      const page = await srv.request('GET', '/account/?code=x');
      assert.equal(page.status, 200);
      assert.match(page.headers.get('content-type'), /text\/html/);
      assert.match(page.text, /Sign in to GOAT/);
      assert.match(page.text, /<script type="module" src="account\.js"><\/script>/);
      const script = await srv.request('GET', '/account/account.js');
      assert.equal(script.status, 200);
      assert.match(script.text, /@reown\/appkit-cdn@1\.8\.24/);
    } finally {
      await srv.close();
    }
  });
});

test('account details are cleaned: method, email, provider and wallet name', () => {
  assert.deepEqual(cleanAccount({ address: ADDRESS, method: 'social', provider: 'Google', email: 'not an email', wallet: 'x'.repeat(80) }), {
    address: ADDRESS,
    method: 'social',
    provider: 'google',
    wallet: 'x'.repeat(60),
  });
  assert.equal(cleanAccount({ address: ADDRESS, method: 'root' }).method, 'wallet');
  assert.throws(() => cleanAccount({ address: 'nope' }), /No wallet address/);
});
