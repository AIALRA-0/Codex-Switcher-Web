'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONFIG_BLOCK_START = '<!-- codex-automation-config';
const CONFIG_BLOCK_END = '-->';
const SUPPORTED_MODELS = ['default', 'gpt-5.1-codex-max', 'gpt-5.1-codex-mini'];
const SUPPORTED_REASONING = ['default', 'low', 'medium', 'high', 'xhigh'];
const RUN_STATES = ['idle', 'batching', 'queued', 'planning', 'waiting_user', 'executing', 'succeeded', 'failed', 'blocked_quota'];

function buildRepoKey(owner, repo) {
  return `${String(owner || '').trim()}/${String(repo || '').trim()}`;
}

function parseRepoKey(repoKey) {
  const [owner = '', repo = ''] = String(repoKey || '').split('/');
  return { owner, repo };
}

function stableHash(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function nowIso() {
  return new Date().toISOString();
}

function clampBatchWindowMs(value, minMs, maxMs, fallbackMs) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallbackMs;
  return Math.max(minMs, Math.min(maxMs, parsed));
}

function normalizeIssueConfig(input = {}, options = {}) {
  const fillUpdatedAt = !!options.fillUpdatedAt;
  const config = {
    auto_run: input.auto_run !== false,
    plan_mode: input.plan_mode === true,
    model: SUPPORTED_MODELS.includes(String(input.model || 'default')) ? String(input.model || 'default') : 'default',
    reasoning_effort: SUPPORTED_REASONING.includes(String(input.reasoning_effort || 'default'))
      ? String(input.reasoning_effort || 'default')
      : 'default',
    last_requested_by: String(input.last_requested_by || '').trim().slice(0, 120),
    updated_at: String(input.updated_at || '').trim() || null
  };
  if (fillUpdatedAt && !config.updated_at) config.updated_at = nowIso();
  return config;
}

function extractIssueConfigBlock(body) {
  const text = String(body || '');
  const startIndex = text.indexOf(CONFIG_BLOCK_START);
  if (startIndex === -1) return null;
  const endIndex = text.indexOf(CONFIG_BLOCK_END, startIndex);
  if (endIndex === -1) return null;
  const raw = text.slice(startIndex + CONFIG_BLOCK_START.length, endIndex).trim();
  return {
    raw,
    startIndex,
    endIndex: endIndex + CONFIG_BLOCK_END.length
  };
}

function parseIssueConfig(body) {
  const block = extractIssueConfigBlock(body);
  if (!block) {
    return {
      config: normalizeIssueConfig(),
      hasConfig: false,
      raw: null
    };
  }

  try {
    const parsed = JSON.parse(block.raw);
    return {
      config: normalizeIssueConfig(parsed),
      hasConfig: true,
      raw: block.raw
    };
  } catch (_) {
    return {
      config: normalizeIssueConfig(),
      hasConfig: true,
      raw: block.raw,
      invalid: true
    };
  }
}

function stripIssueConfigBlock(body) {
  const text = String(body || '');
  const block = extractIssueConfigBlock(text);
  if (!block) return text;
  const stripped = `${text.slice(0, block.startIndex).trimEnd()}\n${text.slice(block.endIndex).trimStart()}`.trim();
  return stripped;
}

function renderIssueConfigBlock(config) {
  return `${CONFIG_BLOCK_START}
${JSON.stringify(normalizeIssueConfig(config, { fillUpdatedAt: true }), null, 2)}
-->`;
}

function renderIssueBodyWithConfig(body, config) {
  const base = stripIssueConfigBlock(body).trimEnd();
  const block = renderIssueConfigBlock(config);
  return base ? `${base}\n\n${block}\n` : `${block}\n`;
}

function buildConfigFingerprint(config) {
  const normalized = normalizeIssueConfig(config);
  return JSON.stringify({
    plan_mode: normalized.plan_mode,
    model: normalized.model,
    reasoning_effort: normalized.reasoning_effort
  });
}

function parseCodexControlCommand(text) {
  const value = String(text || '').trim();
  if (!value) return null;
  if (/^\/codex\s+approve\b/i.test(value)) {
    return { kind: 'approve', note: '' };
  }
  const reviseMatch = value.match(/^\/codex\s+revise\b([\s\S]*)$/i);
  if (reviseMatch) {
    return {
      kind: 'revise',
      note: String(reviseMatch[1] || '').trim()
    };
  }
  if (/^\/codex\s+cancel\b/i.test(value)) {
    return { kind: 'cancel', note: '' };
  }
  return null;
}

function summarizeIssueList(issues = []) {
  return issues.map((issue) => `#${issue.number}: ${issue.title}`).join('\n');
}

function buildBatchSummary(issues = []) {
  const ids = issues.map((issue) => `#${issue.number}`).join(', ');
  const titles = issues.map((issue) => String(issue.title || '').trim()).filter(Boolean);
  const firstTitle = titles[0] || 'issue batch';
  if (!ids) return firstTitle;
  if (titles.length === 1) return `${ids} ${firstTitle}`;
  return `${ids} ${firstTitle}${titles.length > 1 ? ` +${titles.length - 1}` : ''}`;
}

function sanitizeCommitSummary(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[^a-zA-Z0-9#:_./ -]/g, '')
    .slice(0, 72) || 'automation batch';
}

function shouldRolloverRepoSession(session, promptVersion) {
  if (!session) return { rollover: false, reason: '' };
  const createdAtMs = Date.parse(session.created_at || session.thread_started_at || 0);
  if (Number.isFinite(createdAtMs) && createdAtMs > 0) {
    const ageMs = Date.now() - createdAtMs;
    if (ageMs >= 14 * 24 * 60 * 60 * 1000) {
      return { rollover: true, reason: 'age_limit' };
    }
  }
  if (Number(session.batch_count || 0) >= 40) return { rollover: true, reason: 'batch_limit' };
  if (Number(session.consecutive_failures || 0) >= 2) return { rollover: true, reason: 'failure_limit' };
  if (promptVersion && session.prompt_version && session.prompt_version !== promptVersion) {
    return { rollover: true, reason: 'prompt_version_changed' };
  }
  return { rollover: false, reason: '' };
}

function pickPreferredSlot(slots = []) {
  const candidates = slots
    .filter((slot) => slot && slot.can_switch !== false && slot.requires_auth !== true)
    .map((slot) => {
      const remaining5h = Math.max(0, 100 - Number(slot.quota_5h_pct == null ? 0 : slot.quota_5h_pct));
      const remainingWeek = Math.max(0, 100 - Number(slot.quota_week_pct == null ? 0 : slot.quota_week_pct));
      const exhausted = Number(slot.quota_5h_pct || 0) >= 100 || Number(slot.quota_week_pct || 0) >= 100;
      return {
        ...slot,
        exhausted,
        remaining5h,
        remainingWeek
      };
    })
    .filter((slot) => !slot.exhausted);

  candidates.sort((a, b) => {
    if (b.remaining5h !== a.remaining5h) return b.remaining5h - a.remaining5h;
    if (b.remainingWeek !== a.remainingWeek) return b.remainingWeek - a.remainingWeek;
    return String(a.label || a.email || a.id).localeCompare(String(b.label || b.email || b.id), 'zh-Hans-CN');
  });
  return candidates[0] || null;
}

function loadPromptTemplate(name) {
  const fullPath = path.join(__dirname, '..', 'prompts', `${name}.md`);
  return fs.readFileSync(fullPath, 'utf8');
}

function renderPrompt(template, variables = {}) {
  return String(template || '').replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key) => {
    if (!Object.prototype.hasOwnProperty.call(variables, key)) return '';
    return String(variables[key] == null ? '' : variables[key]);
  });
}

module.exports = {
  CONFIG_BLOCK_END,
  CONFIG_BLOCK_START,
  RUN_STATES,
  SUPPORTED_MODELS,
  SUPPORTED_REASONING,
  buildBatchSummary,
  buildConfigFingerprint,
  buildRepoKey,
  clampBatchWindowMs,
  extractIssueConfigBlock,
  loadPromptTemplate,
  normalizeIssueConfig,
  nowIso,
  parseCodexControlCommand,
  parseIssueConfig,
  parseRepoKey,
  pickPreferredSlot,
  renderIssueBodyWithConfig,
  renderPrompt,
  sanitizeCommitSummary,
  shouldRolloverRepoSession,
  stableHash,
  stripIssueConfigBlock,
  summarizeIssueList
};
