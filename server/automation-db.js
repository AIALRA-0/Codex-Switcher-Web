'use strict';

const { db, nowIso } = require('./db');

db.exec(`
CREATE TABLE IF NOT EXISTS repo_sessions (
  repo_key TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  local_path TEXT NOT NULL,
  workspace_url TEXT NOT NULL,
  browser_profile_dir TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'idle',
  paused INTEGER NOT NULL DEFAULT 0,
  prompt_version TEXT,
  thread_title TEXT,
  handoff_summary TEXT,
  batch_count INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_seen_at TEXT,
  last_error TEXT,
  thread_started_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS issue_batches (
  id TEXT PRIMARY KEY,
  repo_key TEXT NOT NULL,
  state TEXT NOT NULL,
  config_fingerprint TEXT NOT NULL,
  plan_mode INTEGER NOT NULL DEFAULT 0,
  model TEXT NOT NULL,
  reasoning_effort TEXT NOT NULL,
  issue_numbers_json TEXT NOT NULL DEFAULT '[]',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  ready_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  error_text TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(repo_key) REFERENCES repo_sessions(repo_key) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS automation_runs (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  repo_key TEXT NOT NULL,
  state TEXT NOT NULL,
  phase TEXT NOT NULL DEFAULT 'execute',
  slot_id TEXT,
  model TEXT NOT NULL,
  reasoning_effort TEXT NOT NULL,
  plan_mode INTEGER NOT NULL DEFAULT 0,
  prompt_text TEXT,
  latest_assistant_text TEXT,
  commit_before TEXT,
  commit_after TEXT,
  last_error TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(batch_id) REFERENCES issue_batches(id) ON DELETE CASCADE,
  FOREIGN KEY(repo_key) REFERENCES repo_sessions(repo_key) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  repo_key TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(run_id) REFERENCES automation_runs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS issue_config_snapshots (
  repo_key TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  issue_api_id INTEGER,
  title TEXT,
  issue_updated_at TEXT,
  body_hash TEXT,
  config_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open',
  last_polled_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (repo_key, issue_number),
  FOREIGN KEY(repo_key) REFERENCES repo_sessions(repo_key) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_repo_sessions_status ON repo_sessions(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_issue_batches_repo_state ON issue_batches(repo_key, state, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_issue_batches_ready ON issue_batches(state, ready_at ASC);
CREATE INDEX IF NOT EXISTS idx_automation_runs_repo_state ON automation_runs(repo_key, state, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_run_events_run_created ON run_events(run_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_issue_snapshots_repo_state ON issue_config_snapshots(repo_key, state, updated_at DESC);
`);

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch (_) {
    return fallback;
  }
}

function mapRepoSession(row) {
  if (!row) return null;
  return {
    ...row,
    paused: !!row.paused
  };
}

function mapBatch(row) {
  if (!row) return null;
  return {
    ...row,
    plan_mode: !!row.plan_mode,
    issue_numbers: parseJson(row.issue_numbers_json, []),
    metadata: parseJson(row.metadata_json, {})
  };
}

function mapRun(row) {
  if (!row) return null;
  return {
    ...row,
    plan_mode: !!row.plan_mode
  };
}

function mapIssueSnapshot(row) {
  if (!row) return null;
  return {
    ...row,
    config: parseJson(row.config_json, {})
  };
}

function listRepoSessions() {
  return db.prepare(`
    SELECT *
    FROM repo_sessions
    ORDER BY updated_at DESC, repo_key ASC
  `).all().map(mapRepoSession);
}

function getRepoSession(repoKey) {
  return mapRepoSession(db.prepare('SELECT * FROM repo_sessions WHERE repo_key = ?').get(repoKey));
}

function upsertRepoSession(record) {
  const current = getRepoSession(record.repo_key);
  const createdAt = current ? current.created_at : nowIso();
  const threadStartedAt = record.thread_started_at || (current ? current.thread_started_at : nowIso());
  db.prepare(`
    INSERT INTO repo_sessions (
      repo_key, owner, repo_name, local_path, workspace_url, browser_profile_dir, status, paused,
      prompt_version, thread_title, handoff_summary, batch_count, consecutive_failures, last_seen_at,
      last_error, thread_started_at, created_at, updated_at
    ) VALUES (
      @repo_key, @owner, @repo_name, @local_path, @workspace_url, @browser_profile_dir, @status, @paused,
      @prompt_version, @thread_title, @handoff_summary, @batch_count, @consecutive_failures, @last_seen_at,
      @last_error, @thread_started_at, @created_at, @updated_at
    )
    ON CONFLICT(repo_key) DO UPDATE SET
      owner = excluded.owner,
      repo_name = excluded.repo_name,
      local_path = excluded.local_path,
      workspace_url = excluded.workspace_url,
      browser_profile_dir = excluded.browser_profile_dir,
      status = excluded.status,
      paused = excluded.paused,
      prompt_version = excluded.prompt_version,
      thread_title = excluded.thread_title,
      handoff_summary = excluded.handoff_summary,
      batch_count = excluded.batch_count,
      consecutive_failures = excluded.consecutive_failures,
      last_seen_at = excluded.last_seen_at,
      last_error = excluded.last_error,
      thread_started_at = excluded.thread_started_at,
      updated_at = excluded.updated_at
  `).run({
    repo_key: record.repo_key,
    owner: record.owner,
    repo_name: record.repo_name,
    local_path: record.local_path,
    workspace_url: record.workspace_url,
    browser_profile_dir: record.browser_profile_dir,
    status: record.status || (current ? current.status : 'idle'),
    paused: record.paused ? 1 : 0,
    prompt_version: record.prompt_version || (current ? current.prompt_version : null),
    thread_title: record.thread_title == null ? (current ? current.thread_title : null) : record.thread_title,
    handoff_summary: record.handoff_summary == null ? (current ? current.handoff_summary : null) : record.handoff_summary,
    batch_count: Number(record.batch_count == null ? (current ? current.batch_count : 0) : record.batch_count),
    consecutive_failures: Number(record.consecutive_failures == null ? (current ? current.consecutive_failures : 0) : record.consecutive_failures),
    last_seen_at: record.last_seen_at == null ? (current ? current.last_seen_at : null) : record.last_seen_at,
    last_error: record.last_error == null ? (current ? current.last_error : null) : record.last_error,
    thread_started_at: threadStartedAt,
    created_at: createdAt,
    updated_at: nowIso()
  });
  return getRepoSession(record.repo_key);
}

function updateRepoSession(repoKey, patch = {}) {
  const current = getRepoSession(repoKey);
  if (!current) return null;
  return upsertRepoSession({
    ...current,
    ...patch,
    repo_key: repoKey
  });
}

function createIssueBatch(record) {
  db.prepare(`
    INSERT INTO issue_batches (
      id, repo_key, state, config_fingerprint, plan_mode, model, reasoning_effort,
      issue_numbers_json, metadata_json, ready_at, started_at, completed_at, error_text, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.id,
    record.repo_key,
    record.state,
    record.config_fingerprint,
    record.plan_mode ? 1 : 0,
    record.model,
    record.reasoning_effort,
    JSON.stringify(record.issue_numbers || []),
    JSON.stringify(record.metadata || {}),
    record.ready_at || null,
    record.started_at || null,
    record.completed_at || null,
    record.error_text || null,
    nowIso(),
    nowIso()
  );
  return getIssueBatch(record.id);
}

function getIssueBatch(batchId) {
  return mapBatch(db.prepare('SELECT * FROM issue_batches WHERE id = ?').get(batchId));
}

function listIssueBatches(states = [], limit = 200) {
  if (!states.length) {
    return db.prepare(`
      SELECT *
      FROM issue_batches
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit).map(mapBatch);
  }

  const placeholders = states.map(() => '?').join(', ');
  return db.prepare(`
    SELECT *
    FROM issue_batches
    WHERE state IN (${placeholders})
    ORDER BY created_at ASC
    LIMIT ?
  `).all(...states, limit).map(mapBatch);
}

function listRepoIssueBatches(repoKey, limit = 50) {
  return db.prepare(`
    SELECT *
    FROM issue_batches
    WHERE repo_key = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(repoKey, limit).map(mapBatch);
}

function findOpenBatchForRepoConfig(repoKey, configFingerprint) {
  return mapBatch(db.prepare(`
    SELECT *
    FROM issue_batches
    WHERE repo_key = ?
      AND config_fingerprint = ?
      AND state IN ('batching', 'queued', 'planning', 'waiting_user', 'executing', 'blocked_quota')
    ORDER BY created_at DESC
    LIMIT 1
  `).get(repoKey, configFingerprint));
}

function updateIssueBatch(batchId, patch = {}) {
  const current = getIssueBatch(batchId);
  if (!current) return null;
  db.prepare(`
    UPDATE issue_batches
    SET state = ?,
        plan_mode = ?,
        model = ?,
        reasoning_effort = ?,
        issue_numbers_json = ?,
        metadata_json = ?,
        ready_at = ?,
        started_at = ?,
        completed_at = ?,
        error_text = ?,
        updated_at = ?
    WHERE id = ?
  `).run(
    patch.state || current.state,
    (patch.plan_mode == null ? current.plan_mode : patch.plan_mode) ? 1 : 0,
    patch.model || current.model,
    patch.reasoning_effort || current.reasoning_effort,
    JSON.stringify(patch.issue_numbers || current.issue_numbers || []),
    JSON.stringify(patch.metadata || current.metadata || {}),
    Object.prototype.hasOwnProperty.call(patch, 'ready_at') ? patch.ready_at : current.ready_at,
    Object.prototype.hasOwnProperty.call(patch, 'started_at') ? patch.started_at : current.started_at,
    Object.prototype.hasOwnProperty.call(patch, 'completed_at') ? patch.completed_at : current.completed_at,
    Object.prototype.hasOwnProperty.call(patch, 'error_text') ? patch.error_text : current.error_text,
    nowIso(),
    batchId
  );
  return getIssueBatch(batchId);
}

function createAutomationRun(record) {
  db.prepare(`
    INSERT INTO automation_runs (
      id, batch_id, repo_key, state, phase, slot_id, model, reasoning_effort, plan_mode,
      prompt_text, latest_assistant_text, commit_before, commit_after, last_error,
      started_at, completed_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.id,
    record.batch_id,
    record.repo_key,
    record.state,
    record.phase || 'execute',
    record.slot_id || null,
    record.model,
    record.reasoning_effort,
    record.plan_mode ? 1 : 0,
    record.prompt_text || null,
    record.latest_assistant_text || null,
    record.commit_before || null,
    record.commit_after || null,
    record.last_error || null,
    record.started_at || null,
    record.completed_at || null,
    nowIso(),
    nowIso()
  );
  return getAutomationRun(record.id);
}

function getAutomationRun(runId) {
  return mapRun(db.prepare('SELECT * FROM automation_runs WHERE id = ?').get(runId));
}

function updateAutomationRun(runId, patch = {}) {
  const current = getAutomationRun(runId);
  if (!current) return null;
  db.prepare(`
    UPDATE automation_runs
    SET state = ?,
        phase = ?,
        slot_id = ?,
        model = ?,
        reasoning_effort = ?,
        plan_mode = ?,
        prompt_text = ?,
        latest_assistant_text = ?,
        commit_before = ?,
        commit_after = ?,
        last_error = ?,
        started_at = ?,
        completed_at = ?,
        updated_at = ?
    WHERE id = ?
  `).run(
    patch.state || current.state,
    patch.phase || current.phase,
    Object.prototype.hasOwnProperty.call(patch, 'slot_id') ? patch.slot_id : current.slot_id,
    patch.model || current.model,
    patch.reasoning_effort || current.reasoning_effort,
    (patch.plan_mode == null ? current.plan_mode : patch.plan_mode) ? 1 : 0,
    Object.prototype.hasOwnProperty.call(patch, 'prompt_text') ? patch.prompt_text : current.prompt_text,
    Object.prototype.hasOwnProperty.call(patch, 'latest_assistant_text') ? patch.latest_assistant_text : current.latest_assistant_text,
    Object.prototype.hasOwnProperty.call(patch, 'commit_before') ? patch.commit_before : current.commit_before,
    Object.prototype.hasOwnProperty.call(patch, 'commit_after') ? patch.commit_after : current.commit_after,
    Object.prototype.hasOwnProperty.call(patch, 'last_error') ? patch.last_error : current.last_error,
    Object.prototype.hasOwnProperty.call(patch, 'started_at') ? patch.started_at : current.started_at,
    Object.prototype.hasOwnProperty.call(patch, 'completed_at') ? patch.completed_at : current.completed_at,
    nowIso(),
    runId
  );
  return getAutomationRun(runId);
}

function listActiveAutomationRuns() {
  return db.prepare(`
    SELECT *
    FROM automation_runs
    WHERE state IN ('planning', 'waiting_user', 'executing', 'queued', 'blocked_quota')
    ORDER BY created_at ASC
  `).all().map(mapRun);
}

function getActiveAutomationRunForRepo(repoKey) {
  return mapRun(db.prepare(`
    SELECT *
    FROM automation_runs
    WHERE repo_key = ?
      AND state IN ('planning', 'waiting_user', 'executing', 'queued', 'blocked_quota')
    ORDER BY created_at DESC
    LIMIT 1
  `).get(repoKey));
}

function listRepoAutomationRuns(repoKey, limit = 20) {
  return db.prepare(`
    SELECT *
    FROM automation_runs
    WHERE repo_key = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(repoKey, limit).map(mapRun);
}

function createRunEvent(record) {
  const createdAt = record.created_at || nowIso();
  const result = db.prepare(`
    INSERT INTO run_events (run_id, repo_key, event_type, payload_json, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    record.run_id,
    record.repo_key,
    record.event_type,
    JSON.stringify(record.payload || {}),
    createdAt
  );
  return {
    id: result.lastInsertRowid,
    run_id: record.run_id,
    repo_key: record.repo_key,
    event_type: record.event_type,
    payload: record.payload || {},
    created_at: createdAt
  };
}

function listRunEvents(runId, limit = 300) {
  return db.prepare(`
    SELECT *
    FROM run_events
    WHERE run_id = ?
    ORDER BY created_at ASC, id ASC
    LIMIT ?
  `).all(runId, limit).map((row) => ({
    ...row,
    payload: parseJson(row.payload_json, {})
  }));
}

function upsertIssueConfigSnapshot(record) {
  const current = getIssueConfigSnapshot(record.repo_key, record.issue_number);
  db.prepare(`
    INSERT INTO issue_config_snapshots (
      repo_key, issue_number, issue_api_id, title, issue_updated_at, body_hash, config_json,
      state, last_polled_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(repo_key, issue_number) DO UPDATE SET
      issue_api_id = excluded.issue_api_id,
      title = excluded.title,
      issue_updated_at = excluded.issue_updated_at,
      body_hash = excluded.body_hash,
      config_json = excluded.config_json,
      state = excluded.state,
      last_polled_at = excluded.last_polled_at,
      updated_at = excluded.updated_at
  `).run(
    record.repo_key,
    Number(record.issue_number),
    record.issue_api_id || null,
    record.title || null,
    record.issue_updated_at || null,
    record.body_hash || null,
    JSON.stringify(record.config || {}),
    record.state || 'open',
    record.last_polled_at || nowIso(),
    current ? current.created_at : nowIso(),
    nowIso()
  );
  return getIssueConfigSnapshot(record.repo_key, record.issue_number);
}

function getIssueConfigSnapshot(repoKey, issueNumber) {
  return mapIssueSnapshot(db.prepare(`
    SELECT *
    FROM issue_config_snapshots
    WHERE repo_key = ? AND issue_number = ?
  `).get(repoKey, Number(issueNumber)));
}

function listIssueConfigSnapshots(repoKey) {
  return db.prepare(`
    SELECT *
    FROM issue_config_snapshots
    WHERE repo_key = ?
    ORDER BY issue_number ASC
  `).all(repoKey).map(mapIssueSnapshot);
}

module.exports = {
  createAutomationRun,
  createIssueBatch,
  createRunEvent,
  findOpenBatchForRepoConfig,
  getActiveAutomationRunForRepo,
  getAutomationRun,
  getIssueBatch,
  getIssueConfigSnapshot,
  getRepoSession,
  listActiveAutomationRuns,
  listIssueBatches,
  listIssueConfigSnapshots,
  listRepoAutomationRuns,
  listRepoIssueBatches,
  listRepoSessions,
  listRunEvents,
  updateAutomationRun,
  updateIssueBatch,
  updateRepoSession,
  upsertIssueConfigSnapshot,
  upsertRepoSession
};
