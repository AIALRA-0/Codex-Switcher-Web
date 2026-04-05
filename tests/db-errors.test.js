'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const DB_MODULE_PATH = path.join(__dirname, '..', 'server', 'db.js');
const CONFIG_MODULE_PATH = path.join(__dirname, '..', 'server', 'config.js');

function clearDbModules() {
  delete require.cache[DB_MODULE_PATH];
  delete require.cache[CONFIG_MODULE_PATH];
}

function withTempDb(run) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-switcher-db-errors-'));
  const previousDbPath = process.env.DB_PATH;
  process.env.DB_PATH = path.join(tempDir, 'codex-switcher.db');
  clearDbModules();
  const db = require(DB_MODULE_PATH);
  return Promise.resolve()
    .then(() => run(db))
    .finally(() => {
      clearDbModules();
      if (previousDbPath === undefined) delete process.env.DB_PATH;
      else process.env.DB_PATH = previousDbPath;
      fs.rmSync(tempDir, { recursive: true, force: true });
    });
}

test('database write helpers normalize opaque error objects before persisting', async () => {
  await withTempDb((db) => {
    db.seedDefaultSlots();
    const slot = db.createAccount({
      id: 'slot_alpha',
      label: 'alpha@example.com',
      email: 'alpha@example.com',
      login_method: 'email',
      state: 'draft'
    });

    db.updateSlot(slot.id, { last_error: { message: 'AGENT_REQUEST_TIMEOUT' } });
    const updatedSlot = db.getSlotById(slot.id);
    assert.equal(updatedSlot.last_error, 'AGENT_REQUEST_TIMEOUT');

    const profile = db.createAuthProfile({
      id: 'auth_alpha',
      slot_id: slot.id,
      workspace_label: '主认证',
      auth_cipher: 'cipher',
      is_primary: true,
      last_error: { error: 'AUTH_AGENT_FORBIDDEN' }
    });
    assert.equal(profile.last_error, 'AUTH_AGENT_FORBIDDEN');

    db.updateAuthProfile(profile.id, { last_error: {} });
    const updatedProfile = db.getAuthProfileById(profile.id);
    assert.equal(updatedProfile.last_error, 'UNKNOWN_BACKEND_ERROR');

    db.createBootstrapSession({
      id: 'bootstrap_alpha',
      slot_id: slot.id,
      status: 'failed',
      error_text: { code: 'DEVICE_AUTH_RATE_LIMITED' }
    });
    const bootstrap = db.getBootstrapSession('bootstrap_alpha');
    assert.equal(bootstrap.error_text, 'DEVICE_AUTH_RATE_LIMITED');
  });
});

test('startup migration repairs legacy [object Object] error values', async () => {
  await withTempDb((db) => {
    db.seedDefaultSlots();
    const slot = db.createAccount({
      id: 'slot_beta',
      label: 'beta@example.com',
      email: 'beta@example.com',
      login_method: 'google',
      state: 'error'
    });
    db.createAuthProfile({
      id: 'auth_beta',
      slot_id: slot.id,
      workspace_label: '主认证',
      auth_cipher: 'cipher',
      is_primary: true,
      last_error: null
    });
    db.createBootstrapSession({
      id: 'bootstrap_beta',
      slot_id: slot.id,
      status: 'failed',
      error_text: null
    });

    db.db.prepare("UPDATE account_slots SET last_error = '[object Object]' WHERE id = ?").run(slot.id);
    db.db.prepare("UPDATE account_auth_profiles SET last_error = '[object Object]' WHERE id = ?").run('auth_beta');
    db.db.prepare("UPDATE bootstrap_sessions SET error_text = '[object Object]' WHERE id = ?").run('bootstrap_beta');

    db.seedDefaultSlots();

    assert.equal(db.getSlotById(slot.id).last_error, 'UNKNOWN_BACKEND_ERROR');
    assert.equal(db.getAuthProfileById('auth_beta').last_error, 'UNKNOWN_BACKEND_ERROR');
    assert.equal(db.getBootstrapSession('bootstrap_beta').error_text, 'UNKNOWN_BACKEND_ERROR');
  });
});

test('setPrimaryAuthProfile switches primary workspace without hitting the unique slot constraint', async () => {
  await withTempDb((db) => {
    db.seedDefaultSlots();
    const slot = db.createAccount({
      id: 'slot_gamma',
      label: 'gamma@example.com',
      email: 'gamma@example.com',
      login_method: 'google',
      state: 'ready'
    });
    db.createAuthProfile({
      id: 'auth_gamma_primary',
      slot_id: slot.id,
      workspace_label: '主认证',
      auth_cipher: 'cipher-primary',
      is_primary: true
    });
    db.createAuthProfile({
      id: 'auth_gamma_secondary',
      slot_id: slot.id,
      workspace_label: 'FR 工作区',
      auth_cipher: 'cipher-secondary',
      is_primary: false
    });

    db.setPrimaryAuthProfile(slot.id, 'auth_gamma_secondary');

    const profiles = db.listAuthProfilesForSlot(slot.id);
    const primaryProfiles = profiles.filter((profile) => profile.is_primary);
    assert.equal(primaryProfiles.length, 1);
    assert.equal(primaryProfiles[0].id, 'auth_gamma_secondary');
  });
});
