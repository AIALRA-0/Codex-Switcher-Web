'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { URL } = require('url');
const { atomicWriteFile } = require('./file-ops');

const AGENT_SHARED_SECRET = process.env.CODEX_AGENT_SHARED_SECRET || 'change-me-before-production-agent-secret';
const SOCKET_PATH = process.env.CODEX_AGENT_SOCKET_PATH || '/run/codex-switcher/agent.sock';
const ACTIVE_CODEX_HOME = process.env.CODEX_ACTIVE_HOME || '/root/.codex';
const ACTIVE_AUTH_PATH = process.env.CODEX_ACTIVE_AUTH_PATH || path.join(ACTIVE_CODEX_HOME, 'auth.json');
const BACKUP_DIR = process.env.CODEX_AGENT_BACKUP_DIR || '/var/lib/codex-switcher/agent';
const BOOTSTRAP_ROOT = process.env.CODEX_BOOTSTRAP_ROOT || '/var/lib/codex-switcher/bootstrap';
const CODEX_BINARY = process.env.CODEX_BINARY || 'codex';
const CHATGPT_BACKEND_BASE = process.env.CODEX_CHATGPT_BACKEND_BASE || 'https://chatgpt.com/backend-api';
const AUTH_TOKEN_URL = process.env.CODEX_AUTH_TOKEN_URL || 'https://auth.openai.com/oauth/token';
const ACCESS_TOKEN_REFRESH_SKEW_MS = Number(process.env.CODEX_ACCESS_TOKEN_REFRESH_SKEW_MS || 5 * 60 * 1000);
const REQUEST_ORIGINATOR = process.env.CODEX_REQUEST_ORIGINATOR || 'codex_vscode';
const TOKEN_REFRESH_TIMEOUT_MS = Number(process.env.TOKEN_REFRESH_TIMEOUT_MS || 5000);
const USAGE_REQUEST_TIMEOUT_MS = Number(process.env.USAGE_REQUEST_TIMEOUT_MS || 4000);

const sessions = new Map();
const ANSI_PATTERN = /\u001B\[[0-9;]*m/g;

function getBootstrapSessionSnapshot(bootstrapId) {
  const session = sessions.get(bootstrapId);
  if (!session) return null;
  return {
    id: session.id,
    slotId: session.slotId,
    deviceCode: session.deviceCode,
    verificationUri: session.verificationUri,
    status: session.status,
    error: session.error,
    logTail: session.logTail
  };
}

function nowIso() {
  return new Date().toISOString();
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 5000, timeoutError = 'REQUEST_TIMEOUT') {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(timeoutError)), Math.max(1000, timeoutMs));
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } catch (error) {
    if (error && error.name === 'AbortError') {
      throw new Error(timeoutError);
    }
    const message = describeThrownError(error, timeoutError);
    if (message === timeoutError) {
      throw new Error(timeoutError);
    }
    throw new Error(message);
  } finally {
    clearTimeout(timer);
  }
}

function ensureDir(dirPath, mode = 0o700) {
  fs.mkdirSync(dirPath, { recursive: true, mode });
}

function parseJsonSafely(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch (_) {
    return fallback;
  }
}

function describeAgentErrorValue(value) {
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return '';
    if ((text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']'))) {
      const parsed = parseJsonSafely(text, null);
      if (parsed && parsed !== value) return describeAgentErrorValue(parsed);
    }
    return text;
  }
  if (value == null) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object') {
    return describeAgentErrorValue(value.message)
      || describeAgentErrorValue(value.error_description)
      || describeAgentErrorValue(value.error)
      || describeAgentErrorValue(value.code)
      || describeAgentErrorValue(value.type)
      || (() => {
        try {
          const serialized = JSON.stringify(value);
          return serialized === '{}' || serialized === '[]' ? '' : serialized;
        } catch (_) {
          return String(value);
        }
      })();
  }
  return String(value).trim();
}

function describeThrownError(error, fallback = 'UNKNOWN_AGENT_ERROR') {
  const text = describeAgentErrorValue(error);
  return text && text !== '[object Object]' ? text : fallback;
}

function buildApiErrorMessage(prefix, statusCode, payload, rawText = '') {
  const base = `${prefix}_${statusCode}`;
  const normalizedPayload = payload && typeof payload === 'object' ? payload : null;
  const payloadMessage = describeAgentErrorValue(normalizedPayload && (
    normalizedPayload.error_description
    || normalizedPayload.error
    || normalizedPayload.message
  ));
  const payloadCode = describeAgentErrorValue(normalizedPayload && (
    normalizedPayload.code
    || (normalizedPayload.error && normalizedPayload.error.code)
  ));
  const rawMessage = (() => {
    const text = String(rawText || '').trim();
    if (!text) return '';
    const parsed = parseJsonSafely(text, null);
    if (parsed && typeof parsed === 'object') return describeAgentErrorValue(parsed);
    return text.slice(0, 240);
  })();
  const message = payloadMessage || rawMessage;
  if (!message) return base;
  if (payloadCode && !message.includes(payloadCode)) {
    return `${base}: ${message} [${payloadCode}]`;
  }
  return `${base}: ${message}`;
}

function decodeIdToken(idToken) {
  try {
    if (!idToken) return {};
    const payload = idToken.split('.')[1];
    if (!payload) return {};
    return parseJsonSafely(Buffer.from(payload, 'base64url').toString('utf8'), {}) || {};
  } catch (_) {
    return {};
  }
}

function decodeJwtClaims(token) {
  try {
    if (!token) return {};
    const payload = token.split('.')[1];
    if (!payload) return {};
    return parseJsonSafely(Buffer.from(payload, 'base64url').toString('utf8'), {}) || {};
  } catch (_) {
    return {};
  }
}

function buildAuthRecordFromParsed(parsed) {
  const normalizedParsed = parsed && typeof parsed === 'object' ? parsed : {};
  const authJson = `${JSON.stringify(normalizedParsed, null, 2)}\n`;
  const tokens = normalizedParsed.tokens || {};
  const idClaims = decodeIdToken(tokens.id_token);
  const accessClaims = decodeJwtClaims(tokens.access_token);
  const accessAuthClaims = accessClaims['https://api.openai.com/auth'] || {};
  const profileClaims = accessClaims['https://api.openai.com/profile'] || {};
  const idTokenEmail = idClaims.email || null;
  const profileEmail = profileClaims.email || null;
  const chatgptUserId = accessAuthClaims.chatgpt_user_id || accessAuthClaims.user_id || null;
  const chatgptAccountUserId = accessAuthClaims.chatgpt_account_user_id
    || (chatgptUserId && (tokens.account_id || accessAuthClaims.chatgpt_account_id)
      ? `${chatgptUserId}__${tokens.account_id || accessAuthClaims.chatgpt_account_id}`
      : null);
  const subject = idClaims.sub || accessClaims.sub || null;
  const identityKey = chatgptAccountUserId || chatgptUserId || subject || (idTokenEmail || profileEmail || '').trim().toLowerCase() || null;

  return {
    authJson,
    parsed: normalizedParsed,
    tokens,
    accountId: tokens.account_id || accessAuthClaims.chatgpt_account_id || null,
    identityKey,
    chatgptUserId,
    chatgptAccountUserId,
    email: idTokenEmail || profileEmail || null,
    idTokenEmail,
    profileEmail,
    name: idClaims.name || null,
    clientId: accessClaims.client_id || null,
    authProvider: idClaims.auth_provider || null,
    subject
  };
}

function parseAuthRecord(authJson) {
  const parsed = parseJsonSafely(authJson, {}) || {};
  return buildAuthRecordFromParsed(parsed);
}

function emptyAuthRecord() {
  return buildAuthRecordFromParsed({});
}

function readCurrentAuthRecord() {
  if (!fs.existsSync(ACTIVE_AUTH_PATH)) {
    return emptyAuthRecord();
  }

  const authJson = fs.readFileSync(ACTIVE_AUTH_PATH, 'utf8');
  const parsed = parseJsonSafely(authJson, {}) || {};
  const record = buildAuthRecordFromParsed(parsed);

  return {
    ...record,
    authJson
  };
}

function readCurrentAuth() {
  const current = readCurrentAuthRecord();
  return {
    authJson: current.authJson,
    accountId: current.accountId,
    identityKey: current.identityKey || null,
    email: current.email,
    name: current.name
  };
}

function writeCurrentAuthRecord(parsed) {
  const nextRecord = buildAuthRecordFromParsed(parsed);
  atomicWriteFile(ACTIVE_AUTH_PATH, nextRecord.authJson);
  return readCurrentAuthRecord();
}

function getBackupPath() {
  ensureDir(BACKUP_DIR, 0o700);
  return path.join(BACKUP_DIR, 'last-auth-backup.json');
}

function saveBackup(authJson) {
  atomicWriteFile(getBackupPath(), authJson);
}

function restoreBackup() {
  const backupPath = getBackupPath();
  if (!fs.existsSync(backupPath)) {
    throw new Error('NO_BACKUP_AVAILABLE');
  }
  const backupJson = fs.readFileSync(backupPath, 'utf8');
  atomicWriteFile(ACTIVE_AUTH_PATH, backupJson);
  return readCurrentAuth();
}

function validateExpectedAccountId(authJson, expectedAccountId) {
  const parsed = parseJsonSafely(authJson, {});
  const tokens = parsed.tokens || {};
  const actualAccountId = tokens && tokens.account_id ? tokens.account_id : null;
  if (expectedAccountId && actualAccountId !== expectedAccountId) {
    throw new Error(`ACCOUNT_ID_MISMATCH: expected ${expectedAccountId}, got ${actualAccountId || 'null'}`);
  }
  return actualAccountId;
}

function validateExpectedIdentityKey(authJson, expectedIdentityKey) {
  if (!expectedIdentityKey) return null;
  const record = parseAuthRecord(authJson);
  if (record.identityKey !== expectedIdentityKey) {
    throw new Error(`IDENTITY_KEY_MISMATCH: expected ${expectedIdentityKey}, got ${record.identityKey || 'null'}`);
  }
  return record.identityKey;
}

function tokenExpiresSoon(accessToken, skewMs = ACCESS_TOKEN_REFRESH_SKEW_MS) {
  const claims = decodeJwtClaims(accessToken);
  const exp = claims && Number.isFinite(Number(claims.exp)) ? Number(claims.exp) : null;
  if (!exp) return true;
  return (exp * 1000) - Date.now() <= skewMs;
}

async function refreshAccessTokenForRecord(record, options = {}) {
  const { force = false, persist = false } = options;
  const current = record || readCurrentAuthRecord();
  if (!current || !current.tokens || !current.tokens.access_token) {
    throw new Error('NOT_LOGGED_IN');
  }
  if (!force && !tokenExpiresSoon(current.tokens.access_token)) {
    return current;
  }
  if (!current.tokens.refresh_token) {
    throw new Error('NO_REFRESH_TOKEN_AVAILABLE');
  }
  if (!current.clientId) {
    throw new Error('AUTH_CLIENT_ID_MISSING');
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: current.tokens.refresh_token,
    client_id: current.clientId
  });

  const response = await fetchWithTimeout(AUTH_TOKEN_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded'
    },
    body
  }, TOKEN_REFRESH_TIMEOUT_MS, 'TOKEN_REFRESH_TIMEOUT');

  const rawText = await response.text();
  const payload = parseJsonSafely(rawText, {});
  if (!response.ok || !payload.access_token) {
    throw new Error(buildApiErrorMessage('TOKEN_REFRESH_FAILED', response.status, payload, rawText));
  }

  const nextParsed = {
    ...current.parsed,
    tokens: {
      ...current.tokens,
      access_token: payload.access_token,
      id_token: payload.id_token || current.tokens.id_token || null,
      refresh_token: payload.refresh_token || current.tokens.refresh_token,
      account_id: payload.account_id || current.tokens.account_id || decodeJwtClaims(payload.access_token)['https://api.openai.com/auth']?.chatgpt_account_id || null
    },
    last_refresh: nowIso()
  };

  if (persist) {
    return writeCurrentAuthRecord(nextParsed);
  }
  return buildAuthRecordFromParsed(nextParsed);
}

async function refreshAccessToken(force = false) {
  return refreshAccessTokenForRecord(readCurrentAuthRecord(), { force, persist: true });
}

function buildWhamHeaders(tokens) {
  if (!tokens || !tokens.access_token) {
    throw new Error('NOT_LOGGED_IN');
  }
  const headers = {
    Authorization: `Bearer ${tokens.access_token}`,
    originator: REQUEST_ORIGINATOR
  };
  if (tokens.account_id) {
    headers['ChatGPT-Account-Id'] = tokens.account_id;
  }
  return headers;
}

function isoFromEpochSeconds(epochSeconds) {
  const value = Number(epochSeconds);
  if (!Number.isFinite(value) || value <= 0) return null;
  return new Date(value * 1000).toISOString();
}

function formatResetLabel(resetAtIso) {
  const value = resetAtIso ? new Date(resetAtIso) : null;
  if (!value || Number.isNaN(value.getTime())) return null;
  const now = new Date();
  const sameUtcDay = value.getUTCFullYear() === now.getUTCFullYear()
    && value.getUTCMonth() === now.getUTCMonth()
    && value.getUTCDate() === now.getUTCDate();
  if (sameUtcDay) {
    return value.toISOString().slice(11, 16);
  }
  return `${value.getUTCMonth() + 1}月${value.getUTCDate()}日 ${value.toISOString().slice(11, 16)}`;
}

function normalizeWhamUsageWindow(window) {
  if (!window) return null;
  const resetAt = isoFromEpochSeconds(window.reset_at);
  const pct = Number.isFinite(Number(window.used_percent))
    ? Number(window.used_percent)
    : Number.isFinite(Number(window.usedPercent))
      ? Number(window.usedPercent)
      : null;
  return {
    pct,
    resetAt,
    resetLabel: formatResetLabel(resetAt),
    windowSeconds: Number.isFinite(Number(window.limit_window_seconds)) ? Number(window.limit_window_seconds) : null
  };
}

function normalizeWhamUsagePayload(payload) {
  const rateLimit = payload && typeof payload === 'object'
    ? (payload.rate_limit || payload.rateLimit || payload.usage?.rate_limit || {})
    : {};
  const windowCandidates = [
    rateLimit.primary_window,
    rateLimit.secondary_window,
    ...(Array.isArray(rateLimit.windows) ? rateLimit.windows : []),
    ...(Array.isArray(payload && payload.windows) ? payload.windows : [])
  ];
  const windows = windowCandidates
    .map(normalizeWhamUsageWindow)
    .filter((window) => window && (window.pct != null || window.resetAt || window.windowSeconds));

  const fiveHour = windows.find((window) => window.windowSeconds && window.windowSeconds <= 24 * 60 * 60)
    || windows[0]
    || null;
  const week = windows.find((window) => window.windowSeconds && window.windowSeconds > 24 * 60 * 60)
    || windows[1]
    || null;
  const parserStatus = fiveHour || week ? 'ok' : 'unknown';

  return {
    parserStatus,
    accountId: payload && payload.account_id ? payload.account_id : null,
    email: payload && payload.email ? payload.email : null,
    planType: payload && payload.plan_type ? payload.plan_type : null,
    fiveHour,
    week,
    rawText: JSON.stringify({
      account_id: payload && payload.account_id ? payload.account_id : null,
      email: payload && payload.email ? payload.email : null,
      plan_type: payload && payload.plan_type ? payload.plan_type : null,
      rate_limit: payload && payload.rate_limit ? payload.rate_limit : null
    })
  };
}

async function fetchWhamJsonForRecord(pathname, record, options = {}) {
  const { persist = false } = options;
  let current = await refreshAccessTokenForRecord(record, { force: false, persist });
  let response = await fetchWithTimeout(`${CHATGPT_BACKEND_BASE}${pathname}`, {
    headers: buildWhamHeaders(current.tokens)
  }, USAGE_REQUEST_TIMEOUT_MS, 'USAGE_REQUEST_TIMEOUT');

  if (response.status === 401) {
    current = await refreshAccessTokenForRecord(current, { force: true, persist });
    response = await fetchWithTimeout(`${CHATGPT_BACKEND_BASE}${pathname}`, {
      headers: buildWhamHeaders(current.tokens)
    }, USAGE_REQUEST_TIMEOUT_MS, 'USAGE_REQUEST_TIMEOUT');
  }

  const text = await response.text();
  if (!response.ok) {
    throw new Error(buildApiErrorMessage('WHAM_REQUEST_FAILED', response.status, parseJsonSafely(text, null), text));
  }
  return {
    payload: parseJsonSafely(text, null),
    authRecord: current
  };
}

async function fetchWhamJson(pathname) {
  return fetchWhamJsonForRecord(pathname, readCurrentAuthRecord(), { persist: true });
}

async function getUsageStatusForRecord(record, options = {}) {
  const { persist = false } = options;
  const { payload, authRecord } = await fetchWhamJsonForRecord('/wham/usage', record, { persist });
  return {
    ok: true,
    usage: normalizeWhamUsagePayload(payload),
    observedAt: nowIso(),
    authJson: authRecord.authJson,
    accountId: authRecord.accountId,
    identityKey: authRecord.identityKey,
    email: authRecord.email,
    planType: payload && payload.plan_type ? payload.plan_type : null
  };
}

async function getUsageStatus() {
  return getUsageStatusForRecord(readCurrentAuthRecord(), { persist: true });
}

async function getUsageStatusForAuthJson(authJson) {
  if (!authJson) throw new Error('AUTH_JSON_REQUIRED');
  return getUsageStatusForRecord(parseAuthRecord(authJson), { persist: false });
}

function handleActivateProfile(body) {
  const previous = readCurrentAuth();
  saveBackup(previous.authJson);
  try {
    validateExpectedAccountId(body.authJson, body.expectedAccountId || null);
    validateExpectedIdentityKey(body.authJson, body.expectedIdentityKey || null);
    atomicWriteFile(ACTIVE_AUTH_PATH, body.authJson);
    const current = readCurrentAuth();
    return { ok: true, accountId: current.accountId, identityKey: current.identityKey || null };
  } catch (error) {
    restoreBackup();
    throw error;
  }
}

function logoutActiveAuth() {
  const previous = readCurrentAuth();
  saveBackup(previous.authJson);
  if (fs.existsSync(ACTIVE_AUTH_PATH)) {
    fs.unlinkSync(ACTIVE_AUTH_PATH);
  }
  return { ok: true };
}

function bootstrapHomeForId(bootstrapId) {
  return path.join(BOOTSTRAP_ROOT, bootstrapId);
}

function removeBootstrapHome(bootstrapId) {
  const home = bootstrapHomeForId(bootstrapId);
  if (fs.existsSync(home)) {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function stripAnsi(text) {
  return String(text || '').replace(ANSI_PATTERN, '');
}

function extractDeviceAuthError(text) {
  const source = stripAnsi(text);
  const rateLimitMatch = source.match(/Error logging in with device code:\s*(.+429 Too Many Requests.*)/i)
    || source.match(/(device code request failed with status 429 Too Many Requests)/i);
  if (rateLimitMatch) return rateLimitMatch[1].trim();
  const deviceAuthErrorMatch = source.match(/Error logging in with device code:\s*(.+)/i);
  if (deviceAuthErrorMatch) return deviceAuthErrorMatch[1].trim();
  return '';
}

function deriveDeviceAuthExitError(session, code) {
  const parsed = extractDeviceAuthError(session.logTail || '');
  if (parsed) return parsed;
  if (/device auth timed out after 15 minutes/i.test(session.logTail || '')) {
    return 'device auth timed out after 15 minutes';
  }
  const lines = String(session.logTail || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^Welcome to Codex/i.test(line))
    .filter((line) => !/^OpenAI's command-line coding agent/i.test(line))
    .filter((line) => !/^Follow these steps/i.test(line))
    .filter((line) => !/Never share this code/i.test(line))
    .filter((line) => !/^https?:\/\//i.test(line))
    .filter((line) => !/^[12]\./.test(line));
  if (lines.length) return lines[lines.length - 1];
  if (code === 1) return 'device auth exited unexpectedly before completing the login flow';
  return `device-auth exited with code ${code}`;
}

function parseDeviceAuthOutput(session, chunk) {
  const text = stripAnsi(chunk);
  session.logTail = `${session.logTail}${text}`.slice(-8000);

  if (text.includes('https://auth.openai.com/codex/device')) {
    session.verificationUri = 'https://auth.openai.com/codex/device';
  }

  const codeMatch = text.match(/\b([A-Z0-9]{4}-[A-Z0-9]{5})\b/);
  if (codeMatch) {
    session.deviceCode = codeMatch[1];
  }

  const parsedError = extractDeviceAuthError(session.logTail);
  if (parsedError && /429 Too Many Requests/i.test(parsedError)) {
    session.status = 'failed';
    session.error = parsedError;
    return;
  }

  if (parsedError) {
    session.status = 'failed';
    session.error = parsedError;
    return;
  }

  if (/Successfully logged in/i.test(text)) {
    session.status = 'succeeded';
  } else if (/Never share this code/i.test(text) || /Open this link in your browser/i.test(text)) {
    session.status = 'awaiting_user';
  }
}

function cancelBootstrapSession(bootstrapId) {
  const session = sessions.get(bootstrapId);
  if (!session) {
    removeBootstrapHome(bootstrapId);
    return { ok: true, cancelled: false };
  }

  if (session.process && !session.process.killed && session.status !== 'captured' && session.status !== 'success_pending_capture') {
    try {
      session.process.kill('SIGTERM');
    } catch (_) {
      // ignore
    }
  }

  sessions.delete(bootstrapId);
  removeBootstrapHome(bootstrapId);
  return { ok: true, cancelled: true };
}

function startDeviceAuthSession(body) {
  const bootstrapId = body.bootstrapId;
  if (!bootstrapId) throw new Error('BOOTSTRAP_ID_REQUIRED');
  if (sessions.has(bootstrapId)) return sessions.get(bootstrapId);

  const bootstrapHome = bootstrapHomeForId(bootstrapId);
  const isolatedCodexHome = path.join(bootstrapHome, '.codex');
  ensureDir(isolatedCodexHome, 0o700);

  const session = {
    id: bootstrapId,
    slotId: body.slotId || null,
    bootstrapHome,
    isolatedCodexHome,
    deviceCode: null,
    verificationUri: 'https://auth.openai.com/codex/device',
    logTail: '',
    status: 'starting',
    error: null,
    startedAt: nowIso()
  };

  const child = spawn(CODEX_BINARY, ['login', '--device-auth'], {
    env: {
      ...process.env,
      HOME: bootstrapHome,
      CODEX_HOME: isolatedCodexHome
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  session.process = child;
  child.stdout.on('data', (chunk) => parseDeviceAuthOutput(session, chunk));
  child.stderr.on('data', (chunk) => parseDeviceAuthOutput(session, chunk));
  child.on('exit', (code) => {
    if (session.status === 'succeeded') {
      session.status = 'success_pending_capture';
      return;
    }
    if (code === 0) {
      session.status = 'success_pending_capture';
    } else {
      session.status = 'failed';
      session.error = session.error || deriveDeviceAuthExitError(session, code);
    }
  });
  child.on('error', (error) => {
    session.status = 'failed';
    session.error = describeThrownError(error);
  });

  sessions.set(bootstrapId, session);
  return session;
}

function getBootstrapStatus(bootstrapId) {
  const session = sessions.get(bootstrapId);
  if (!session) throw new Error('BOOTSTRAP_NOT_FOUND');
  return {
    ok: true,
    status: session.status,
    deviceCode: session.deviceCode,
    verificationUri: session.verificationUri,
    logTail: session.logTail,
    bootstrapHome: session.bootstrapHome,
    error: session.error
  };
}

function captureAuthProfile(bootstrapId) {
  const session = sessions.get(bootstrapId);
  if (!session) throw new Error('BOOTSTRAP_NOT_FOUND');
  const authPath = path.join(session.isolatedCodexHome, 'auth.json');
  if (!fs.existsSync(authPath)) throw new Error('AUTH_PROFILE_NOT_READY');
  const authJson = fs.readFileSync(authPath, 'utf8');
  const record = parseAuthRecord(authJson);
  return {
    ok: true,
    authJson,
    accountId: record.accountId || null,
    identityKey: record.identityKey || null,
    chatgptUserId: record.chatgptUserId || null,
    chatgptAccountUserId: record.chatgptAccountUserId || null,
    email: record.email || null,
    name: record.name || null,
    authProvider: record.authProvider || null,
    subject: record.subject || null,
    idTokenEmail: record.idTokenEmail || null,
    profileEmail: record.profileEmail || null,
    bootstrapHome: session.bootstrapHome
  };
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

async function handleRequest(req, res) {
  if (req.headers['x-agent-token'] !== AGENT_SHARED_SECRET) {
    return sendJson(res, 403, { ok: false, error: 'FORBIDDEN' });
  }

  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'POST' && url.pathname === '/activate_profile') {
      const body = await readBody(req);
      return sendJson(res, 200, handleActivateProfile(body));
    }

    if (req.method === 'POST' && url.pathname === '/rollback_profile') {
      const restored = restoreBackup();
      return sendJson(res, 200, { ok: true, accountId: restored.accountId });
    }

    if (req.method === 'POST' && url.pathname === '/logout_active_auth') {
      return sendJson(res, 200, logoutActiveAuth());
    }

    if (req.method === 'POST' && url.pathname === '/start_device_auth') {
      const body = await readBody(req);
      const session = startDeviceAuthSession(body);
      return sendJson(res, 200, {
        ok: true,
        status: session.status,
        deviceCode: session.deviceCode,
        verificationUri: session.verificationUri,
        bootstrapHome: session.bootstrapHome
      });
    }

    if (req.method === 'GET' && url.pathname === '/bootstrap_status') {
      return sendJson(res, 200, getBootstrapStatus(url.searchParams.get('id')));
    }

    if (req.method === 'POST' && url.pathname === '/cancel_bootstrap') {
      const body = await readBody(req);
      return sendJson(res, 200, cancelBootstrapSession(body.bootstrapId));
    }

    if (req.method === 'POST' && url.pathname === '/capture_auth_profile') {
      const body = await readBody(req);
      return sendJson(res, 200, captureAuthProfile(body.bootstrapId));
    }

    if (req.method === 'GET' && url.pathname === '/login_status') {
      const status = readCurrentAuth();
      return sendJson(res, 200, {
        ok: true,
        authMode: 'chatgpt',
        tokens: {
          account_id: status.accountId
        },
        identityKey: status.identityKey || null,
        email: status.email || null,
        name: status.name || null
      });
    }

    if (req.method === 'GET' && url.pathname === '/usage_status') {
      return sendJson(res, 200, await getUsageStatus());
    }

    if (req.method === 'POST' && url.pathname === '/usage_for_profile') {
      const body = await readBody(req);
      if (body.expectedAccountId) {
        validateExpectedAccountId(body.authJson || '', body.expectedAccountId);
      }
      if (body.expectedIdentityKey) {
        validateExpectedIdentityKey(body.authJson || '', body.expectedIdentityKey);
      }
      return sendJson(res, 200, await getUsageStatusForAuthJson(body.authJson || ''));
    }

    return sendJson(res, 404, { ok: false, error: 'NOT_FOUND' });
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: describeThrownError(error) });
  }
}

async function startServer() {
  ensureDir(path.dirname(SOCKET_PATH), 0o755);
  ensureDir(BOOTSTRAP_ROOT, 0o700);
  if (fs.existsSync(SOCKET_PATH)) fs.unlinkSync(SOCKET_PATH);

  serverInstance = http.createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
      sendJson(res, 500, { ok: false, error: describeThrownError(error) });
    });
  });
  await new Promise((resolve, reject) => {
    serverInstance.listen(SOCKET_PATH, () => {
      fs.chmodSync(SOCKET_PATH, 0o660);
      console.log(`Codex switcher agent listening on ${SOCKET_PATH}`);
      resolve();
    });
    serverInstance.on('error', reject);
  });
}

let serverInstance = null;
let agentShutdownPromise = null;

async function stopServer() {
  if (agentShutdownPromise) return agentShutdownPromise;
  agentShutdownPromise = (async () => {
    if (serverInstance) {
      await new Promise((resolve) => {
        serverInstance.close(() => resolve());
      });
      serverInstance = null;
    }
    if (fs.existsSync(SOCKET_PATH)) {
      fs.unlinkSync(SOCKET_PATH);
    }
  })();
  return agentShutdownPromise;
}

function registerShutdownSignal(signal) {
  process.on(signal, () => {
    stopServer().then(() => {
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
  startServer();
}

module.exports = {
  buildApiErrorMessage,
  captureAuthProfile,
  cancelBootstrapSession,
  describeThrownError,
  handleActivateProfile,
  logoutActiveAuth,
  normalizeWhamUsagePayload,
  parseDeviceAuthOutput,
  readCurrentAuth,
  restoreBackup,
  startDeviceAuthSession,
  startServer,
  stopServer,
  validateExpectedAccountId,
  validateExpectedIdentityKey,
  getUsageStatus,
  getUsageStatusForAuthJson
};
