'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-switcher-service-'));

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-0123456789';
process.env.CODEX_PROFILE_ENCRYPTION_KEY = process.env.CODEX_PROFILE_ENCRYPTION_KEY || 'test-profile-secret-0123456789';
process.env.CODEX_AGENT_SHARED_SECRET = process.env.CODEX_AGENT_SHARED_SECRET || 'test-agent-secret-0123456789';
process.env.CODEX_SWITCHER_DATA_DIR = tempRoot;
process.env.DB_PATH = path.join(tempRoot, 'codex-switcher.db');
process.env.AUDIT_LOG_PATH = path.join(tempRoot, 'audit.log');

const { seedDefaultSlots } = require('../server/db');
const { getRuntimeSettings, updateRuntimeSettings } = require('../server/service');

seedDefaultSlots();

test.after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('getRuntimeSettings returns seeded defaults', () => {
  const settings = getRuntimeSettings();
  assert.equal(settings.auto_switch_enabled, false);
  assert.ok(settings.updated_at);
});

test('updateRuntimeSettings persists allowed values', () => {
  const settings = updateRuntimeSettings({
    auto_switch_enabled: true
  });
  assert.equal(settings.auto_switch_enabled, true);
  assert.ok(settings.updated_at);
});

test('updateRuntimeSettings preserves known values when patch is empty', () => {
  updateRuntimeSettings({ auto_switch_enabled: true });
  const settings = updateRuntimeSettings({});
  assert.equal(settings.auto_switch_enabled, true);
});
