'use strict';

const {
  completeSwitchEvent,
  createSwitchEvent,
  deleteAccount,
  deleteBootstrapSession,
  deleteProfile,
  getActiveSlot,
  getAppSettings,
  getBootstrapSession,
  getLatestActiveBootstrapSession,
  getProfile,
  getRuntimeLock,
  getSlotByAccountId,
  getSlotByIdentityKey,
  getSlotByEmail,
  getSlotById,
  insertQuotaSample,
  listBootstrapSessions,
  listSlots,
  nowIso,
  setActiveSlot,
  setAppSettings,
  updateBootstrapSession,
  updateSlot,
  upsertProfile,
  upsertRuntimeLock,
  deleteRuntimeLock
} = require('./db');
const {
  activateProfile,
  cancelBootstrap,
  captureAuthProfile,
  getBootstrapStatus,
  getLoginStatus,
  probeProfile,
  refreshProfileTokens,
  startDeviceAuth,
  getUsageForProfile,
  getUsageStatus,
  logoutActiveAuth
} = require('./agent-client');
const { decryptString, encryptString } = require('./security');
const { broadcast } = require('./sse');
const { writeAudit } = require('./audit');
const { config } = require('./config');
const { buildManagedAuthUrl } = require('./auth-link');

const DAY_MS = 24 * 60 * 60 * 1000;
const DEVICE_AUTH_COOLDOWN_MS = 60 * 1000;
const RUNTIME_SYNC_TTL_MS = Math.max(5000, Math.min(config.quotaSampleIntervalMs || (2 * 60 * 1000), 15000));
const SETTINGS_REFRESH_INTERVAL_OPTIONS = [10000, 30000, 60000, 120000];
const SETTINGS_PROBE_INTERVAL_OPTIONS = [300000, 900000, 1800000, 3600000];

let runtimeSyncCache = {
  key: '',
  syncedAt: 0,
  result: null,
  inFlight: null
};

function normalizeBooleanSetting(value, fallback = true) {
  if (value == null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function normalizeNumberSetting(value, fallback, allowed) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  if (Array.isArray(allowed) && allowed.length && !allowed.includes(parsed)) return fallback;
  return parsed;
}

function resolveAppSettings() {
  const stored = getAppSettings();
  return {
    runtimeRefreshIntervalMs: normalizeNumberSetting(
      stored.ui_refresh_interval_ms,
      30000,
      SETTINGS_REFRESH_INTERVAL_OPTIONS
    ),
    availabilityProbeEnabled: normalizeBooleanSetting(
      stored.availability_probe_enabled,
      true
    ),
    availabilityProbeIntervalMs: normalizeNumberSetting(
      stored.availability_probe_interval_ms,
      900000,
      SETTINGS_PROBE_INTERVAL_OPTIONS
    )
  };
}

function updateAppSettings(input = {}) {
  const current = resolveAppSettings();
  const next = {
    runtimeRefreshIntervalMs: normalizeNumberSetting(
      input.runtimeRefreshIntervalMs,
      current.runtimeRefreshIntervalMs,
      SETTINGS_REFRESH_INTERVAL_OPTIONS
    ),
    availabilityProbeEnabled: Object.prototype.hasOwnProperty.call(input, 'availabilityProbeEnabled')
      ? !!input.availabilityProbeEnabled
      : current.availabilityProbeEnabled,
    availabilityProbeIntervalMs: normalizeNumberSetting(
      input.availabilityProbeIntervalMs,
      current.availabilityProbeIntervalMs,
      SETTINGS_PROBE_INTERVAL_OPTIONS
    )
  };

  setAppSettings({
    ui_refresh_interval_ms: String(next.runtimeRefreshIntervalMs),
    availability_probe_enabled: next.availabilityProbeEnabled ? '1' : '0',
    availability_probe_interval_ms: String(next.availabilityProbeIntervalMs)
  });
  return resolveAppSettings();
}

function emptyQuotaSyncResult(observedAt = nowIso()) {
  return {
    activeUsage: null,
    refreshedCount: 0,
    failedCount: 0,
    observedAt
  };
}

function hasResetElapsed(resetAt) {
  return !!resetAt && new Date(resetAt).getTime() <= Date.now();
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function runtimeSyncCacheKey(activeSession) {
  if (!activeSession) return 'anonymous';
  return JSON.stringify({
    activeSlotId: activeSession.activeSlotId || null,
    accountId: activeSession.accountId || null,
    identityKey: activeSession.identityKey || null,
    email: normalizeEmail(activeSession.email || '')
  });
}

function invalidateRuntimeSyncCache() {
  runtimeSyncCache = {
    key: '',
    syncedAt: 0,
    result: null,
    inFlight: null
  };
}

function buildProfileEmailMismatchMessage(slot, actualEmail) {
  return `PROFILE_EMAIL_MISMATCH: expected ${normalizeEmail(slot.email)}, got ${normalizeEmail(actualEmail)}`;
}

function buildDuplicateProfileMessage(identityKey, primarySlot, duplicateSlot) {
  const primaryLabel = normalizeEmail(primarySlot.email) || primarySlot.label || primarySlot.id;
  const duplicateLabel = normalizeEmail(duplicateSlot.email) || duplicateSlot.label || duplicateSlot.id;
  return `DUPLICATE_PROFILE_IDENTITY: ${duplicateLabel} 与 ${primaryLabel} 绑定到了同一个成员身份 ${identityKey}，请重新认证目标账号`;
}

function buildDuplicateBootstrapMessage(targetSlot, existingSlot, captured = {}) {
  const targetLabel = normalizeEmail(targetSlot.email) || targetSlot.label || targetSlot.id;
  const actualEmail = normalizeEmail(captured.email);
  const actualAccountId = String(captured.accountId || '').trim();
  const existingLabel = existingSlot
    ? (normalizeEmail(existingSlot.email) || existingSlot.label || existingSlot.id)
    : null;

  if (actualEmail && actualEmail !== targetLabel) {
    const accountHint = actualAccountId ? `，account_id 为 ${actualAccountId}` : '';
    const bindingHint = existingLabel ? `，它当前对应的受管账号是 ${existingLabel}` : '';
    return `当前授权得到的是 ${actualEmail}${accountHint}${bindingHint}，不是目标账号 ${targetLabel}。系统已刷新新的设备码；请重新打开认证页并使用 ${targetLabel} 完成授权。`;
  }

  if (existingLabel && actualAccountId) {
    return `当前授权得到的邮箱是 ${actualEmail || '未知邮箱'}，但它返回的 OpenAI account_id ${actualAccountId} 已经绑定在 ${existingLabel}。这通常说明这个登录入口和 ${existingLabel} 指向同一个 OpenAI 账号；系统已停止自动重试，请确认你要绑定的是一个独立账号。`;
  }

  if (existingLabel) {
    return `当前授权得到的身份已经绑定在 ${existingLabel}，不是目标账号 ${targetLabel}。系统已停止自动重试，请确认你要绑定的是一个独立账号。`;
  }

  return `当前授权得到的身份不是目标账号 ${targetLabel}。系统已刷新新的设备码；请重新打开认证页并使用 ${targetLabel} 完成授权。`;
}

function buildBootstrapConflictSlotPatch(slot, message) {
  if (slot && slot.has_profile) {
    return {
      state: deriveSlotState(slot),
      last_error: message
    };
  }

  return {
    state: 'auth_required',
    account_id: null,
    identity_key: null,
    quota_5h_pct: null,
    quota_5h_reset_at: null,
    quota_5h_reset_label: null,
    quota_week_pct: null,
    quota_week_reset_at: null,
    quota_week_reset_label: null,
    freshness: 'stale',
    last_bootstrap_at: null,
    last_error: message
  };
}

function findDuplicateBootstrapSlot(targetSlotId, captured = {}) {
  const actualIdentityKey = String(captured.identityKey || '').trim();
  if (actualIdentityKey) {
    const byIdentity = getSlotByIdentityKey(actualIdentityKey);
    if (byIdentity && byIdentity.id !== targetSlotId) return byIdentity;
  }

  const actualEmail = normalizeEmail(captured.email);
  if (actualEmail) {
    const byEmail = getSlotByEmail(actualEmail);
    if (byEmail && byEmail.id !== targetSlotId) return byEmail;
  }

  return null;
}

function shouldRetryDuplicateBootstrap(targetSlot, captured = {}) {
  const targetEmail = normalizeEmail(targetSlot && targetSlot.email);
  const actualEmail = normalizeEmail(captured.email);
  return !!(targetEmail && actualEmail && targetEmail !== actualEmail);
}

function isDeviceAuthRateLimitedText(text) {
  return /429 Too Many Requests/i.test(String(text || ''));
}

function isBootstrapNotFoundText(text) {
  return /BOOTSTRAP_NOT_FOUND/i.test(String(text || ''));
}

function isAgentRestartBootstrapError(text) {
  return /connect ENOENT \/run\/codex-switcher\/agent\.sock/i.test(String(text || ''));
}

function getActiveDeviceAuthCooldownLock() {
  const lock = getRuntimeLock('device_auth_cooldown');
  if (!lock || !lock.expires_at) return null;
  if (new Date(lock.expires_at).getTime() <= Date.now()) {
    deleteRuntimeLock('device_auth_cooldown');
    return null;
  }
  return lock;
}

function isAccountDraft(slot) {
  return !String(slot.email || '').trim()
    || !String(slot.login_method || '').trim()
    || !String(slot.expires_at || '').trim();
}

function parseExpiryDate(expiresAt) {
  const raw = String(expiresAt || '').trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return new Date(`${raw}T23:59:59.999Z`);
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatExpiryDate(expiresAt) {
  const value = parseExpiryDate(expiresAt);
  if (!value) return '--';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    timeZone: 'UTC'
  }).format(value);
}

function buildSubscriptionStatus(expiresAt) {
  const value = parseExpiryDate(expiresAt);
  if (!value) {
    return {
      status: 'unknown',
      label: '未设置到期日',
      daysRemaining: null,
      displayDate: '--'
    };
  }

  const diffMs = value.getTime() - Date.now();
  const daysRemaining = Math.ceil(diffMs / DAY_MS);
  const displayDate = formatExpiryDate(expiresAt);

  if (diffMs < 0) {
    return {
      status: 'expired',
      label: `已于 ${displayDate} 到期`,
      daysRemaining,
      displayDate
    };
  }

  if (daysRemaining <= 3) {
    return {
      status: 'warning',
      label: `${daysRemaining} 天内到期`,
      daysRemaining,
      displayDate
    };
  }

  return {
    status: 'healthy',
    label: `有效期至 ${displayDate}`,
    daysRemaining,
    displayDate
  };
}

function deriveSlotState(slot) {
  if (slot.is_active) return 'active';
  if (isAccountDraft(slot)) return 'draft';
  if (!slot.has_profile) return 'auth_required';
  if (slot.state === 'error' && slot.last_error) return 'error';
  if (slot.quota_5h_pct >= 100 && slot.quota_5h_reset_at && !hasResetElapsed(slot.quota_5h_reset_at)) return 'exhausted';
  return 'ready';
}

function serializeSlot(slot) {
  const displayState = deriveSlotState(slot);
  const subscription = buildSubscriptionStatus(slot.expires_at);
  return {
    ...slot,
    display_state: displayState,
    precise: slot.freshness === 'live',
    predicted: false,
    requires_auth: displayState === 'auth_required',
    can_authenticate: !isAccountDraft(slot),
    can_switch: displayState === 'ready',
    can_logout: !isAccountDraft(slot) && !!slot.has_profile,
    can_delete: !slot.is_active,
    subscription_status: subscription.status,
    subscription_label: subscription.label,
    days_until_expiry: subscription.daysRemaining,
    expiry_text: subscription.displayDate
  };
}

function chooseNextAvailableSlot(activeSlotId) {
  const slots = listSlots()
    .map(serializeSlot)
    .filter((slot) => slot.id !== activeSlotId);
  return slots.find((slot) => slot.can_switch) || null;
}

function dispatchBrowserAction() {
  return null;
}

function buildDetectedActiveSlot(activeSession, usageSnapshot = null) {
  if (!activeSession || !activeSession.accountId) return null;
  const hasQuota = usageSnapshot && usageSnapshot.parserStatus === 'ok';
  return {
    id: 'detected_active',
    label: '当前活动账号',
    email: activeSession.email || '',
    slot_type: 'account',
    login_method: '',
    priority: 0,
    state: 'active',
    display_state: 'active',
    account_id: activeSession.accountId,
    quota_5h_pct: hasQuota ? usageSnapshot.fiveHour?.pct ?? null : null,
    quota_5h_reset_at: hasQuota ? usageSnapshot.fiveHour?.resetAt ?? null : null,
    quota_5h_reset_label: hasQuota ? usageSnapshot.fiveHour?.resetLabel ?? null : null,
    quota_week_pct: hasQuota ? usageSnapshot.week?.pct ?? null : null,
    quota_week_reset_at: hasQuota ? usageSnapshot.week?.resetAt ?? null : null,
    quota_week_reset_label: hasQuota ? usageSnapshot.week?.resetLabel ?? null : null,
    freshness: hasQuota ? 'live' : 'stale',
    precise: hasQuota,
    predicted: false,
    can_switch: false,
    can_authenticate: false,
    can_logout: false,
    can_delete: false,
    has_profile: false,
    is_active: 1,
    synthetic: true,
    subscription_status: 'unknown',
    subscription_label: '未纳入账号列表',
    days_until_expiry: null,
    expiry_text: '--'
  };
}

function buildDriftStatus(input = {}) {
  const previousActiveSlot = input.previousActiveSlot || null;
  const matchedSlot = input.matchedSlot || null;
  const accountId = input.accountId || null;
  const email = normalizeEmail(input.email || '');
  const switchLock = getRuntimeLock('switch_lock');
  if (switchLock) return null;

  if (!accountId && previousActiveSlot) {
    return {
      kind: 'external_logout',
      level: 'warning'
    };
  }

  if (accountId && !matchedSlot) {
    return {
      kind: 'unmanaged_active_session',
      level: 'warning',
      email: email || null
    };
  }

  if (accountId && previousActiveSlot && matchedSlot && previousActiveSlot.id !== matchedSlot.id) {
    return {
      kind: 'external_profile_change',
      level: 'warning',
      previousLabel: normalizeEmail(previousActiveSlot.email) || previousActiveSlot.label || previousActiveSlot.id,
      currentLabel: normalizeEmail(matchedSlot.email) || matchedSlot.label || matchedSlot.id
    };
  }

  return null;
}

async function reconcileActiveSlotFromAgent() {
  try {
    const previousActiveSlot = getActiveSlot();
    const status = await getLoginStatus();
    const accountId = status.tokens && status.tokens.account_id ? status.tokens.account_id : null;
    const identityKey = status.identityKey ? String(status.identityKey).trim() : null;
    const email = status.email ? String(status.email).trim().toLowerCase() : null;

    if (!accountId) {
      if (previousActiveSlot) setActiveSlot(null);
      return {
        activeSlotId: null,
        accountId: null,
        identityKey: null,
        email: null,
        drift: buildDriftStatus({ previousActiveSlot })
      };
    }

    const matched = (identityKey ? getSlotByIdentityKey(identityKey) : null)
      || (email ? getSlotByEmail(email) : null)
      || getSlotByAccountId(accountId);
    if (matched) {
      if (!matched.is_active) setActiveSlot(matched.id);
      updateSlot(matched.id, {
        account_id: accountId,
        identity_key: identityKey || matched.identity_key || matched.profile_identity_key || null,
        state: 'active',
        last_error: null,
        is_active: 1
      });
    } else if (getActiveSlot()) {
      setActiveSlot(null);
    }

    return {
      activeSlotId: matched ? matched.id : null,
      accountId,
      identityKey,
      email,
      drift: buildDriftStatus({
        previousActiveSlot,
        matchedSlot: matched,
        accountId,
        email
      })
    };
  } catch (error) {
    writeAudit('agent.login_status_failed', { message: error.message });
    return { activeSlotId: null, accountId: null, identityKey: null, email: null, error: error.message, drift: null };
  }
}

function buildQuotaPatch(usageSnapshot, fallbackState = 'ready', observedAt = nowIso()) {
  return {
    quota_5h_pct: usageSnapshot.fiveHour ? usageSnapshot.fiveHour.pct : null,
    quota_5h_reset_at: usageSnapshot.fiveHour ? usageSnapshot.fiveHour.resetAt : null,
    quota_5h_reset_label: usageSnapshot.fiveHour ? usageSnapshot.fiveHour.resetLabel : null,
    quota_week_pct: usageSnapshot.week ? usageSnapshot.week.pct : null,
    quota_week_reset_at: usageSnapshot.week ? usageSnapshot.week.resetAt : null,
    quota_week_reset_label: usageSnapshot.week ? usageSnapshot.week.resetLabel : null,
    freshness: 'live',
    last_seen_at: observedAt,
    state: usageSnapshot.fiveHour && usageSnapshot.fiveHour.pct >= 100 ? 'exhausted' : fallbackState,
    last_error: null
  };
}

function insertQuotaSampleForSlot(slotId, usageSnapshot, observedAt) {
  insertQuotaSample({
    slot_id: slotId,
    browser_client_id: 'agent_backend',
    parser_status: usageSnapshot.parserStatus,
    quota_5h_pct: usageSnapshot.fiveHour ? usageSnapshot.fiveHour.pct : null,
    quota_5h_reset_at: usageSnapshot.fiveHour ? usageSnapshot.fiveHour.resetAt : null,
    quota_5h_reset_label: usageSnapshot.fiveHour ? usageSnapshot.fiveHour.resetLabel : null,
    quota_week_pct: usageSnapshot.week ? usageSnapshot.week.pct : null,
    quota_week_reset_at: usageSnapshot.week ? usageSnapshot.week.resetAt : null,
    quota_week_reset_label: usageSnapshot.week ? usageSnapshot.week.resetLabel : null,
    raw_text: usageSnapshot.rawText || '',
    observed_at: observedAt
  });
}

function markUsageFailure(slot, observedAt, error) {
  updateSlot(slot.id, {
    quota_5h_pct: null,
    quota_5h_reset_at: null,
    quota_5h_reset_label: null,
    quota_week_pct: null,
    quota_week_reset_at: null,
    quota_week_reset_label: null,
    freshness: 'stale',
    last_seen_at: observedAt,
    state: slot.has_profile ? 'error' : deriveSlotState(slot),
    last_error: error.message
  });
  insertQuotaSample({
    slot_id: slot.id,
    browser_client_id: 'agent_backend',
    parser_status: 'error',
    raw_text: `backend_usage_fetch_failed :: ${error.message}`,
    observed_at: observedAt
  });
}

function applyProfileIdentityGuard(slot, result) {
  const expectedEmail = normalizeEmail(slot.email);
  const actualEmail = normalizeEmail(result && result.email);
  if (expectedEmail && actualEmail && expectedEmail !== actualEmail) {
    throw new Error(buildProfileEmailMismatchMessage(slot, actualEmail));
  }
}

async function syncUsageForSlot(slot, activeSession, sharedActiveUsage = null) {
  const observedAt = nowIso();

  try {
    let result;
    if (activeSession && activeSession.activeSlotId === slot.id && activeSession.accountId) {
      result = sharedActiveUsage || await getUsageStatus();
    } else {
      const profile = getProfile(slot.id);
      if (!profile) return null;
      result = await getUsageForProfile({
        authJson: decryptString(profile.auth_cipher),
        expectedAccountId: profile.account_id || slot.account_id || null,
        expectedIdentityKey: profile.identity_key || slot.identity_key || null
      });
      applyProfileIdentityGuard(slot, result);
      if (result.authJson) {
        upsertProfile(
          slot.id,
          encryptString(result.authJson),
          result.accountId || slot.account_id || null,
          result.identityKey || profile.identity_key || slot.identity_key || null
        );
      }
    }

    const usageSnapshot = result.usage;
    const resultObservedAt = result.observedAt || observedAt;
    updateSlot(slot.id, {
      ...buildQuotaPatch(usageSnapshot, slot.is_active ? 'active' : 'ready', resultObservedAt),
      account_id: result.accountId || usageSnapshot.accountId || slot.account_id || null,
      identity_key: result.identityKey || slot.identity_key || null
    });
    insertQuotaSampleForSlot(slot.id, usageSnapshot, resultObservedAt);

    return {
      ...usageSnapshot,
      observedAt: resultObservedAt,
      accountId: result.accountId || usageSnapshot.accountId || slot.account_id || null,
      identityKey: result.identityKey || slot.identity_key || null,
      email: result.email || usageSnapshot.email || slot.email || null,
      planType: result.planType || usageSnapshot.planType || null
    };
  } catch (error) {
    markUsageFailure(slot, observedAt, error);
    writeAudit('agent.usage_status_failed', { slotId: slot.id, message: error.message });
    return {
      parserStatus: 'error',
      observedAt,
      error: error.message
    };
  }
}

async function syncAllManagedQuotas(activeSession) {
  const slots = listSlots();
  let activeUsage = null;
  let refreshedCount = 0;
  let failedCount = 0;
  let lastObservedAt = null;

  const activeSlot = activeSession && activeSession.activeSlotId
    ? slots.find((slot) => slot.id === activeSession.activeSlotId) || null
    : null;

  if (activeSlot) {
    activeUsage = await syncUsageForSlot(activeSlot, activeSession);
    lastObservedAt = activeUsage && activeUsage.observedAt ? activeUsage.observedAt : lastObservedAt;
    if (activeUsage && activeUsage.parserStatus === 'ok') refreshedCount += 1;
    else if (activeUsage && activeUsage.parserStatus === 'error') failedCount += 1;
  } else if (activeSession && activeSession.accountId) {
    try {
      const result = await getUsageStatus();
      activeUsage = {
        ...result.usage,
        observedAt: result.observedAt || nowIso(),
        accountId: result.accountId || result.usage.accountId || activeSession.accountId || null,
        identityKey: result.identityKey || activeSession.identityKey || null,
        email: result.email || result.usage.email || activeSession.email || null,
        planType: result.planType || result.usage.planType || null
      };
      refreshedCount += 1;
      lastObservedAt = activeUsage.observedAt;
    } catch (error) {
      activeUsage = {
        parserStatus: 'error',
        observedAt: nowIso(),
        error: error.message
      };
      failedCount += 1;
      writeAudit('agent.usage_status_failed', { slotId: null, message: error.message });
    }
  }

  for (const slot of slots) {
    if (activeSlot && slot.id === activeSlot.id) continue;
    if (!slot.has_profile) continue;
    const usage = await syncUsageForSlot(slot, activeSession);
    if (!usage) continue;
    lastObservedAt = usage.observedAt || lastObservedAt;
    if (usage.parserStatus === 'ok') refreshedCount += 1;
    else if (usage.parserStatus === 'error') failedCount += 1;
  }

  return {
    activeUsage,
    refreshedCount,
    failedCount,
    observedAt: lastObservedAt || nowIso()
  };
}

function enforceUniqueManagedProfiles() {
  const slots = listSlots().filter((slot) => slot.has_profile && (slot.identity_key || slot.profile_identity_key));
  const grouped = new Map();
  let changed = false;

  for (const slot of slots) {
    const key = String(slot.identity_key || slot.profile_identity_key || '').trim();
    if (!key) continue;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(slot);
  }

  for (const [identityKey, duplicates] of grouped.entries()) {
    if (duplicates.length <= 1) continue;
    const primary = duplicates.find((slot) => slot.is_active) || duplicates[0];
    for (const slot of duplicates) {
      if (slot.id === primary.id) continue;
      const message = buildDuplicateProfileMessage(identityKey, primary, slot);
      const alreadyMarked = slot.last_error === message
        && slot.quota_5h_pct == null
        && slot.quota_week_pct == null
        && slot.freshness === 'stale';
      if (alreadyMarked) continue;
      markUsageFailure(slot, nowIso(), new Error(message));
      changed = true;
    }
  }

  return changed;
}

async function getManagedQuotaSync(activeSession, options = {}) {
  const cacheKey = runtimeSyncCacheKey(activeSession);
  const now = Date.now();
  const force = options.forceQuotaSync === true;

  if (!force
    && runtimeSyncCache.result
    && runtimeSyncCache.key === cacheKey
    && (now - runtimeSyncCache.syncedAt) < RUNTIME_SYNC_TTL_MS) {
    return runtimeSyncCache.result;
  }

  if (runtimeSyncCache.inFlight && runtimeSyncCache.key === cacheKey) {
    return runtimeSyncCache.inFlight;
  }

  runtimeSyncCache.key = cacheKey;
  runtimeSyncCache.inFlight = (async () => {
    const result = await syncAllManagedQuotas(activeSession);
    runtimeSyncCache.result = result;
    runtimeSyncCache.syncedAt = Date.now();
    runtimeSyncCache.inFlight = null;
    return result;
  })();

  try {
    return await runtimeSyncCache.inFlight;
  } catch (error) {
    runtimeSyncCache.inFlight = null;
    throw error;
  }
}

function buildQuotaSourceStatus(activeSession, syncResult) {
  if (!syncResult) {
    return {
      mode: 'backend_api',
      state: 'idle',
      message: '等待额度同步'
    };
  }

  if (!activeSession || !activeSession.accountId) {
    return {
      mode: 'backend_api',
      state: syncResult.refreshedCount > 0 ? 'online' : 'idle',
      message: syncResult.refreshedCount > 0
        ? `已刷新 ${syncResult.refreshedCount} 个可查询账号`
        : '当前没有活动登录态',
      observedAt: syncResult.observedAt
    };
  }

  const activeUsage = syncResult.activeUsage;
  if (activeUsage && activeUsage.parserStatus === 'ok') {
    return {
      mode: 'backend_api',
      state: 'online',
      message: `已刷新 ${syncResult.refreshedCount} 个可查询账号`,
      observedAt: activeUsage.observedAt || syncResult.observedAt,
      email: activeUsage.email || activeSession.email || null,
      accountId: activeUsage.accountId || activeSession.accountId || null,
      planType: activeUsage.planType || null,
      refreshedCount: syncResult.refreshedCount,
      failedCount: syncResult.failedCount
    };
  }

  return {
    mode: 'backend_api',
    state: syncResult.refreshedCount > 0 ? 'degraded' : 'error',
    message: syncResult.failedCount > 0
      ? `刷新中有 ${syncResult.failedCount} 个账号失败`
      : '后端额度同步失败',
    observedAt: syncResult.observedAt,
    email: activeSession.email || null,
    accountId: activeSession.accountId || null,
    refreshedCount: syncResult.refreshedCount,
    failedCount: syncResult.failedCount
  };
}

function buildRuntimeSummary(slots) {
  return {
    totalAccounts: slots.length,
    authenticatedAccounts: slots.filter((slot) => slot.has_profile).length,
    activeAccounts: slots.filter((slot) => slot.is_active).length,
    expiringSoon: slots.filter((slot) => slot.subscription_status === 'warning').length,
    expiredAccounts: slots.filter((slot) => slot.subscription_status === 'expired').length
  };
}

async function activateSlot(slotId, reason = 'manual_switch') {
  const slot = getSlotById(slotId);
  if (!slot) throw new Error('ACCOUNT_NOT_FOUND');
  const profile = getProfile(slotId);
  if (!profile) throw new Error('PROFILE_NOT_FOUND');

  const previous = getActiveSlot();
  const switchEventId = createSwitchEvent(previous ? previous.id : null, slot.id, reason, 'starting', { reason });
  upsertRuntimeLock('switch_lock', 'app', { slotId }, new Date(Date.now() + config.switchLockMs).toISOString());

  try {
    const result = await activateProfile({
      slotId: slot.id,
      authJson: decryptString(profile.auth_cipher),
      expectedAccountId: profile.account_id || slot.account_id || null,
      expectedIdentityKey: profile.identity_key || slot.identity_key || null
    });

    setActiveSlot(slot.id);
    updateSlot(slot.id, {
      state: 'active',
      account_id: result.accountId || slot.account_id || null,
      identity_key: result.identityKey || profile.identity_key || slot.identity_key || null,
      last_error: null
    });

    try {
      const usageResult = await getUsageStatus();
      updateSlot(slot.id, {
        ...buildQuotaPatch(usageResult.usage, 'active', usageResult.observedAt || nowIso()),
        account_id: usageResult.accountId || usageResult.usage.accountId || result.accountId || slot.account_id || null,
        identity_key: usageResult.identityKey || result.identityKey || profile.identity_key || slot.identity_key || null
      });
      insertQuotaSampleForSlot(slot.id, usageResult.usage, usageResult.observedAt || nowIso());
    } catch (usageError) {
      updateSlot(slot.id, {
        freshness: 'stale',
        last_error: usageError.message
      });
    }

    completeSwitchEvent(switchEventId, 'completed', { accountId: result.accountId || null });
    deleteRuntimeLock('switch_lock');
    invalidateRuntimeSyncCache();
    broadcast('admins', 'runtime_updated', { reason: 'activate_slot', slotId: slot.id });
    writeAudit('slot.activated', { slotId: slot.id, reason });
    return result;
  } catch (error) {
    completeSwitchEvent(switchEventId, 'failed', { error: error.message });
    deleteRuntimeLock('switch_lock');
    updateSlot(slot.id, { state: 'error', last_error: error.message });
    broadcast('admins', 'runtime_updated', { reason: 'activate_slot_failed', slotId: slot.id, error: error.message });
    writeAudit('slot.activate_failed', { slotId: slot.id, reason, error: error.message });
    throw error;
  }
}

async function maybeAutoSwitch() {
  return false;
}

async function logoutSlot(slotId) {
  const slot = getSlotById(slotId);
  if (!slot) throw new Error('ACCOUNT_NOT_FOUND');

  if (slot.is_active) {
    await logoutActiveAuth();
    setActiveSlot(null);
  }

  deleteProfile(slot.id);
  updateSlot(slot.id, {
    state: isAccountDraft(slot) ? 'draft' : 'auth_required',
    account_id: null,
    identity_key: null,
    quota_5h_pct: null,
    quota_5h_reset_at: null,
    quota_5h_reset_label: null,
    quota_week_pct: null,
    quota_week_reset_at: null,
    quota_week_reset_label: null,
    freshness: 'stale',
    last_error: null,
    is_active: 0
  });
  invalidateRuntimeSyncCache();
  broadcast('admins', 'runtime_updated', { reason: 'logout_slot', slotId: slot.id });
  writeAudit('slot.logged_out', { slotId: slot.id });
}

function buildProbeStatusPatch(result) {
  const observedAt = result && result.observedAt ? result.observedAt : nowIso();
  const probe = result && result.probe ? result.probe : {};
  const details = [
    probe.lastMessage || '',
    probe.stderrTail || '',
    probe.stdoutTail || ''
  ].filter(Boolean).join('\n');
  return {
    last_probe_at: observedAt,
    last_probe_status: probe.ok ? 'ok' : 'error',
    last_probe_error: probe.ok ? null : (details || `Probe failed${probe.exitCode != null ? ` (exit ${probe.exitCode})` : ''}`),
    last_probe_message: probe.ok ? (probe.lastMessage || 'OK') : (details || '')
  };
}

async function refreshStoredProfileTokensForSlot(slot) {
  const profile = getProfile(slot.id);
  if (!profile) return null;
  const result = await refreshProfileTokens({
    authJson: decryptString(profile.auth_cipher),
    expectedAccountId: profile.account_id || slot.account_id || null,
    expectedIdentityKey: profile.identity_key || slot.identity_key || null
  });
  upsertProfile(
    slot.id,
    encryptString(result.authJson),
    result.accountId || slot.account_id || null,
    result.identityKey || profile.identity_key || slot.identity_key || null
  );
  updateSlot(slot.id, {
    account_id: result.accountId || slot.account_id || null,
    identity_key: result.identityKey || slot.identity_key || null,
    last_error: null
  });
  return result;
}

async function keepProfilesWarm() {
  const slots = listSlots().filter((slot) => slot.has_profile);
  let refreshedCount = 0;
  let failedCount = 0;
  let observedAt = nowIso();

  for (const slot of slots) {
    try {
      const result = await refreshStoredProfileTokensForSlot(slot);
      if (result) {
        refreshedCount += 1;
        observedAt = nowIso();
      }
    } catch (error) {
      failedCount += 1;
      writeAudit('profile.keepalive_failed', { slotId: slot.id, message: error.message });
    }
  }

  upsertRuntimeLock('profile_keepalive_status', 'app', {
    refreshedCount,
    failedCount,
    observedAt
  }, null);
  return { refreshedCount, failedCount, observedAt };
}

async function probeManagedAccount(slotId, mode = 'manual') {
  const slot = getSlotById(slotId);
  if (!slot) throw new Error('ACCOUNT_NOT_FOUND');
  const profile = getProfile(slot.id);
  if (!profile) throw new Error('PROFILE_NOT_FOUND');

  updateSlot(slot.id, {
    last_probe_status: 'pending',
    last_probe_error: null
  });

  try {
    const result = await probeProfile({
      authJson: decryptString(profile.auth_cipher),
      expectedAccountId: profile.account_id || slot.account_id || null,
      expectedIdentityKey: profile.identity_key || slot.identity_key || null
    });
    upsertProfile(
      slot.id,
      encryptString(result.authJson),
      result.accountId || slot.account_id || null,
      result.identityKey || profile.identity_key || slot.identity_key || null
    );
    updateSlot(slot.id, {
      account_id: result.accountId || slot.account_id || null,
      identity_key: result.identityKey || slot.identity_key || null,
      ...buildProbeStatusPatch(result)
    });
    writeAudit('probe.completed', {
      slotId: slot.id,
      mode,
      ok: result.probe.ok,
      exitCode: result.probe.exitCode,
      timedOut: result.probe.timedOut
    });
    return result;
  } catch (error) {
    const observedAt = nowIso();
    updateSlot(slot.id, {
      last_probe_at: observedAt,
      last_probe_status: 'error',
      last_probe_error: error.message,
      last_probe_message: ''
    });
    writeAudit('probe.failed', { slotId: slot.id, mode, message: error.message });
    throw error;
  }
}

function chooseNextProbeSlot(settings) {
  const pendingBootstrapIds = new Set(
    listBootstrapSessions(50)
      .filter((session) => ['starting', 'awaiting_user', 'success_pending_capture', 'succeeded'].includes(session.status))
      .map((session) => session.slot_id)
  );
  return listSlots()
    .filter((slot) => slot.has_profile && !pendingBootstrapIds.has(slot.id))
    .sort((left, right) => {
      const leftTime = left.last_probe_at ? new Date(left.last_probe_at).getTime() : 0;
      const rightTime = right.last_probe_at ? new Date(right.last_probe_at).getTime() : 0;
      return leftTime - rightTime;
    })
    .find((slot) => {
      if (!slot.last_probe_at) return true;
      return (Date.now() - new Date(slot.last_probe_at).getTime()) >= settings.availabilityProbeIntervalMs;
    }) || null;
}

async function maybeRunAvailabilityProbe() {
  const settings = resolveAppSettings();
  if (!settings.availabilityProbeEnabled) return null;
  if (getRuntimeLock('switch_lock')) return null;
  if (getLatestActiveBootstrapSession()) return null;
  const runningProbe = getRuntimeLock('availability_probe_lock');
  if (runningProbe) return null;

  const nextSlot = chooseNextProbeSlot(settings);
  if (!nextSlot) return null;

  upsertRuntimeLock('availability_probe_lock', 'app', { slotId: nextSlot.id }, new Date(Date.now() + 5 * 60 * 1000).toISOString());
  try {
    const result = await probeManagedAccount(nextSlot.id, 'auto');
    upsertRuntimeLock('availability_probe_status', 'app', {
      slotId: nextSlot.id,
      observedAt: result.observedAt,
      ok: result.probe.ok
    }, null);
    return result;
  } finally {
    deleteRuntimeLock('availability_probe_lock');
  }
}

async function deleteManagedAccount(slotId) {
  const slot = getSlotById(slotId);
  if (!slot) throw new Error('ACCOUNT_NOT_FOUND');
  if (slot.is_active) throw new Error('ACTIVE_ACCOUNT_CANNOT_BE_DELETED');
  const relatedBootstrapSessions = listBootstrapSessions(200).filter((session) => session.slot_id === slot.id);
  for (const session of relatedBootstrapSessions) {
    await deleteBootstrapTask(session.id);
  }
  deleteProfile(slot.id);
  deleteAccount(slot.id);
  invalidateRuntimeSyncCache();
  broadcast('admins', 'runtime_updated', { reason: 'account_deleted', slotId: slot.id });
  writeAudit('account.deleted', { slotId: slot.id, email: slot.email || null });
}

async function deleteBootstrapTask(bootstrapId) {
  const session = getBootstrapSession(bootstrapId);
  if (!session) return;

  await cancelBootstrap({ bootstrapId: session.id });
  deleteBootstrapSession(session.id);
  const slot = getSlotById(session.slot_id);
  if (slot) {
    updateSlot(session.slot_id, {
      state: deriveSlotState(slot),
      last_error: null
    });
  }
  invalidateRuntimeSyncCache();
  broadcast('admins', 'runtime_updated', { reason: 'bootstrap_deleted', bootstrapId: session.id });
  writeAudit('bootstrap.deleted', { bootstrapId: session.id, slotId: session.slot_id, status: session.status });
}

async function clearBootstrapTasks() {
  const sessions = listBootstrapSessions(200);
  for (const session of sessions) {
    await deleteBootstrapTask(session.id);
  }
  return sessions.length;
}

function cleanupCapturedBootstrapSessions() {
  const capturedSessions = listBootstrapSessions(200).filter((session) => session.status === 'captured');
  if (!capturedSessions.length) return 0;

  for (const session of capturedSessions) {
    deleteBootstrapSession(session.id);
    writeAudit('bootstrap.captured_session_cleared', { bootstrapId: session.id, slotId: session.slot_id });
  }

  invalidateRuntimeSyncCache();
  return capturedSessions.length;
}

function cleanupStaleBootstrapSessions() {
  const staleSessions = listBootstrapSessions(50).filter((session) => {
    const failureText = `${session.error_text || ''}\n${session.log_tail || ''}`;
    return isBootstrapNotFoundText(failureText) || isAgentRestartBootstrapError(failureText);
  });

  if (!staleSessions.length) return 0;

  for (const session of staleSessions) {
    deleteBootstrapSession(session.id);
    const slot = getSlotById(session.slot_id);
    if (slot) {
      updateSlot(session.slot_id, {
        state: deriveSlotState(slot),
        last_error: null
      });
    }
    writeAudit('bootstrap.stale_session_cleared', { bootstrapId: session.id, slotId: session.slot_id });
  }

  invalidateRuntimeSyncCache();
  return staleSessions.length;
}

async function syncPendingBootstrapSessions() {
  let changed = false;
  const sessions = listBootstrapSessions(20).filter((session) => ['starting', 'awaiting_user', 'success_pending_capture', 'succeeded'].includes(session.status));

  for (const session of sessions) {
    try {
      const status = await getBootstrapStatus(session.id);
      const nextPatch = {
        status: status.status,
        device_code: status.deviceCode || session.device_code,
        verification_uri: status.verificationUri || session.verification_uri,
        log_tail: status.logTail || session.log_tail
      };
      if (status.error) nextPatch.error_text = status.error;
      updateBootstrapSession(session.id, nextPatch);
      changed = true;

      if (status.status === 'succeeded' || status.status === 'success_pending_capture') {
        const captured = await captureAuthProfile({ bootstrapId: session.id });
        const currentSlot = getSlotById(session.slot_id);
        const duplicateSlot = findDuplicateBootstrapSlot(session.slot_id, captured);
        if (currentSlot && duplicateSlot) {
          const duplicateMessage = buildDuplicateBootstrapMessage(currentSlot, duplicateSlot, captured);
          const shouldRetry = shouldRetryDuplicateBootstrap(currentSlot, captured);
          await cancelBootstrap({ bootstrapId: session.id });
          updateSlot(session.slot_id, buildBootstrapConflictSlotPatch(currentSlot, duplicateMessage));
          invalidateRuntimeSyncCache();

          if (shouldRetry) {
            const restarted = await startDeviceAuth({
              bootstrapId: session.id,
              slotId: session.slot_id
            });
            updateBootstrapSession(session.id, {
              status: restarted.status || 'starting',
              device_code: restarted.deviceCode || null,
              verification_uri: restarted.verificationUri || session.verification_uri,
              error_text: duplicateMessage,
              completed_at: null,
              log_tail: status.logTail || session.log_tail
            });
          } else {
            updateBootstrapSession(session.id, {
              status: 'failed',
              error_text: duplicateMessage,
              completed_at: nowIso(),
              log_tail: status.logTail || session.log_tail
            });
          }

          writeAudit('bootstrap.duplicate_account', {
            bootstrapId: session.id,
            slotId: session.slot_id,
            duplicateSlotId: duplicateSlot.id,
            accountId: captured.accountId,
            identityKey: captured.identityKey || null,
            capturedEmail: captured.email || null,
            retryable: shouldRetry
          });
          continue;
        }
        upsertProfile(
          session.slot_id,
          encryptString(captured.authJson),
          captured.accountId || null,
          captured.identityKey || null
        );
        updateSlot(session.slot_id, {
          state: 'ready',
          account_id: captured.accountId || null,
          identity_key: captured.identityKey || null,
          last_bootstrap_at: nowIso(),
          last_error: null
        });
        invalidateRuntimeSyncCache();
        deleteBootstrapSession(session.id);
        writeAudit('bootstrap.captured', { bootstrapId: session.id, slotId: session.slot_id });
      } else if (status.status === 'failed') {
        const bootstrapFailureText = `${status.error || ''}\n${status.logTail || ''}\n${session.error_text || ''}\n${session.log_tail || ''}`;
        if (isBootstrapNotFoundText(bootstrapFailureText)) {
          deleteBootstrapSession(session.id);
          const slot = getSlotById(session.slot_id);
          if (slot) {
            updateSlot(session.slot_id, {
              state: deriveSlotState(slot),
              last_error: null
            });
          }
          writeAudit('bootstrap.stale_session_cleared', { bootstrapId: session.id, slotId: session.slot_id });
          changed = true;
          continue;
        }
        updateSlot(session.slot_id, { state: 'auth_required', last_error: status.error || 'bootstrap failed' });
        if (isDeviceAuthRateLimitedText(status.error || status.logTail || session.error_text || session.log_tail)) {
          upsertRuntimeLock(
            'device_auth_cooldown',
            'openai_rate_limit',
            { error: status.error || session.error_text || 'device auth rate limited' },
            new Date(Date.now() + DEVICE_AUTH_COOLDOWN_MS).toISOString()
          );
        }
      }
    } catch (error) {
      updateBootstrapSession(session.id, {
        status: 'failed',
        error_text: error.message,
        completed_at: nowIso()
      });
      updateSlot(session.slot_id, { state: 'auth_required', last_error: error.message });
      writeAudit('bootstrap.sync_failed', { bootstrapId: session.id, error: error.message });
      changed = true;
    }
  }

  return changed;
}

async function buildRuntimeSnapshot(options = {}) {
  const skipQuotaSync = options.skipQuotaSync === true;
  const activeSession = await reconcileActiveSlotFromAgent();
  const settings = resolveAppSettings();
  await syncPendingBootstrapSessions();
  cleanupStaleBootstrapSessions();
  cleanupCapturedBootstrapSessions();
  let syncResult = null;
  if (!skipQuotaSync) {
    syncResult = await getManagedQuotaSync(activeSession);
  } else {
    const cacheKey = runtimeSyncCacheKey(activeSession);
    if (runtimeSyncCache.result && runtimeSyncCache.key === cacheKey) {
      syncResult = runtimeSyncCache.result;
    } else {
      syncResult = emptyQuotaSyncResult();
    }
  }
  if (enforceUniqueManagedProfiles()) {
    invalidateRuntimeSyncCache();
  }

  const bootstrapSessions = listBootstrapSessions(10).map((session) => ({
    ...session,
    auth_open_url: buildManagedAuthUrl(
      session.verification_uri || config.authDeviceUrl,
      session.email || ''
    )
  }));
  const pendingSlotIds = new Set(
    bootstrapSessions
      .filter((session) => ['starting', 'awaiting_user', 'success_pending_capture', 'succeeded'].includes(session.status))
      .map((session) => session.slot_id)
  );

  const slots = listSlots().map((slot) => ({
    ...serializeSlot(slot),
    has_pending_bootstrap: pendingSlotIds.has(slot.id)
  }));
  const activeUsage = syncResult && syncResult.activeUsage ? syncResult.activeUsage : null;
  const activeSlot = slots.find((slot) => slot.is_active) || buildDetectedActiveSlot(activeSession, activeUsage);
  const deviceAuthCooldown = getActiveDeviceAuthCooldownLock();

  return {
    now: nowIso(),
    serverTimeZone: config.serverTimeZone,
    settings,
    activeSlot,
    activeSession,
    driftStatus: activeSession && activeSession.drift ? activeSession.drift : null,
    quotaSource: buildQuotaSourceStatus(activeSession, syncResult),
    summary: buildRuntimeSummary(slots),
    slots,
    bootstrapSessions,
    deviceAuthCooldown,
    switchLock: getRuntimeLock('switch_lock'),
    maintenance: {
      profileKeepalive: getRuntimeLock('profile_keepalive_status'),
      availabilityProbe: getRuntimeLock('availability_probe_status')
    }
  };
}

module.exports = {
  activateSlot,
  buildRuntimeSnapshot,
  clearBootstrapTasks,
  chooseNextAvailableSlot,
  deleteBootstrapTask,
  deleteManagedAccount,
  deriveSlotState,
  dispatchBrowserAction,
  keepProfilesWarm,
  logoutSlot,
  maybeRunAvailabilityProbe,
  maybeAutoSwitch,
  invalidateRuntimeSyncCache,
  probeManagedAccount,
  reconcileActiveSlotFromAgent,
  resolveAppSettings,
  serializeSlot,
  syncPendingBootstrapSessions,
  updateAppSettings,
  buildDuplicateBootstrapMessage,
  buildDuplicateProfileMessage,
  buildProfileEmailMismatchMessage
};
