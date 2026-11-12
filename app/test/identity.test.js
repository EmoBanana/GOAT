import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanUserId, getUserId } from '../lib/identity.js';

test('user ids follow the server rule [A-Za-z0-9._@-]{1,80}', () => {
  assert.equal(cleanUserId('alice'), 'alice');
  assert.equal(cleanUserId('Alice Tan'), 'Alice-Tan');
  assert.equal(cleanUserId('  ~weird~  '), 'weird');
  assert.equal(cleanUserId('x'.repeat(100)).length, 80);
  assert.equal(cleanUserId(''), '');
});

test('GOAT_USER wins, then the login name, then anonymous', () => {
  assert.equal(getUserId({ GOAT_USER: 'demo@site' }, () => 'login'), 'demo@site');
  assert.equal(getUserId({}, () => 'login'), 'login');
  assert.equal(getUserId({}, () => ''), 'anonymous');
});
