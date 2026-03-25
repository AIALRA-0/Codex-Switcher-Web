'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildManagedAuthUrl } = require('../server/auth-link');

test('buildManagedAuthUrl adds login prompt and login_hint', () => {
  const url = buildManagedAuthUrl('https://auth.openai.com/codex/device', 'target@example.com');
  assert.match(url, /^https:\/\/auth\.openai\.com\/codex\/device\?/);
  assert.match(url, /prompt=login/);
  assert.match(url, /max_age=0/);
  assert.match(url, /login_hint=target%40example\.com/);
});

test('buildManagedAuthUrl falls back to default device url', () => {
  const url = buildManagedAuthUrl('', 'slot@example.com');
  assert.match(url, /^https:\/\/auth\.openai\.com\/codex\/device\?/);
  assert.match(url, /login_hint=slot%40example\.com/);
});
