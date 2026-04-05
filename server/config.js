'use strict';

const path = require('path');

const DATA_DIR = process.env.CODEX_SWITCHER_DATA_DIR || '/var/lib/codex-switcher';
const DEFAULT_PORT = optionalNumber('PORT', 29000);
const DEFAULT_APP_URL = process.env.APP_URL || `http://localhost:${DEFAULT_PORT}`;

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
  if (process.env.NODE_ENV === 'test') return value;
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

function optionalBoolean(name, fallback) {
  const value = process.env[name];
  if (value == null || value === '') return fallback;
  return String(value).toLowerCase() === 'true';
}

function optionalString(name, fallback) {
  if (Object.prototype.hasOwnProperty.call(process.env, name)) {
    return process.env[name];
  }
  return fallback;
}

function deriveOrigin(url, fallback = '') {
  try {
    return new URL(String(url || fallback)).origin;
  } catch (_) {
    return fallback;
  }
}

const config = {
  host: process.env.HOST || '0.0.0.0',
  port: DEFAULT_PORT,
  appUrl: DEFAULT_APP_URL,
  appOrigin: deriveOrigin(DEFAULT_APP_URL, `http://localhost:${DEFAULT_PORT}`),
  cookieDomain: optionalString('COOKIE_DOMAIN', optionalString('SESSION_COOKIE_DOMAIN', '')),
  cookieSecure: optionalBoolean('COOKIE_SECURE', /^https:/i.test(DEFAULT_APP_URL)),
  dataDir: DATA_DIR,
  dbPath: process.env.DB_PATH || path.join(DATA_DIR, 'codex-switcher.db'),
  auditLogPath: process.env.AUDIT_LOG_PATH || path.join(DATA_DIR, 'audit.log'),
  sessionSecret: requireSecretEnv('SESSION_SECRET', 'change-me-before-production'),
  profileEncryptionKey: requireSecretEnv('CODEX_PROFILE_ENCRYPTION_KEY', 'change-me-before-production-profile-key'),
  agentSharedSecret: requireSecretEnv('CODEX_AGENT_SHARED_SECRET', 'change-me-before-production-agent-secret'),
  adminSeedEmail: process.env.ADMIN_SEED_EMAIL || '',
  adminSeedPassword: process.env.ADMIN_SEED_PASSWORD || '',
  agentSocketPath: process.env.CODEX_AGENT_SOCKET_PATH || '/run/codex-switcher/agent.sock',
  browserBindTtlMs: optionalNumber('BROWSER_BIND_TTL_MS', 10 * 60 * 1000),
  browserPollIntervalMs: optionalNumber('BROWSER_POLL_INTERVAL_MS', 5000),
  quotaSampleIntervalMs: optionalNumber('QUOTA_SAMPLE_INTERVAL_MS', 30 * 1000),
  quotaSyncConcurrency: optionalNumber('QUOTA_SYNC_CONCURRENCY', 2),
  switchLockMs: optionalNumber('SWITCH_LOCK_MS', 60 * 1000),
  agentRequestTimeoutMs: optionalNumber('AGENT_REQUEST_TIMEOUT_MS', 10000),
  tokenRefreshTimeoutMs: optionalNumber('TOKEN_REFRESH_TIMEOUT_MS', 7000),
  usageRequestTimeoutMs: optionalNumber('USAGE_REQUEST_TIMEOUT_MS', 7000),
  browserActionRetentionMs: optionalNumber('BROWSER_ACTION_RETENTION_MS', 30 * 60 * 1000),
  codeWorkspaceUrl: process.env.CODE_WORKSPACE_URL || 'https://code.example.com/?workspace=/workspace/default.code-workspace',
  codeOrigin: process.env.CODE_ORIGIN || deriveOrigin(process.env.CODE_WORKSPACE_URL || 'https://code.example.com/?workspace=/workspace/default.code-workspace', 'https://code.example.com'),
  authDeviceUrl: process.env.AUTH_DEVICE_URL || 'https://auth.openai.com/codex/device',
  authWorkspaceUrl: process.env.AUTH_WORKSPACE_URL || 'https://auth.example.com',
  authWorkspaceTokenTtlMs: optionalNumber('AUTH_WORKSPACE_TOKEN_TTL_MS', 30 * 60 * 1000),
  authWorkspaceTerminalTtlMs: optionalNumber('AUTH_WORKSPACE_TERMINAL_TTL_MS', 60 * 1000),
  bridgeProxyToken: process.env.CODEX_BRIDGE_PROXY_TOKEN || process.env.CODEX_AGENT_SHARED_SECRET || 'change-me-before-production-bridge-token',
  forgejoProxyToken: process.env.FORGEJO_AUTOMATION_PROXY_TOKEN || process.env.CODEX_AGENT_SHARED_SECRET || 'change-me-before-production-forgejo-proxy-token',
  forgejoBaseUrl: process.env.FORGEJO_BASE_URL || '',
  forgejoToken: process.env.FORGEJO_TOKEN || '',
  managedProjectsStatePath: process.env.MANAGED_PROJECTS_STATE_PATH || path.join(DATA_DIR, 'managed-projects.json'),
  automationEnabled: String(process.env.AUTOMATION_ENABLED || 'false').toLowerCase() === 'true',
  automationPollIntervalMs: optionalNumber('AUTOMATION_POLL_INTERVAL_MS', 30 * 1000),
  automationBatchWindowMs: optionalNumber('AUTOMATION_BATCH_WINDOW_MS', 90 * 1000),
  automationBatchWindowMinMs: optionalNumber('AUTOMATION_BATCH_WINDOW_MIN_MS', 60 * 1000),
  automationBatchWindowMaxMs: optionalNumber('AUTOMATION_BATCH_WINDOW_MAX_MS', 120 * 1000),
  automationPromptVersion: process.env.AUTOMATION_PROMPT_VERSION || 'v1',
  automationSessionRoot: process.env.AUTOMATION_SESSION_ROOT || path.join(DATA_DIR, 'code-sessions'),
  automationBrowserExecutablePath: process.env.AUTOMATION_BROWSER_EXECUTABLE_PATH || '',
  codeServerPassword: process.env.CODE_SERVER_PASSWORD || '',
  codeServerHeadless: String(process.env.CODE_SERVER_HEADLESS || 'true').toLowerCase() !== 'false',
  forgejoBotName: process.env.FORGEJO_BOT_NAME || 'codex-switcher',
  serverTimeZone: process.env.SERVER_TIMEZONE || process.env.TZ || defaultServerTimeZone(),
  autoSwitchEnabled: String(process.env.AUTO_SWITCH_ENABLED || 'false').toLowerCase() === 'true',
  loginRateLimitMax: optionalNumber('LOGIN_RATE_LIMIT_MAX', 10),
  loginRateLimitWindowMs: optionalNumber('LOGIN_RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000),
  writeRateLimitMax: optionalNumber('WRITE_RATE_LIMIT_MAX', 120),
  writeRateLimitWindowMs: optionalNumber('WRITE_RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000)
};

module.exports = {
  config,
};
