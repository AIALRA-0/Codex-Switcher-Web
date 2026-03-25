'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-0123456789';
process.env.CODEX_PROFILE_ENCRYPTION_KEY = process.env.CODEX_PROFILE_ENCRYPTION_KEY || 'test-profile-secret-0123456789';
process.env.CODEX_AGENT_SHARED_SECRET = process.env.CODEX_AGENT_SHARED_SECRET || 'test-agent-secret-0123456789';

const {
  normalizeWhamUsagePayload,
  parseDeviceAuthOutput,
  validateExpectedAccountId,
  validateExpectedIdentityKey
} = require('../server/agent');
const {
  buildDuplicateBootstrapMessage,
  buildDuplicateProfileMessage,
  buildProfileEmailMismatchMessage
} = require('../server/service');
const db = require('../server/db');

test('validateExpectedAccountId returns parsed account id', () => {
  const accountId = validateExpectedAccountId(JSON.stringify({
    tokens: {
      account_id: 'acct_123'
    }
  }), 'acct_123');
  assert.equal(accountId, 'acct_123');
});

test('validateExpectedAccountId throws on mismatch', () => {
  assert.throws(() => {
    validateExpectedAccountId(JSON.stringify({
      tokens: {
        account_id: 'acct_123'
      }
    }), 'acct_456');
  }, /ACCOUNT_ID_MISMATCH/);
});

test('validateExpectedIdentityKey returns parsed identity key', () => {
  const identityKey = validateExpectedIdentityKey(JSON.stringify({
    tokens: {
      account_id: 'acct_123',
      access_token: 'x'
    }
  }), null);
  assert.equal(identityKey, null);
});

test('validateExpectedIdentityKey throws on mismatch', () => {
  const authJson = JSON.stringify({
    tokens: {
      account_id: 'acct_123',
      id_token: [
        Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url'),
        Buffer.from(JSON.stringify({ sub: 'auth0|user_1', email: 'slot@example.com' })).toString('base64url'),
        ''
      ].join('.')
    }
  });
  assert.throws(() => {
    validateExpectedIdentityKey(authJson, 'auth0|other');
  }, /IDENTITY_KEY_MISMATCH/);
});

test('parseDeviceAuthOutput captures device code and awaiting state', () => {
  const session = {
    logTail: '',
    verificationUri: null,
    deviceCode: null,
    status: 'starting'
  };

  parseDeviceAuthOutput(session, `
Open this link in your browser and sign in to your account
https://auth.openai.com/codex/device

Enter this one-time code (expires in 15 minutes)
7OR1-VASIZ

Device codes are a common phishing target. Never share this code.
`);

  assert.equal(session.verificationUri, 'https://auth.openai.com/codex/device');
  assert.equal(session.deviceCode, '7OR1-VASIZ');
  assert.equal(session.status, 'awaiting_user');
});

test('parseDeviceAuthOutput strips ansi escapes and still captures device code', () => {
  const session = {
    logTail: '',
    verificationUri: null,
    deviceCode: null,
    status: 'starting'
  };

  parseDeviceAuthOutput(session, `
Welcome to Codex [v\u001b[90m0.104.0\u001b[0m]
\u001b[90mOpenAI's command-line coding agent\u001b[0m

1. Open this link in your browser and sign in to your account
   \u001b[94mhttps://auth.openai.com/codex/device\u001b[0m

2. Enter this one-time code \u001b[90m(expires in 15 minutes)\u001b[0m
   \u001b[94m9TOV-RQBFV\u001b[0m

\u001b[90mDevice codes are a common phishing target. Never share this code.\u001b[0m
`);

  assert.equal(session.verificationUri, 'https://auth.openai.com/codex/device');
  assert.equal(session.deviceCode, '9TOV-RQBFV');
  assert.equal(session.status, 'awaiting_user');
  assert.ok(!session.logTail.includes('\u001b['));
});

test('normalizeWhamUsagePayload maps backend usage windows', () => {
  const normalized = normalizeWhamUsagePayload({
    account_id: 'acct_live',
    email: 'slot@example.com',
    plan_type: 'team',
    rate_limit: {
      primary_window: {
        used_percent: 63,
        limit_window_seconds: 18000,
        reset_at: 1774107961
      },
      secondary_window: {
        used_percent: 44,
        limit_window_seconds: 604800,
        reset_at: 1774638001
      }
    }
  });

  assert.equal(normalized.parserStatus, 'ok');
  assert.equal(normalized.accountId, 'acct_live');
  assert.equal(normalized.email, 'slot@example.com');
  assert.equal(normalized.planType, 'team');
  assert.equal(normalized.fiveHour.pct, 63);
  assert.equal(normalized.fiveHour.resetAt, '2026-03-21T15:46:01.000Z');
  assert.equal(normalized.week.pct, 44);
  assert.equal(normalized.week.resetAt, '2026-03-27T19:00:01.000Z');
});

test('normalizeWhamUsagePayload supports windows arrays from backend variants', () => {
  const normalized = normalizeWhamUsagePayload({
    account_id: 'acct_variant',
    email: 'variant@example.com',
    plan_type: 'pro',
    rateLimit: {
      windows: [
        {
          usedPercent: 12,
          limit_window_seconds: 18000,
          reset_at: 1774207961
        },
        {
          usedPercent: 67,
          limit_window_seconds: 604800,
          reset_at: 1774638001
        }
      ]
    }
  });

  assert.equal(normalized.parserStatus, 'ok');
  assert.equal(normalized.fiveHour.pct, 12);
  assert.equal(normalized.week.pct, 67);
});

test('normalizeWhamUsagePayload returns unknown when no usable windows exist', () => {
  const normalized = normalizeWhamUsagePayload({
    account_id: 'acct_empty',
    email: 'empty@example.com',
    plan_type: 'free'
  });

  assert.equal(normalized.parserStatus, 'unknown');
  assert.equal(normalized.fiveHour, null);
  assert.equal(normalized.week, null);
});

test('db exports completeSwitchEvent', () => {
  assert.equal(typeof db.completeSwitchEvent, 'function');
});

test('buildProfileEmailMismatchMessage explains expected and actual emails', () => {
  assert.equal(
    buildProfileEmailMismatchMessage({ email: 'Slot@Example.com' }, 'Actual@Example.com'),
    'PROFILE_EMAIL_MISMATCH: expected slot@example.com, got actual@example.com'
  );
});

test('buildDuplicateProfileMessage explains duplicate account binding', () => {
  assert.match(
    buildDuplicateProfileMessage('user_live', { email: 'primary@example.com' }, { email: 'shadow@example.com' }),
    /DUPLICATE_PROFILE_IDENTITY: shadow@example\.com 与 primary@example\.com 绑定到了同一个成员身份 user_live/
  );
});

test('buildDuplicateBootstrapMessage reports captured wrong email instead of duplicate slot label', () => {
  assert.equal(
    buildDuplicateBootstrapMessage(
      { email: 'target@example.com' },
      { email: 'existing@example.com' },
      { email: 'other@example.com', accountId: 'acct_163' }
    ),
    '当前授权得到的是 other@example.com，account_id 为 acct_163，它当前对应的受管账号是 existing@example.com，不是目标账号 target@example.com。系统已刷新新的设备码；请重新打开认证页并使用 target@example.com 完成授权。'
  );
});

test('buildDuplicateBootstrapMessage explains linked-account collisions without auto-retry wording', () => {
  assert.equal(
    buildDuplicateBootstrapMessage(
      { email: 'target@example.com' },
      { email: 'existing@example.com' },
      { email: 'target@example.com', accountId: 'acct_shared' }
    ),
    '当前授权得到的邮箱是 target@example.com，但它返回的 OpenAI account_id acct_shared 已经绑定在 existing@example.com。这通常说明这个登录入口和 existing@example.com 指向同一个 OpenAI 账号；系统已停止自动重试，请确认你要绑定的是一个独立账号。'
  );
});
