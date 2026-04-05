'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildConfigFingerprint,
  normalizeIssueConfig,
  parseCodexControlCommand,
  parseIssueConfig,
  renderIssueBodyWithConfig,
  shouldRolloverRepoSession
} = require('../server/automation-helpers');

test('issue config round-trips through hidden block', () => {
  const body = 'Please fix this bug.';
  const rendered = renderIssueBodyWithConfig(body, {
    auto_run: false,
    plan_mode: true,
    model: 'gpt-5.1-codex-max',
    reasoning_effort: 'high',
    last_requested_by: 'alice'
  });

  const parsed = parseIssueConfig(rendered);
  assert.equal(parsed.hasConfig, true);
  assert.equal(parsed.config.auto_run, false);
  assert.equal(parsed.config.plan_mode, true);
  assert.equal(parsed.config.model, 'gpt-5.1-codex-max');
  assert.equal(parsed.config.reasoning_effort, 'high');
});

test('config fingerprint only depends on merge-relevant fields', () => {
  const left = buildConfigFingerprint(normalizeIssueConfig({
    plan_mode: true,
    model: 'gpt-5.1-codex-max',
    reasoning_effort: 'high',
    last_requested_by: 'alice'
  }));
  const right = buildConfigFingerprint(normalizeIssueConfig({
    plan_mode: true,
    model: 'gpt-5.1-codex-max',
    reasoning_effort: 'high',
    last_requested_by: 'bob'
  }));
  assert.equal(left, right);
});

test('codex control commands parse correctly', () => {
  assert.deepEqual(parseCodexControlCommand('/codex approve'), { kind: 'approve', note: '' });
  assert.deepEqual(parseCodexControlCommand('/codex cancel'), { kind: 'cancel', note: '' });
  assert.deepEqual(parseCodexControlCommand('/codex revise please split this into two commits'), {
    kind: 'revise',
    note: 'please split this into two commits'
  });
  assert.equal(parseCodexControlCommand('hello world'), null);
});

test('repo session rollover triggers on prompt version drift and failures', () => {
  const base = {
    created_at: new Date().toISOString(),
    batch_count: 0,
    consecutive_failures: 0,
    prompt_version: 'v1'
  };

  assert.deepEqual(shouldRolloverRepoSession(base, 'v1'), { rollover: false, reason: '' });
  assert.deepEqual(shouldRolloverRepoSession({ ...base, prompt_version: 'v0' }, 'v1'), {
    rollover: true,
    reason: 'prompt_version_changed'
  });
  assert.deepEqual(shouldRolloverRepoSession({ ...base, consecutive_failures: 2 }, 'v1'), {
    rollover: true,
    reason: 'failure_limit'
  });
});
