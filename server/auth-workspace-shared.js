'use strict';

const { URL } = require('url');

const AUTH_WORKSPACE_LOCK = 'auth_workspace';
const AUTH_WORKSPACE_ACTIVE_STATES = new Set([
  'preparing_workspace',
  'ready_for_login',
  'awaiting_user',
  'verifying_identity',
  'retrying_wrong_account'
]);

const AUTH_WORKSPACE_TERMINAL_STATES = new Set([
  'captured',
  'failed',
  'cancelled'
]);

function normalizeBaseUrl(value, fallback) {
  const raw = String(value || fallback || '').trim();
  return raw.replace(/\/+$/, '');
}

function buildAuthBootstrapHash(payload = null) {
  if (!payload || typeof payload !== 'object') return '';
  const normalized = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value == null || value === '') continue;
    normalized[key] = value;
  }
  if (!Object.keys(normalized).length) return '';
  const encoded = Buffer.from(JSON.stringify(normalized), 'utf8').toString('base64url');
  return `codex-switcher-bootstrap=${encodeURIComponent(encoded)}`;
}

function buildManagedAuthUrl(inputUrl, preferredEmail = '', bootstrapPayload = null) {
  const fallback = 'https://auth.openai.com/codex/device';
  const baseUrl = inputUrl || fallback;
  const email = String(preferredEmail || '').trim().toLowerCase();
  const bootstrapHash = buildAuthBootstrapHash(bootstrapPayload);

  try {
    const url = new URL(baseUrl);
    url.searchParams.set('prompt', 'login');
    url.searchParams.set('max_age', '0');
    if (email) url.searchParams.set('login_hint', email);
    url.hash = bootstrapHash;
    return url.toString();
  } catch (_) {
    const params = new URLSearchParams({
      prompt: 'login',
      max_age: '0'
    });
    if (email) params.set('login_hint', email);
    return `${fallback}?${params.toString()}${bootstrapHash ? `#${bootstrapHash}` : ''}`;
  }
}

function authWorkspacePortalUrl(baseUrl, slotId, accessToken) {
  const normalizedBase = normalizeBaseUrl(baseUrl, 'https://auth.example.com');
  return `${normalizedBase}/auth-workspace/${encodeURIComponent(slotId)}#token=${encodeURIComponent(accessToken)}`;
}

function buildAuthWorkspaceNoVncPath(accessToken) {
  const token = String(accessToken || '').trim();
  if (!token) return null;
  return `/novnc/${encodeURIComponent(token)}/?autoconnect=1&resize=remote&reconnect=1&show_dot=0&view_clip=0&quality=7&compression=7`;
}

function sanitizeAuthWorkspace(payload) {
  if (!payload) return null;
  const {
    accessTokenCipher,
    accessTokenHash,
    ...safe
  } = payload;
  return safe;
}

function isActiveAuthWorkspaceState(state) {
  return AUTH_WORKSPACE_ACTIVE_STATES.has(String(state || ''));
}

function isTerminalAuthWorkspaceState(state) {
  return AUTH_WORKSPACE_TERMINAL_STATES.has(String(state || ''));
}

module.exports = {
  AUTH_WORKSPACE_ACTIVE_STATES,
  AUTH_WORKSPACE_LOCK,
  AUTH_WORKSPACE_TERMINAL_STATES,
  authWorkspacePortalUrl,
  buildAuthBootstrapHash,
  buildAuthWorkspaceNoVncPath,
  buildManagedAuthUrl,
  isActiveAuthWorkspaceState,
  isTerminalAuthWorkspaceState,
  normalizeBaseUrl,
  sanitizeAuthWorkspace
};
