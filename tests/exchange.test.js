'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const SERVER_DIR = path.join(__dirname, '..', 'server');
const CONFIG_PATH = path.join(SERVER_DIR, 'config.js');
const DB_PATH = path.join(SERVER_DIR, 'db.js');
const EXCHANGE_PATH = path.join(SERVER_DIR, 'exchange.js');
const SECURITY_PATH = path.join(SERVER_DIR, 'security.js');

const { encryptWithPassphrase } = require('../server/security');
const {
  EXPORT_SCHEMA_VERSION,
  exportExchangeEnvelope,
  importExchangeEnvelope,
  normalizeStrategy,
  parseExchangeEnvelope
} = require('../server/exchange');

function clearExchangeModules() {
  for (const modulePath of [CONFIG_PATH, DB_PATH, EXCHANGE_PATH, SECURITY_PATH]) {
    delete require.cache[modulePath];
  }
}

function withIsolatedExchangeRuntime(run) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-switcher-exchange-'));
  const previousEnv = {};
  const envPatch = {
    DB_PATH: path.join(tempDir, 'exchange.db'),
    AUDIT_LOG_PATH: path.join(tempDir, 'audit.log'),
    SESSION_SECRET: 'test-session-secret',
    CODEX_PROFILE_ENCRYPTION_KEY: 'test-profile-key-1234567890',
    CODEX_AGENT_SHARED_SECRET: 'test-agent-secret-1234567890',
    COOKIE_DOMAIN: '',
    COOKIE_SECURE: 'false',
    APP_URL: 'http://127.0.0.1:29995',
    PORT: '29995',
    HOST: '127.0.0.1'
  };

  for (const [key, value] of Object.entries(envPatch)) {
    previousEnv[key] = process.env[key];
    process.env[key] = value;
  }

  clearExchangeModules();
  const db = require(DB_PATH);
  const security = require(SECURITY_PATH);
  const exchange = require(EXCHANGE_PATH);
  db.seedDefaultSlots();
  for (const slot of db.listSlots()) {
    db.deleteAccount(slot.id);
  }

  return Promise.resolve()
    .then(() => run({ db, security, exchange }))
    .finally(() => {
      clearExchangeModules();
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    });
}

test('normalizeStrategy falls back to merge for unknown values', () => {
  assert.equal(normalizeStrategy('replace'), 'replace');
  assert.equal(normalizeStrategy('skip'), 'skip');
  assert.equal(normalizeStrategy('unexpected'), 'merge');
});

test('parseExchangeEnvelope decrypts encrypted exchange payload', () => {
  const payload = {
    schema_version: EXPORT_SCHEMA_VERSION,
    exported_at: '2026-04-01T00:00:00.000Z',
    source: 'codex-switcher-web',
    accounts: []
  };
  const envelope = {
    schema_version: EXPORT_SCHEMA_VERSION,
    exported_at: payload.exported_at,
    source: payload.source,
    encryption: encryptWithPassphrase(JSON.stringify(payload), 'portable-secret')
  };
  const parsed = parseExchangeEnvelope(envelope, 'portable-secret');
  assert.equal(parsed.schema_version, EXPORT_SCHEMA_VERSION);
  assert.deepEqual(parsed.accounts, []);
});

test('parseExchangeEnvelope returns a specific decrypt error for wrong passphrases', () => {
  const payload = {
    schema_version: EXPORT_SCHEMA_VERSION,
    exported_at: '2026-04-01T00:00:00.000Z',
    source: 'codex-switcher-web',
    accounts: []
  };
  const envelope = {
    schema_version: EXPORT_SCHEMA_VERSION,
    exported_at: payload.exported_at,
    source: payload.source,
    encryption: encryptWithPassphrase(JSON.stringify(payload), 'portable-secret')
  };
  assert.throws(() => parseExchangeEnvelope(envelope, 'wrong-secret'), /EXCHANGE_DECRYPT_FAILED/);
});

test('export then import with merge preserves the same auth profile without requiring reauth', async () => {
  await withIsolatedExchangeRuntime(async ({ db, security, exchange }) => {
    const slot = db.createAccount({
      id: 'account_roundtrip',
      label: 'Roundtrip 账号',
      email: 'roundtrip@example.com',
      login_method: 'google',
      expires_at: '2026-05-01',
      state: 'ready'
    });

    db.createAuthProfile({
      id: 'auth_roundtrip_primary',
      slot_id: slot.id,
      workspace_label: '主认证',
      auth_cipher: security.encryptString(JSON.stringify({
        account_id: 'acct_roundtrip',
        identity_key: 'ident_roundtrip'
      })),
      account_id: 'acct_roundtrip',
      identity_key: 'ident_roundtrip',
      is_primary: true,
      is_active: false,
      freshness: 'live',
      runtime_status: 'ready',
      quota_5h_pct: 21,
      quota_5h_reset_at: '2026-04-03T10:00:00.000Z',
      quota_5h_reset_label: '5h',
      quota_week_pct: 33,
      quota_week_reset_at: '2026-04-09T10:00:00.000Z',
      quota_week_reset_label: '7d',
      last_seen_at: '2026-04-03T10:00:00.000Z',
      last_error: null,
      last_error_kind: null,
      failure_count: 0,
      backoff_until: null,
      reauth_required: 0
    });
    db.syncSlotAuthAggregate(slot.id);

    const beforeProfiles = db.listAuthProfilesForSlot(slot.id);
    const beforeCipher = beforeProfiles[0].auth_cipher;
    const envelope = exchange.exportExchangeEnvelope('portable-secret', { source: 'roundtrip-test' });
    const result = exchange.importExchangeEnvelope(envelope, 'portable-secret', { strategy: 'merge' });

    const slots = db.listSlots();
    const profiles = db.listAuthProfilesForSlot(slot.id);
    assert.equal(result.created_accounts, 0);
    assert.equal(result.updated_accounts, 1);
    assert.equal(result.created_auth_profiles, 0);
    assert.equal(result.updated_auth_profiles, 1);
    assert.equal(slots.length, 1);
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0].auth_cipher, beforeCipher);
    assert.equal(profiles[0].reauth_required, false);
    assert.equal(profiles[0].failure_count, 0);
    assert.equal(profiles[0].runtime_status, 'ready');
  });
});
