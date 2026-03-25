'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-0123456789';
process.env.CODEX_PROFILE_ENCRYPTION_KEY = process.env.CODEX_PROFILE_ENCRYPTION_KEY || 'test-profile-secret-0123456789';
process.env.CODEX_AGENT_SHARED_SECRET = process.env.CODEX_AGENT_SHARED_SECRET || 'test-agent-secret-0123456789';

const { encryptString, decryptString, hashToken } = require('../server/security');

test('encryptString and decryptString round-trip auth payload', () => {
  const payload = JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: {
      account_id: 'acct_test',
      access_token: 'abc'
    }
  });
  const encrypted = encryptString(payload);
  const decrypted = decryptString(encrypted);
  assert.equal(decrypted, payload);
});

test('hashToken is deterministic for identical values', () => {
  assert.equal(hashToken('browser-token'), hashToken('browser-token'));
});
