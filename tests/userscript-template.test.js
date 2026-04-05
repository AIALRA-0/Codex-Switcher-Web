'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildUserscript } = require('../server/userscript-template');

const baseConfig = {
  appUrl: 'https://codex.example.com',
  codeWorkspaceUrl: 'https://code.example.com/?workspace=/workspace/default.code-workspace',
  authDeviceUrl: 'https://auth.openai.com/codex/device',
  browserPollIntervalMs: 5000,
  quotaSampleIntervalMs: 120000
};

test('buildUserscript includes google, email, and device-code auth automation paths', () => {
  const script = buildUserscript(baseConfig);
  assert.match(script, /Continue with Google/);
  assert.match(script, /input\[type="email"\]/);
  assert.match(script, /input\[name\^="character_"\]/);
  assert.match(script, /pending\.requestedAction === 'fill_device_code'/);
  assert.match(script, /form\[action\*="\/deviceauth\/authorize_code"\]/);
  assert.match(script, /input\[name="user_code_text"\]/);
  assert.match(script, /form\[aria-label="Pick a log in option"\]/);
  assert.doesNotMatch(script, /clickLoginIfPossible/);
});
