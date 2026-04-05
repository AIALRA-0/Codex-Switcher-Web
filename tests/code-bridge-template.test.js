'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildCodeBridge } = require('../server/code-bridge-template');

test('buildCodeBridge includes bidirectional recovery endpoints and actions', () => {
  const script = buildCodeBridge();

  assert.ok(script.includes('/_codex_switcher/api'));
  assert.ok(script.includes('/events/stream?sessionId='));
  assert.ok(script.includes('/actions/'));
  assert.ok(script.includes('/ack'));
  assert.ok(script.includes('recover_same_thread'));
  assert.ok(script.includes('resume_prompt'));
  assert.ok(script.includes('open_new_thread_and_resume'));
  assert.ok(script.includes('blocked_all_accounts'));
  assert.ok(script.includes('activeAuthGenerationSeen'));
});
