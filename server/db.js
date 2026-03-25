'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { config } = require('./config');

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS admin_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  last_login_at TEXT,
  failed_attempts INTEGER DEFAULT 0,
  locked_until TEXT
);

CREATE TABLE IF NOT EXISTS account_slots (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  email TEXT,
  slot_type TEXT NOT NULL,
  login_method TEXT NOT NULL,
  priority INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'auth_required',
  account_id TEXT,
  identity_key TEXT,
  quota_5h_pct INTEGER,
  quota_5h_reset_at TEXT,
  quota_5h_reset_label TEXT,
  quota_week_pct INTEGER,
  quota_week_reset_at TEXT,
  quota_week_reset_label TEXT,
  freshness TEXT DEFAULT 'stale',
  last_seen_at TEXT,
  last_activated_at TEXT,
  last_bootstrap_at TEXT,
  last_error TEXT,
  is_active INTEGER DEFAULT 0,
  expires_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS encrypted_profiles (
  slot_id TEXT PRIMARY KEY,
  auth_cipher TEXT NOT NULL,
  account_id TEXT,
  identity_key TEXT,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(slot_id) REFERENCES account_slots(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS quota_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slot_id TEXT,
  browser_client_id TEXT,
  parser_status TEXT NOT NULL,
  quota_5h_pct INTEGER,
  quota_5h_reset_at TEXT,
  quota_5h_reset_label TEXT,
  quota_week_pct INTEGER,
  quota_week_reset_at TEXT,
  quota_week_reset_label TEXT,
  raw_text TEXT,
  observed_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(slot_id) REFERENCES account_slots(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS switch_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_slot_id TEXT,
  to_slot_id TEXT,
  trigger_reason TEXT NOT NULL,
  status TEXT NOT NULL,
  detail TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS bootstrap_sessions (
  id TEXT PRIMARY KEY,
  slot_id TEXT NOT NULL,
  status TEXT NOT NULL,
  email TEXT,
  login_method TEXT,
  device_code TEXT,
  verification_uri TEXT,
  log_tail TEXT,
  bootstrap_home TEXT,
  error_text TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  FOREIGN KEY(slot_id) REFERENCES account_slots(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS browser_clients (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  bind_code_hash TEXT,
  bind_code_expires_at TEXT,
  access_token_hash TEXT,
  token_issued_at TEXT,
  pending_actions_json TEXT DEFAULT '[]',
  last_user_agent TEXT,
  last_page_url TEXT,
  last_seen_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS runtime_locks (
  name TEXT PRIMARY KEY,
  owner TEXT,
  payload TEXT,
  expires_at TEXT,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_account_slots_priority ON account_slots(priority);
CREATE INDEX IF NOT EXISTS idx_quota_samples_slot_created ON quota_samples(slot_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_switch_events_created ON switch_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bootstrap_sessions_updated ON bootstrap_sessions(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_browser_clients_state ON browser_clients(state, updated_at DESC);
`);

function nowIso() {
  return new Date().toISOString();
}

function safeParseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch (_) {
    return fallback;
  }
}

function tableColumns(tableName) {
  return db.prepare(`PRAGMA table_info(${tableName})`).all();
}

function ensureColumn(tableName, columnName, definition) {
  const columns = tableColumns(tableName);
  if (columns.some((column) => column.name === columnName)) return;
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
}

function migrateLegacySlots() {
  ensureColumn('account_slots', 'expires_at', 'TEXT');
  ensureColumn('account_slots', 'created_at', 'TEXT');
  ensureColumn('account_slots', 'updated_at', 'TEXT');
  ensureColumn('account_slots', 'identity_key', 'TEXT');
  ensureColumn('encrypted_profiles', 'identity_key', 'TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_account_slots_updated ON account_slots(updated_at DESC)');

  const current = nowIso();
  db.prepare(`
    UPDATE account_slots
    SET created_at = COALESCE(created_at, ?),
        updated_at = COALESCE(updated_at, ?),
        slot_type = CASE WHEN slot_type IN ('fixed', 'temporary_primary', 'detected') THEN 'account' ELSE slot_type END
  `).run(current, current);

  const rows = db.prepare(`
    SELECT s.*, p.slot_id AS has_profile
    FROM account_slots s
    LEFT JOIN encrypted_profiles p ON p.slot_id = s.id
    ORDER BY priority ASC, created_at ASC, id ASC
  `).all();

  const deleteSlot = db.prepare('DELETE FROM account_slots WHERE id = ?');
  const updateSlot = db.prepare(`
    UPDATE account_slots
    SET label = ?,
        slot_type = 'account',
        priority = ?,
        updated_at = ?
    WHERE id = ?
  `);

  const tx = db.transaction(() => {
    let nextOrder = 1;
    for (const row of rows) {
      const isLegacyEmptyTemp = row.id === 'temporary_primary' && !String(row.email || '').trim() && !row.has_profile && !row.is_active;
      if (isLegacyEmptyTemp) {
        deleteSlot.run(row.id);
        continue;
      }

      let nextLabel = row.label || `账号 ${nextOrder}`;
      const fixedMatch = /^固定账号\s*(\d+)$/.exec(String(nextLabel).trim());
      if (fixedMatch) nextLabel = `账号 ${fixedMatch[1]}`;
      if (nextLabel === '临时主号') nextLabel = `账号 ${nextOrder}`;

      updateSlot.run(nextLabel, nextOrder, current, row.id);
      nextOrder += 1;
    }
  });

  tx();
}

function seedDefaultSlots() {
  migrateLegacySlots();

  const existingCount = db.prepare('SELECT COUNT(*) AS count FROM account_slots').get().count;
  if (existingCount > 0) return;
}

function getAdminUser() {
  return db.prepare('SELECT * FROM admin_users ORDER BY id ASC LIMIT 1').get() || null;
}

function createAdminUser(email, passwordHash) {
  return db.prepare('INSERT INTO admin_users (email, password_hash) VALUES (?, ?)').run(email, passwordHash);
}

function updateAdminLogin(email) {
  db.prepare('UPDATE admin_users SET last_login_at=?, failed_attempts=0, locked_until=NULL WHERE email=?').run(nowIso(), email);
}

function recordAdminFailedLogin(email, attempts, lockedUntil) {
  db.prepare('UPDATE admin_users SET failed_attempts=?, locked_until=? WHERE email=?').run(attempts, lockedUntil || null, email);
}

function mapSlotRow(row) {
  return {
    ...row,
    has_profile: !!row.profile_updated_at
  };
}

function listSlots() {
  const rows = db.prepare(`
    SELECT s.*, p.account_id AS profile_account_id, p.identity_key AS profile_identity_key, p.updated_at AS profile_updated_at
    FROM account_slots s
    LEFT JOIN encrypted_profiles p ON p.slot_id = s.id
    ORDER BY
      s.is_active DESC,
      CASE WHEN s.expires_at IS NULL OR s.expires_at = '' THEN 1 ELSE 0 END ASC,
      s.expires_at ASC,
      lower(COALESCE(NULLIF(s.email, ''), NULLIF(s.label, ''), s.id)) ASC,
      s.created_at ASC
  `).all();
  return rows.map(mapSlotRow);
}

function getSlotById(slotId) {
  const row = db.prepare(`
    SELECT s.*, p.account_id AS profile_account_id, p.identity_key AS profile_identity_key, p.updated_at AS profile_updated_at
    FROM account_slots s
    LEFT JOIN encrypted_profiles p ON p.slot_id = s.id
    WHERE s.id = ?
  `).get(slotId);
  return row ? mapSlotRow(row) : null;
}

function getSlotByAccountId(accountId) {
  const row = db.prepare(`
    SELECT s.*, p.account_id AS profile_account_id, p.identity_key AS profile_identity_key, p.updated_at AS profile_updated_at
    FROM account_slots s
    LEFT JOIN encrypted_profiles p ON p.slot_id = s.id
    WHERE s.account_id = ? OR p.account_id = ?
    ORDER BY s.is_active DESC, p.updated_at DESC, s.updated_at DESC, s.created_at ASC
    LIMIT 1
  `).get(accountId, accountId);
  return row ? mapSlotRow(row) : null;
}

function getSlotByIdentityKey(identityKey) {
  const row = db.prepare(`
    SELECT s.*, p.account_id AS profile_account_id, p.identity_key AS profile_identity_key, p.updated_at AS profile_updated_at
    FROM account_slots s
    LEFT JOIN encrypted_profiles p ON p.slot_id = s.id
    WHERE s.identity_key = ? OR p.identity_key = ?
    ORDER BY s.is_active DESC, p.updated_at DESC, s.updated_at DESC, s.created_at ASC
    LIMIT 1
  `).get(identityKey, identityKey);
  return row ? mapSlotRow(row) : null;
}

function getSlotByEmail(email) {
  const row = db.prepare(`
    SELECT s.*, p.account_id AS profile_account_id, p.identity_key AS profile_identity_key, p.updated_at AS profile_updated_at
    FROM account_slots s
    LEFT JOIN encrypted_profiles p ON p.slot_id = s.id
    WHERE lower(s.email) = lower(?)
    LIMIT 1
  `).get(email);
  return row ? mapSlotRow(row) : null;
}

function getActiveSlot() {
  const row = db.prepare(`
    SELECT s.*, p.account_id AS profile_account_id, p.identity_key AS profile_identity_key, p.updated_at AS profile_updated_at
    FROM account_slots s
    LEFT JOIN encrypted_profiles p ON p.slot_id = s.id
    WHERE s.is_active = 1
    LIMIT 1
  `).get();
  return row ? mapSlotRow(row) : null;
}

function nextAccountPriority() {
  return (db.prepare('SELECT COALESCE(MAX(priority), 0) + 1 AS value FROM account_slots').get().value) || 1;
}

function createAccount(record = {}) {
  const id = record.id || `account_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const priority = record.priority || nextAccountPriority();
  const current = nowIso();

  db.prepare(`
    INSERT INTO account_slots (
      id, label, email, slot_type, login_method, priority, state, expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, 'account', ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    record.label || record.email || '',
    record.email || '',
    record.login_method || 'email',
    priority,
    record.state || 'draft',
    record.expires_at || null,
    current,
    current
  );

  return getSlotById(id);
}

function deleteAccount(slotId) {
  db.prepare('DELETE FROM account_slots WHERE id = ?').run(slotId);
}

function setActiveSlot(slotId, activatedAt = nowIso()) {
  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE account_slots
      SET is_active = 0,
          state = CASE WHEN state = 'active' THEN 'ready' ELSE state END,
          updated_at = ?
    `).run(activatedAt);
    if (slotId) {
      db.prepare(`
        UPDATE account_slots
        SET is_active = 1,
            state = 'active',
            last_activated_at = ?,
            last_error = NULL,
            updated_at = ?
        WHERE id = ?
      `).run(activatedAt, activatedAt, slotId);
    }
  });
  tx();
}

function updateSlot(slotId, patch) {
  const allowed = [
    'label',
    'email',
    'login_method',
    'priority',
    'state',
    'account_id',
    'identity_key',
    'quota_5h_pct',
    'quota_5h_reset_at',
    'quota_5h_reset_label',
    'quota_week_pct',
    'quota_week_reset_at',
    'quota_week_reset_label',
    'freshness',
    'last_seen_at',
    'last_activated_at',
    'last_bootstrap_at',
    'last_error',
    'is_active',
    'expires_at'
  ];

  const keys = allowed.filter((key) => Object.prototype.hasOwnProperty.call(patch, key));
  if (!keys.length) return;

  const sql = `UPDATE account_slots SET ${keys.map((key) => `${key} = ?`).join(', ')}, updated_at = ? WHERE id = ?`;
  const params = keys.map((key) => patch[key]);
  params.push(nowIso(), slotId);
  db.prepare(sql).run(...params);
}

function upsertProfile(slotId, authCipher, accountId, identityKey) {
  db.prepare(`
    INSERT INTO encrypted_profiles (slot_id, auth_cipher, account_id, identity_key, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(slot_id) DO UPDATE SET
      auth_cipher = excluded.auth_cipher,
      account_id = excluded.account_id,
      identity_key = excluded.identity_key,
      updated_at = excluded.updated_at
  `).run(slotId, authCipher, accountId || null, identityKey || null, nowIso());
}

function getProfile(slotId) {
  return db.prepare('SELECT * FROM encrypted_profiles WHERE slot_id = ?').get(slotId) || null;
}

function deleteProfile(slotId) {
  db.prepare('DELETE FROM encrypted_profiles WHERE slot_id = ?').run(slotId);
}

function insertQuotaSample(sample) {
  db.prepare(`
    INSERT INTO quota_samples (
      slot_id,
      browser_client_id,
      parser_status,
      quota_5h_pct,
      quota_5h_reset_at,
      quota_5h_reset_label,
      quota_week_pct,
      quota_week_reset_at,
      quota_week_reset_label,
      raw_text,
      observed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sample.slot_id || null,
    sample.browser_client_id || null,
    sample.parser_status,
    sample.quota_5h_pct == null ? null : sample.quota_5h_pct,
    sample.quota_5h_reset_at || null,
    sample.quota_5h_reset_label || null,
    sample.quota_week_pct == null ? null : sample.quota_week_pct,
    sample.quota_week_reset_at || null,
    sample.quota_week_reset_label || null,
    sample.raw_text || null,
    sample.observed_at || nowIso()
  );
}

function listRecentQuotaSamples(limit = 30) {
  return db.prepare(`
    SELECT *
    FROM quota_samples
    ORDER BY COALESCE(observed_at, created_at) DESC
    LIMIT ?
  `).all(limit);
}

function getLatestQuotaSample(slotId = undefined) {
  if (slotId === undefined) {
    return db.prepare(`
      SELECT *
      FROM quota_samples
      ORDER BY COALESCE(observed_at, created_at) DESC
      LIMIT 1
    `).get() || null;
  }

  return db.prepare(`
    SELECT *
    FROM quota_samples
    WHERE slot_id IS ?
    ORDER BY COALESCE(observed_at, created_at) DESC
    LIMIT 1
  `).get(slotId) || null;
}

function getRecentLiveSamplesForSlot(slotId, limit = 2) {
  return db.prepare(`
    SELECT *
    FROM quota_samples
    WHERE slot_id = ? AND parser_status = 'ok'
    ORDER BY COALESCE(observed_at, created_at) DESC
    LIMIT ?
  `).all(slotId, limit);
}

function createSwitchEvent(fromSlotId, toSlotId, triggerReason, status, detail = {}) {
  const info = db.prepare(`
    INSERT INTO switch_events (from_slot_id, to_slot_id, trigger_reason, status, detail)
    VALUES (?, ?, ?, ?, ?)
  `).run(fromSlotId || null, toSlotId || null, triggerReason, status, JSON.stringify(detail));
  return info.lastInsertRowid;
}

function completeSwitchEvent(eventId, status, detail = {}) {
  db.prepare(`
    UPDATE switch_events
    SET status = ?, detail = ?, completed_at = ?
    WHERE id = ?
  `).run(status, JSON.stringify(detail), nowIso(), eventId);
}

function listRecentSwitchEvents(limit = 30) {
  const rows = db.prepare(`
    SELECT *
    FROM switch_events
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit);
  return rows.map((row) => ({
    ...row,
    detail: safeParseJson(row.detail, {})
  }));
}

function clearQuotaSamples() {
  return db.prepare('DELETE FROM quota_samples').run().changes;
}

function clearSwitchEvents() {
  return db.prepare('DELETE FROM switch_events').run().changes;
}

function createBootstrapSession(record) {
  db.prepare(`
    INSERT INTO bootstrap_sessions (
      id,
      slot_id,
      status,
      email,
      login_method,
      device_code,
      verification_uri,
      log_tail,
      bootstrap_home,
      error_text,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.id,
    record.slot_id,
    record.status,
    record.email || null,
    record.login_method || null,
    record.device_code || null,
    record.verification_uri || null,
    record.log_tail || '',
    record.bootstrap_home || null,
    record.error_text || null,
    nowIso(),
    nowIso()
  );
}

function updateBootstrapSession(bootstrapId, patch) {
  const allowed = [
    'status',
    'device_code',
    'verification_uri',
    'log_tail',
    'bootstrap_home',
    'error_text',
    'completed_at'
  ];
  const keys = allowed.filter((key) => Object.prototype.hasOwnProperty.call(patch, key));
  if (!keys.length) return;
  const sql = `UPDATE bootstrap_sessions SET ${keys.map((key) => `${key} = ?`).join(', ')}, updated_at = ? WHERE id = ?`;
  const params = keys.map((key) => patch[key]);
  params.push(nowIso(), bootstrapId);
  db.prepare(sql).run(...params);
}

function getBootstrapSession(bootstrapId) {
  return db.prepare('SELECT * FROM bootstrap_sessions WHERE id = ?').get(bootstrapId) || null;
}

function getLatestBootstrapSessionForSlot(slotId) {
  return db.prepare(`
    SELECT *
    FROM bootstrap_sessions
    WHERE slot_id = ?
    ORDER BY updated_at DESC
    LIMIT 1
  `).get(slotId) || null;
}

function getLatestActiveBootstrapSession() {
  return db.prepare(`
    SELECT *
    FROM bootstrap_sessions
    WHERE status IN ('starting', 'awaiting_user', 'success_pending_capture', 'succeeded')
    ORDER BY updated_at DESC
    LIMIT 1
  `).get() || null;
}

function listBootstrapSessions(limit = 10) {
  return db.prepare(`
    SELECT *
    FROM bootstrap_sessions
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(limit);
}

function deleteBootstrapSession(bootstrapId) {
  db.prepare('DELETE FROM bootstrap_sessions WHERE id = ?').run(bootstrapId);
}

function createBrowserClient(record) {
  db.prepare(`
    INSERT INTO browser_clients (
      id,
      label,
      state,
      bind_code_hash,
      bind_code_expires_at,
      pending_actions_json,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, '[]', ?, ?)
  `).run(record.id, record.label, 'pending', record.bind_code_hash, record.bind_code_expires_at, nowIso(), nowIso());
}

function listBrowserClients() {
  const rows = db.prepare(`
    SELECT *
    FROM browser_clients
    ORDER BY updated_at DESC
  `).all();
  return rows.map((row) => ({
    ...row,
    pending_actions: safeParseJson(row.pending_actions_json, [])
  }));
}

function ensureCodeBridgeClient() {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM browser_clients WHERE id <> ?').run('code_bridge');
    db.prepare(`
      INSERT INTO browser_clients (
        id,
        label,
        state,
        pending_actions_json,
        created_at,
        updated_at
      ) VALUES (?, ?, 'active', '[]', ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        label = excluded.label,
        state = 'active',
        revoked_at = NULL,
        updated_at = excluded.updated_at
    `).run('code_bridge', 'Code Server Workspace', nowIso(), nowIso());
  });

  tx();
}

function getCodeBridgeClient() {
  return db.prepare('SELECT * FROM browser_clients WHERE id = ? LIMIT 1').get('code_bridge') || null;
}

function findPendingBrowserClientByBindCodeHash(hash) {
  return db.prepare(`
    SELECT *
    FROM browser_clients
    WHERE bind_code_hash = ? AND state = 'pending'
    LIMIT 1
  `).get(hash) || null;
}

function registerBrowserClient(clientId, accessTokenHash, metadata = {}) {
  db.prepare(`
    UPDATE browser_clients
    SET state = 'active',
        access_token_hash = ?,
        token_issued_at = ?,
        bind_code_hash = NULL,
        bind_code_expires_at = NULL,
        last_user_agent = ?,
        last_page_url = ?,
        last_seen_at = ?,
        updated_at = ?
    WHERE id = ?
  `).run(
    accessTokenHash,
    nowIso(),
    metadata.userAgent || null,
    metadata.pageUrl || null,
    nowIso(),
    nowIso(),
    clientId
  );
}

function getBrowserClientByTokenHash(tokenHash) {
  return db.prepare(`
    SELECT *
    FROM browser_clients
    WHERE access_token_hash = ? AND state = 'active' AND revoked_at IS NULL
    LIMIT 1
  `).get(tokenHash) || null;
}

function getBrowserClientById(clientId) {
  return db.prepare('SELECT * FROM browser_clients WHERE id = ? LIMIT 1').get(clientId) || null;
}

function touchBrowserClient(clientId, metadata = {}) {
  db.prepare(`
    UPDATE browser_clients
    SET last_seen_at = ?,
        last_user_agent = COALESCE(?, last_user_agent),
        last_page_url = COALESCE(?, last_page_url),
        updated_at = ?
    WHERE id = ?
  `).run(nowIso(), metadata.userAgent || null, metadata.pageUrl || null, nowIso(), clientId);
}

function revokeBrowserClient(clientId) {
  db.prepare(`
    UPDATE browser_clients
    SET state = 'revoked',
        revoked_at = ?,
        pending_actions_json = '[]',
        updated_at = ?
    WHERE id = ?
  `).run(nowIso(), nowIso(), clientId);
}

function enqueueBrowserAction(clientId, action) {
  const row = db.prepare('SELECT pending_actions_json FROM browser_clients WHERE id = ?').get(clientId);
  const queue = safeParseJson(row ? row.pending_actions_json : '[]', []);
  queue.push(action);
  db.prepare('UPDATE browser_clients SET pending_actions_json = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(queue), nowIso(), clientId);
}

function popBrowserActions(clientId) {
  const row = db.prepare('SELECT pending_actions_json FROM browser_clients WHERE id = ?').get(clientId);
  const actions = safeParseJson(row ? row.pending_actions_json : '[]', []);
  db.prepare('UPDATE browser_clients SET pending_actions_json = ?, updated_at = ? WHERE id = ?')
    .run('[]', nowIso(), clientId);
  return actions;
}

function getLatestDispatchTarget() {
  return getCodeBridgeClient();
}

function upsertRuntimeLock(name, owner, payload, expiresAt) {
  db.prepare(`
    INSERT INTO runtime_locks (name, owner, payload, expires_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      owner = excluded.owner,
      payload = excluded.payload,
      expires_at = excluded.expires_at,
      updated_at = excluded.updated_at
  `).run(name, owner || null, payload ? JSON.stringify(payload) : null, expiresAt || null, nowIso());
}

function getRuntimeLock(name) {
  const row = db.prepare('SELECT * FROM runtime_locks WHERE name = ?').get(name);
  if (!row) return null;
  return {
    ...row,
    payload: safeParseJson(row.payload, null)
  };
}

function deleteRuntimeLock(name) {
  db.prepare('DELETE FROM runtime_locks WHERE name = ?').run(name);
}

module.exports = {
  clearQuotaSamples,
  clearSwitchEvents,
  completeSwitchEvent,
  createAccount,
  createAdminUser,
  createBootstrapSession,
  createBrowserClient,
  createSwitchEvent,
  db,
  deleteAccount,
  deleteBootstrapSession,
  deleteProfile,
  deleteRuntimeLock,
  enqueueBrowserAction,
  ensureCodeBridgeClient,
  findPendingBrowserClientByBindCodeHash,
  getActiveSlot,
  getAdminUser,
  getBootstrapSession,
  getLatestActiveBootstrapSession,
  getLatestBootstrapSessionForSlot,
  getBrowserClientById,
  getBrowserClientByTokenHash,
  getCodeBridgeClient,
  getLatestDispatchTarget,
  getLatestQuotaSample,
  getProfile,
  getRecentLiveSamplesForSlot,
  getRuntimeLock,
  getSlotByAccountId,
  getSlotByIdentityKey,
  getSlotByEmail,
  getSlotById,
  insertQuotaSample,
  listBootstrapSessions,
  listBrowserClients,
  listRecentQuotaSamples,
  listRecentSwitchEvents,
  listSlots,
  nowIso,
  popBrowserActions,
  recordAdminFailedLogin,
  registerBrowserClient,
  revokeBrowserClient,
  safeParseJson,
  seedDefaultSlots,
  setActiveSlot,
  touchBrowserClient,
  updateAdminLogin,
  updateBootstrapSession,
  updateSlot,
  upsertProfile,
  upsertRuntimeLock
};
