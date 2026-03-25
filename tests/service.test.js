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
const { resolveAppSettings, updateAppSettings } = require('../server/service');

seedDefaultSlots();

test.after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('resolveAppSettings returns seeded defaults', () => {
  const settings = resolveAppSettings();
  assert.equal(settings.runtimeRefreshIntervalMs, 30000);
  assert.equal(settings.availabilityProbeEnabled, true);
  assert.equal(settings.availabilityProbeIntervalMs, 900000);
});

test('updateAppSettings persists allowed values', () => {
  const settings = updateAppSettings({
    runtimeRefreshIntervalMs: 60000,
    availabilityProbeEnabled: false,
    availabilityProbeIntervalMs: 1800000
  });
  assert.equal(settings.runtimeRefreshIntervalMs, 60000);
  assert.equal(settings.availabilityProbeEnabled, false);
  assert.equal(settings.availabilityProbeIntervalMs, 1800000);
});

test('updateAppSettings ignores unsupported refresh values', () => {
  const settings = updateAppSettings({
    runtimeRefreshIntervalMs: 45000,
    availabilityProbeIntervalMs: 123456
  });
  assert.equal(settings.runtimeRefreshIntervalMs, 60000);
  assert.equal(settings.availabilityProbeIntervalMs, 1800000);
});
