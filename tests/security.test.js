'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  decryptString,
  decryptWithPassphrase,
  encryptString,
  encryptWithPassphrase,
  generatePortablePassphrase,
  hashToken
} = require('../server/security');

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

test('encryptWithPassphrase and decryptWithPassphrase round-trip portable payload', () => {
  const envelope = encryptWithPassphrase(JSON.stringify({
    schema_version: 'codex-switcher-export-v1',
    accounts: [{ email: 'demo@example.com' }]
  }), 'passphrase-123');
  const decrypted = decryptWithPassphrase(envelope, 'passphrase-123');
  const parsed = JSON.parse(decrypted);
  assert.equal(parsed.schema_version, 'codex-switcher-export-v1');
  assert.equal(parsed.accounts[0].email, 'demo@example.com');
});

test('generatePortablePassphrase returns short clipboard-friendly tokens', () => {
  const passphrase = generatePortablePassphrase(10);
  assert.match(passphrase, /^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
});
