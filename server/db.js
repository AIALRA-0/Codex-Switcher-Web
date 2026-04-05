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

CREATE TABLE IF NOT EXISTS account_auth_profiles (
  id TEXT PRIMARY KEY,
  slot_id TEXT NOT NULL,
  workspace_label TEXT NOT NULL,
  auth_cipher TEXT NOT NULL,
  account_id TEXT,
  identity_key TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 0,
  freshness TEXT DEFAULT 'stale',
  quota_5h_pct INTEGER,
  quota_5h_reset_at TEXT,
  quota_5h_reset_label TEXT,
  quota_week_pct INTEGER,
  quota_week_reset_at TEXT,
  quota_week_reset_label TEXT,
  last_seen_at TEXT,
  last_error TEXT,
  runtime_status TEXT DEFAULT 'stale',
  last_error_kind TEXT,
  failure_count INTEGER DEFAULT 0,
  backoff_until TEXT,
  reauth_required INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
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
  intent TEXT,
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

CREATE TABLE IF NOT EXISTS bridge_sessions (
  id TEXT PRIMARY KEY,
  workspace_kind TEXT NOT NULL,
  page_url TEXT,
  visible INTEGER NOT NULL DEFAULT 0,
  focused INTEGER NOT NULL DEFAULT 0,
  thread_title TEXT,
  latest_request TEXT,
  latest_response TEXT,
  draft_prompt TEXT,
  running INTEGER NOT NULL DEFAULT 0,
  auth_required INTEGER NOT NULL DEFAULT 0,
  send_enabled INTEGER NOT NULL DEFAULT 0,
  interruption_reason TEXT,
  active_auth_generation_seen INTEGER NOT NULL DEFAULT 0,
  last_user_agent TEXT,
  last_seen_at TEXT,
  last_recovered_at TEXT,
  last_error TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS bridge_actions (
  id TEXT PRIMARY KEY,
  bridge_session_id TEXT NOT NULL,
  action_type TEXT NOT NULL,
  payload_json TEXT,
  result_json TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  sent_at TEXT,
  acked_at TEXT,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(bridge_session_id) REFERENCES bridge_sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS resume_intents (
  id TEXT PRIMARY KEY,
  bridge_session_id TEXT,
  reason TEXT NOT NULL,
  source_slot_id TEXT,
  target_slot_id TEXT,
  original_prompt TEXT,
  draft_prompt TEXT,
  latest_request TEXT,
  latest_response TEXT,
  recovery_summary TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  sent_at TEXT,
  acked_at TEXT,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(bridge_session_id) REFERENCES bridge_sessions(id) ON DELETE SET NULL
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
CREATE INDEX IF NOT EXISTS idx_quota_samples_observed_at_desc ON quota_samples(observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_switch_events_created ON switch_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bootstrap_sessions_updated ON bootstrap_sessions(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_browser_clients_state ON browser_clients(state, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_bridge_sessions_kind_seen ON bridge_sessions(workspace_kind, last_seen_at DESC, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_bridge_actions_session_status ON bridge_actions(bridge_session_id, status, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_resume_intents_status_created ON resume_intents(status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_account_auth_profiles_primary_per_slot
  ON account_auth_profiles(slot_id)
  WHERE is_primary = 1;
CREATE UNIQUE INDEX IF NOT EXISTS idx_account_auth_profiles_identity_key
  ON account_auth_profiles(identity_key)
  WHERE identity_key IS NOT NULL AND identity_key <> '';
CREATE INDEX IF NOT EXISTS idx_account_auth_profiles_account_id_lookup
  ON account_auth_profiles(account_id)
  WHERE account_id IS NOT NULL AND account_id <> '';
CREATE INDEX IF NOT EXISTS idx_account_auth_profiles_slot_updated
  ON account_auth_profiles(slot_id, updated_at DESC);
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

function normalizeStoredError(value) {
  if (value == null) return null;
  if (value instanceof Error) {
    return normalizeStoredError(value.message || value.code || value.name || null);
  }
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return null;
    if ((text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']'))) {
      const parsed = safeParseJson(text, null);
      if (parsed && parsed !== value) return normalizeStoredError(parsed);
    }
    if (
      text === '[object Object]'
      || text === '{}'
      || text === '[]'
      || text === 'null'
      || text === 'undefined'
    ) {
      return 'UNKNOWN_BACKEND_ERROR';
    }
    return text;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object') {
    return normalizeStoredError(value.error)
      || normalizeStoredError(value.message)
      || normalizeStoredError(value.code)
      || (() => {
        try {
          const serialized = JSON.stringify(value);
          if (!serialized || serialized === '{}' || serialized === '[]') return 'UNKNOWN_BACKEND_ERROR';
          return serialized;
        } catch (_) {
          return 'UNKNOWN_BACKEND_ERROR';
        }
      })();
  }
  const text = String(value).trim();
  return text && text !== '[object Object]' ? text : 'UNKNOWN_BACKEND_ERROR';
}

function normalizeErrorFields(record, keys) {
  if (!record || typeof record !== 'object') return record;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      record[key] = normalizeStoredError(record[key]);
    }
  }
  return record;
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
  ensureColumn('account_slots', 'active_auth_profile_id', 'TEXT');
  ensureColumn('encrypted_profiles', 'identity_key', 'TEXT');
  ensureColumn('bootstrap_sessions', 'auth_profile_id', 'TEXT');
  ensureColumn('bootstrap_sessions', 'workspace_label', 'TEXT');
  ensureColumn('bootstrap_sessions', 'intent', "TEXT DEFAULT 'create_workspace'");
  ensureColumn('account_auth_profiles', 'runtime_status', "TEXT DEFAULT 'stale'");
  ensureColumn('account_auth_profiles', 'last_error_kind', 'TEXT');
  ensureColumn('account_auth_profiles', 'failure_count', 'INTEGER DEFAULT 0');
  ensureColumn('account_auth_profiles', 'backoff_until', 'TEXT');
  ensureColumn('account_auth_profiles', 'reauth_required', 'INTEGER DEFAULT 0');
  db.exec('CREATE INDEX IF NOT EXISTS idx_account_slots_updated ON account_slots(updated_at DESC)');
  db.exec('DROP INDEX IF EXISTS idx_account_auth_profiles_account_id');
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_account_auth_profiles_account_id_lookup
      ON account_auth_profiles(account_id)
      WHERE account_id IS NOT NULL AND account_id <> ''
  `);

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

  db.prepare(`
    UPDATE quota_samples
    SET observed_at = COALESCE(NULLIF(observed_at, ''), created_at)
    WHERE observed_at IS NULL OR observed_at = ''
  `).run();

  const legacyProfiles = db.prepare(`
    SELECT s.*, p.auth_cipher, p.account_id AS profile_account_id, p.identity_key AS profile_identity_key, p.updated_at AS profile_updated_at
    FROM account_slots s
    INNER JOIN encrypted_profiles p ON p.slot_id = s.id
    WHERE NOT EXISTS (
      SELECT 1
      FROM account_auth_profiles ap
      WHERE ap.slot_id = s.id
    )
    ORDER BY s.created_at ASC, s.id ASC
  `).all();

  if (legacyProfiles.length) {
    const insertProfile = db.prepare(`
      INSERT INTO account_auth_profiles (
        id,
        slot_id,
        workspace_label,
        auth_cipher,
        account_id,
        identity_key,
        is_primary,
        is_active,
        freshness,
        quota_5h_pct,
        quota_5h_reset_at,
        quota_5h_reset_label,
        quota_week_pct,
        quota_week_reset_at,
        quota_week_reset_label,
        last_seen_at,
        last_error,
        runtime_status,
        last_error_kind,
        failure_count,
        backoff_until,
        reauth_required,
        created_at,
        updated_at
      ) VALUES (
        @id,
        @slot_id,
        @workspace_label,
        @auth_cipher,
        @account_id,
        @identity_key,
        @is_primary,
        @is_active,
        @freshness,
        @quota_5h_pct,
        @quota_5h_reset_at,
        @quota_5h_reset_label,
        @quota_week_pct,
        @quota_week_reset_at,
        @quota_week_reset_label,
        @last_seen_at,
        @last_error,
        @runtime_status,
        @last_error_kind,
        @failure_count,
        @backoff_until,
        @reauth_required,
        @created_at,
        @updated_at
      )
    `);
    const txProfiles = db.transaction(() => {
      for (const row of legacyProfiles) {
        const authProfileId = `auth_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
        insertProfile.run({
          id: authProfileId,
          slot_id: row.id,
          workspace_label: '主认证',
          auth_cipher: row.auth_cipher,
          account_id: row.profile_account_id || row.account_id || null,
          identity_key: row.profile_identity_key || row.identity_key || null,
          is_primary: 1,
          is_active: row.is_active ? 1 : 0,
          freshness: row.freshness || 'stale',
          quota_5h_pct: row.quota_5h_pct == null ? null : row.quota_5h_pct,
          quota_5h_reset_at: row.quota_5h_reset_at || null,
          quota_5h_reset_label: row.quota_5h_reset_label || null,
          quota_week_pct: row.quota_week_pct == null ? null : row.quota_week_pct,
          quota_week_reset_at: row.quota_week_reset_at || null,
          quota_week_reset_label: row.quota_week_reset_label || null,
          last_seen_at: row.last_seen_at || null,
          last_error: row.last_error || null,
          runtime_status: row.is_active ? 'active' : 'ready',
          last_error_kind: null,
          failure_count: 0,
          backoff_until: null,
          reauth_required: 0,
          created_at: row.profile_updated_at || row.created_at || current,
          updated_at: row.profile_updated_at || row.updated_at || current
        });
        db.prepare(`
          UPDATE account_slots
          SET active_auth_profile_id = COALESCE(active_auth_profile_id, ?),
              updated_at = ?
          WHERE id = ?
        `).run(row.is_active ? authProfileId : null, current, row.id);
      }
    });
    txProfiles();
  }

  db.prepare(`
    UPDATE account_slots
    SET active_auth_profile_id = (
      SELECT ap.id
      FROM account_auth_profiles ap
      WHERE ap.slot_id = account_slots.id AND ap.is_active = 1
      ORDER BY ap.updated_at DESC
      LIMIT 1
    )
    WHERE is_active = 1 AND (
      active_auth_profile_id IS NULL
      OR active_auth_profile_id = ''
    )
  `).run();

  db.prepare(`
    UPDATE bootstrap_sessions
    SET workspace_label = COALESCE(NULLIF(workspace_label, ''), '主认证')
    WHERE workspace_label IS NULL OR workspace_label = ''
  `).run();
  db.prepare(`
    UPDATE bootstrap_sessions
    SET intent = CASE
      WHEN auth_profile_id IS NOT NULL AND auth_profile_id <> '' THEN 'reauth_workspace'
      ELSE 'create_workspace'
    END
    WHERE intent IS NULL OR intent = ''
  `).run();
  db.prepare(`
    UPDATE account_auth_profiles
    SET runtime_status = CASE
      WHEN reauth_required = 1 THEN 'reauth_required'
      WHEN last_error IS NOT NULL AND last_error <> '' THEN 'error'
      WHEN is_active = 1 THEN 'active'
      ELSE 'ready'
    END,
        failure_count = COALESCE(failure_count, 0),
        reauth_required = COALESCE(reauth_required, 0)
    WHERE runtime_status IS NULL
       OR runtime_status = ''
       OR failure_count IS NULL
       OR reauth_required IS NULL
  `).run();

  const repairAccountSlotError = db.prepare('UPDATE account_slots SET last_error = ?, updated_at = ? WHERE id = ?');
  const repairAuthProfileError = db.prepare('UPDATE account_auth_profiles SET last_error = ?, updated_at = ? WHERE id = ?');
  const repairBootstrapError = db.prepare('UPDATE bootstrap_sessions SET error_text = ?, updated_at = ? WHERE id = ?');
  const currentForRepair = nowIso();

  for (const row of db.prepare('SELECT id, last_error FROM account_slots WHERE last_error IS NOT NULL').all()) {
    const normalized = normalizeStoredError(row.last_error);
    if (normalized !== row.last_error) repairAccountSlotError.run(normalized, currentForRepair, row.id);
  }
  for (const row of db.prepare('SELECT id, last_error FROM account_auth_profiles WHERE last_error IS NOT NULL').all()) {
    const normalized = normalizeStoredError(row.last_error);
    if (normalized !== row.last_error) repairAuthProfileError.run(normalized, currentForRepair, row.id);
  }
  for (const row of db.prepare('SELECT id, error_text FROM bootstrap_sessions WHERE error_text IS NOT NULL').all()) {
    const normalized = normalizeStoredError(row.error_text);
    if (normalized !== row.error_text) repairBootstrapError.run(normalized, currentForRepair, row.id);
  }
}

function seedDefaultSlots() {
  migrateLegacySlots();

  const existingCount = db.prepare('SELECT COUNT(*) AS count FROM account_slots').get().count;
  if (existingCount > 0) return;

  const defaults = [
    { id: 'account_seed_1', label: '账号 1', email: 'account1@example.com', login_method: 'email' },
    { id: 'account_seed_2', label: '账号 2', email: 'account2@example.com', login_method: 'email' },
    { id: 'account_seed_3', label: '账号 3', email: 'account3@example.com', login_method: 'google' },
    { id: 'account_seed_4', label: '账号 4', email: 'account4@example.com', login_method: 'google' }
  ];

  const insert = db.prepare(`
    INSERT INTO account_slots (
      id, label, email, slot_type, login_method, priority, state, created_at, updated_at
    ) VALUES (
      @id, @label, @email, 'account', @login_method, @priority, 'auth_required', @created_at, @updated_at
    )
  `);

  const current = nowIso();
  const tx = db.transaction(() => {
    defaults.forEach((row, index) => insert.run({
      ...row,
      priority: index + 1,
      created_at: current,
      updated_at: current
    }));
  });
  tx();
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
    has_profile: Number(row.auth_profile_count || 0) > 0 || !!row.profile_updated_at,
    auth_profile_count: Number(row.auth_profile_count || 0),
    primary_auth_profile_id: row.primary_auth_profile_id || null,
    primary_workspace_label: row.primary_workspace_label || null,
    active_auth_profile_id: row.active_auth_profile_id || row.active_auth_profile_id_row || null,
    active_workspace_label: row.active_workspace_label || null
  };
}

function slotSelectSql(whereClause = '', orderClause = '') {
  return `
    SELECT
      s.*,
      primary_ap.id AS primary_auth_profile_id,
      primary_ap.workspace_label AS primary_workspace_label,
      primary_ap.account_id AS profile_account_id,
      primary_ap.identity_key AS profile_identity_key,
      primary_ap.updated_at AS profile_updated_at,
      primary_ap.quota_5h_pct AS profile_quota_5h_pct,
      primary_ap.quota_5h_reset_at AS profile_quota_5h_reset_at,
      primary_ap.quota_5h_reset_label AS profile_quota_5h_reset_label,
      primary_ap.quota_week_pct AS profile_quota_week_pct,
      primary_ap.quota_week_reset_at AS profile_quota_week_reset_at,
      primary_ap.quota_week_reset_label AS profile_quota_week_reset_label,
      primary_ap.freshness AS profile_freshness,
      primary_ap.last_seen_at AS profile_last_seen_at,
      primary_ap.last_error AS profile_last_error,
      active_ap.id AS active_auth_profile_id_row,
      active_ap.workspace_label AS active_workspace_label,
      active_ap.account_id AS active_profile_account_id,
      active_ap.identity_key AS active_profile_identity_key,
      COALESCE(auth_counts.auth_profile_count, 0) AS auth_profile_count
    FROM account_slots s
    LEFT JOIN account_auth_profiles primary_ap
      ON primary_ap.slot_id = s.id AND primary_ap.is_primary = 1
    LEFT JOIN account_auth_profiles active_ap
      ON active_ap.id = COALESCE(s.active_auth_profile_id, primary_ap.id)
    LEFT JOIN (
      SELECT slot_id, COUNT(*) AS auth_profile_count
      FROM account_auth_profiles
      GROUP BY slot_id
    ) auth_counts
      ON auth_counts.slot_id = s.id
    ${whereClause}
    ${orderClause}
  `;
}

function listSlots() {
  const rows = db.prepare(slotSelectSql(
    '',
    `
      ORDER BY
        s.is_active DESC,
        CASE WHEN s.expires_at IS NULL OR s.expires_at = '' THEN 1 ELSE 0 END ASC,
        s.expires_at ASC,
        lower(COALESCE(NULLIF(s.email, ''), NULLIF(s.label, ''), s.id)) ASC,
        s.created_at ASC
    `
  )).all();
  return rows.map(mapSlotRow);
}

function getSlotById(slotId) {
  const row = db.prepare(slotSelectSql('WHERE s.id = ?', '')).get(slotId);
  return row ? mapSlotRow(row) : null;
}

function getSlotByAccountId(accountId) {
  const row = db.prepare(slotSelectSql(
    'WHERE s.account_id = ? OR primary_ap.account_id = ? OR active_ap.account_id = ?',
    'ORDER BY s.is_active DESC, primary_ap.updated_at DESC, s.updated_at DESC, s.created_at ASC LIMIT 1'
  )).get(accountId, accountId, accountId);
  return row ? mapSlotRow(row) : null;
}

function getSlotByIdentityKey(identityKey) {
  const row = db.prepare(slotSelectSql(
    'WHERE s.identity_key = ? OR primary_ap.identity_key = ? OR active_ap.identity_key = ?',
    'ORDER BY s.is_active DESC, primary_ap.updated_at DESC, s.updated_at DESC, s.created_at ASC LIMIT 1'
  )).get(identityKey, identityKey, identityKey);
  return row ? mapSlotRow(row) : null;
}

function getSlotByEmail(email) {
  const row = db.prepare(slotSelectSql('WHERE lower(s.email) = lower(?)', 'LIMIT 1')).get(email);
  return row ? mapSlotRow(row) : null;
}

function getActiveSlot() {
  const row = db.prepare(slotSelectSql('WHERE s.is_active = 1', 'LIMIT 1')).get();
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

function setActiveSlot(slotId, authProfileId = null, activatedAt = nowIso()) {
  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE account_slots
      SET is_active = 0,
          active_auth_profile_id = NULL,
          state = CASE WHEN state = 'active' THEN 'ready' ELSE state END,
          updated_at = ?
    `).run(activatedAt);
    db.prepare(`
      UPDATE account_auth_profiles
      SET is_active = 0,
          updated_at = ?
    `).run(activatedAt);
    if (slotId) {
      db.prepare(`
        UPDATE account_slots
        SET is_active = 1,
            active_auth_profile_id = ?,
            state = 'active',
            last_activated_at = ?,
            last_error = NULL,
            updated_at = ?
        WHERE id = ?
      `).run(authProfileId || null, activatedAt, activatedAt, slotId);
      if (authProfileId) {
        db.prepare(`
          UPDATE account_auth_profiles
          SET is_active = 1,
              updated_at = ?
          WHERE id = ?
        `).run(activatedAt, authProfileId);
      }
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
    'active_auth_profile_id',
    'expires_at'
  ];

  normalizeErrorFields(patch, ['last_error']);
  const keys = allowed.filter((key) => Object.prototype.hasOwnProperty.call(patch, key));
  if (!keys.length) return;

  const sql = `UPDATE account_slots SET ${keys.map((key) => `${key} = ?`).join(', ')}, updated_at = ? WHERE id = ?`;
  const params = keys.map((key) => patch[key]);
  params.push(nowIso(), slotId);
  db.prepare(sql).run(...params);
}

function upsertProfile(slotId, authCipher, accountId, identityKey) {
  const existingPrimary = db.prepare(`
    SELECT id, workspace_label, created_at
    FROM account_auth_profiles
    WHERE slot_id = ? AND is_primary = 1
    LIMIT 1
  `).get(slotId);
  const authProfileId = existingPrimary ? existingPrimary.id : `auth_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const workspaceLabel = existingPrimary ? existingPrimary.workspace_label : '主认证';
  const createdAt = existingPrimary ? existingPrimary.created_at : nowIso();
  db.prepare(`
    INSERT INTO account_auth_profiles (
      id,
      slot_id,
      workspace_label,
      auth_cipher,
      account_id,
      identity_key,
      is_primary,
      is_active,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      slot_id = excluded.slot_id,
      workspace_label = excluded.workspace_label,
      auth_cipher = excluded.auth_cipher,
      account_id = excluded.account_id,
      identity_key = excluded.identity_key,
      is_primary = 1,
      updated_at = excluded.updated_at
  `).run(authProfileId, slotId, workspaceLabel, authCipher, accountId || null, identityKey || null, createdAt, nowIso());
  db.prepare(`
    INSERT INTO encrypted_profiles (slot_id, auth_cipher, account_id, identity_key, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(slot_id) DO UPDATE SET
      auth_cipher = excluded.auth_cipher,
      account_id = excluded.account_id,
      identity_key = excluded.identity_key,
      updated_at = excluded.updated_at
  `).run(slotId, authCipher, accountId || null, identityKey || null, nowIso());
  return getAuthProfileById(authProfileId);
}

function getProfile(slotId) {
  return db.prepare(`
    SELECT *
    FROM account_auth_profiles
    WHERE slot_id = ? AND is_primary = 1
    LIMIT 1
  `).get(slotId) || db.prepare('SELECT * FROM encrypted_profiles WHERE slot_id = ?').get(slotId) || null;
}

function deleteProfile(slotId) {
  db.prepare('DELETE FROM encrypted_profiles WHERE slot_id = ?').run(slotId);
  db.prepare('DELETE FROM account_auth_profiles WHERE slot_id = ?').run(slotId);
}

function mapAuthProfileRow(row) {
  if (!row) return null;
  return {
    ...row,
    is_primary: !!row.is_primary,
    is_active: !!row.is_active,
    reauth_required: !!row.reauth_required,
    failure_count: Number(row.failure_count || 0)
  };
}

function listAuthProfilesForSlot(slotId) {
  const rows = db.prepare(`
    SELECT *
    FROM account_auth_profiles
    WHERE slot_id = ?
    ORDER BY is_primary DESC, is_active DESC, lower(workspace_label) ASC, created_at ASC
  `).all(slotId);
  return rows.map(mapAuthProfileRow);
}

function getAuthProfileById(authProfileId) {
  const row = db.prepare('SELECT * FROM account_auth_profiles WHERE id = ? LIMIT 1').get(authProfileId);
  return mapAuthProfileRow(row);
}

function getPrimaryAuthProfileForSlot(slotId) {
  const row = db.prepare(`
    SELECT *
    FROM account_auth_profiles
    WHERE slot_id = ? AND is_primary = 1
    LIMIT 1
  `).get(slotId);
  return mapAuthProfileRow(row);
}

function getAuthProfileByIdentityKey(identityKey) {
  const row = db.prepare(`
    SELECT *
    FROM account_auth_profiles
    WHERE identity_key = ?
    LIMIT 1
  `).get(identityKey);
  return mapAuthProfileRow(row);
}

function getAuthProfileByAccountId(accountId) {
  const row = db.prepare(`
    SELECT *
    FROM account_auth_profiles
    WHERE account_id = ?
    ORDER BY is_active DESC, is_primary DESC, updated_at DESC
    LIMIT 1
  `).get(accountId);
  return mapAuthProfileRow(row);
}

function getAuthProfileByWorkspaceLabel(slotId, workspaceLabel) {
  const label = String(workspaceLabel || '').trim();
  if (!slotId || !label) return null;
  const row = db.prepare(`
    SELECT *
    FROM account_auth_profiles
    WHERE slot_id = ?
      AND lower(workspace_label) = lower(?)
    ORDER BY is_primary DESC, is_active DESC, updated_at DESC, created_at ASC
    LIMIT 1
  `).get(slotId, label);
  return mapAuthProfileRow(row);
}

function createAuthProfile(record) {
  normalizeErrorFields(record, ['last_error']);
  const id = record.id || `auth_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const current = nowIso();
  db.prepare(`
    INSERT INTO account_auth_profiles (
      id,
      slot_id,
      workspace_label,
      auth_cipher,
      account_id,
      identity_key,
      is_primary,
      is_active,
      freshness,
      quota_5h_pct,
      quota_5h_reset_at,
      quota_5h_reset_label,
      quota_week_pct,
      quota_week_reset_at,
      quota_week_reset_label,
      last_seen_at,
      last_error,
      runtime_status,
      last_error_kind,
      failure_count,
      backoff_until,
      reauth_required,
      created_at,
      updated_at
    ) VALUES (
      @id,
      @slot_id,
      @workspace_label,
      @auth_cipher,
      @account_id,
      @identity_key,
      @is_primary,
      @is_active,
      @freshness,
      @quota_5h_pct,
      @quota_5h_reset_at,
      @quota_5h_reset_label,
      @quota_week_pct,
      @quota_week_reset_at,
      @quota_week_reset_label,
      @last_seen_at,
      @last_error,
      @runtime_status,
      @last_error_kind,
      @failure_count,
      @backoff_until,
      @reauth_required,
      @created_at,
      @updated_at
    )
  `).run({
    id,
    slot_id: record.slot_id,
    workspace_label: record.workspace_label || '未命名认证',
    auth_cipher: record.auth_cipher,
    account_id: record.account_id || null,
    identity_key: record.identity_key || null,
    is_primary: record.is_primary ? 1 : 0,
    is_active: record.is_active ? 1 : 0,
    freshness: record.freshness || 'stale',
    quota_5h_pct: record.quota_5h_pct == null ? null : record.quota_5h_pct,
    quota_5h_reset_at: record.quota_5h_reset_at || null,
    quota_5h_reset_label: record.quota_5h_reset_label || null,
    quota_week_pct: record.quota_week_pct == null ? null : record.quota_week_pct,
    quota_week_reset_at: record.quota_week_reset_at || null,
    quota_week_reset_label: record.quota_week_reset_label || null,
    last_seen_at: record.last_seen_at || null,
    last_error: record.last_error || null,
    runtime_status: record.runtime_status || 'stale',
    last_error_kind: record.last_error_kind || null,
    failure_count: Number.isFinite(Number(record.failure_count)) ? Number(record.failure_count) : 0,
    backoff_until: record.backoff_until || null,
    reauth_required: record.reauth_required ? 1 : 0,
    created_at: record.created_at || current,
    updated_at: current
  });
  return getAuthProfileById(id);
}

function updateAuthProfile(authProfileId, patch) {
  const allowed = [
    'workspace_label',
    'auth_cipher',
    'account_id',
    'identity_key',
    'is_primary',
    'is_active',
    'freshness',
    'quota_5h_pct',
    'quota_5h_reset_at',
    'quota_5h_reset_label',
    'quota_week_pct',
    'quota_week_reset_at',
    'quota_week_reset_label',
    'last_seen_at',
    'last_error',
    'runtime_status',
    'last_error_kind',
    'failure_count',
    'backoff_until',
    'reauth_required'
  ];
  normalizeErrorFields(patch, ['last_error']);
  const keys = allowed.filter((key) => Object.prototype.hasOwnProperty.call(patch, key));
  if (!keys.length) return;
  const sql = `UPDATE account_auth_profiles SET ${keys.map((key) => `${key} = ?`).join(', ')}, updated_at = ? WHERE id = ?`;
  const params = keys.map((key) => patch[key]);
  params.push(nowIso(), authProfileId);
  db.prepare(sql).run(...params);
}

function setPrimaryAuthProfile(slotId, authProfileId) {
  const current = nowIso();
  const tx = db.transaction(() => {
    const target = db.prepare(`
      SELECT id
      FROM account_auth_profiles
      WHERE slot_id = ? AND id = ?
      LIMIT 1
    `).get(slotId, authProfileId);
    if (!target) return;
    db.prepare(`
      UPDATE account_auth_profiles
      SET is_primary = 0,
          updated_at = ?
      WHERE slot_id = ? AND is_primary = 1
    `).run(current, slotId);
    db.prepare(`
      UPDATE account_auth_profiles
      SET is_primary = 1,
          updated_at = ?
      WHERE slot_id = ? AND id = ?
    `).run(current, slotId, authProfileId);
  });
  tx();
}

function deleteAuthProfile(authProfileId) {
  db.prepare('DELETE FROM account_auth_profiles WHERE id = ?').run(authProfileId);
}

function syncSlotAuthAggregate(slotId) {
  const primary = getPrimaryAuthProfileForSlot(slotId);
  const current = nowIso();
  db.prepare(`
    UPDATE account_slots
    SET account_id = ?,
        identity_key = ?,
        quota_5h_pct = ?,
        quota_5h_reset_at = ?,
        quota_5h_reset_label = ?,
        quota_week_pct = ?,
        quota_week_reset_at = ?,
        quota_week_reset_label = ?,
        freshness = ?,
        last_seen_at = ?,
        last_error = ?,
        active_auth_profile_id = CASE
          WHEN active_auth_profile_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM account_auth_profiles ap WHERE ap.id = active_auth_profile_id
          ) THEN active_auth_profile_id
          ELSE NULL
        END,
        updated_at = ?
    WHERE id = ?
  `).run(
    primary ? primary.account_id || null : null,
    primary ? primary.identity_key || null : null,
    primary ? (primary.quota_5h_pct == null ? null : primary.quota_5h_pct) : null,
    primary ? primary.quota_5h_reset_at || null : null,
    primary ? primary.quota_5h_reset_label || null : null,
    primary ? (primary.quota_week_pct == null ? null : primary.quota_week_pct) : null,
    primary ? primary.quota_week_reset_at || null : null,
    primary ? primary.quota_week_reset_label || null : null,
    primary ? (primary.freshness || 'stale') : 'stale',
    primary ? primary.last_seen_at || null : null,
    primary ? normalizeStoredError(primary.last_error) : null,
    current,
    slotId
  );
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
    ORDER BY observed_at DESC
    LIMIT ?
  `).all(limit);
}

function getLatestQuotaSample(slotId = undefined) {
  if (slotId === undefined) {
    return db.prepare(`
      SELECT *
      FROM quota_samples
      ORDER BY observed_at DESC
      LIMIT 1
    `).get() || null;
  }

  return db.prepare(`
    SELECT *
    FROM quota_samples
    WHERE slot_id IS ?
    ORDER BY observed_at DESC
    LIMIT 1
  `).get(slotId) || null;
}

function getRecentLiveSamplesForSlot(slotId, limit = 2) {
  return db.prepare(`
    SELECT *
    FROM quota_samples
    WHERE slot_id = ? AND parser_status = 'ok'
    ORDER BY observed_at DESC
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
  normalizeErrorFields(record, ['error_text']);
  db.prepare(`
    INSERT INTO bootstrap_sessions (
      id,
      slot_id,
      status,
      email,
      login_method,
      intent,
      auth_profile_id,
      workspace_label,
      device_code,
      verification_uri,
      log_tail,
      bootstrap_home,
      error_text,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.id,
    record.slot_id,
    record.status,
    record.email || null,
    record.login_method || null,
    record.intent || 'create_workspace',
    record.auth_profile_id || null,
    record.workspace_label || '主认证',
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
    'intent',
    'device_code',
    'verification_uri',
    'log_tail',
    'bootstrap_home',
    'error_text',
    'auth_profile_id',
    'workspace_label',
    'completed_at'
  ];
  normalizeErrorFields(patch, ['error_text']);
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
    `).run('code_bridge', 'code.example.com', nowIso(), nowIso());
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

function mapBridgeSessionRow(row) {
  if (!row) return null;
  return {
    ...row,
    visible: !!row.visible,
    focused: !!row.focused,
    running: !!row.running,
    auth_required: !!row.auth_required,
    send_enabled: !!row.send_enabled,
    active_auth_generation_seen: Number(row.active_auth_generation_seen || 0),
    last_error: normalizeStoredError(row.last_error)
  };
}

function upsertBridgeSession(record) {
  normalizeErrorFields(record, ['last_error']);
  const current = nowIso();
  db.prepare(`
    INSERT INTO bridge_sessions (
      id,
      workspace_kind,
      page_url,
      visible,
      focused,
      thread_title,
      latest_request,
      latest_response,
      draft_prompt,
      running,
      auth_required,
      send_enabled,
      interruption_reason,
      active_auth_generation_seen,
      last_user_agent,
      last_seen_at,
      last_recovered_at,
      last_error,
      created_at,
      updated_at
    ) VALUES (
      @id,
      @workspace_kind,
      @page_url,
      @visible,
      @focused,
      @thread_title,
      @latest_request,
      @latest_response,
      @draft_prompt,
      @running,
      @auth_required,
      @send_enabled,
      @interruption_reason,
      @active_auth_generation_seen,
      @last_user_agent,
      @last_seen_at,
      @last_recovered_at,
      @last_error,
      @created_at,
      @updated_at
    )
    ON CONFLICT(id) DO UPDATE SET
      workspace_kind = excluded.workspace_kind,
      page_url = excluded.page_url,
      visible = excluded.visible,
      focused = excluded.focused,
      thread_title = excluded.thread_title,
      latest_request = excluded.latest_request,
      latest_response = excluded.latest_response,
      draft_prompt = excluded.draft_prompt,
      running = excluded.running,
      auth_required = excluded.auth_required,
      send_enabled = excluded.send_enabled,
      interruption_reason = excluded.interruption_reason,
      active_auth_generation_seen = excluded.active_auth_generation_seen,
      last_user_agent = excluded.last_user_agent,
      last_seen_at = excluded.last_seen_at,
      last_recovered_at = COALESCE(excluded.last_recovered_at, bridge_sessions.last_recovered_at),
      last_error = excluded.last_error,
      updated_at = excluded.updated_at
  `).run({
    id: record.id,
    workspace_kind: record.workspace_kind,
    page_url: record.page_url || null,
    visible: record.visible ? 1 : 0,
    focused: record.focused ? 1 : 0,
    thread_title: record.thread_title || null,
    latest_request: record.latest_request || null,
    latest_response: record.latest_response || null,
    draft_prompt: record.draft_prompt || null,
    running: record.running ? 1 : 0,
    auth_required: record.auth_required ? 1 : 0,
    send_enabled: record.send_enabled ? 1 : 0,
    interruption_reason: record.interruption_reason || null,
    active_auth_generation_seen: Number.isFinite(Number(record.active_auth_generation_seen))
      ? Number(record.active_auth_generation_seen)
      : 0,
    last_user_agent: record.last_user_agent || null,
    last_seen_at: record.last_seen_at || current,
    last_recovered_at: record.last_recovered_at || null,
    last_error: record.last_error || null,
    created_at: record.created_at || current,
    updated_at: current
  });
  return getBridgeSessionById(record.id);
}

function updateBridgeSession(sessionId, patch = {}) {
  const allowed = [
    'workspace_kind',
    'page_url',
    'visible',
    'focused',
    'thread_title',
    'latest_request',
    'latest_response',
    'draft_prompt',
    'running',
    'auth_required',
    'send_enabled',
    'interruption_reason',
    'active_auth_generation_seen',
    'last_user_agent',
    'last_seen_at',
    'last_recovered_at',
    'last_error'
  ];
  normalizeErrorFields(patch, ['last_error']);
  const keys = allowed.filter((key) => Object.prototype.hasOwnProperty.call(patch, key));
  if (!keys.length) return getBridgeSessionById(sessionId);
  const sql = `UPDATE bridge_sessions SET ${keys.map((key) => `${key} = ?`).join(', ')}, updated_at = ? WHERE id = ?`;
  const params = keys.map((key) => {
    if (['visible', 'focused', 'running', 'auth_required', 'send_enabled'].includes(key)) return patch[key] ? 1 : 0;
    if (key === 'active_auth_generation_seen') {
      return Number.isFinite(Number(patch[key])) ? Number(patch[key]) : 0;
    }
    return patch[key];
  });
  params.push(nowIso(), sessionId);
  db.prepare(sql).run(...params);
  return getBridgeSessionById(sessionId);
}

function getBridgeSessionById(sessionId) {
  const row = db.prepare('SELECT * FROM bridge_sessions WHERE id = ? LIMIT 1').get(sessionId);
  return mapBridgeSessionRow(row);
}

function listBridgeSessions(workspaceKind = null) {
  const rows = workspaceKind
    ? db.prepare(`
      SELECT *
      FROM bridge_sessions
      WHERE workspace_kind = ?
      ORDER BY updated_at DESC
    `).all(workspaceKind)
    : db.prepare(`
      SELECT *
      FROM bridge_sessions
      ORDER BY updated_at DESC
    `).all();
  return rows.map(mapBridgeSessionRow);
}

function mapBridgeActionRow(row) {
  if (!row) return null;
  return {
    ...row,
    payload: safeParseJson(row.payload_json, {}),
    result: safeParseJson(row.result_json, null)
  };
}

function createBridgeAction(record = {}) {
  const current = nowIso();
  const id = record.id || `bridge_action_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
  db.prepare(`
    INSERT INTO bridge_actions (
      id,
      bridge_session_id,
      action_type,
      payload_json,
      result_json,
      status,
      created_at,
      sent_at,
      acked_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    record.bridge_session_id,
    record.action_type,
    JSON.stringify(record.payload || {}),
    record.result ? JSON.stringify(record.result) : null,
    record.status || 'queued',
    record.created_at || current,
    record.sent_at || null,
    record.acked_at || null,
    current
  );
  return getBridgeActionById(id);
}

function getBridgeActionById(actionId) {
  const row = db.prepare('SELECT * FROM bridge_actions WHERE id = ? LIMIT 1').get(actionId);
  return mapBridgeActionRow(row);
}

function updateBridgeAction(actionId, patch = {}) {
  const allowed = ['payload_json', 'result_json', 'status', 'sent_at', 'acked_at'];
  const normalizedPatch = { ...patch };
  if (Object.prototype.hasOwnProperty.call(patch, 'payload')) {
    normalizedPatch.payload_json = JSON.stringify(patch.payload || {});
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'result')) {
    normalizedPatch.result_json = patch.result == null ? null : JSON.stringify(patch.result);
  }
  const keys = allowed.filter((key) => Object.prototype.hasOwnProperty.call(normalizedPatch, key));
  if (!keys.length) return getBridgeActionById(actionId);
  const sql = `UPDATE bridge_actions SET ${keys.map((key) => `${key} = ?`).join(', ')}, updated_at = ? WHERE id = ?`;
  const params = keys.map((key) => normalizedPatch[key]);
  params.push(nowIso(), actionId);
  db.prepare(sql).run(...params);
  return getBridgeActionById(actionId);
}

function listBridgeActionsForSession(sessionId, statuses = null) {
  const normalizedStatuses = Array.isArray(statuses)
    ? statuses.map((status) => String(status || '').trim()).filter(Boolean)
    : null;
  if (normalizedStatuses && normalizedStatuses.length) {
    const placeholders = normalizedStatuses.map(() => '?').join(', ');
    return db.prepare(`
      SELECT *
      FROM bridge_actions
      WHERE bridge_session_id = ?
        AND status IN (${placeholders})
      ORDER BY created_at ASC
    `).all(sessionId, ...normalizedStatuses).map(mapBridgeActionRow);
  }
  return db.prepare(`
    SELECT *
    FROM bridge_actions
    WHERE bridge_session_id = ?
    ORDER BY created_at ASC
  `).all(sessionId).map(mapBridgeActionRow);
}

function mapResumeIntentRow(row) {
  if (!row) return null;
  return {
    ...row
  };
}

function createResumeIntent(record = {}) {
  const current = nowIso();
  const id = record.id || `resume_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
  db.prepare(`
    INSERT INTO resume_intents (
      id,
      bridge_session_id,
      reason,
      source_slot_id,
      target_slot_id,
      original_prompt,
      draft_prompt,
      latest_request,
      latest_response,
      recovery_summary,
      status,
      created_at,
      sent_at,
      acked_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    record.bridge_session_id || null,
    record.reason || 'interrupted',
    record.source_slot_id || null,
    record.target_slot_id || null,
    record.original_prompt || null,
    record.draft_prompt || null,
    record.latest_request || null,
    record.latest_response || null,
    record.recovery_summary || null,
    record.status || 'pending',
    record.created_at || current,
    record.sent_at || null,
    record.acked_at || null,
    current
  );
  return getResumeIntentById(id);
}

function getResumeIntentById(intentId) {
  const row = db.prepare('SELECT * FROM resume_intents WHERE id = ? LIMIT 1').get(intentId);
  return mapResumeIntentRow(row);
}

function updateResumeIntent(intentId, patch = {}) {
  const allowed = [
    'bridge_session_id',
    'reason',
    'source_slot_id',
    'target_slot_id',
    'original_prompt',
    'draft_prompt',
    'latest_request',
    'latest_response',
    'recovery_summary',
    'status',
    'sent_at',
    'acked_at'
  ];
  const keys = allowed.filter((key) => Object.prototype.hasOwnProperty.call(patch, key));
  if (!keys.length) return getResumeIntentById(intentId);
  const sql = `UPDATE resume_intents SET ${keys.map((key) => `${key} = ?`).join(', ')}, updated_at = ? WHERE id = ?`;
  const params = keys.map((key) => patch[key]);
  params.push(nowIso(), intentId);
  db.prepare(sql).run(...params);
  return getResumeIntentById(intentId);
}

function listResumeIntents(statuses = null, limit = 20) {
  const normalizedStatuses = Array.isArray(statuses)
    ? statuses.map((status) => String(status || '').trim()).filter(Boolean)
    : null;
  if (normalizedStatuses && normalizedStatuses.length) {
    const placeholders = normalizedStatuses.map(() => '?').join(', ');
    return db.prepare(`
      SELECT *
      FROM resume_intents
      WHERE status IN (${placeholders})
      ORDER BY created_at DESC
      LIMIT ?
    `).all(...normalizedStatuses, limit).map(mapResumeIntentRow);
  }
  return db.prepare(`
    SELECT *
    FROM resume_intents
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit).map(mapResumeIntentRow);
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
  createAuthProfile,
  clearQuotaSamples,
  clearSwitchEvents,
  completeSwitchEvent,
  createAccount,
  createAdminUser,
  createBootstrapSession,
  createBridgeAction,
  createBrowserClient,
  createResumeIntent,
  createSwitchEvent,
  db,
  deleteAccount,
  deleteAuthProfile,
  deleteBootstrapSession,
  deleteProfile,
  deleteRuntimeLock,
  enqueueBrowserAction,
  ensureCodeBridgeClient,
  findPendingBrowserClientByBindCodeHash,
  getActiveSlot,
  getAdminUser,
  getBridgeActionById,
  getBridgeSessionById,
  getBootstrapSession,
  getLatestActiveBootstrapSession,
  getLatestBootstrapSessionForSlot,
  getBrowserClientById,
  getBrowserClientByTokenHash,
  getCodeBridgeClient,
  getAuthProfileByAccountId,
  getAuthProfileById,
  getAuthProfileByIdentityKey,
  getAuthProfileByWorkspaceLabel,
  getLatestDispatchTarget,
  getLatestQuotaSample,
  getProfile,
  getPrimaryAuthProfileForSlot,
  getRecentLiveSamplesForSlot,
  getResumeIntentById,
  getRuntimeLock,
  getSlotByAccountId,
  getSlotByIdentityKey,
  getSlotByEmail,
  getSlotById,
  insertQuotaSample,
  listAuthProfilesForSlot,
  listBootstrapSessions,
  listBridgeActionsForSession,
  listBridgeSessions,
  listBrowserClients,
  listRecentQuotaSamples,
  listRecentSwitchEvents,
  listResumeIntents,
  listSlots,
  nowIso,
  popBrowserActions,
  recordAdminFailedLogin,
  registerBrowserClient,
  revokeBrowserClient,
  safeParseJson,
  seedDefaultSlots,
  setPrimaryAuthProfile,
  setActiveSlot,
  syncSlotAuthAggregate,
  touchBrowserClient,
  updateBridgeAction,
  updateBridgeSession,
  updateAdminLogin,
  updateAuthProfile,
  updateBootstrapSession,
  updateResumeIntent,
  updateSlot,
  upsertBridgeSession,
  upsertProfile,
  upsertRuntimeLock
};
