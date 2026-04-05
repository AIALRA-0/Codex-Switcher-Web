'use strict';

const path = require('path');
const { URL } = require('url');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieSession = require('cookie-session');

const { config } = require('./config');
const {
  assertAuth,
  generatePortablePassphrase,
  genCSRF,
  hashPassword,
  verifyCSRF,
  verifyPassword
} = require('./security');
const {
  broadcast,
  registerSseClient,
  sendEvent,
  unregisterSseClient
} = require('./sse');
const {
  createAccount,
  deleteAuthProfile,
  createAdminUser,
  createBootstrapSession,
  clearQuotaSamples,
  clearSwitchEvents,
  deleteBootstrapSession,
  deleteProfile,
  getAuthProfileById,
  getAuthProfileByWorkspaceLabel,
  getAdminUser,
  getBootstrapSession,
  getPrimaryAuthProfileForSlot,
  getLatestActiveBootstrapSession,
  getLatestBootstrapSessionForSlot,
  getProfile,
  getRuntimeLock,
  getSlotByEmail,
  getSlotById,
  listAuthProfilesForSlot,
  listRecentQuotaSamples,
  listRecentSwitchEvents,
  listSlots,
  nowIso,
  recordAdminFailedLogin,
  seedDefaultSlots,
  setPrimaryAuthProfile,
  syncSlotAuthAggregate,
  updateAdminLogin,
  updateAuthProfile,
  updateBootstrapSession,
  updateSlot
} = require('./db');
const { writeAudit } = require('./audit');
const {
  activateSlot,
  acknowledgeBridgeAction,
  buildRuntimeSnapshot,
  buildInteractiveRecoverySummary,
  clearBootstrapTasks,
  deleteBootstrapTask,
  deleteManagedAccount,
  acknowledgeRuntimeAlert,
  getActiveAuthGeneration,
  getRuntimeRefreshState,
  getRuntimeSettings,
  handleBridgeHeartbeat,
  logoutSlot,
  maybeAutoSwitch,
  queueSlotLogout,
  queueSlotSwitch,
  reconcileActiveSlotFromAgent,
  replayBridgeActionsForSession,
  requestRuntimeRefresh,
  serializeSlot,
  syncPendingBootstrapSessions,
  updateRuntimeSettings
} = require('./service');
const {
  cancelBootstrap,
  startDeviceAuth
} = require('./agent-client');
const { buildManagedAuthUrl } = require('./auth-workspace-shared');
const { buildCodeBridge } = require('./code-bridge-template');
const { buildRepoKey } = require('./automation-helpers');
const { getAutomationService } = require('./automation');
const {
  exportExchangeEnvelope,
  importExchangeEnvelope,
  normalizeStrategy
} = require('./exchange');

const app = express();
const publicDir = path.join(__dirname, '..', 'public');
const automationService = getAutomationService();
const frameAncestors = (() => {
  const values = new Set(["'self'"]);
  for (const candidate of [config.appOrigin || config.appUrl, config.authWorkspaceUrl]) {
    try {
      if (candidate) values.add(new URL(candidate).origin);
    } catch (_) {
      // ignore invalid origins
    }
  }
  return Array.from(values);
})();

app.set('trust proxy', 'loopback');
app.disable('x-powered-by');

app.use(helmet({
  xFrameOptions: false,
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'", 'https://static.cloudflareinsights.com'],
      'script-src-elem': ["'self'", 'https://static.cloudflareinsights.com'],
      'style-src': ["'self'"],
      'img-src': ["'self'", 'data:', 'https://cloudflareinsights.com'],
      'connect-src': ["'self'", 'https://cloudflareinsights.com', 'https://static.cloudflareinsights.com'],
      'frame-ancestors': frameAncestors
    }
  }
}));

app.use(express.json({ limit: '256kb' }));
app.use(cookieSession({
  name: 'codex_switcher_session',
  keys: [config.sessionSecret],
  secure: config.cookieSecure,
  httpOnly: true,
  sameSite: 'lax',
  ...(config.cookieDomain ? { domain: config.cookieDomain } : {}),
  maxAge: 7 * 24 * 60 * 60 * 1000
}));

const loginLimiter = rateLimit({
  windowMs: config.loginRateLimitWindowMs,
  max: config.loginRateLimitMax,
  standardHeaders: true,
  legacyHeaders: false
});

const writeLimiter = rateLimit({
  windowMs: config.writeRateLimitWindowMs,
  max: config.writeRateLimitMax,
  standardHeaders: true,
  legacyHeaders: false
});

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const LOGIN_METHOD_VALUES = ['email', 'google', 'apple', 'microsoft', 'phone'];

function normalizeText(value) {
  return String(value || '').trim();
}

function unwrapErrorMessage(value) {
  if (value == null) return 'UNKNOWN_BACKEND_ERROR';
  if (value instanceof Error) return unwrapErrorMessage(value.message || value.code || value.name);
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text || text === '[object Object]' || text === '{}' || text === '[]') return 'UNKNOWN_BACKEND_ERROR';
    return text;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object') {
    return unwrapErrorMessage(value.error)
      || unwrapErrorMessage(value.message)
      || unwrapErrorMessage(value.code)
      || (() => {
        try {
          const serialized = JSON.stringify(value);
          return serialized && serialized !== '{}' && serialized !== '[]'
            ? serialized
            : 'UNKNOWN_BACKEND_ERROR';
        } catch (_) {
          return 'UNKNOWN_BACKEND_ERROR';
        }
      })();
  }
  const text = String(value).trim();
  return text || 'UNKNOWN_BACKEND_ERROR';
}

function sanitizeWorkspaceLabel(value) {
  return String(value || '').trim().slice(0, 80);
}

function findDuplicateAccountByEmail(email, excludeSlotId = null) {
  const normalizedEmail = normalizeText(email).toLowerCase();
  if (!normalizedEmail) return null;
  const existing = getSlotByEmail(normalizedEmail);
  if (!existing) return null;
  return existing.id === excludeSlotId ? null : existing;
}

function findDuplicateWorkspaceLabel(slotId, workspaceLabel, excludeAuthProfileId = null) {
  const normalizedLabel = sanitizeWorkspaceLabel(workspaceLabel);
  if (!slotId || !normalizedLabel) return null;
  const existing = getAuthProfileByWorkspaceLabel(slotId, normalizedLabel);
  if (!existing) return null;
  return existing.id === excludeAuthProfileId ? null : existing;
}

function normalizeAgentTaskError(error) {
  const message = String(error && error.message ? error.message : '').trim();
  if (!message) return null;
  if (message === 'AUTH_AGENT_FORBIDDEN') {
    return { status: 503, code: 'AUTH_AGENT_FORBIDDEN' };
  }
  if (message === 'AUTH_AGENT_UNAVAILABLE') {
    return { status: 503, code: 'AUTH_AGENT_UNAVAILABLE' };
  }
  if (message === 'AGENT_REQUEST_TIMEOUT') {
    return { status: 504, code: 'AGENT_REQUEST_TIMEOUT' };
  }
  if (message === 'FORBIDDEN') {
    return { status: 503, code: 'AUTH_AGENT_FORBIDDEN' };
  }
  if (/ENOENT|ECONNREFUSED|ECONNRESET|EPIPE|socket hang up/i.test(message)) {
    return { status: 503, code: 'AUTH_AGENT_UNAVAILABLE' };
  }
  return null;
}

function createTimingRecorder() {
  const startedAt = process.hrtime.bigint();
  const metrics = [];
  return {
    record(name, valueMs, description = '') {
      if (!Number.isFinite(valueMs)) return;
      metrics.push({ name, valueMs, description });
    },
    measure(name, startedNs, description = '') {
      const elapsedMs = Number(process.hrtime.bigint() - startedNs) / 1e6;
      metrics.push({ name, valueMs: elapsedMs, description });
    },
    apply(res) {
      const totalMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const parts = [
        ...metrics.map((item) => `${item.name};dur=${item.valueMs.toFixed(1)}${item.description ? `;desc="${item.description}"` : ''}`),
        `total;dur=${totalMs.toFixed(1)}`
      ];
      res.setHeader('Server-Timing', parts.join(', '));
    }
  };
}

function normalizeExpiryDate(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return DATE_PATTERN.test(text) ? text : '';
}

function sanitizeAccountInput(body) {
  const patch = {};
  if (typeof body.label === 'string') patch.label = body.label.trim().slice(0, 100);
  if (typeof body.email === 'string') {
    patch.email = body.email.trim().toLowerCase();
    if (patch.email) patch.label = patch.email;
  }
  if (typeof body.login_method === 'string' && LOGIN_METHOD_VALUES.includes(body.login_method)) patch.login_method = body.login_method;
  if (Object.prototype.hasOwnProperty.call(body || {}, 'expires_at')) patch.expires_at = normalizeExpiryDate(body.expires_at);
  return patch;
}

function hasSavedMetadata(slot) {
  return !!String(slot.email || '').trim()
    && EMAIL_PATTERN.test(String(slot.email || '').trim())
    && LOGIN_METHOD_VALUES.includes(String(slot.login_method || ''))
    && !!normalizeExpiryDate(slot.expires_at);
}

function deriveStateAfterEdit(slot, patch, hasProfile = !!getProfile(slot.id)) {
  const merged = { ...slot, ...patch };
  if (!hasSavedMetadata(merged)) return 'draft';
  if (hasProfile) return slot.is_active ? 'active' : 'ready';
  return 'auth_required';
}

function shouldResetSlotProfile(slot, patch) {
  if (!getProfile(slot.id)) return false;
  const nextEmail = Object.prototype.hasOwnProperty.call(patch, 'email')
    ? String(patch.email || '').trim().toLowerCase()
    : String(slot.email || '').trim().toLowerCase();
  const nextLoginMethod = Object.prototype.hasOwnProperty.call(patch, 'login_method')
    ? patch.login_method
    : slot.login_method;
  return nextEmail !== String(slot.email || '').trim().toLowerCase() || nextLoginMethod !== slot.login_method;
}

function buildProfileResetPatch(slot) {
  const draftLike = !hasSavedMetadata(slot);
  return {
    account_id: null,
    quota_5h_pct: null,
    quota_5h_reset_at: null,
    quota_5h_reset_label: null,
    quota_week_pct: null,
    quota_week_reset_at: null,
    quota_week_reset_label: null,
    freshness: 'stale',
    last_seen_at: null,
    last_bootstrap_at: null,
    last_error: null,
    is_active: 0,
    state: draftLike ? 'draft' : 'auth_required'
  };
}

function authWorkspaceHost() {
  try {
    return new URL(config.authWorkspaceUrl).host;
  } catch (_) {
    return '';
  }
}

function isAuthWorkspaceHost(req) {
  return String(req.hostname || req.get('host') || '').toLowerCase() === authWorkspaceHost().toLowerCase();
}

async function createBootstrapForSlot(slot, options = {}) {
  const bootstrapId = require('./security').randomToken(12);
  const authProfileId = options.authProfileId || null;
  const workspaceLabel = sanitizeWorkspaceLabel(options.workspaceLabel) || (authProfileId ? (getAuthProfileById(authProfileId)?.workspace_label || '主认证') : '主认证');
  const targetProfile = authProfileId ? getAuthProfileById(authProfileId) : null;
  const intent = options.intent
    || (authProfileId
      ? (targetProfile && targetProfile.is_primary ? 'reauth_primary' : 'reauth_workspace')
      : 'create_workspace');
  createBootstrapSession({
    id: bootstrapId,
    slot_id: slot.id,
    status: 'starting',
    email: slot.email,
    login_method: slot.login_method,
    intent,
    auth_profile_id: authProfileId,
    workspace_label: workspaceLabel
  });

  try {
    const started = await startDeviceAuth({
      bootstrapId,
      slotId: slot.id
    });

    updateBootstrapSession(bootstrapId, {
      status: started.status || 'awaiting_user',
      device_code: started.deviceCode || null,
      verification_uri: started.verificationUri || config.authDeviceUrl,
      bootstrap_home: started.bootstrapHome || null
    });

    updateSlot(slot.id, {
      state: 'auth_required',
      last_error: null
    });
    writeAudit('bootstrap.started', { bootstrapId, slotId: slot.id, email: slot.email, loginMethod: slot.login_method });
    sendRuntimeUpdate('bootstrap_started', { accountId: slot.id, bootstrapId });
    return getBootstrapSession(bootstrapId);
  } catch (error) {
    const agentError = normalizeAgentTaskError(error);
    const storedError = agentError ? agentError.code : unwrapErrorMessage(error);
    updateBootstrapSession(bootstrapId, {
      status: 'failed',
      error_text: storedError,
      completed_at: nowIso()
    });
    updateSlot(slot.id, { state: 'auth_required', last_error: storedError });
    if (agentError) {
      const wrappedError = new Error(agentError.code);
      wrappedError.cause = error;
      throw wrappedError;
    }
    throw error;
  }
}

async function ensureBootstrapSessionForSlot(slot, options = {}) {
  const authProfileId = options.authProfileId || null;
  const targetProfile = authProfileId ? getAuthProfileById(authProfileId) : null;
  const intent = options.intent
    || (authProfileId
      ? (targetProfile && targetProfile.is_primary ? 'reauth_primary' : 'reauth_workspace')
      : 'create_workspace');
  const existingBootstrap = getLatestBootstrapSessionForSlot(slot.id);
  if (
    existingBootstrap
    && ['starting', 'awaiting_user', 'success_pending_capture', 'succeeded'].includes(existingBootstrap.status)
    && String(existingBootstrap.auth_profile_id || '') === String(authProfileId || '')
    && String(existingBootstrap.intent || 'create_workspace') === intent
  ) {
    return existingBootstrap;
  }

  const activeBootstrap = getLatestActiveBootstrapSession();
  if (activeBootstrap && activeBootstrap.slot_id !== slot.id) {
    throw new Error(`BOOTSTRAP_ALREADY_ACTIVE:${activeBootstrap.email || activeBootstrap.slot_id}`);
  }

  const deviceAuthCooldown = getRuntimeLock('device_auth_cooldown');
  if (deviceAuthCooldown && deviceAuthCooldown.expires_at && new Date(deviceAuthCooldown.expires_at).getTime() > Date.now()) {
    throw new Error('DEVICE_AUTH_RATE_LIMITED');
  }

  if (
    existingBootstrap
    && existingBootstrap.status === 'failed'
    && /429 Too Many Requests/i.test(`${existingBootstrap.error_text || ''}\n${existingBootstrap.log_tail || ''}`)
    && (Date.now() - new Date(existingBootstrap.updated_at).getTime()) < 60_000
  ) {
    throw new Error('DEVICE_AUTH_RATE_LIMITED');
  }

  return createBootstrapForSlot(slot, { ...options, intent });
}

async function restartBootstrapSessionForSlot(slot, options = {}) {
  const existing = getLatestBootstrapSessionForSlot(slot.id);
  if (existing) {
    await cancelBootstrap({ bootstrapId: existing.id }).catch(() => {});
    deleteBootstrapSession(existing.id);
  }
  updateSlot(slot.id, {
    state: 'auth_required',
    last_error: null
  });
  return createBootstrapForSlot(slot, options);
}

async function seedAdminIfNeeded() {
  seedDefaultSlots();
  const admin = getAdminUser();
  if (admin) return;
  if (!config.adminSeedEmail || !config.adminSeedPassword) {
    throw new Error('ADMIN_SEED_EMAIL and ADMIN_SEED_PASSWORD are required for first startup');
  }
  const passwordHash = await hashPassword(config.adminSeedPassword);
  createAdminUser(config.adminSeedEmail, passwordHash);
  writeAudit('admin.seeded', { email: config.adminSeedEmail });
}

function sendRuntimeUpdate(reason, extra = {}) {
  broadcast('admins', 'runtime_updated', { reason, ...extra, ts: nowIso() });
}

function assertForgejoProxy(req, res, next) {
  return automationService.requireForgejoProxy(req, res, next);
}

function assertBridgeProxy(req, res, next) {
  return automationService.requireBridgeProxy(req, res, next);
}

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, now: nowIso() });
});

app.get('/api/csrf', (req, res) => {
  res.json({ ok: true, token: genCSRF(req) });
});

app.get('/api/session', (req, res) => {
  if (!req.session || !req.session.adminUserId) {
    return res.json({ authenticated: false });
  }
  const admin = getAdminUser();
  return res.json({
    authenticated: true,
    user: {
      id: req.session.adminUserId,
      email: admin ? admin.email : ''
    }
  });
});

app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  const admin = getAdminUser();
  if (!admin || !email || !password || admin.email !== String(email).trim()) {
    writeAudit('auth.login_failed', { email });
    return res.status(401).json({ ok: false, error: 'INVALID_CREDENTIALS' });
  }

  if (admin.locked_until && new Date(admin.locked_until).getTime() > Date.now()) {
    return res.status(429).json({ ok: false, error: 'ACCOUNT_LOCKED' });
  }

  const ok = await verifyPassword(password, admin.password_hash);
  if (!ok) {
    const nextAttempts = (admin.failed_attempts || 0) + 1;
    const lockedUntil = nextAttempts >= 5 ? new Date(Date.now() + 10 * 60 * 1000).toISOString() : null;
    recordAdminFailedLogin(admin.email, nextAttempts, lockedUntil);
    writeAudit('auth.login_failed', { email, attempts: nextAttempts });
    return res.status(401).json({ ok: false, error: 'INVALID_CREDENTIALS' });
  }

  req.session.adminUserId = admin.id;
  genCSRF(req);
  updateAdminLogin(admin.email);
  writeAudit('auth.login_succeeded', { email });
  return res.json({ ok: true });
});

app.post('/api/auth/logout', writeLimiter, verifyCSRF, assertAuth, (req, res) => {
  const admin = getAdminUser();
  writeAudit('auth.logout', { email: admin ? admin.email : '' });
  req.session = null;
  res.json({ ok: true });
});

app.get('/api/events/stream', assertAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  registerSseClient('admins', res);
  sendEvent(res, 'hello', { now: nowIso() });
  const interval = setInterval(() => sendEvent(res, 'ping', { now: nowIso() }), 25000);

  req.on('close', () => {
    clearInterval(interval);
    unregisterSseClient('admins', res);
  });
});

app.get('/api/runtime', assertAuth, async (_req, res, next) => {
  const timing = createTimingRecorder();
  try {
    const includeLogs = String(_req.query.includeLogs || '1') !== '0';
    const runtimeStart = process.hrtime.bigint();
    const runtime = await buildRuntimeSnapshot();
    timing.measure('db', runtimeStart, 'runtime_snapshot');
    const payload = {
      ok: true,
      runtime
    };
    if (includeLogs) {
      const logsStart = process.hrtime.bigint();
      payload.recentSwitches = listRecentSwitchEvents(60);
      payload.recentSamples = listRecentQuotaSamples(60);
      timing.measure('logs', logsStart, 'recent_logs');
    }
    timing.record('bootstrap_sync', 0, 'background');
    timing.record('agent_status', 0, 'snapshot_only');
    timing.record('quota_sync', 0, 'snapshot_only');
    timing.apply(res);
    res.json(payload);
  } catch (error) {
    next(error);
  }
});

app.post('/api/runtime/refresh', writeLimiter, verifyCSRF, assertAuth, (req, res) => {
  const timing = createTimingRecorder();
  const preferredSlotId = typeof req.body?.slotId === 'string' ? req.body.slotId : null;
  const trigger = typeof req.body?.trigger === 'string' ? req.body.trigger : 'manual';
  const scheduleStart = process.hrtime.bigint();
  const refreshState = requestRuntimeRefresh(trigger, { preferredSlotId, mode: preferredSlotId ? 'manual' : 'auto' });
  timing.measure('quota_sync', scheduleStart, 'refresh_scheduled');
  timing.record('db', 0, 'write_lock_only');
  timing.record('bootstrap_sync', 0, 'background');
  timing.record('agent_status', 0, 'background');
  timing.apply(res);
  res.status(202).json({
    ok: true,
    accepted: true,
    refreshState
  });
});

app.patch('/api/runtime/settings', writeLimiter, verifyCSRF, assertAuth, (req, res) => {
  const nextSettings = {};
  if (typeof req.body?.autoSwitchEnabled === 'boolean') {
    nextSettings.auto_switch_enabled = req.body.autoSwitchEnabled;
  }
  const settings = updateRuntimeSettings(nextSettings);
  sendRuntimeUpdate('runtime_settings_updated', { settings });
  res.json({ ok: true, settings });
});

app.post('/api/runtime/alerts/:id/ack', writeLimiter, verifyCSRF, assertAuth, (req, res) => {
  const acknowledged = acknowledgeRuntimeAlert(req.params.id);
  if (acknowledged) {
    sendRuntimeUpdate('runtime_alert_acknowledged', { alertId: req.params.id });
  }
  res.json({ ok: true, acknowledged });
});

app.get('/api/automation/runtime', assertAuth, (_req, res) => {
  res.json(automationService.getDashboardSnapshot());
});

app.get('/api/automation/runs/:id', assertAuth, (req, res) => {
  const details = automationService.getRunDetails(req.params.id);
  if (!details) return res.status(404).json({ ok: false, error: 'RUN_NOT_FOUND' });
  return res.json({ ok: true, ...details });
});

app.delete('/api/logs/switches', writeLimiter, verifyCSRF, assertAuth, (_req, res) => {
  const deleted = clearSwitchEvents();
  writeAudit('logs.switches_cleared', { deleted });
  sendRuntimeUpdate('switch_logs_cleared', { deleted });
  res.json({ ok: true, deleted });
});

app.delete('/api/logs/quota-samples', writeLimiter, verifyCSRF, assertAuth, (_req, res) => {
  const deleted = clearQuotaSamples();
  writeAudit('logs.quota_samples_cleared', { deleted });
  sendRuntimeUpdate('quota_logs_cleared', { deleted });
  res.json({ ok: true, deleted });
});

app.get('/api/exchange/passphrase', assertAuth, (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    ok: true,
    passphrase: generatePortablePassphrase(10),
    settings: getRuntimeSettings()
  });
});

app.post('/api/exchange/export', writeLimiter, verifyCSRF, assertAuth, (req, res) => {
  try {
    const passphrase = String(req.body?.passphrase || '');
    const source = normalizeText(req.body?.source || 'codex-switcher-web');
    if (!passphrase) return res.status(400).json({ ok: false, error: 'PASSPHRASE_REQUIRED' });
    const exportData = exportExchangeEnvelope(passphrase, { source });
    writeAudit('exchange.exported', {
      source,
      accountCount: exportData && exportData.encryption ? listSlots().length : 0
    });
    res.json({ ok: true, exportData });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message || 'EXPORT_FAILED' });
  }
});

app.post('/api/exchange/import', writeLimiter, verifyCSRF, assertAuth, (req, res) => {
  try {
    const passphrase = String(req.body?.passphrase || '');
    if (!passphrase) return res.status(400).json({ ok: false, error: 'PASSPHRASE_REQUIRED' });
    const strategy = normalizeStrategy(String(req.body?.strategy || 'merge'));
    const envelope = typeof req.body?.data === 'string' ? JSON.parse(req.body.data) : req.body?.data;
    const result = importExchangeEnvelope(envelope, passphrase, { strategy });
    writeAudit('exchange.imported', result);
    sendRuntimeUpdate('exchange_imported', result);
    res.json({ ok: true, result });
  } catch (error) {
    const message = String(error.message || '');
    if (message === 'PASSPHRASE_REQUIRED') {
      return res.status(400).json({ ok: false, error: 'PASSPHRASE_REQUIRED' });
    }
    if (
      [
        'UNSUPPORTED_EXCHANGE_SCHEMA',
        'INVALID_EXCHANGE_PAYLOAD',
        'UNSUPPORTED_ENCRYPTION',
        'EXCHANGE_DECRYPT_FAILED',
        'EXCHANGE_PROFILE_CONFLICT_OTHER_ACCOUNT',
        'EXCHANGE_DUPLICATE_WORKSPACE'
      ].includes(message)
    ) {
      return res.status(400).json({ ok: false, error: message });
    }
    return res.status(400).json({ ok: false, error: 'EXCHANGE_IMPORT_FAILED' });
  }
});

app.get('/api/accounts', assertAuth, (_req, res) => {
  res.json({ ok: true, accounts: listSlots().map(serializeSlot) });
});

app.post('/api/accounts', writeLimiter, verifyCSRF, assertAuth, (_req, res) => {
  const account = createAccount();
  writeAudit('account.created', { accountId: account.id });
  sendRuntimeUpdate('account_created', { accountId: account.id });
  res.json({ ok: true, account: serializeSlot(account) });
});

app.patch('/api/accounts/:id', writeLimiter, verifyCSRF, assertAuth, (req, res) => {
  const slot = getSlotById(req.params.id);
  if (!slot) return res.status(404).json({ ok: false, error: 'ACCOUNT_NOT_FOUND' });

  const patch = sanitizeAccountInput(req.body || {});
  if (patch.email) {
    const duplicateSlot = findDuplicateAccountByEmail(patch.email, slot.id);
    if (duplicateSlot) {
      return res.status(409).json({ ok: false, error: 'ACCOUNT_EMAIL_DUPLICATE' });
    }
  }
  const resetProfile = shouldResetSlotProfile(slot, patch);
  if (resetProfile && slot.is_active) {
    return res.status(409).json({ ok: false, error: 'ACTIVE_ACCOUNT_MUST_EXIT_FIRST' });
  }

  if (resetProfile) {
    deleteProfile(slot.id);
    Object.assign(patch, buildProfileResetPatch({ ...slot, ...patch }));
  }

  patch.state = deriveStateAfterEdit(slot, patch, !resetProfile && !!getProfile(slot.id));
  updateSlot(slot.id, patch);
  writeAudit('account.updated', { accountId: slot.id, patch });
  sendRuntimeUpdate('account_updated', { accountId: slot.id });
  res.json({ ok: true, account: serializeSlot(getSlotById(slot.id)) });
});

app.post('/api/accounts/:id/bootstrap', writeLimiter, verifyCSRF, assertAuth, async (req, res, next) => {
  const slot = getSlotById(req.params.id);
  if (!slot) return res.status(404).json({ ok: false, error: 'ACCOUNT_NOT_FOUND' });
  if (!hasSavedMetadata(slot)) return res.status(400).json({ ok: false, error: 'ACCOUNT_DATA_INCOMPLETE' });
  const authProfileId = typeof req.body?.authProfileId === 'string' ? req.body.authProfileId : null;
  const workspaceLabel = sanitizeWorkspaceLabel(req.body?.workspaceLabel || '');
  if (authProfileId) {
    const authProfile = getAuthProfileById(authProfileId);
    if (!authProfile || authProfile.slot_id !== slot.id) {
      return res.status(404).json({ ok: false, error: 'AUTH_PROFILE_NOT_FOUND' });
    }
  } else if (slot.has_profile && !workspaceLabel) {
    return res.status(400).json({ ok: false, error: 'WORKSPACE_LABEL_REQUIRED' });
  }
  if (!authProfileId && workspaceLabel) {
    const duplicateWorkspace = findDuplicateWorkspaceLabel(slot.id, workspaceLabel);
    if (duplicateWorkspace) {
      return res.status(409).json({ ok: false, error: 'WORKSPACE_LABEL_DUPLICATE' });
    }
  }

  try {
    const bootstrapSession = await ensureBootstrapSessionForSlot(slot, {
      authProfileId,
      workspaceLabel
    });
    const authOpenUrl = buildManagedAuthUrl(
      bootstrapSession.verification_uri || config.authDeviceUrl,
      slot.email || ''
    );
    res.json({
      ok: true,
      reused: bootstrapSession && bootstrapSession.id === (getLatestBootstrapSessionForSlot(slot.id) || {}).id,
      bootstrapSession,
      authOpenUrl
    });
  } catch (error) {
    if (error.message === 'DEVICE_AUTH_RATE_LIMITED') {
      return res.status(429).json({ ok: false, error: 'DEVICE_AUTH_RATE_LIMITED' });
    }
    if (error.message.startsWith('BOOTSTRAP_ALREADY_ACTIVE:')) {
      return res.status(409).json({ ok: false, error: 'BOOTSTRAP_ALREADY_ACTIVE' });
    }
    const agentError = normalizeAgentTaskError(error);
    if (agentError) {
      return res.status(agentError.status).json({ ok: false, error: agentError.code });
    }
    next(error);
  }
});

app.post('/api/accounts/:id/bootstrap/restart', writeLimiter, verifyCSRF, assertAuth, async (req, res, next) => {
  const slot = getSlotById(req.params.id);
  if (!slot) return res.status(404).json({ ok: false, error: 'ACCOUNT_NOT_FOUND' });
  if (!hasSavedMetadata(slot)) return res.status(400).json({ ok: false, error: 'ACCOUNT_DATA_INCOMPLETE' });
  const authProfileId = typeof req.body?.authProfileId === 'string' ? req.body.authProfileId : null;
  const workspaceLabel = sanitizeWorkspaceLabel(req.body?.workspaceLabel || '');
  if (authProfileId) {
    const authProfile = getAuthProfileById(authProfileId);
    if (!authProfile || authProfile.slot_id !== slot.id) {
      return res.status(404).json({ ok: false, error: 'AUTH_PROFILE_NOT_FOUND' });
    }
  }
  if (!authProfileId && workspaceLabel) {
    const duplicateWorkspace = findDuplicateWorkspaceLabel(slot.id, workspaceLabel);
    if (duplicateWorkspace) {
      return res.status(409).json({ ok: false, error: 'WORKSPACE_LABEL_DUPLICATE' });
    }
  }

  try {
    const activeBootstrap = getLatestActiveBootstrapSession();
    if (activeBootstrap && activeBootstrap.slot_id !== slot.id) {
      return res.status(409).json({ ok: false, error: 'BOOTSTRAP_ALREADY_ACTIVE' });
    }
    const bootstrapSession = await restartBootstrapSessionForSlot(slot, {
      authProfileId,
      workspaceLabel
    });
    const authOpenUrl = buildManagedAuthUrl(
      bootstrapSession.verification_uri || config.authDeviceUrl,
      slot.email || ''
    );
    return res.json({
      ok: true,
      bootstrapSession,
      authOpenUrl
    });
  } catch (error) {
    if (error.message === 'DEVICE_AUTH_RATE_LIMITED') {
      return res.status(429).json({ ok: false, error: 'DEVICE_AUTH_RATE_LIMITED' });
    }
    if (String(error.message || '').startsWith('BOOTSTRAP_ALREADY_ACTIVE:')) {
      return res.status(409).json({ ok: false, error: 'BOOTSTRAP_ALREADY_ACTIVE' });
    }
    const agentError = normalizeAgentTaskError(error);
    if (agentError) {
      return res.status(agentError.status).json({ ok: false, error: agentError.code });
    }
    next(error);
  }
});

app.all(['/api/accounts/:id/auth-workspace', '/api/auth-workspaces/:slotId', '/api/auth-workspaces/:slotId/reset', '/api/auth-workspaces/:slotId/actions'], (_req, res) => {
  res.status(410).json({ ok: false, error: 'AUTH_WORKSPACE_RETIRED' });
});

app.delete('/api/bootstrap-sessions/:id', writeLimiter, verifyCSRF, assertAuth, async (req, res, next) => {
  try {
    await deleteBootstrapTask(req.params.id);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/bootstrap-sessions', writeLimiter, verifyCSRF, assertAuth, async (_req, res, next) => {
  try {
    const deleted = await clearBootstrapTasks();
    res.json({ ok: true, deleted });
  } catch (error) {
    next(error);
  }
});

app.post('/api/accounts/:id/switch', writeLimiter, verifyCSRF, assertAuth, async (req, res, next) => {
  try {
    const authProfileId = typeof req.body?.authProfileId === 'string' ? req.body.authProfileId : null;
    if (authProfileId) {
      const authProfile = getAuthProfileById(authProfileId);
      if (!authProfile || authProfile.slot_id !== req.params.id) {
        return res.status(404).json({ ok: false, error: 'AUTH_PROFILE_NOT_FOUND' });
      }
    }
    const result = queueSlotSwitch(req.params.id, 'manual_switch', { authProfileId });
    res.status(202).json({ ok: true, accepted: true, ...result });
  } catch (error) {
    next(error);
  }
});

app.post('/api/accounts/:id/logout', writeLimiter, verifyCSRF, assertAuth, async (req, res, next) => {
  try {
    const authProfileId = typeof req.body?.authProfileId === 'string' ? req.body.authProfileId : null;
    if (authProfileId) {
      const authProfile = getAuthProfileById(authProfileId);
      if (!authProfile || authProfile.slot_id !== req.params.id) {
        return res.status(404).json({ ok: false, error: 'AUTH_PROFILE_NOT_FOUND' });
      }
    }
    const result = queueSlotLogout(req.params.id, { authProfileId });
    res.status(202).json({ ok: true, accepted: true, ...result });
  } catch (error) {
    next(error);
  }
});

app.patch('/api/accounts/:id/auth-profiles/:authProfileId', writeLimiter, verifyCSRF, assertAuth, (req, res) => {
  const slot = getSlotById(req.params.id);
  if (!slot) return res.status(404).json({ ok: false, error: 'ACCOUNT_NOT_FOUND' });
  const authProfile = getAuthProfileById(req.params.authProfileId);
  if (!authProfile || authProfile.slot_id !== slot.id) {
    return res.status(404).json({ ok: false, error: 'AUTH_PROFILE_NOT_FOUND' });
  }
  const patch = {};
  if (typeof req.body?.workspaceLabel === 'string') {
    const workspaceLabel = sanitizeWorkspaceLabel(req.body.workspaceLabel);
    if (!workspaceLabel) return res.status(400).json({ ok: false, error: 'WORKSPACE_LABEL_REQUIRED' });
    const duplicateWorkspace = findDuplicateWorkspaceLabel(slot.id, workspaceLabel, authProfile.id);
    if (duplicateWorkspace) {
      return res.status(409).json({ ok: false, error: 'WORKSPACE_LABEL_DUPLICATE' });
    }
    patch.workspace_label = workspaceLabel;
  }
  updateAuthProfile(authProfile.id, patch);
  syncSlotAuthAggregate(slot.id);
  sendRuntimeUpdate('auth_profile_updated', { accountId: slot.id, authProfileId: authProfile.id });
  res.json({ ok: true, authProfile: getAuthProfileById(authProfile.id) });
});

app.post('/api/accounts/:id/auth-profiles/:authProfileId/primary', writeLimiter, verifyCSRF, assertAuth, (req, res) => {
  const slot = getSlotById(req.params.id);
  if (!slot) return res.status(404).json({ ok: false, error: 'ACCOUNT_NOT_FOUND' });
  const authProfile = getAuthProfileById(req.params.authProfileId);
  if (!authProfile || authProfile.slot_id !== slot.id) {
    return res.status(404).json({ ok: false, error: 'AUTH_PROFILE_NOT_FOUND' });
  }
  setPrimaryAuthProfile(slot.id, authProfile.id);
  syncSlotAuthAggregate(slot.id);
  sendRuntimeUpdate('auth_profile_primary_changed', { accountId: slot.id, authProfileId: authProfile.id });
  res.json({ ok: true, authProfile: getAuthProfileById(authProfile.id) });
});

app.delete('/api/accounts/:id/auth-profiles/:authProfileId', writeLimiter, verifyCSRF, assertAuth, async (req, res, next) => {
  try {
    const slot = getSlotById(req.params.id);
    if (!slot) return res.status(404).json({ ok: false, error: 'ACCOUNT_NOT_FOUND' });
    const authProfile = getAuthProfileById(req.params.authProfileId);
    if (!authProfile || authProfile.slot_id !== slot.id) {
      return res.status(404).json({ ok: false, error: 'AUTH_PROFILE_NOT_FOUND' });
    }
    if (authProfile.is_active || (slot.is_active && slot.active_auth_profile_id === authProfile.id)) {
      const result = queueSlotLogout(slot.id, { authProfileId: authProfile.id });
      return res.status(202).json({ ok: true, accepted: true, ...result });
    }
    await logoutSlot(slot.id, { authProfileId: authProfile.id });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/accounts/:id', writeLimiter, verifyCSRF, assertAuth, async (req, res, next) => {
  try {
    await deleteManagedAccount(req.params.id);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get('/api/slots', assertAuth, (_req, res) => {
  res.json({ ok: true, slots: listSlots().map(serializeSlot) });
});

app.use('/assets', express.static(publicDir, {
  maxAge: '5m',
  etag: true
}));

app.get('/codex-switcher.user.js', (_req, res) => {
  res.status(410).type('text/plain; charset=utf-8').send('Codex Switcher userscript has been retired.');
});

app.get('/bridge/code.js', (_req, res) => {
  res.type('application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(buildCodeBridge());
});

app.post('/api/bridge/workspace-ready', assertBridgeProxy, async (req, res, next) => {
  try {
    const heartbeat = await handleBridgeHeartbeat(req.body || {});
    const repoSession = automationService.recordBridgeHeartbeat(req.body || {});
    res.json({
      ok: true,
      repoSession,
      session: heartbeat.session,
      interactiveRecovery: heartbeat.interactiveRecovery,
      activeAuthGeneration: heartbeat.activeAuthGeneration
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/bridge/thread-health', assertBridgeProxy, async (req, res, next) => {
  try {
    const heartbeat = await handleBridgeHeartbeat(req.body || {});
    const repoSession = automationService.recordBridgeHeartbeat(req.body || {});
    res.json({
      ok: true,
      repoSession,
      session: heartbeat.session,
      interactiveRecovery: heartbeat.interactiveRecovery,
      activeAuthGeneration: heartbeat.activeAuthGeneration
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/bridge/events/stream', assertBridgeProxy, (req, res) => {
  const sessionId = String(req.query.sessionId || '').trim();
  if (!sessionId) {
    return res.status(400).json({ ok: false, error: 'BRIDGE_SESSION_ID_REQUIRED' });
  }
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const key = `bridge:${sessionId}`;
  registerSseClient(key, res);
  sendEvent(res, 'hello', {
    now: nowIso(),
    sessionId,
    activeAuthGeneration: getActiveAuthGeneration(),
    interactiveRecovery: buildInteractiveRecoverySummary()
  });
  replayBridgeActionsForSession(sessionId);
  const interval = setInterval(() => sendEvent(res, 'ping', {
    now: nowIso(),
    sessionId,
    activeAuthGeneration: getActiveAuthGeneration()
  }), 25000);
  req.on('close', () => {
    clearInterval(interval);
    unregisterSseClient(key, res);
  });
});

app.post('/api/bridge/actions/:id/ack', assertBridgeProxy, (req, res, next) => {
  try {
    const action = acknowledgeBridgeAction(req.params.id, req.body || {});
    res.json({ ok: true, action });
  } catch (error) {
    next(error);
  }
});

app.get('/api/forgejo/events/stream', assertForgejoProxy, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  registerSseClient('automation_console', res);
  sendEvent(res, 'hello', { now: nowIso() });
  const interval = setInterval(() => sendEvent(res, 'ping', { now: nowIso() }), 25000);
  req.on('close', () => {
    clearInterval(interval);
    unregisterSseClient('automation_console', res);
  });
});

app.get('/api/forgejo/runtime', assertForgejoProxy, (_req, res) => {
  res.json(automationService.getDashboardSnapshot());
});

app.get('/api/forgejo/runs/:id', assertForgejoProxy, (req, res) => {
  const details = automationService.getRunDetails(req.params.id);
  if (!details) return res.status(404).json({ ok: false, error: 'RUN_NOT_FOUND' });
  return res.json({ ok: true, ...details });
});

app.get('/api/forgejo/repos/:owner/:repo/issues/:number/config', assertForgejoProxy, async (req, res, next) => {
  try {
    const payload = await automationService.readIssueConfig(
      req.params.owner,
      req.params.repo,
      Number(req.params.number)
    );
    res.json({ ok: true, ...payload });
  } catch (error) {
    next(error);
  }
});

app.put('/api/forgejo/repos/:owner/:repo/issues/:number/config', assertForgejoProxy, async (req, res, next) => {
  try {
    const payload = await automationService.updateIssueConfig(
      req.params.owner,
      req.params.repo,
      Number(req.params.number),
      req.body || {}
    );
    res.json({ ok: true, ...payload });
  } catch (error) {
    next(error);
  }
});

app.post('/api/forgejo/repos/:owner/:repo/issues/:number/commands', assertForgejoProxy, async (req, res, next) => {
  try {
    const command = String(req.body && req.body.command || '').trim().toLowerCase();
    const note = String(req.body && req.body.note || '').trim();
    let text = '';
    if (command === 'approve') text = '/codex approve';
    if (command === 'cancel') text = '/codex cancel';
    if (command === 'revise') text = `/codex revise ${note}`.trimEnd();
    if (!text) return res.status(400).json({ ok: false, error: 'INVALID_COMMAND' });
    await automationService.postIssueCommand(
      req.params.owner,
      req.params.repo,
      Number(req.params.number),
      text
    );
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post('/api/forgejo/batches/:id/retry', assertForgejoProxy, (req, res) => {
  const batch = automationService.retryBatch(req.params.id);
  if (!batch) return res.status(404).json({ ok: false, error: 'BATCH_NOT_FOUND' });
  res.json({ ok: true, batch });
});

app.post('/api/forgejo/repos/:owner/:repo/pause', assertForgejoProxy, (req, res) => {
  const repoSession = automationService.toggleRepoPause(
    buildRepoKey(req.params.owner, req.params.repo),
    !!(req.body && req.body.paused)
  );
  if (!repoSession) return res.status(404).json({ ok: false, error: 'REPO_NOT_FOUND' });
  res.json({ ok: true, repoSession });
});

app.get(['/auth-workspace', '/auth-workspace/:slotId'], (_req, res) => {
  res.redirect(302, config.appUrl);
});

app.get('/', (req, res) => {
  if (isAuthWorkspaceHost(req)) {
    return res.redirect(302, config.appUrl);
  }
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.use((error, _req, res, _next) => {
  console.error('[codex-switcher]', error);
  const message = unwrapErrorMessage(error);
  writeAudit('app.error', { message });
  res.status(500).json({ ok: false, error: message });
});

let bootstrapSyncTimer = null;
let autoSwitchTimer = null;
let httpServer = null;
let shutdownPromise = null;
const activeSockets = new Set();

async function start() {
  await seedAdminIfNeeded();
  await reconcileActiveSlotFromAgent();
  automationService.start();
  requestRuntimeRefresh('startup', { mode: 'auto' });

  bootstrapSyncTimer = setInterval(() => {
    syncPendingBootstrapSessions().then((changed) => {
      if (changed) sendRuntimeUpdate('bootstrap_synced');
    }).catch((error) => {
      writeAudit('bootstrap.sync_failed', { message: error.message });
    });
  }, 5000);
  bootstrapSyncTimer.unref();

  autoSwitchTimer = setInterval(() => {
    maybeAutoSwitch().then((result) => {
      if (result && result.state && result.state !== 'healthy' && result.state !== 'disabled' && result.state !== 'no_active_slot' && result.state !== 'busy') {
        sendRuntimeUpdate('auto_switch_checked', result);
      }
    }).catch((error) => {
      writeAudit('auto_switch.failed', { message: error.message });
    });
  }, 10000);
  autoSwitchTimer.unref();

  await new Promise((resolve, reject) => {
    const server = app.listen(config.port, config.host, () => {
      httpServer = server;
      console.log(`Codex switcher listening on http://${config.host}:${config.port}`);
      resolve();
    });
    server.on('connection', (socket) => {
      activeSockets.add(socket);
      socket.on('close', () => activeSockets.delete(socket));
    });
    server.on('error', reject);
  });
}

async function stop() {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    if (bootstrapSyncTimer) {
      clearInterval(bootstrapSyncTimer);
      bootstrapSyncTimer = null;
    }
    if (autoSwitchTimer) {
      clearInterval(autoSwitchTimer);
      autoSwitchTimer = null;
    }
    await automationService.stop().catch(() => {});
    if (httpServer) {
      await new Promise((resolve) => {
        httpServer.close(() => resolve());
        httpServer.closeIdleConnections?.();
        httpServer.closeAllConnections?.();
        setTimeout(() => {
          for (const socket of activeSockets) {
            socket.destroy();
          }
          resolve();
        }, 1000).unref();
      });
      httpServer = null;
    }
    activeSockets.clear();
  })();
  return shutdownPromise;
}

function registerShutdownSignal(signal) {
  process.on(signal, () => {
    stop().then(() => {
      process.exit(0);
    }).catch((error) => {
      console.error(error);
      process.exit(1);
    });
  });
}

if (require.main === module) {
  registerShutdownSignal('SIGINT');
  registerShutdownSignal('SIGTERM');
  start().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  app,
  start,
  stop
};
