'use strict';

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieSession = require('cookie-session');

const { config } = require('./config');
const {
  assertAuth,
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
  createAdminUser,
  createBootstrapSession,
  clearQuotaSamples,
  clearSwitchEvents,
  deleteBootstrapSession,
  deleteProfile,
  getAdminUser,
  getBootstrapSession,
  getLatestActiveBootstrapSession,
  getLatestBootstrapSessionForSlot,
  getProfile,
  getRuntimeLock,
  getSlotById,
  listRecentQuotaSamples,
  listRecentSwitchEvents,
  listSlots,
  nowIso,
  recordAdminFailedLogin,
  seedDefaultSlots,
  updateAdminLogin,
  updateBootstrapSession,
  updateSlot
} = require('./db');
const { writeAudit } = require('./audit');
const {
  activateSlot,
  buildRuntimeSnapshot,
  clearBootstrapTasks,
  deleteBootstrapTask,
  deleteManagedAccount,
  logoutSlot,
  reconcileActiveSlotFromAgent,
  serializeSlot,
  syncPendingBootstrapSessions
} = require('./service');
const {
  cancelBootstrap,
  startDeviceAuth
} = require('./agent-client');
const { buildManagedAuthUrl } = require('./auth-link');

const app = express();
const publicDir = path.join(__dirname, '..', 'public');

app.set('trust proxy', config.trustProxy);
app.disable('x-powered-by');

app.use(helmet({
  xFrameOptions: false,
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'"],
      'style-src': ["'self'"],
      'img-src': ["'self'", 'data:'],
      'connect-src': ["'self'"],
      'frame-ancestors': ["'self'"]
    }
  }
}));

app.use(express.json({ limit: '256kb' }));
app.use(cookieSession({
  name: 'codex_switcher_session',
  keys: [config.sessionSecret],
  secure: config.sessionSecure,
  httpOnly: true,
  sameSite: 'lax',
  domain: config.sessionCookieDomain || undefined,
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
  if (typeof body.login_method === 'string' && ['email', 'google'].includes(body.login_method)) patch.login_method = body.login_method;
  if (Object.prototype.hasOwnProperty.call(body || {}, 'expires_at')) patch.expires_at = normalizeExpiryDate(body.expires_at);
  return patch;
}

function hasSavedMetadata(slot) {
  return !!String(slot.email || '').trim()
    && EMAIL_PATTERN.test(String(slot.email || '').trim())
    && ['email', 'google'].includes(String(slot.login_method || ''))
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

async function createBootstrapForSlot(slot) {
  const bootstrapId = require('./security').randomToken(12);
  createBootstrapSession({
    id: bootstrapId,
    slot_id: slot.id,
    status: 'starting',
    email: slot.email,
    login_method: slot.login_method
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
    updateBootstrapSession(bootstrapId, {
      status: 'failed',
      error_text: error.message,
      completed_at: nowIso()
    });
    updateSlot(slot.id, { state: 'auth_required', last_error: error.message });
    throw error;
  }
}

async function ensureBootstrapSessionForSlot(slot) {
  const existingBootstrap = getLatestBootstrapSessionForSlot(slot.id);
  if (existingBootstrap && ['starting', 'awaiting_user', 'success_pending_capture', 'succeeded'].includes(existingBootstrap.status)) {
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

  return createBootstrapForSlot(slot);
}

async function restartBootstrapSessionForSlot(slot) {
  const existing = getLatestBootstrapSessionForSlot(slot.id);
  if (existing) {
    await cancelBootstrap({ bootstrapId: existing.id }).catch(() => {});
    deleteBootstrapSession(existing.id);
  }
  updateSlot(slot.id, {
    state: 'auth_required',
    last_error: null
  });
  return createBootstrapForSlot(slot);
}

async function seedAdminIfNeeded() {
  seedDefaultSlots();
  const admin = getAdminUser();
  if (admin) return;
  if (!config.adminSeedEmail || !config.adminSeedPassword) {
    throw new Error('Initial admin is not configured. Set ADMIN_SEED_EMAIL and ADMIN_SEED_PASSWORD before first startup.');
  }
  const passwordHash = await hashPassword(config.adminSeedPassword);
  createAdminUser(config.adminSeedEmail, passwordHash);
  writeAudit('admin.seeded', { email: config.adminSeedEmail });
}

function sendRuntimeUpdate(reason, extra = {}) {
  broadcast('admins', 'runtime_updated', { reason, ...extra, ts: nowIso() });
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

app.get('/api/public-config', (_req, res) => {
  res.json({
    ok: true,
    defaultUiLanguage: config.defaultUiLanguage,
    codeWorkspaceUrl: config.codeWorkspaceUrl || '',
    codeOrigin: config.codeOrigin || ''
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
  try {
    const includeLogs = String(_req.query.includeLogs || '1') !== '0';
    const skipQuotaSync = String(_req.query.fast || '0') === '1';
    const runtime = await buildRuntimeSnapshot({ skipQuotaSync });
    const payload = {
      ok: true,
      runtime
    };
    if (includeLogs) {
      payload.recentSwitches = listRecentSwitchEvents(60);
      payload.recentSamples = listRecentQuotaSamples(60);
    }
    res.json(payload);
  } catch (error) {
    next(error);
  }
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

  try {
    const bootstrapSession = await ensureBootstrapSessionForSlot(slot);
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
    next(error);
  }
});

app.post('/api/accounts/:id/bootstrap/restart', writeLimiter, verifyCSRF, assertAuth, async (req, res, next) => {
  const slot = getSlotById(req.params.id);
  if (!slot) return res.status(404).json({ ok: false, error: 'ACCOUNT_NOT_FOUND' });
  if (!hasSavedMetadata(slot)) return res.status(400).json({ ok: false, error: 'ACCOUNT_DATA_INCOMPLETE' });

  try {
    const activeBootstrap = getLatestActiveBootstrapSession();
    if (activeBootstrap && activeBootstrap.slot_id !== slot.id) {
      return res.status(409).json({ ok: false, error: 'BOOTSTRAP_ALREADY_ACTIVE' });
    }
    const bootstrapSession = await restartBootstrapSessionForSlot(slot);
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
    await activateSlot(req.params.id, 'manual_switch');
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post('/api/accounts/:id/logout', writeLimiter, verifyCSRF, assertAuth, async (req, res, next) => {
  try {
    await logoutSlot(req.params.id);
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
  res.status(410).type('text/plain; charset=utf-8').send('Codex Switcher Web no longer bundles a userscript.');
});

app.get('/', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.use((error, _req, res, _next) => {
  console.error('[codex-switcher]', error);
  writeAudit('app.error', { message: error.message });
  res.status(500).json({ ok: false, error: error.message });
});

let bootstrapSyncTimer = null;
let httpServer = null;
let shutdownPromise = null;
const activeSockets = new Set();

async function start() {
  await seedAdminIfNeeded();
  await reconcileActiveSlotFromAgent();

  bootstrapSyncTimer = setInterval(() => {
    syncPendingBootstrapSessions().then((changed) => {
      if (changed) sendRuntimeUpdate('bootstrap_synced');
    }).catch((error) => {
      writeAudit('bootstrap.sync_failed', { message: error.message });
    });
  }, 5000);
  bootstrapSyncTimer.unref();

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
