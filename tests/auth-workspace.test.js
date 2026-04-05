'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildAuthBootstrapHash,
  buildAuthWorkspaceNoVncPath,
  authWorkspacePortalUrl,
  buildManagedAuthUrl
} = require('../server/auth-workspace-shared');

test('buildAuthWorkspaceNoVncPath returns tokenized noVNC path', () => {
  assert.equal(
    buildAuthWorkspaceNoVncPath('abc123token'),
    '/novnc/abc123token/?autoconnect=1&resize=remote&reconnect=1&show_dot=0&view_clip=0&quality=7&compression=7'
  );
});

test('buildAuthWorkspaceNoVncPath returns null when token missing', () => {
  assert.equal(buildAuthWorkspaceNoVncPath(''), null);
  assert.equal(buildAuthWorkspaceNoVncPath(null), null);
});

test('authWorkspacePortalUrl embeds token in hash only', () => {
  const url = authWorkspacePortalUrl('https://auth.example.com/', 'fixed_3', 'secret-token');
  assert.equal(
    url,
    'https://auth.example.com/auth-workspace/fixed_3#token=secret-token'
  );
  assert.ok(!url.includes('?token='));
});

test('buildAuthBootstrapHash encodes bootstrap payload into hash fragment', () => {
  const hash = buildAuthBootstrapHash({
    slotId: 'fixed_2',
    email: 'member@example.com',
    loginMethod: 'email',
    requestedAction: 'prefill_email'
  });
  assert.match(hash, /^codex-switcher-bootstrap=/);
});

test('buildManagedAuthUrl appends auth bootstrap hash', () => {
  const url = buildManagedAuthUrl('https://auth.openai.com/codex/device', 'member@example.com', {
    slotId: 'fixed_2',
    email: 'member@example.com',
    loginMethod: 'email',
    requestedAction: 'prefill_email'
  });
  assert.match(url, /prompt=login/);
  assert.match(url, /login_hint=member%40example\.com/);
  assert.match(url, /#codex-switcher-bootstrap=/);
});
