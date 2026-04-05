'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const SERVER_DIR = path.join(__dirname, '..', 'server');
const CONFIG_PATH = path.join(SERVER_DIR, 'config.js');
const AUDIT_PATH = path.join(SERVER_DIR, 'audit.js');
const DB_PATH = path.join(SERVER_DIR, 'db.js');
const SECURITY_PATH = path.join(SERVER_DIR, 'security.js');
const SERVICE_PATH = path.join(SERVER_DIR, 'service.js');
const AGENT_CLIENT_PATH = path.join(SERVER_DIR, 'agent-client.js');

function clearServerModules() {
  for (const modulePath of [SERVICE_PATH, DB_PATH, SECURITY_PATH, AUDIT_PATH, CONFIG_PATH, AGENT_CLIENT_PATH]) {
    delete require.cache[modulePath];
  }
}

function restoreEnv(previous) {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function waitFor(predicate, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const attempt = () => {
      try {
        if (predicate()) {
          resolve();
          return;
        }
      } catch (error) {
        reject(error);
        return;
      }
      if ((Date.now() - startedAt) >= timeoutMs) {
        reject(new Error('WAIT_TIMEOUT'));
        return;
      }
      setTimeout(attempt, 25);
    };
    attempt();
  });
}

function buildUsage({ accountId, identityKey, email, fiveHourPct, weekPct, planType = 'team' }) {
  const observedAt = new Date().toISOString();
  return {
    usage: {
      parserStatus: 'ok',
      accountId,
      email,
      planType,
      fiveHour: {
        pct: fiveHourPct,
        resetAt: observedAt,
        resetLabel: '5h'
      },
      week: {
        pct: weekPct,
        resetAt: observedAt,
        resetLabel: '7d'
      }
    },
    observedAt,
    accountId,
    identityKey,
    email,
    planType
  };
}

function withIsolatedRuntime(run) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-switcher-auto-switch-'));
  const envPatch = {
    DB_PATH: path.join(tempDir, 'codex-switcher.db'),
    AUDIT_LOG_PATH: path.join(tempDir, 'audit.log'),
    SESSION_SECRET: 'test-session-secret',
    CODEX_PROFILE_ENCRYPTION_KEY: 'test-profile-key-1234567890',
    CODEX_AGENT_SHARED_SECRET: 'test-agent-secret-1234567890',
    AUTO_SWITCH_ENABLED: 'false',
    COOKIE_DOMAIN: '',
    COOKIE_SECURE: 'false',
    APP_URL: 'http://127.0.0.1:29999',
    PORT: '29999',
    HOST: '127.0.0.1'
  };
  const previousEnv = {};
  for (const [key, value] of Object.entries(envPatch)) {
    previousEnv[key] = process.env[key];
    process.env[key] = value;
  }

  clearServerModules();

  const usageByAccountId = new Map();
  const usageByIdentityKey = new Map();
  const agentBehavior = {
    activateProfile: null,
    getLoginStatus: null,
    getUsageStatus: null,
    getUsageForProfile: null,
    logoutActiveAuth: null,
    startDeviceAuth: null,
    getBootstrapStatus: null,
    cancelBootstrap: null,
    captureAuthProfile: null,
    rollbackProfile: null,
    startAuthWorkspace: null,
    resetAuthWorkspace: null,
    stopAuthWorkspace: null,
    updateAuthWorkspaceState: null,
    getAuthWorkspaceStatus: null,
    runAuthWorkspaceAction: null
  };

  const agentStub = {
    behavior: agentBehavior,
    setUsage(identity = {}, usage) {
      const accountId = identity.accountId || identity.account_id || null;
      const identityKey = identity.identityKey || identity.identity_key || null;
      if (accountId) usageByAccountId.set(accountId, usage);
      if (identityKey) usageByIdentityKey.set(identityKey, usage);
    },
    async activateProfile(input) {
      if (agentBehavior.activateProfile) return agentBehavior.activateProfile(input);
      return {
        accountId: input.expectedAccountId || 'acct_unknown',
        identityKey: input.expectedIdentityKey || null
      };
    },
    async getLoginStatus() {
      if (agentBehavior.getLoginStatus) return agentBehavior.getLoginStatus();
      const db = require(DB_PATH);
      const activeSlot = db.getActiveSlot();
      if (!activeSlot) return { tokens: {} };
      const activeProfile = activeSlot.active_auth_profile_id
        ? db.getAuthProfileById(activeSlot.active_auth_profile_id)
        : db.getPrimaryAuthProfileForSlot(activeSlot.id);
      return {
        tokens: {
          account_id: (activeProfile && activeProfile.account_id) || activeSlot.account_id || null
        },
        identityKey: (activeProfile && activeProfile.identity_key) || activeSlot.identity_key || null,
        email: activeSlot.email || null
      };
    },
    async getUsageStatus() {
      if (agentBehavior.getUsageStatus) return agentBehavior.getUsageStatus();
      const db = require(DB_PATH);
      const activeSlot = db.getActiveSlot();
      if (!activeSlot) throw new Error('NO_ACTIVE_SLOT');
      const activeProfile = activeSlot.active_auth_profile_id
        ? db.getAuthProfileById(activeSlot.active_auth_profile_id)
        : db.getPrimaryAuthProfileForSlot(activeSlot.id);
      const accountId = (activeProfile && activeProfile.account_id) || activeSlot.account_id || null;
      const identityKey = (activeProfile && activeProfile.identity_key) || activeSlot.identity_key || null;
      const usage = (accountId && usageByAccountId.get(accountId)) || (identityKey && usageByIdentityKey.get(identityKey));
      if (!usage) throw new Error('MISSING_ACTIVE_USAGE');
      return usage;
    },
    async getUsageForProfile(input) {
      if (agentBehavior.getUsageForProfile) return agentBehavior.getUsageForProfile(input);
      const accountId = input.expectedAccountId || null;
      const identityKey = input.expectedIdentityKey || null;
      const usage = (accountId && usageByAccountId.get(accountId)) || (identityKey && usageByIdentityKey.get(identityKey));
      if (!usage) throw new Error('MISSING_PROFILE_USAGE');
      return usage;
    },
    async logoutActiveAuth() {
      if (agentBehavior.logoutActiveAuth) return agentBehavior.logoutActiveAuth();
      return { ok: true };
    },
    async startDeviceAuth() {
      if (agentBehavior.startDeviceAuth) return agentBehavior.startDeviceAuth();
      throw new Error('NOT_IMPLEMENTED_IN_TEST');
    },
    async getBootstrapStatus() {
      if (agentBehavior.getBootstrapStatus) return agentBehavior.getBootstrapStatus();
      throw new Error('NOT_IMPLEMENTED_IN_TEST');
    },
    async cancelBootstrap() {
      if (agentBehavior.cancelBootstrap) return agentBehavior.cancelBootstrap();
      throw new Error('NOT_IMPLEMENTED_IN_TEST');
    },
    async captureAuthProfile() {
      if (agentBehavior.captureAuthProfile) return agentBehavior.captureAuthProfile();
      throw new Error('NOT_IMPLEMENTED_IN_TEST');
    },
    async rollbackProfile() {
      if (agentBehavior.rollbackProfile) return agentBehavior.rollbackProfile();
      throw new Error('NOT_IMPLEMENTED_IN_TEST');
    },
    async startAuthWorkspace() {
      if (agentBehavior.startAuthWorkspace) return agentBehavior.startAuthWorkspace();
      throw new Error('NOT_IMPLEMENTED_IN_TEST');
    },
    async resetAuthWorkspace() {
      if (agentBehavior.resetAuthWorkspace) return agentBehavior.resetAuthWorkspace();
      throw new Error('NOT_IMPLEMENTED_IN_TEST');
    },
    async stopAuthWorkspace() {
      if (agentBehavior.stopAuthWorkspace) return agentBehavior.stopAuthWorkspace();
      throw new Error('NOT_IMPLEMENTED_IN_TEST');
    },
    async updateAuthWorkspaceState() {
      if (agentBehavior.updateAuthWorkspaceState) return agentBehavior.updateAuthWorkspaceState();
      throw new Error('NOT_IMPLEMENTED_IN_TEST');
    },
    async getAuthWorkspaceStatus() {
      if (agentBehavior.getAuthWorkspaceStatus) return agentBehavior.getAuthWorkspaceStatus();
      throw new Error('NOT_IMPLEMENTED_IN_TEST');
    },
    async runAuthWorkspaceAction() {
      if (agentBehavior.runAuthWorkspaceAction) return agentBehavior.runAuthWorkspaceAction();
      throw new Error('NOT_IMPLEMENTED_IN_TEST');
    }
  };

  require.cache[AGENT_CLIENT_PATH] = {
    id: AGENT_CLIENT_PATH,
    filename: AGENT_CLIENT_PATH,
    loaded: true,
    exports: agentStub
  };

  const security = require(SECURITY_PATH);
  const db = require(DB_PATH);
  const service = require(SERVICE_PATH);
  db.seedDefaultSlots();
  for (const slot of db.listSlots()) {
    db.deleteAccount(slot.id);
  }

  return Promise.resolve()
    .then(() => run({ tempDir, db, service, security, agentStub }))
    .finally(() => {
      clearServerModules();
      restoreEnv(previousEnv);
      fs.rmSync(tempDir, { recursive: true, force: true });
    });
}

function createManagedAccount(db, security, options) {
  const slot = db.createAccount({
    id: options.slotId,
    label: options.label,
    email: options.email,
    login_method: options.loginMethod || 'google',
    expires_at: options.expiresAt || '2026-12-31',
    state: options.state || 'ready'
  });
  const profile = db.createAuthProfile({
    id: options.authProfileId,
    slot_id: slot.id,
    workspace_label: options.workspaceLabel || '主认证',
    auth_cipher: security.encryptString(JSON.stringify({
      account_id: options.accountId,
      identity_key: options.identityKey,
      workspace: options.workspaceLabel || '主认证'
    })),
    account_id: options.accountId,
    identity_key: options.identityKey,
    is_primary: true,
    is_active: !!options.isActive,
    freshness: 'live',
    quota_5h_pct: options.fiveHourPct,
    quota_5h_reset_at: '2026-04-01T05:00:00.000Z',
    quota_5h_reset_label: '5h',
    quota_week_pct: options.weekPct,
    quota_week_reset_at: '2026-04-08T05:00:00.000Z',
    quota_week_reset_label: '7d',
    last_seen_at: '2026-04-01T00:00:00.000Z'
  });
  db.syncSlotAuthAggregate(slot.id);
  if (options.isActive) db.setActiveSlot(slot.id, profile.id, '2026-04-01T00:00:00.000Z');
  return {
    slot: db.getSlotById(slot.id),
    profile: db.getAuthProfileById(profile.id)
  };
}

test('maybeAutoSwitch moves to the best remaining account when active quota is exhausted', async () => {
  await withIsolatedRuntime(async ({ db, service, security, agentStub }) => {
    service.updateRuntimeSettings({ auto_switch_enabled: true });

    const active = createManagedAccount(db, security, {
      slotId: 'account_active',
      authProfileId: 'auth_active',
      label: '活动账号',
      email: 'active@example.com',
      accountId: 'acct_active',
      identityKey: 'ident_active',
      fiveHourPct: 100,
      weekPct: 30,
      isActive: true
    });
    const candidateLow = createManagedAccount(db, security, {
      slotId: 'account_low',
      authProfileId: 'auth_low',
      label: '普通候选',
      email: 'low@example.com',
      accountId: 'acct_low',
      identityKey: 'ident_low',
      fiveHourPct: 60,
      weekPct: 80
    });
    const candidateBest = createManagedAccount(db, security, {
      slotId: 'account_best',
      authProfileId: 'auth_best',
      label: '最佳候选',
      email: 'best@example.com',
      accountId: 'acct_best',
      identityKey: 'ident_best',
      fiveHourPct: 10,
      weekPct: 20
    });

    agentStub.setUsage(active.profile, buildUsage({
      accountId: active.profile.account_id,
      identityKey: active.profile.identity_key,
      email: active.slot.email,
      fiveHourPct: 100,
      weekPct: 30
    }));
    agentStub.setUsage(candidateLow.profile, buildUsage({
      accountId: candidateLow.profile.account_id,
      identityKey: candidateLow.profile.identity_key,
      email: candidateLow.slot.email,
      fiveHourPct: 60,
      weekPct: 80
    }));
    agentStub.setUsage(candidateBest.profile, buildUsage({
      accountId: candidateBest.profile.account_id,
      identityKey: candidateBest.profile.identity_key,
      email: candidateBest.slot.email,
      fiveHourPct: 10,
      weekPct: 20
    }));

    const result = await service.maybeAutoSwitch();
    assert.equal(result.state, 'queued');
    assert.equal(result.targetSlotId, candidateBest.slot.id);
    assert.equal(result.targetAuthProfileId, candidateBest.profile.id);

    await waitFor(() => {
      const currentActive = db.getActiveSlot();
      return currentActive && currentActive.id === candidateBest.slot.id;
    });

    const currentActive = db.getActiveSlot();
    const snapshot = await service.buildRuntimeSnapshot();
    assert.equal(currentActive.id, candidateBest.slot.id);
    assert.equal(currentActive.active_auth_profile_id, candidateBest.profile.id);
    assert.ok(!snapshot.autoSwitchStatus);
    assert.deepEqual(snapshot.alerts, []);
  });
});

test('maybeAutoSwitch persists a no-candidate alert when every remaining account is exhausted', async () => {
  await withIsolatedRuntime(async ({ db, service, security, agentStub }) => {
    service.updateRuntimeSettings({ auto_switch_enabled: true });

    const active = createManagedAccount(db, security, {
      slotId: 'account_active_empty',
      authProfileId: 'auth_active_empty',
      label: '活动账号',
      email: 'active-empty@example.com',
      accountId: 'acct_active_empty',
      identityKey: 'ident_active_empty',
      fiveHourPct: 100,
      weekPct: 45,
      isActive: true
    });
    const exhaustedCandidate = createManagedAccount(db, security, {
      slotId: 'account_exhausted_candidate',
      authProfileId: 'auth_exhausted_candidate',
      label: '不可切换账号',
      email: 'exhausted@example.com',
      accountId: 'acct_exhausted_candidate',
      identityKey: 'ident_exhausted_candidate',
      fiveHourPct: 50,
      weekPct: 100
    });

    agentStub.setUsage(active.profile, buildUsage({
      accountId: active.profile.account_id,
      identityKey: active.profile.identity_key,
      email: active.slot.email,
      fiveHourPct: 100,
      weekPct: 45
    }));
    agentStub.setUsage(exhaustedCandidate.profile, buildUsage({
      accountId: exhaustedCandidate.profile.account_id,
      identityKey: exhaustedCandidate.profile.identity_key,
      email: exhaustedCandidate.slot.email,
      fiveHourPct: 50,
      weekPct: 100
    }));

    const result = await service.maybeAutoSwitch();
    assert.equal(result.state, 'no_candidate');

    const currentActive = db.getActiveSlot();
    const snapshot = await service.buildRuntimeSnapshot();
    assert.equal(currentActive.id, active.slot.id);
    assert.equal(snapshot.autoSwitchStatus.state, 'no_candidate');
    assert.equal(snapshot.autoSwitchStatus.active_slot_id, active.slot.id);
    assert.equal(snapshot.alerts.length, 1);
    assert.equal(snapshot.alerts[0].kind, 'no_available_quota');
    assert.match(snapshot.alerts[0].message, /没有找到同时满足 5 小时额度和 1 周额度都大于 0/i);
  });
});

test('create_workspace bootstrap fails when captured identity already exists in the same slot', async () => {
  await withIsolatedRuntime(async ({ db, service, security, agentStub }) => {
    const managed = createManagedAccount(db, security, {
      slotId: 'account_workspace_dup',
      authProfileId: 'auth_workspace_dup',
      label: '重复工作区账号',
      email: 'dup@example.com',
      accountId: 'acct_dup',
      identityKey: 'ident_dup',
      fiveHourPct: 25,
      weekPct: 25
    });

    db.createBootstrapSession({
      id: 'bootstrap_workspace_dup',
      slot_id: managed.slot.id,
      status: 'awaiting_user',
      email: managed.slot.email,
      login_method: managed.slot.login_method,
      workspace_label: '客户 A',
      intent: 'create_workspace'
    });

    agentStub.behavior.getBootstrapStatus = async () => ({
      status: 'succeeded',
      logTail: 'done'
    });
    agentStub.behavior.captureAuthProfile = async () => ({
      authJson: JSON.stringify({ tokens: { account_id: managed.profile.account_id } }),
      accountId: managed.profile.account_id,
      identityKey: managed.profile.identity_key,
      email: managed.slot.email
    });

    await service.syncPendingBootstrapSessions();

    const session = db.getBootstrapSession('bootstrap_workspace_dup');
    const profiles = db.listAuthProfilesForSlot(managed.slot.id);
    assert.equal(session.status, 'failed');
    assert.match(session.error_text, /^WORKSPACE_ALREADY_EXISTS:/);
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0].workspace_label, '主认证');
  });
});

test('reauth_workspace bootstrap fails when captured identity belongs to another workspace in the same slot', async () => {
  await withIsolatedRuntime(async ({ db, service, security, agentStub }) => {
    const managed = createManagedAccount(db, security, {
      slotId: 'account_workspace_reauth',
      authProfileId: 'auth_workspace_primary',
      label: '重认证账号',
      email: 'reauth@example.com',
      accountId: 'acct_primary',
      identityKey: 'ident_primary',
      fiveHourPct: 20,
      weekPct: 20
    });

    const secondary = db.createAuthProfile({
      id: 'auth_workspace_secondary',
      slot_id: managed.slot.id,
      workspace_label: '客户 B',
      auth_cipher: security.encryptString(JSON.stringify({
        account_id: 'acct_secondary',
        identity_key: 'ident_secondary'
      })),
      account_id: 'acct_secondary',
      identity_key: 'ident_secondary',
      is_primary: false,
      is_active: false,
      freshness: 'live',
      quota_5h_pct: 10,
      quota_5h_reset_at: '2026-04-01T05:00:00.000Z',
      quota_5h_reset_label: '5h',
      quota_week_pct: 10,
      quota_week_reset_at: '2026-04-08T05:00:00.000Z',
      quota_week_reset_label: '7d',
      last_seen_at: '2026-04-01T00:00:00.000Z'
    });
    db.syncSlotAuthAggregate(managed.slot.id);

    db.createBootstrapSession({
      id: 'bootstrap_workspace_reauth',
      slot_id: managed.slot.id,
      status: 'awaiting_user',
      email: managed.slot.email,
      login_method: managed.slot.login_method,
      auth_profile_id: secondary.id,
      workspace_label: secondary.workspace_label,
      intent: 'reauth_workspace'
    });

    agentStub.behavior.getBootstrapStatus = async () => ({
      status: 'succeeded',
      logTail: 'done'
    });
    agentStub.behavior.captureAuthProfile = async () => ({
      authJson: JSON.stringify({ tokens: { account_id: managed.profile.account_id } }),
      accountId: managed.profile.account_id,
      identityKey: managed.profile.identity_key,
      email: managed.slot.email
    });

    await service.syncPendingBootstrapSessions();

    const session = db.getBootstrapSession('bootstrap_workspace_reauth');
    const refreshedSecondary = db.getAuthProfileById(secondary.id);
    assert.equal(session.status, 'failed');
    assert.match(session.error_text, /^WORKSPACE_REAUTH_TARGET_MISMATCH:/);
    assert.equal(refreshedSecondary.identity_key, 'ident_secondary');
  });
});

test('logoutSlot promotes the first remaining workspace when deleting the primary workspace', async () => {
  await withIsolatedRuntime(async ({ db, service, security }) => {
    const managed = createManagedAccount(db, security, {
      slotId: 'account_primary_delete',
      authProfileId: 'auth_primary_delete',
      label: '删除主认证账号',
      email: 'delete-primary@example.com',
      accountId: 'acct_primary_delete',
      identityKey: 'ident_primary_delete',
      fiveHourPct: 30,
      weekPct: 30
    });

    const promoted = db.createAuthProfile({
      id: 'auth_promoted_first',
      slot_id: managed.slot.id,
      workspace_label: 'A 工作区',
      auth_cipher: security.encryptString(JSON.stringify({
        account_id: 'acct_promoted_first',
        identity_key: 'ident_promoted_first'
      })),
      account_id: 'acct_promoted_first',
      identity_key: 'ident_promoted_first',
      is_primary: false,
      is_active: false,
      freshness: 'live'
    });

    db.createAuthProfile({
      id: 'auth_promoted_second',
      slot_id: managed.slot.id,
      workspace_label: 'Z 工作区',
      auth_cipher: security.encryptString(JSON.stringify({
        account_id: 'acct_promoted_second',
        identity_key: 'ident_promoted_second'
      })),
      account_id: 'acct_promoted_second',
      identity_key: 'ident_promoted_second',
      is_primary: false,
      is_active: false,
      freshness: 'live'
    });

    await service.logoutSlot(managed.slot.id, { authProfileId: managed.profile.id });

    const primary = db.getPrimaryAuthProfileForSlot(managed.slot.id);
    assert.equal(primary.id, promoted.id);
    assert.equal(primary.workspace_label, 'A 工作区');
  });
});

test('maybeAutoSwitch prefers the primary workspace inside the selected candidate account', async () => {
  await withIsolatedRuntime(async ({ db, service, security, agentStub }) => {
    service.updateRuntimeSettings({ auto_switch_enabled: true });

    const active = createManagedAccount(db, security, {
      slotId: 'account_active_prefer_primary',
      authProfileId: 'auth_active_prefer_primary',
      label: '活动账号',
      email: 'active-prefer@example.com',
      accountId: 'acct_active_prefer_primary',
      identityKey: 'ident_active_prefer_primary',
      fiveHourPct: 100,
      weekPct: 50,
      isActive: true
    });

    const candidate = createManagedAccount(db, security, {
      slotId: 'account_candidate_prefer_primary',
      authProfileId: 'auth_candidate_primary',
      label: '候选账号',
      email: 'candidate@example.com',
      accountId: 'acct_candidate_primary',
      identityKey: 'ident_candidate_primary',
      fiveHourPct: 60,
      weekPct: 60
    });

    const strongerSecondary = db.createAuthProfile({
      id: 'auth_candidate_secondary',
      slot_id: candidate.slot.id,
      workspace_label: 'B 工作区',
      auth_cipher: security.encryptString(JSON.stringify({
        account_id: 'acct_candidate_secondary',
        identity_key: 'ident_candidate_secondary'
      })),
      account_id: 'acct_candidate_secondary',
      identity_key: 'ident_candidate_secondary',
      is_primary: false,
      is_active: false,
      freshness: 'live',
      quota_5h_pct: 10,
      quota_5h_reset_at: '2026-04-01T05:00:00.000Z',
      quota_5h_reset_label: '5h',
      quota_week_pct: 10,
      quota_week_reset_at: '2026-04-08T05:00:00.000Z',
      quota_week_reset_label: '7d',
      last_seen_at: '2026-04-01T00:00:00.000Z'
    });
    db.syncSlotAuthAggregate(candidate.slot.id);

    const otherCandidate = createManagedAccount(db, security, {
      slotId: 'account_other_candidate',
      authProfileId: 'auth_other_candidate',
      label: '其他候选',
      email: 'other@example.com',
      accountId: 'acct_other_candidate',
      identityKey: 'ident_other_candidate',
      fiveHourPct: 50,
      weekPct: 50
    });

    agentStub.setUsage(active.profile, buildUsage({
      accountId: active.profile.account_id,
      identityKey: active.profile.identity_key,
      email: active.slot.email,
      fiveHourPct: 100,
      weekPct: 50
    }));
    agentStub.setUsage(candidate.profile, buildUsage({
      accountId: candidate.profile.account_id,
      identityKey: candidate.profile.identity_key,
      email: candidate.slot.email,
      fiveHourPct: 60,
      weekPct: 60
    }));
    agentStub.setUsage(strongerSecondary, buildUsage({
      accountId: strongerSecondary.account_id,
      identityKey: strongerSecondary.identity_key,
      email: candidate.slot.email,
      fiveHourPct: 10,
      weekPct: 10
    }));
    agentStub.setUsage(otherCandidate.profile, buildUsage({
      accountId: otherCandidate.profile.account_id,
      identityKey: otherCandidate.profile.identity_key,
      email: otherCandidate.slot.email,
      fiveHourPct: 50,
      weekPct: 50
    }));

    const result = await service.maybeAutoSwitch();
    assert.equal(result.state, 'queued');
    assert.equal(result.targetSlotId, candidate.slot.id);
    assert.equal(result.targetAuthProfileId, candidate.profile.id);
  });
});

test('buildRuntimeSnapshot exposes the next auto switch candidate before exhaustion happens', async () => {
  await withIsolatedRuntime(async ({ db, service, security }) => {
    service.updateRuntimeSettings({ auto_switch_enabled: true });

    createManagedAccount(db, security, {
      slotId: 'account_active_preview',
      authProfileId: 'auth_active_preview',
      label: '当前账号',
      email: 'active-preview@example.com',
      accountId: 'acct_active_preview',
      identityKey: 'ident_active_preview',
      fiveHourPct: 12,
      weekPct: 25,
      isActive: true
    });

    const candidate = createManagedAccount(db, security, {
      slotId: 'account_preview_best',
      authProfileId: 'auth_preview_best',
      label: '预览候选',
      email: 'preview-best@example.com',
      accountId: 'acct_preview_best',
      identityKey: 'ident_preview_best',
      fiveHourPct: 20,
      weekPct: 18
    });

    createManagedAccount(db, security, {
      slotId: 'account_preview_low',
      authProfileId: 'auth_preview_low',
      label: '较差候选',
      email: 'preview-low@example.com',
      accountId: 'acct_preview_low',
      identityKey: 'ident_preview_low',
      fiveHourPct: 70,
      weekPct: 70
    });

    const snapshot = await service.buildRuntimeSnapshot();
    assert.equal(snapshot.nextAutoSwitchTarget.slot_id, candidate.slot.id);
    assert.equal(snapshot.nextAutoSwitchTarget.auth_profile_id, candidate.profile.id);
    assert.equal(snapshot.nextAutoSwitchTarget.state, 'available');
  });
});

test('retryable usage timeouts enter backoff after repeated failures', async () => {
  await withIsolatedRuntime(async ({ db, service, security, agentStub }) => {
    createManagedAccount(db, security, {
      slotId: 'account_timeout_backoff',
      authProfileId: 'auth_timeout_backoff',
      label: '超时账号',
      email: 'timeout@example.com',
      accountId: 'acct_timeout_backoff',
      identityKey: 'ident_timeout_backoff',
      fiveHourPct: 20,
      weekPct: 20
    });

    let callCount = 0;
    agentStub.behavior.getUsageForProfile = async () => {
      callCount += 1;
      throw new Error('USAGE_REQUEST_TIMEOUT');
    };

    await service.runRuntimeRefresh('test_timeout_backoff', { mode: 'all' });
    await service.runRuntimeRefresh('test_timeout_backoff', { mode: 'all' });
    await service.runRuntimeRefresh('test_timeout_backoff', { mode: 'all' });

    const profile = db.getAuthProfileById('auth_timeout_backoff');
    assert.equal(profile.last_error_kind, 'usage_timeout');
    assert.equal(profile.failure_count, 2);
    assert.ok(profile.backoff_until);
    assert.equal(callCount, 4);
  });
});

test('terminal workspace errors mark reauth_required and stop repeated polling', async () => {
  await withIsolatedRuntime(async ({ db, service, security, agentStub }) => {
    createManagedAccount(db, security, {
      slotId: 'account_terminal_error',
      authProfileId: 'auth_terminal_error',
      label: '失效工作区账号',
      email: 'terminal@example.com',
      accountId: 'acct_terminal_error',
      identityKey: 'ident_terminal_error',
      fiveHourPct: 20,
      weekPct: 20
    });

    let callCount = 0;
    agentStub.behavior.getUsageForProfile = async () => {
      callCount += 1;
      throw new Error('WHAM_REQUEST_FAILED_402: {"detail":{"code":"deactivated_workspace"}}');
    };

    await service.runRuntimeRefresh('test_terminal_error', { mode: 'all' });
    await service.runRuntimeRefresh('test_terminal_error', { mode: 'all' });

    const profile = db.getAuthProfileById('auth_terminal_error');
    assert.equal(profile.last_error_kind, 'deactivated_workspace');
    assert.equal(profile.reauth_required, true);
    assert.equal(callCount, 1);
  });
});

test('interactive bridge heartbeat triggers auto switch and dispatches recovery actions', async () => {
  await withIsolatedRuntime(async ({ db, service, security, agentStub }) => {
    service.updateRuntimeSettings({ auto_switch_enabled: true });

    const active = createManagedAccount(db, security, {
      slotId: 'account_bridge_active',
      authProfileId: 'auth_bridge_active',
      label: '活动账号',
      email: 'bridge-active@example.com',
      accountId: 'acct_bridge_active',
      identityKey: 'ident_bridge_active',
      fiveHourPct: 100,
      weekPct: 30,
      isActive: true
    });
    const candidate = createManagedAccount(db, security, {
      slotId: 'account_bridge_candidate',
      authProfileId: 'auth_bridge_candidate',
      label: '候选账号',
      email: 'bridge-candidate@example.com',
      accountId: 'acct_bridge_candidate',
      identityKey: 'ident_bridge_candidate',
      fiveHourPct: 20,
      weekPct: 20
    });

    agentStub.setUsage(active.profile, buildUsage({
      accountId: active.profile.account_id,
      identityKey: active.profile.identity_key,
      email: active.slot.email,
      fiveHourPct: 100,
      weekPct: 30
    }));
    agentStub.setUsage(candidate.profile, buildUsage({
      accountId: candidate.profile.account_id,
      identityKey: candidate.profile.identity_key,
      email: candidate.slot.email,
      fiveHourPct: 20,
      weekPct: 20
    }));

    const heartbeat = await service.handleBridgeHeartbeat({
      sessionId: 'bridge_interactive_default',
      workspaceKind: 'interactive_default',
      pageUrl: 'http://127.0.0.1:8080/?workspace=%2Fopt%2Fcode-server%2Fdefault-root.code-workspace',
      focused: true,
      visible: true,
      latestRequest: '继续当前任务',
      latestResponse: '上一轮已经完成',
      draftPrompt: '继续当前任务',
      sendEnabled: false,
      running: false,
      interruptionReason: 'quota_exhausted_after_completion'
    });

    assert.equal(heartbeat.session.workspace_kind, 'interactive_default');
    assert.equal(heartbeat.interactiveRecovery.lastInterruptionReason, 'quota_exhausted_after_completion');

    await waitFor(() => {
      const currentActive = db.getActiveSlot();
      const actions = db.listBridgeActionsForSession('bridge_interactive_default');
      return currentActive
        && currentActive.id === candidate.slot.id
        && actions.some((item) => item.action_type === 'auth_switched')
        && actions.some((item) => item.action_type === 'recover_same_thread');
    }, 2500);

    const snapshot = await service.buildRuntimeSnapshot();
    const actions = db.listBridgeActionsForSession('bridge_interactive_default');
    const intent = db.listResumeIntents(null, 10)[0];

    assert.equal(service.getActiveAuthGeneration() > 0, true);
    assert.equal(intent.status, 'recovering');
    assert.equal(intent.target_slot_id, candidate.slot.id);
    assert.ok(actions.find((item) => item.action_type === 'auth_switched'));
    assert.ok(actions.find((item) => item.action_type === 'recover_same_thread'));
    assert.equal(snapshot.interactiveRecovery.primaryBridgeSession.id, 'bridge_interactive_default');
    assert.equal(snapshot.interactiveRecovery.pendingResumeIntent.targetSlotId, candidate.slot.id);
  });
});

test('bridge action acknowledgements advance the resume lifecycle to completed', async () => {
  await withIsolatedRuntime(async ({ db, service, security, agentStub }) => {
    service.updateRuntimeSettings({ auto_switch_enabled: true });

    const active = createManagedAccount(db, security, {
      slotId: 'account_resume_active',
      authProfileId: 'auth_resume_active',
      label: '活动账号',
      email: 'resume-active@example.com',
      accountId: 'acct_resume_active',
      identityKey: 'ident_resume_active',
      fiveHourPct: 100,
      weekPct: 30,
      isActive: true
    });
    const candidate = createManagedAccount(db, security, {
      slotId: 'account_resume_candidate',
      authProfileId: 'auth_resume_candidate',
      label: '候选账号',
      email: 'resume-candidate@example.com',
      accountId: 'acct_resume_candidate',
      identityKey: 'ident_resume_candidate',
      fiveHourPct: 10,
      weekPct: 10
    });

    agentStub.setUsage(active.profile, buildUsage({
      accountId: active.profile.account_id,
      identityKey: active.profile.identity_key,
      email: active.slot.email,
      fiveHourPct: 100,
      weekPct: 30
    }));
    agentStub.setUsage(candidate.profile, buildUsage({
      accountId: candidate.profile.account_id,
      identityKey: candidate.profile.identity_key,
      email: candidate.slot.email,
      fiveHourPct: 10,
      weekPct: 10
    }));

    await service.handleBridgeHeartbeat({
      sessionId: 'bridge_resume_session',
      workspaceKind: 'interactive_default',
      pageUrl: 'http://127.0.0.1:8080/?workspace=%2Fopt%2Fcode-server%2Fdefault-root.code-workspace',
      focused: true,
      visible: true,
      latestRequest: '把任务继续做完',
      latestResponse: '收到',
      draftPrompt: '把任务继续做完',
      sendEnabled: false,
      running: false,
      interruptionReason: 'compression_paused'
    });

    await waitFor(() => db.listBridgeActionsForSession('bridge_resume_session').some((item) => item.action_type === 'recover_same_thread'), 2500);

    const recoverAction = db.listBridgeActionsForSession('bridge_resume_session').find((item) => item.action_type === 'recover_same_thread');
    service.acknowledgeBridgeAction(recoverAction.id, {
      status: 'completed',
      result: {
        canResume: true
      }
    });

    await waitFor(() => db.listBridgeActionsForSession('bridge_resume_session').some((item) => item.action_type === 'resume_prompt'));
    let intent = db.listResumeIntents(null, 10)[0];
    const resumeAction = db.listBridgeActionsForSession('bridge_resume_session').find((item) => item.action_type === 'resume_prompt');

    assert.equal(intent.status, 'resuming');
    assert.equal(resumeAction.status, 'dispatched');

    service.acknowledgeBridgeAction(resumeAction.id, {
      status: 'completed',
      result: {
        sent: true
      }
    });

    intent = db.listResumeIntents(null, 10)[0];
    const session = db.getBridgeSessionById('bridge_resume_session');
    assert.equal(intent.status, 'completed');
    assert.ok(intent.acked_at);
    assert.equal(session.interruption_reason, null);
    assert.ok(session.last_recovered_at);
  });
});

test('recovery prompt payload collapses repeated fallback text before dispatching resume_prompt', async () => {
  await withIsolatedRuntime(async ({ db, service, security }) => {
    const active = createManagedAccount(db, security, {
      slotId: 'account_prompt_collapse',
      authProfileId: 'auth_prompt_collapse',
      label: 'Prompt Collapse',
      email: 'prompt-collapse@example.com',
      accountId: 'acct_prompt_collapse',
      identityKey: 'ident_prompt_collapse',
      fiveHourPct: 20,
      weekPct: 20,
      isActive: true
    });

    await service.handleBridgeHeartbeat({
      sessionId: 'bridge_prompt_collapse',
      workspaceKind: 'interactive_default',
      pageUrl: 'http://127.0.0.1:8080/?workspace=%2Fopt%2Fcode-server%2Fdefault-root.code-workspace',
      focused: true,
      visible: true,
      latestRequest: null,
      latestResponse: null,
      draftPrompt: null,
      sendEnabled: true,
      running: false,
      interruptionReason: null
    });

    db.createResumeIntent({
      bridge_session_id: 'bridge_prompt_collapse',
      reason: 'composer_unavailable',
      source_slot_id: active.slot.id,
      original_prompt: '中断了，请继续严格按照原来规划完成全部任务 中断了，请继续严格按照原来规划完成全部任务',
      draft_prompt: '中断了，请继续严格按照原来规划完成全部任务 中断了，请继续严格按照原来规划完成全部任务',
      latest_request: null,
      latest_response: null,
      recovery_summary: '中断了，请继续严格按照原来规划完成全部任务',
      status: 'pending'
    });

    await service.handleBridgeHeartbeat({
      sessionId: 'bridge_prompt_collapse',
      workspaceKind: 'interactive_default',
      pageUrl: 'http://127.0.0.1:8080/?workspace=%2Fopt%2Fcode-server%2Fdefault-root.code-workspace',
      focused: true,
      visible: true,
      latestRequest: null,
      latestResponse: null,
      draftPrompt: null,
      sendEnabled: true,
      running: false,
      interruptionReason: null
    });

    await waitFor(() => db.listBridgeActionsForSession('bridge_prompt_collapse').some((item) => item.action_type === 'recover_same_thread'), 2500);

    const recoverAction = db.listBridgeActionsForSession('bridge_prompt_collapse').find((item) => item.action_type === 'recover_same_thread');
    service.acknowledgeBridgeAction(recoverAction.id, {
      status: 'completed',
      result: {
        canResume: true
      }
    });

    await waitFor(() => db.listBridgeActionsForSession('bridge_prompt_collapse').some((item) => item.action_type === 'resume_prompt'), 2500);
    const resumeAction = db.listBridgeActionsForSession('bridge_prompt_collapse').find((item) => item.action_type === 'resume_prompt');

    assert.equal(resumeAction.payload.prompt, '中断了，请继续严格按照原来规划完成全部任务');
  });
});

test('composer_unavailable does not recreate resume intents when the draft is only a failed fallback residue', async () => {
  await withIsolatedRuntime(async ({ db, service, security }) => {
    createManagedAccount(db, security, {
      slotId: 'account_prompt_guard',
      authProfileId: 'auth_prompt_guard',
      label: 'Prompt Guard',
      email: 'prompt-guard@example.com',
      accountId: 'acct_prompt_guard',
      identityKey: 'ident_prompt_guard',
      fiveHourPct: 20,
      weekPct: 20,
      isActive: true
    });

    await service.handleBridgeHeartbeat({
      sessionId: 'bridge_prompt_guard',
      workspaceKind: 'interactive_default',
      pageUrl: 'http://127.0.0.1:8080/?workspace=%2Fopt%2Fcode-server%2Fdefault-root.code-workspace',
      focused: true,
      visible: true,
      latestRequest: null,
      latestResponse: null,
      draftPrompt: null,
      sendEnabled: false,
      running: false,
      interruptionReason: null
    });

    db.updateBridgeSession('bridge_prompt_guard', {
      last_error: 'PROMPT_INPUT_NOT_ACCEPTED'
    });

    await service.handleBridgeHeartbeat({
      sessionId: 'bridge_prompt_guard',
      workspaceKind: 'interactive_default',
      pageUrl: 'http://127.0.0.1:8080/?workspace=%2Fopt%2Fcode-server%2Fdefault-root.code-workspace',
      focused: true,
      visible: true,
      latestRequest: null,
      latestResponse: null,
      draftPrompt: '中断了，请继续严格按照原来规划完成全部任务 中断了，请继续严格按照原来规划完成全部任务',
      sendEnabled: false,
      running: false,
      interruptionReason: 'composer_unavailable'
    });

    assert.equal(db.listResumeIntents(null, 10).length, 0);
    assert.equal(db.listBridgeActionsForSession('bridge_prompt_guard').length, 0);
  });
});

test('composer_unavailable ignores fallback-only draft residue even before a failed intent is recorded', async () => {
  await withIsolatedRuntime(async ({ db, service, security }) => {
    createManagedAccount(db, security, {
      slotId: 'account_prompt_guard_initial',
      authProfileId: 'auth_prompt_guard_initial',
      label: 'Prompt Guard Initial',
      email: 'prompt-guard-initial@example.com',
      accountId: 'acct_prompt_guard_initial',
      identityKey: 'ident_prompt_guard_initial',
      fiveHourPct: 20,
      weekPct: 20,
      isActive: true
    });

    await service.handleBridgeHeartbeat({
      sessionId: 'bridge_prompt_guard_initial',
      workspaceKind: 'interactive_default',
      pageUrl: 'http://127.0.0.1:8080/?workspace=%2Fopt%2Fcode-server%2Fdefault-root.code-workspace',
      focused: true,
      visible: true,
      latestRequest: null,
      latestResponse: null,
      draftPrompt: '中断了，请继续严格按照原来规划完成全部任务',
      sendEnabled: false,
      running: false,
      interruptionReason: 'composer_unavailable'
    });

    assert.equal(db.listResumeIntents(null, 10).length, 0);
    assert.equal(db.listBridgeActionsForSession('bridge_prompt_guard_initial').length, 0);
  });
});

test('compression interruption falls back to open_new_thread_and_resume after same-thread recovery fails', async () => {
  await withIsolatedRuntime(async ({ db, service, security, agentStub }) => {
    service.updateRuntimeSettings({ auto_switch_enabled: true });

    const active = createManagedAccount(db, security, {
      slotId: 'account_compression_active',
      authProfileId: 'auth_compression_active',
      label: '压缩中断活动账号',
      email: 'compression-active@example.com',
      accountId: 'acct_compression_active',
      identityKey: 'ident_compression_active',
      fiveHourPct: 100,
      weekPct: 40,
      isActive: true
    });
    const candidate = createManagedAccount(db, security, {
      slotId: 'account_compression_candidate',
      authProfileId: 'auth_compression_candidate',
      label: '压缩中断候选账号',
      email: 'compression-candidate@example.com',
      accountId: 'acct_compression_candidate',
      identityKey: 'ident_compression_candidate',
      fiveHourPct: 12,
      weekPct: 18
    });

    agentStub.setUsage(active.profile, buildUsage({
      accountId: active.profile.account_id,
      identityKey: active.profile.identity_key,
      email: active.slot.email,
      fiveHourPct: 100,
      weekPct: 40
    }));
    agentStub.setUsage(candidate.profile, buildUsage({
      accountId: candidate.profile.account_id,
      identityKey: candidate.profile.identity_key,
      email: candidate.slot.email,
      fiveHourPct: 12,
      weekPct: 18
    }));

    await service.handleBridgeHeartbeat({
      sessionId: 'bridge_compression_session',
      workspaceKind: 'interactive_default',
      pageUrl: 'http://127.0.0.1:8080/?workspace=%2Fopt%2Fcode-server%2Fdefault-root.code-workspace',
      focused: true,
      visible: true,
      latestRequest: '请继续刚才压缩后中断的任务',
      latestResponse: '压缩完成，等待继续',
      draftPrompt: '请继续刚才压缩后中断的任务',
      sendEnabled: false,
      running: false,
      interruptionReason: 'compression_paused'
    });

    await waitFor(() => {
      const currentActive = db.getActiveSlot();
      const actions = db.listBridgeActionsForSession('bridge_compression_session');
      return currentActive
        && currentActive.id === candidate.slot.id
        && actions.some((item) => item.action_type === 'recover_same_thread');
    }, 2500);

    const recoverAction = db.listBridgeActionsForSession('bridge_compression_session').find((item) => item.action_type === 'recover_same_thread');
    service.acknowledgeBridgeAction(recoverAction.id, {
      status: 'failed',
      result: {
        fallbackRequired: true,
        error: 'SAME_THREAD_NOT_READY'
      }
    });

    await waitFor(() => db.listBridgeActionsForSession('bridge_compression_session').some((item) => item.action_type === 'open_new_thread_and_resume'), 2500);

    const fallbackAction = db.listBridgeActionsForSession('bridge_compression_session').find((item) => item.action_type === 'open_new_thread_and_resume');
    const intentBeforeAck = db.listResumeIntents(null, 10)[0];

    assert.equal(intentBeforeAck.status, 'resuming');
    assert.ok(String(fallbackAction.payload.prompt || '').includes('中断了，请继续严格按照原来规划完成全部任务'));

    service.acknowledgeBridgeAction(fallbackAction.id, {
      status: 'completed',
      result: {
        sent: true,
        newThread: true
      }
    });

    const intent = db.listResumeIntents(null, 10)[0];
    const session = db.getBridgeSessionById('bridge_compression_session');

    assert.equal(intent.status, 'completed');
    assert.ok(intent.sent_at);
    assert.ok(intent.acked_at);
    assert.equal(session.interruption_reason, null);
    assert.ok(session.last_recovered_at);
  });
});

test('bridge interruption with no candidate dispatches blocked_all_accounts', async () => {
  await withIsolatedRuntime(async ({ db, service, security, agentStub }) => {
    service.updateRuntimeSettings({ auto_switch_enabled: true });

    const active = createManagedAccount(db, security, {
      slotId: 'account_blocked_active',
      authProfileId: 'auth_blocked_active',
      label: '活动账号',
      email: 'blocked-active@example.com',
      accountId: 'acct_blocked_active',
      identityKey: 'ident_blocked_active',
      fiveHourPct: 100,
      weekPct: 30,
      isActive: true
    });
    const exhaustedCandidate = createManagedAccount(db, security, {
      slotId: 'account_blocked_candidate',
      authProfileId: 'auth_blocked_candidate',
      label: '不可切换账号',
      email: 'blocked-candidate@example.com',
      accountId: 'acct_blocked_candidate',
      identityKey: 'ident_blocked_candidate',
      fiveHourPct: 20,
      weekPct: 100
    });

    agentStub.setUsage(active.profile, buildUsage({
      accountId: active.profile.account_id,
      identityKey: active.profile.identity_key,
      email: active.slot.email,
      fiveHourPct: 100,
      weekPct: 30
    }));
    agentStub.setUsage(exhaustedCandidate.profile, buildUsage({
      accountId: exhaustedCandidate.profile.account_id,
      identityKey: exhaustedCandidate.profile.identity_key,
      email: exhaustedCandidate.slot.email,
      fiveHourPct: 20,
      weekPct: 100
    }));

    await service.handleBridgeHeartbeat({
      sessionId: 'bridge_blocked_session',
      workspaceKind: 'interactive_default',
      pageUrl: 'http://127.0.0.1:8080/?workspace=%2Fopt%2Fcode-server%2Fdefault-root.code-workspace',
      focused: true,
      visible: true,
      latestRequest: '继续执行',
      latestResponse: '上一轮完成',
      draftPrompt: '继续执行',
      sendEnabled: false,
      running: false,
      interruptionReason: 'quota_exhausted_after_completion'
    });

    await waitFor(() => {
      const actions = db.listBridgeActionsForSession('bridge_blocked_session');
      const snapshot = db.getRuntimeLock('auto_switch_status');
      return actions.some((item) => item.action_type === 'blocked_all_accounts')
        && snapshot
        && snapshot.payload
        && snapshot.payload.state === 'no_candidate';
    }, 2500);

    const snapshot = await service.buildRuntimeSnapshot();
    const actions = db.listBridgeActionsForSession('bridge_blocked_session');
    const intent = db.listResumeIntents(null, 10)[0];

    assert.equal(intent.status, 'blocked');
    assert.ok(actions.find((item) => item.action_type === 'blocked_all_accounts'));
    assert.equal(snapshot.autoSwitchStatus.state, 'no_candidate');
    assert.equal(snapshot.interactiveRecovery.state, 'no_candidate');
    assert.equal(snapshot.interactiveRecovery.lastInterruptionReason, 'quota_exhausted_after_completion');
  });
});
