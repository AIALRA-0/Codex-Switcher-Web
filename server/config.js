'use strict';

const path = require('path');

const DEFAULT_PORT = optionalNumber('PORT', 29000);
const DEFAULT_APP_URL = process.env.APP_URL || `http://localhost:${DEFAULT_PORT}`;
const DATA_DIR = process.env.CODEX_SWITCHER_DATA_DIR || '/data';

function defaultServerTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch (_) {
    return 'UTC';
  }
}

function requireEnv(name, fallback = '') {
  const value = process.env[name] || fallback;
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const DISALLOWED_SECRET_VALUES = new Set([
  'change-me-before-production',
  'change-me-before-production-profile-key',
  'change-me-before-production-agent-secret',
  'replace-with-random-secret',
  'replace-with-admin-password',
  'replace-with-code-server-password'
]);

function requireSecretEnv(name, fallback = '') {
  const value = requireEnv(name, fallback).trim();
  if (DISALLOWED_SECRET_VALUES.has(value)) {
    throw new Error(`Unsafe placeholder value for ${name}. Generate a real secret before startup.`);
  }
  if (value.length < 24) {
    throw new Error(`${name} must be at least 24 characters long.`);
  }
  return value;
}

function optionalNumber(name, fallback) {
  const value = process.env[name];
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function proxySetting(name, fallback) {
  const value = process.env[name];
  if (value == null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : value;
}

function deriveOrigin(url, fallback = '') {
  try {
    return new URL(String(url || fallback)).origin;
  } catch (_) {
    return fallback;
  }
}

function normalizeUiLanguage(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'en' || normalized === 'en-us' || normalized === 'en_us') return 'en';
  return 'zh-CN';
}

const config = {
  host: process.env.HOST || '0.0.0.0',
  port: DEFAULT_PORT,
  appUrl: DEFAULT_APP_URL,
  appOrigin: deriveOrigin(DEFAULT_APP_URL, `http://localhost:${DEFAULT_PORT}`),
  dataDir: DATA_DIR,
  dbPath: process.env.DB_PATH || path.join(DATA_DIR, 'codex-switcher.db'),
  auditLogPath: process.env.AUDIT_LOG_PATH || path.join(DATA_DIR, 'audit.log'),
  sessionSecret: requireSecretEnv('SESSION_SECRET', 'change-me-before-production'),
  profileEncryptionKey: requireSecretEnv('CODEX_PROFILE_ENCRYPTION_KEY', 'change-me-before-production-profile-key'),
  agentSharedSecret: requireSecretEnv('CODEX_AGENT_SHARED_SECRET', 'change-me-before-production-agent-secret'),
  adminSeedEmail: process.env.ADMIN_SEED_EMAIL || '',
  adminSeedPassword: process.env.ADMIN_SEED_PASSWORD || '',
  sessionCookieDomain: process.env.SESSION_COOKIE_DOMAIN || '',
  trustProxy: proxySetting('TRUST_PROXY', 1),
  sessionSecure: String(
    process.env.SESSION_SECURE || (/^https:/i.test(DEFAULT_APP_URL) ? 'true' : 'false')
  ).toLowerCase() !== 'false',
  agentSocketPath: process.env.CODEX_AGENT_SOCKET_PATH || '/run/codex-switcher/agent.sock',
  quotaSampleIntervalMs: optionalNumber('QUOTA_SAMPLE_INTERVAL_MS', 30 * 1000),
  switchLockMs: optionalNumber('SWITCH_LOCK_MS', 60 * 1000),
  codeWorkspaceUrl: process.env.CODE_WORKSPACE_URL || '',
  codeOrigin: process.env.CODE_ORIGIN || deriveOrigin(process.env.CODE_WORKSPACE_URL || '', ''),
  defaultUiLanguage: normalizeUiLanguage(process.env.DEFAULT_UI_LANGUAGE || 'zh-CN'),
  authDeviceUrl: process.env.AUTH_DEVICE_URL || 'https://auth.openai.com/codex/device',
  serverTimeZone: process.env.SERVER_TIMEZONE || process.env.TZ || defaultServerTimeZone(),
  profileKeepaliveIntervalMs: optionalNumber('PROFILE_KEEPALIVE_INTERVAL_MS', 10 * 60 * 1000),
  availabilityProbeSweepMs: optionalNumber('AVAILABILITY_PROBE_SWEEP_MS', 30 * 1000),
  loginRateLimitMax: optionalNumber('LOGIN_RATE_LIMIT_MAX', 10),
  loginRateLimitWindowMs: optionalNumber('LOGIN_RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000),
  writeRateLimitMax: optionalNumber('WRITE_RATE_LIMIT_MAX', 120),
  writeRateLimitWindowMs: optionalNumber('WRITE_RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000)
};

module.exports = {
  config,
};
