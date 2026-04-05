'use strict';

const crypto = require('crypto');

const {
  completeSwitchEvent,
  createAuthProfile,
  createBridgeAction,
  createResumeIntent,
  createSwitchEvent,
  deleteAccount,
  deleteAuthProfile,
  deleteBootstrapSession,
  deleteProfile,
  getBridgeActionById,
  getBridgeSessionById,
  getAuthProfileById,
  getAuthProfileByIdentityKey,
  getActiveSlot,
  getBootstrapSession,
  getProfile,
  getPrimaryAuthProfileForSlot,
  getResumeIntentById,
  getRuntimeLock,
  getSlotByIdentityKey,
  getSlotByEmail,
  getSlotById,
  insertQuotaSample,
  listAuthProfilesForSlot,
  listBootstrapSessions,
  listBridgeActionsForSession,
  listBridgeSessions,
  listResumeIntents,
  listSlots,
  nowIso,
  setPrimaryAuthProfile,
  setActiveSlot,
  syncSlotAuthAggregate,
  updateBridgeAction,
  updateBridgeSession,
  updateAuthProfile,
  updateBootstrapSession,
  updateResumeIntent,
  updateSlot,
  upsertBridgeSession,
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
  startDeviceAuth,
  getUsageForProfile,
  getUsageStatus,
  logoutActiveAuth
} = require('./agent-client');
const { decryptString, encryptString } = require('./security');
const { broadcast } = require('./sse');
const { writeAudit } = require('./audit');
const { config } = require('./config');
const { buildManagedAuthUrl } = require('./auth-workspace-shared');

const DAY_MS = 24 * 60 * 60 * 1000;
const DEVICE_AUTH_COOLDOWN_MS = 60 * 1000;
const RUNTIME_SYNC_TTL_MS = Math.max(5000, Math.min(config.quotaSampleIntervalMs || (2 * 60 * 1000), 15000));
const RUNTIME_REFRESH_LOCK = 'runtime_refresh';
const OPERATION_QUEUE_LOCK = 'runtime_operation';
const RUNTIME_SETTINGS_LOCK = 'runtime_settings';
const AUTO_SWITCH_ALERT_LOCK = 'auto_switch_alert';
const AUTO_SWITCH_STATUS_LOCK = 'auto_switch_status';
const ACTIVE_AUTH_GENERATION_LOCK = 'active_auth_generation';
const REFRESH_STALE_MS = Math.max(5000, config.quotaSampleIntervalMs || 30000);
const BRIDGE_SESSION_TTL_MS = 2 * 60 * 1000;
const BRIDGE_SESSION_KIND_INTERACTIVE = 'interactive_default';
const BRIDGE_SESSION_KIND_MANAGED_REPO = 'managed_repo';
const OPEN_RESUME_INTENT_STATUSES = new Set(['pending', 'switching', 'recovering', 'resuming']);
const RESUME_FALLBACK_PROMPT = '中断了，请继续严格按照原来规划完成全部任务';
const RETRYABLE_USAGE_ERROR_KINDS = new Set(['usage_timeout', 'upstream_503', 'agent_timeout']);
const TERMINAL_USAGE_ERROR_KINDS = new Set(['deactivated_workspace', 'refresh_token_reused', 'auth_invalid']);
const BOOTSTRAP_INTENTS = {
  createWorkspace: 'create_workspace',
  reauthWorkspace: 'reauth_workspace',
  reauthPrimary: 'reauth_primary'
};
const runtimeSchedulerState = {
  refreshPromise: null,
  refreshCursor: 0,
  operationPromise: Promise.resolve()
};

let runtimeSyncCache = {
  key: '',
  syncedAt: 0,
  result: null,
  inFlight: null
};

const defaultInteractiveWorkspacePath = (() => {
  try {
    const url = new URL(config.codeWorkspaceUrl);
    return decodeURIComponent(url.searchParams.get('workspace') || url.searchParams.get('folder') || '').trim();
  } catch (_) {
    return '';
  }
})();

function hasResetElapsed(resetAt) {
  return !!resetAt && new Date(resetAt).getTime() <= Date.now();
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeWorkspaceLabel(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeBridgeText(value) {
  const text = String(value || '').trim();
  return text || null;
}

function parseBridgePageUrl(value) {
  const text = normalizeBridgeText(value);
  if (!text) return null;
  try {
    return new URL(text, config.codeOrigin);
  } catch (_) {
    return null;
  }
}

function resolveBridgeWorkspacePath(pageUrl) {
  const parsed = parseBridgePageUrl(pageUrl);
  if (!parsed) return '';
  return decodeURIComponent(parsed.searchParams.get('workspace') || parsed.searchParams.get('folder') || '').trim();
}

function deriveBridgeWorkspaceKind(input = {}) {
  const explicitKind = normalizeBridgeText(input.workspaceKind);
  if (explicitKind === BRIDGE_SESSION_KIND_INTERACTIVE || explicitKind === BRIDGE_SESSION_KIND_MANAGED_REPO) {
    return explicitKind;
  }
  const workspacePath = resolveBridgeWorkspacePath(input.pageUrl);
  if (!workspacePath) return 'unknown';
  if (defaultInteractiveWorkspacePath && workspacePath === defaultInteractiveWorkspacePath) {
    return BRIDGE_SESSION_KIND_INTERACTIVE;
  }
  return BRIDGE_SESSION_KIND_MANAGED_REPO;
}

function isBridgeSessionFresh(session) {
  if (!session || !session.last_seen_at) return false;
  const ageMs = Date.now() - new Date(session.last_seen_at).getTime();
  return Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= BRIDGE_SESSION_TTL_MS;
}

function sortBridgeSessionsForRecovery(sessions = []) {
  return [...sessions].sort((left, right) => {
    if (!!right.focused !== !!left.focused) return right.focused ? 1 : -1;
    if (!!right.visible !== !!left.visible) return right.visible ? 1 : -1;
    const rightSeen = new Date(right.last_seen_at || right.updated_at || 0).getTime();
    const leftSeen = new Date(left.last_seen_at || left.updated_at || 0).getTime();
    if (rightSeen !== leftSeen) return rightSeen - leftSeen;
    return String(right.id || '').localeCompare(String(left.id || ''), 'zh-CN');
  });
}

function getPrimaryInteractiveBridgeSession() {
  const sessions = listBridgeSessions(BRIDGE_SESSION_KIND_INTERACTIVE)
    .filter(isBridgeSessionFresh);
  return sortBridgeSessionsForRecovery(sessions)[0] || null;
}

function getOpenResumeIntent() {
  return listResumeIntents([...OPEN_RESUME_INTENT_STATUSES], 10)[0] || null;
}

function getResumeIntentForSession(sessionId) {
  if (!sessionId) return null;
  return listResumeIntents([...OPEN_RESUME_INTENT_STATUSES], 20)
    .find((intent) => intent.bridge_session_id === sessionId) || null;
}

function compactBridgeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function isFallbackOnlyPrompt(text, fallback = RESUME_FALLBACK_PROMPT) {
  const normalizedText = compactBridgeText(text);
  const normalizedFallback = compactBridgeText(fallback);
  if (!normalizedText || !normalizedFallback) return false;
  const remainder = normalizedText.split(normalizedFallback).join(' ').replace(/\s+/g, ' ').trim();
  return remainder.length === 0;
}

function collapseFallbackPromptEcho(text, fallback = RESUME_FALLBACK_PROMPT) {
  const normalizedText = normalizeBridgeText(text);
  if (!normalizedText) return null;
  return isFallbackOnlyPrompt(normalizedText, fallback) ? fallback : normalizedText;
}

function buildRecoveryPrompt(intent, options = {}) {
  const fallback = normalizeBridgeText(options.recoverySummary || intent?.recovery_summary || RESUME_FALLBACK_PROMPT) || RESUME_FALLBACK_PROMPT;
  const basePrompt = collapseFallbackPromptEcho(
    options.prompt
    || intent?.original_prompt
    || intent?.draft_prompt
    || intent?.latest_request,
    fallback
  );
  if (!basePrompt) return fallback;
  if (options.appendFallback) {
    if (compactBridgeText(basePrompt).includes(compactBridgeText(fallback))) return basePrompt;
    return `${basePrompt}\n\n${fallback}`;
  }
  return basePrompt;
}

function getActiveAuthGeneration() {
  const lock = getRuntimeLock(ACTIVE_AUTH_GENERATION_LOCK);
  const value = lock && lock.payload ? Number(lock.payload.value || 0) : 0;
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function bumpActiveAuthGeneration(reason, detail = {}) {
  const nextValue = getActiveAuthGeneration() + 1;
  upsertRuntimeLock(ACTIVE_AUTH_GENERATION_LOCK, 'interactive_recovery', {
    value: nextValue,
    reason: reason || 'unknown',
    detail,
    updated_at: nowIso()
  }, null);
  return nextValue;
}

function ensureBridgeAction(sessionId, actionType, payload = {}, options = {}) {
  if (!sessionId || !actionType) return null;
  const matcher = typeof options.matcher === 'function' ? options.matcher : null;
  const existing = listBridgeActionsForSession(sessionId, ['queued', 'dispatched'])
    .find((item) => item.action_type === actionType && (!matcher || matcher(item.payload || {}, item)));
  if (existing) return existing;
  const action = createBridgeAction({
    bridge_session_id: sessionId,
    action_type: actionType,
    payload,
    status: 'queued'
  });
  return dispatchBridgeAction(action.id);
}

function dispatchBridgeAction(actionId) {
  const action = typeof actionId === 'object' && actionId ? actionId : getBridgeActionById(actionId);
  if (!action) return null;
  const nextAction = action.status === 'queued'
    ? updateBridgeAction(action.id, { status: 'dispatched', sent_at: nowIso() })
    : action;
  broadcast(`bridge:${nextAction.bridge_session_id}`, 'bridge_action', nextAction);
  return nextAction;
}

function replayBridgeActionsForSession(sessionId) {
  return listBridgeActionsForSession(sessionId, ['queued', 'dispatched']).map((action) => dispatchBridgeAction(action.id));
}

function rebindOpenResumeIntent(primarySessionId) {
  const intent = getOpenResumeIntent();
  if (!intent) return null;
  if (primarySessionId && intent.bridge_session_id !== primarySessionId) {
    return updateResumeIntent(intent.id, { bridge_session_id: primarySessionId });
  }
  return intent;
}

function buildInteractiveRecoverySummary() {
  const primarySession = getPrimaryInteractiveBridgeSession();
  const intent = primarySession
    ? (getResumeIntentForSession(primarySession.id) || getOpenResumeIntent())
    : getOpenResumeIntent();
  const autoSwitchStatus = getAutoSwitchStatus();
  return {
    activeAuthGeneration: getActiveAuthGeneration(),
    primaryBridgeSession: primarySession ? {
      id: primarySession.id,
      workspaceKind: primarySession.workspace_kind,
      pageUrl: primarySession.page_url || null,
      focused: !!primarySession.focused,
      visible: !!primarySession.visible,
      running: !!primarySession.running,
      authRequired: !!primarySession.auth_required,
      sendEnabled: !!primarySession.send_enabled,
      threadTitle: primarySession.thread_title || '',
      lastSeenAt: primarySession.last_seen_at || null,
      lastRecoveredAt: primarySession.last_recovered_at || null,
      interruptionReason: primarySession.interruption_reason || null,
      activeAuthGenerationSeen: Number(primarySession.active_auth_generation_seen || 0)
    } : null,
    pendingResumeIntent: intent ? {
      id: intent.id,
      status: intent.status,
      reason: intent.reason,
      sourceSlotId: intent.source_slot_id || null,
      targetSlotId: intent.target_slot_id || null,
      createdAt: intent.created_at || null,
      sentAt: intent.sent_at || null,
      ackedAt: intent.acked_at || null
    } : null,
    lastInterruptionReason: (intent && intent.reason) || (primarySession && primarySession.interruption_reason) || null,
    switchTargetSlotId: autoSwitchStatus && autoSwitchStatus.to_slot_id ? autoSwitchStatus.to_slot_id : null,
    state: intent
      ? intent.status
      : autoSwitchStatus && autoSwitchStatus.state
        ? autoSwitchStatus.state
        : 'idle'
  };
}

function maybeCreateOrRefreshResumeIntent(session, payload = {}) {
  if (!session || session.workspace_kind !== BRIDGE_SESSION_KIND_INTERACTIVE) return null;
  const interruptionReason = normalizeBridgeText(payload.interruptionReason);
  if (!interruptionReason) return null;
  const draftPrompt = normalizeBridgeText(payload.draftPrompt);
  const latestRequest = normalizeBridgeText(payload.latestRequest);
  if (
    interruptionReason === 'composer_unavailable'
    && isFallbackOnlyPrompt(draftPrompt || latestRequest || '', RESUME_FALLBACK_PROMPT)
  ) {
    return null;
  }
  if (
    interruptionReason === 'composer_unavailable'
    && /PROMPT_INPUT_NOT_ACCEPTED/i.test(String(session.last_error || ''))
    && isFallbackOnlyPrompt(draftPrompt || latestRequest || '', RESUME_FALLBACK_PROMPT)
  ) {
    return null;
  }
  const primarySession = getPrimaryInteractiveBridgeSession() || session;
  const openIntent = getOpenResumeIntent();
  const intentPayload = {
    bridge_session_id: primarySession.id,
    reason: interruptionReason,
    source_slot_id: getActiveSlot() ? getActiveSlot().id : null,
    original_prompt: collapseFallbackPromptEcho(draftPrompt || latestRequest || null, RESUME_FALLBACK_PROMPT),
    draft_prompt: collapseFallbackPromptEcho(draftPrompt, RESUME_FALLBACK_PROMPT),
    latest_request: collapseFallbackPromptEcho(latestRequest, RESUME_FALLBACK_PROMPT),
    latest_response: normalizeBridgeText(payload.latestResponse),
    recovery_summary: RESUME_FALLBACK_PROMPT,
    status: 'pending'
  };
  if (openIntent) {
    return updateResumeIntent(openIntent.id, intentPayload);
  }
  return createResumeIntent(intentPayload);
}

function maybeDispatchInteractiveRecovery(context = {}) {
  const primarySession = getPrimaryInteractiveBridgeSession();
  if (!primarySession) return null;
  const currentGeneration = getActiveAuthGeneration();
  if (currentGeneration > Number(primarySession.active_auth_generation_seen || 0)) {
    ensureBridgeAction(primarySession.id, 'auth_switched', {
      activeAuthGeneration: currentGeneration,
      reason: context.reason || 'auth_switched',
      targetSlotId: context.targetSlotId || null,
      targetAuthProfileId: context.targetAuthProfileId || null
    }, {
      matcher: (payload) => Number(payload.activeAuthGeneration || 0) === currentGeneration
    });
  }
  const intent = rebindOpenResumeIntent(primarySession.id);
  if (!intent) return null;
  if (!OPEN_RESUME_INTENT_STATUSES.has(intent.status)) return intent;
  updateResumeIntent(intent.id, {
    bridge_session_id: primarySession.id,
    target_slot_id: context.targetSlotId || intent.target_slot_id || null,
    status: 'recovering'
  });
  ensureBridgeAction(primarySession.id, 'recover_same_thread', {
    resumeIntentId: intent.id,
    activeAuthGeneration: currentGeneration,
    targetSlotId: context.targetSlotId || intent.target_slot_id || null,
    targetAuthProfileId: context.targetAuthProfileId || null,
    reason: intent.reason,
    recoverySummary: intent.recovery_summary || RESUME_FALLBACK_PROMPT
  }, {
    matcher: (payload) => payload.resumeIntentId === intent.id
  });
  return getResumeIntentById(intent.id);
}

function handleBridgeActionProgress(action, status, result = {}) {
  const payload = action.payload || {};
  const intent = payload.resumeIntentId ? getResumeIntentById(payload.resumeIntentId) : null;
  if (!intent) return action;

  if (action.action_type === 'recover_same_thread') {
    if (status === 'completed' && result.canResume !== false && !result.fallbackRequired) {
      updateResumeIntent(intent.id, { status: 'resuming' });
      ensureBridgeAction(action.bridge_session_id, 'resume_prompt', {
        resumeIntentId: intent.id,
        prompt: buildRecoveryPrompt(intent),
        latestRequest: intent.latest_request || null,
        latestResponse: intent.latest_response || null,
        recoverySummary: intent.recovery_summary || RESUME_FALLBACK_PROMPT
      }, {
        matcher: (existingPayload) => existingPayload.resumeIntentId === intent.id
      });
      return action;
    }
    updateResumeIntent(intent.id, { status: 'resuming' });
    ensureBridgeAction(action.bridge_session_id, 'open_new_thread_and_resume', {
      resumeIntentId: intent.id,
      prompt: buildRecoveryPrompt(intent, { appendFallback: true }),
      latestRequest: intent.latest_request || null,
      latestResponse: intent.latest_response || null,
      recoverySummary: intent.recovery_summary || RESUME_FALLBACK_PROMPT
    }, {
      matcher: (existingPayload) => existingPayload.resumeIntentId === intent.id
    });
    return action;
  }

  if (action.action_type === 'resume_prompt' || action.action_type === 'open_new_thread_and_resume') {
    if (status === 'completed') {
      updateResumeIntent(intent.id, {
        status: 'completed',
        sent_at: intent.sent_at || nowIso(),
        acked_at: nowIso()
      });
      updateBridgeSession(action.bridge_session_id, {
        interruption_reason: null,
        last_error: null,
        last_recovered_at: nowIso()
      });
      return action;
    }
    if (status === 'skipped' && result.duplicate) {
      updateResumeIntent(intent.id, {
        status: 'cancelled',
        acked_at: nowIso()
      });
      updateBridgeSession(action.bridge_session_id, {
        interruption_reason: null,
        last_error: null,
        last_recovered_at: nowIso()
      });
      return action;
    }
    if (action.action_type === 'resume_prompt' && result.fallbackRequired) {
      ensureBridgeAction(action.bridge_session_id, 'open_new_thread_and_resume', {
        resumeIntentId: intent.id,
        prompt: buildRecoveryPrompt(intent, { appendFallback: true }),
        latestRequest: intent.latest_request || null,
        latestResponse: intent.latest_response || null,
        recoverySummary: intent.recovery_summary || RESUME_FALLBACK_PROMPT
      }, {
        matcher: (existingPayload) => existingPayload.resumeIntentId === intent.id
      });
      return action;
    }
    updateResumeIntent(intent.id, {
      status: 'failed',
      acked_at: nowIso()
    });
    updateBridgeSession(action.bridge_session_id, {
      last_error: describeErrorValue(result.error || 'BRIDGE_RESUME_FAILED')
    });
  }

  if (action.action_type === 'blocked_all_accounts') {
    updateResumeIntent(intent.id, {
      status: 'blocked',
      acked_at: nowIso()
    });
  }
  return action;
}

function acknowledgeBridgeAction(actionId, payload = {}) {
  const action = getBridgeActionById(actionId);
  if (!action) throw new Error('BRIDGE_ACTION_NOT_FOUND');
  const normalizedStatus = new Set(['completed', 'failed', 'skipped']).has(String(payload.status || '').trim())
    ? String(payload.status || '').trim()
    : 'completed';
  const result = payload && typeof payload.result === 'object' && payload.result
    ? payload.result
    : {};
  const updated = updateBridgeAction(action.id, {
    status: normalizedStatus,
    result,
    acked_at: nowIso()
  });
  handleBridgeActionProgress(updated, normalizedStatus, result);
  return getBridgeActionById(action.id);
}

async function handleBridgeHeartbeat(payload = {}) {
  const sessionId = normalizeBridgeText(payload.sessionId) || `bridge_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const existingSession = getBridgeSessionById(sessionId);
  const workspaceKind = deriveBridgeWorkspaceKind(payload);
  const pageUrl = normalizeBridgeText(payload.pageUrl);
  const session = upsertBridgeSession({
    id: sessionId,
    workspace_kind: workspaceKind,
    page_url: pageUrl,
    visible: !!payload.visible,
    focused: !!payload.focused,
    thread_title: normalizeBridgeText(payload.threadTitle || payload.sessionTitle),
    latest_request: normalizeBridgeText(payload.latestRequest),
    latest_response: normalizeBridgeText(payload.latestResponse),
    draft_prompt: normalizeBridgeText(payload.draftPrompt),
    running: !!payload.running,
    auth_required: !!payload.authRequired,
    send_enabled: !!payload.sendEnabled,
    interruption_reason: normalizeBridgeText(payload.interruptionReason),
    active_auth_generation_seen: Number.isFinite(Number(payload.activeAuthGenerationSeen))
      ? Number(payload.activeAuthGenerationSeen)
      : 0,
    last_user_agent: normalizeBridgeText(payload.userAgent),
    last_seen_at: nowIso(),
    last_error: existingSession ? existingSession.last_error || null : null
  });

  if (workspaceKind === BRIDGE_SESSION_KIND_INTERACTIVE) {
    maybeCreateOrRefreshResumeIntent(session, payload);
    const interruptionReason = normalizeBridgeText(payload.interruptionReason);
    if (interruptionReason && getRuntimeSettings().auto_switch_enabled) {
      void maybeAutoSwitch('bridge_interrupt', {
        bridgeSessionId: session.id,
        interruptionReason
      }).catch((error) => {
        updateBridgeSession(session.id, { last_error: describeErrorValue(error) });
      });
    } else {
      maybeDispatchInteractiveRecovery({ reason: 'bridge_heartbeat' });
    }
  }

  return {
    session: getBridgeSessionById(session.id),
    interactiveRecovery: buildInteractiveRecoverySummary(),
    activeAuthGeneration: getActiveAuthGeneration()
  };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function quotaExhausted(authProfile) {
  return authProfile.quota_5h_pct >= 100
    && authProfile.quota_5h_reset_at
    && !hasResetElapsed(authProfile.quota_5h_reset_at);
}

function deriveAuthRuntimeStatus(profile) {
  if (!profile) return 'stale';
  if (profile.reauth_required) return 'reauth_required';
  if (profile.last_error) return 'error';
  if (profile.is_active) return 'active';
  if (quotaExhausted(profile)) return 'exhausted';
  if (!profile.last_seen_at) return 'stale';
  if (Date.now() - new Date(profile.last_seen_at).getTime() >= REFRESH_STALE_MS) return 'stale';
  return 'ready';
}

function classifyUsageError(error) {
  const message = describeErrorValue(error);
  const lower = message.toLowerCase();
  if (lower.includes('usage_request_timeout') || lower.includes('wham request timed out')) {
    return { kind: 'usage_timeout', terminal: false, retryable: true, message };
  }
  if (lower.includes('agent_request_timeout')) {
    return { kind: 'agent_timeout', terminal: false, retryable: true, message };
  }
  if (lower.includes('deactivated_workspace')) {
    return { kind: 'deactivated_workspace', terminal: true, retryable: false, message };
  }
  if (lower.includes('refresh_token_reused')) {
    return { kind: 'refresh_token_reused', terminal: true, retryable: false, message };
  }
  if (/401|auth_invalid|invalid[_ ]auth|account_id_mismatch|identity_key_mismatch|profile_email_mismatch/i.test(message)) {
    return { kind: 'auth_invalid', terminal: true, retryable: false, message };
  }
  if (/503|service unavailable|bad gateway|gateway timeout|upstream/i.test(message)) {
    return { kind: 'upstream_503', terminal: false, retryable: true, message };
  }
  return { kind: 'unknown', terminal: false, retryable: false, message };
}

function backoffDelayMsFor(failureCount) {
  if (failureCount >= 5) return 5 * 60 * 1000;
  if (failureCount >= 2) return 60 * 1000;
  return 0;
}

function isAuthProfileBackedOff(profile) {
  if (!profile || !profile.backoff_until) return false;
  const time = new Date(profile.backoff_until).getTime();
  return Number.isFinite(time) && time > Date.now();
}

function buildWorkspaceAlreadyExistsMessage(workspaceLabel) {
  const name = String(workspaceLabel || '这个工作区').trim() || '这个工作区';
  return `WORKSPACE_ALREADY_EXISTS: 创建工作区失败，工作区“${name}”已存在，请去对应工作区点重新认证`;
}

function buildWorkspaceReauthMismatchMessage(workspaceLabel) {
  const name = String(workspaceLabel || '目标工作区').trim() || '目标工作区';
  return `WORKSPACE_REAUTH_TARGET_MISMATCH: 当前授权结果不属于“${name}”，系统不会自动覆盖其他工作区；请在正确的工作区卡片里点重新认证`;
}

function describeErrorValue(value) {
  if (value == null) return 'UNKNOWN_BACKEND_ERROR';
  if (value instanceof Error) return describeErrorValue(value.message || value.code || value.name);
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text || text === '[object Object]' || text === '{}' || text === '[]') return 'UNKNOWN_BACKEND_ERROR';
    return text;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object') {
    return describeErrorValue(value.error)
      || describeErrorValue(value.message)
      || describeErrorValue(value.code)
      || (() => {
        try {
          const serialized = JSON.stringify(value);
          return serialized && serialized !== '{}' && serialized !== '[]'
            ? serialized
            : 'UNKNOWN_BACKEND_ERROR';
        } catch (_) {
          return 'UNKNOWN_BACKEND_ERROR';
        }
      })();
  }
  const text = String(value).trim();
  return text || 'UNKNOWN_BACKEND_ERROR';
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

function buildRuntimeSettingsPayload(patch = {}) {
  return {
    auto_switch_enabled: !!config.autoSwitchEnabled,
    updated_at: nowIso(),
    ...patch
  };
}

function getRuntimeSettings() {
  const lock = getRuntimeLock(RUNTIME_SETTINGS_LOCK);
  if (!lock || !lock.payload) return buildRuntimeSettingsPayload();
  return buildRuntimeSettingsPayload(lock.payload);
}

function updateRuntimeSettings(patch = {}) {
  const payload = buildRuntimeSettingsPayload({
    ...getRuntimeSettings(),
    ...patch,
    updated_at: nowIso()
  });
  upsertRuntimeLock(RUNTIME_SETTINGS_LOCK, 'runtime_preferences', payload, null);
  return payload;
}

function buildRuntimeAlertPayload(patch = {}) {
  return {
    id: patch.id || crypto.randomUUID(),
    kind: patch.kind || 'notice',
    title: patch.title || '系统提示',
    message: patch.message || '',
    created_at: patch.created_at || nowIso(),
    ...patch
  };
}

function getRuntimeAlerts() {
  const lock = getRuntimeLock(AUTO_SWITCH_ALERT_LOCK);
  if (!lock || !lock.payload) return [];
  return [buildRuntimeAlertPayload(lock.payload)];
}

function upsertRuntimeAlert(patch = {}) {
  const payload = buildRuntimeAlertPayload(patch);
  upsertRuntimeLock(AUTO_SWITCH_ALERT_LOCK, 'runtime_alerts', payload, null);
  return payload;
}

function clearRuntimeAlert() {
  deleteRuntimeLock(AUTO_SWITCH_ALERT_LOCK);
}

function acknowledgeRuntimeAlert(alertId) {
  const alerts = getRuntimeAlerts();
  const current = alerts[0] || null;
  if (current && current.id === alertId) {
    clearRuntimeAlert();
    return true;
  }
  return false;
}

function buildRuntimeRefreshPayload(patch = {}) {
  return {
    state: 'idle',
    trigger: 'startup',
    started_at: null,
    finished_at: null,
    next_refresh_at: null,
    last_duration_ms: null,
    refreshed_count: 0,
    failed_count: 0,
    plan_type: null,
    last_error: null,
    ...patch
  };
}

function setRuntimeRefreshState(patch = {}, expiresAt = null) {
  const current = getRuntimeLock(RUNTIME_REFRESH_LOCK);
  const payload = buildRuntimeRefreshPayload({
    ...(current && current.payload ? current.payload : {}),
    ...patch
  });
  upsertRuntimeLock(
    RUNTIME_REFRESH_LOCK,
    'runtime_scheduler',
    payload,
    expiresAt
  );
  return payload;
}

function getRuntimeRefreshState() {
  const lock = getRuntimeLock(RUNTIME_REFRESH_LOCK);
  return lock && lock.payload ? buildRuntimeRefreshPayload(lock.payload) : buildRuntimeRefreshPayload();
}

function isSlotSnapshotStale(slot) {
  if (!slot || !slot.has_profile) return false;
  if (!slot.last_seen_at) return true;
  const ageMs = Date.now() - new Date(slot.last_seen_at).getTime();
  return !Number.isFinite(ageMs) || ageMs >= REFRESH_STALE_MS;
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
    return `当前授权得到的是 ${actualEmail}${accountHint}${bindingHint}，不是目标账号 ${targetLabel}。系统已自动重置远程认证台并刷新新的设备码；请继续在认证台中登录 ${targetLabel}`;
  }

  if (existingLabel) {
    return `当前授权得到的成员身份已经绑定在 ${existingLabel}，不是目标账号 ${targetLabel}。系统已停止自动重试；如果你本来就是想给 ${existingLabel} 增加 workspace，请直接在那个账号下新增工作区。`;
  }

  return `当前授权得到的身份不是目标账号 ${targetLabel}。系统已自动重置远程认证台并刷新新的设备码；请继续在认证台中登录 ${targetLabel}`;
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

function serializeAuthProfile(profile, slot = null) {
  if (!profile) return null;
  const owner = slot || getSlotById(profile.slot_id);
  const runtimeStatus = deriveAuthRuntimeStatus(profile);
  const stale = runtimeStatus === 'stale';
  const availability = runtimeStatus === 'error' || runtimeStatus === 'reauth_required'
    ? 'error'
    : runtimeStatus === 'exhausted'
      ? 'exhausted'
      : 'healthy';
  return {
    ...profile,
    role: profile.is_primary ? 'primary' : 'secondary',
    runtime_status: runtimeStatus,
    availability,
    stale,
    owner_slot_id: owner ? owner.id : profile.slot_id,
    owner_email: owner ? owner.email || '' : '',
    display_workspace_label: profile.workspace_label || '未命名认证',
    last_error_kind: profile.last_error_kind || null,
    reauth_required: !!profile.reauth_required,
    backoff_until: profile.backoff_until || null
  };
}

function chooseNextAvailableSlot(activeSlotId) {
  const slots = listSlots()
    .map(serializeSlot)
    .filter((slot) => slot.id !== activeSlotId);
  return slots.find((slot) => slot.can_switch) || null;
}

function quotaRemainingValue(pct) {
  const numeric = Number(pct);
  if (!Number.isFinite(numeric)) return null;
  return Math.max(0, 100 - numeric);
}

function authProfileHasAvailableQuota(authProfile) {
  const fiveHourRemaining = quotaRemainingValue(authProfile.quota_5h_pct);
  const weekRemaining = quotaRemainingValue(authProfile.quota_week_pct);
  if (fiveHourRemaining == null || weekRemaining == null) return false;
  return fiveHourRemaining > 0 && weekRemaining > 0;
}

function authProfileAvailabilityScore(authProfile) {
  const fiveHourRemaining = quotaRemainingValue(authProfile.quota_5h_pct) || 0;
  const weekRemaining = quotaRemainingValue(authProfile.quota_week_pct) || 0;
  return (weekRemaining * 1000) + fiveHourRemaining;
}

function isActiveSlotQuotaExhausted(slot) {
  return authProfileHasAvailableQuota(slot) === false
    && (
      quotaRemainingValue(slot.quota_5h_pct) === 0
      || quotaRemainingValue(slot.quota_week_pct) === 0
    );
}

function selectBestAutoSwitchCandidate(activeSlot) {
  const currentActiveProfileId = activeSlot ? activeSlot.active_auth_profile_id || null : null;
  const slotCandidates = [];

  for (const slot of listSlots()) {
    const usableProfiles = listAuthProfilesForSlot(slot.id).filter((authProfile) => {
      if (!authProfile.auth_cipher) return false;
      if (slot.id === activeSlot?.id && authProfile.id === currentActiveProfileId) return false;
      if (authProfile.reauth_required || authProfile.last_error) return false;
      if (!authProfileHasAvailableQuota(authProfile)) return false;
      return true;
    });
    if (!usableProfiles.length) continue;
    const bestScore = Math.max(...usableProfiles.map((profile) => authProfileAvailabilityScore(profile)));
    const preferredProfile = usableProfiles.find((profile) => profile.is_primary)
      || usableProfiles.sort((left, right) => authProfileAvailabilityScore(right) - authProfileAvailabilityScore(left))[0];
    slotCandidates.push({
      slot,
      authProfile: preferredProfile,
      score: bestScore
    });
  }

  slotCandidates.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    if (!!left.slot.is_active !== !!right.slot.is_active) return left.slot.is_active ? 1 : -1;
    return String(left.slot.id).localeCompare(String(right.slot.id), 'zh-CN');
  });

  return slotCandidates[0] || null;
}

function buildNextAutoSwitchTarget(activeSlot = null) {
  const settings = getRuntimeSettings();
  if (!settings.auto_switch_enabled) {
    return { state: 'disabled', slot_id: null, auth_profile_id: null, workspace_label: null };
  }
  const autoSwitchStatus = getAutoSwitchStatus();
  if (autoSwitchStatus && autoSwitchStatus.to_slot_id) {
    const targetProfile = autoSwitchStatus.to_auth_profile_id
      ? getAuthProfileById(autoSwitchStatus.to_auth_profile_id)
      : null;
    return {
      state: autoSwitchStatus.state || 'queued',
      slot_id: autoSwitchStatus.to_slot_id,
      auth_profile_id: autoSwitchStatus.to_auth_profile_id || null,
      workspace_label: targetProfile ? targetProfile.workspace_label || null : null
    };
  }
  if (!activeSlot) {
    return { state: 'no_active_slot', slot_id: null, auth_profile_id: null, workspace_label: null };
  }
  const candidate = selectBestAutoSwitchCandidate(activeSlot);
  if (!candidate) {
    return { state: 'no_candidate', slot_id: null, auth_profile_id: null, workspace_label: null };
  }
  return {
    state: 'available',
    slot_id: candidate.slot.id,
    auth_profile_id: candidate.authProfile.id,
    workspace_label: candidate.authProfile.workspace_label || null
  };
}

function dispatchBrowserAction(sessionId, actionType, payload = {}, options = {}) {
  if (!sessionId || !actionType) return null;
  return ensureBridgeAction(sessionId, actionType, payload, options);
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

async function reconcileActiveSlotFromAgent() {
  try {
    const status = await getLoginStatus();
    const accountId = status.tokens && status.tokens.account_id ? status.tokens.account_id : null;
    const identityKey = status.identityKey ? String(status.identityKey).trim() : null;
    const email = status.email ? String(status.email).trim().toLowerCase() : null;

    if (!accountId) {
      if (getActiveSlot()) setActiveSlot(null);
      return { activeSlotId: null, accountId: null, identityKey: null, email: null };
    }

    const matched = (identityKey ? getSlotByIdentityKey(identityKey) : null)
      || (email ? getSlotByEmail(email) : null);
    if (matched) {
      const matchedAuthProfile = (identityKey ? getAuthProfileByIdentityKey(identityKey) : null)
        || getPrimaryAuthProfileForSlot(matched.id);
      if (!matched.is_active || matched.active_auth_profile_id !== (matchedAuthProfile && matchedAuthProfile.id)) {
        setActiveSlot(matched.id, matchedAuthProfile ? matchedAuthProfile.id : null);
      }
      updateSlot(matched.id, {
        account_id: accountId,
        identity_key: identityKey || matched.identity_key || matched.profile_identity_key || null,
        active_auth_profile_id: matchedAuthProfile ? matchedAuthProfile.id : matched.active_auth_profile_id || null,
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
      email
    };
  } catch (error) {
    const message = describeErrorValue(error);
    writeAudit('agent.login_status_failed', { message });
    return { activeSlotId: null, accountId: null, identityKey: null, email: null, error: message };
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

function buildAuthProfileQuotaPatch(usageSnapshot, observedAt = nowIso()) {
  return {
    quota_5h_pct: usageSnapshot.fiveHour ? usageSnapshot.fiveHour.pct : null,
    quota_5h_reset_at: usageSnapshot.fiveHour ? usageSnapshot.fiveHour.resetAt : null,
    quota_5h_reset_label: usageSnapshot.fiveHour ? usageSnapshot.fiveHour.resetLabel : null,
    quota_week_pct: usageSnapshot.week ? usageSnapshot.week.pct : null,
    quota_week_reset_at: usageSnapshot.week ? usageSnapshot.week.resetAt : null,
    quota_week_reset_label: usageSnapshot.week ? usageSnapshot.week.resetLabel : null,
    freshness: 'live',
    last_seen_at: observedAt,
    last_error: null
  };
}

function markUsageFailure(slot, observedAt, error, authProfile = null, classification = null) {
  const message = describeErrorValue(error);
  const errorInfo = classification || classifyUsageError(error);
  const nextFailureCount = authProfile ? Number(authProfile.failure_count || 0) + 1 : 0;
  const backoffDelayMs = errorInfo.retryable ? backoffDelayMsFor(nextFailureCount) : 0;
  const backoffUntil = backoffDelayMs ? new Date(Date.now() + backoffDelayMs).toISOString() : null;
  if (authProfile) {
    updateAuthProfile(authProfile.id, {
      quota_5h_pct: null,
      quota_5h_reset_at: null,
      quota_5h_reset_label: null,
      quota_week_pct: null,
      quota_week_reset_at: null,
      quota_week_reset_label: null,
      freshness: 'stale',
      last_seen_at: observedAt,
      last_error: message,
      runtime_status: errorInfo.terminal ? 'reauth_required' : 'error',
      last_error_kind: errorInfo.kind,
      failure_count: nextFailureCount,
      backoff_until: backoffUntil,
      reauth_required: errorInfo.terminal ? 1 : 0
    });
    syncSlotAuthAggregate(slot.id);
  }
  if (!authProfile || authProfile.is_primary) {
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
      last_error: message
    });
  }
  insertQuotaSample({
    slot_id: slot.id,
    browser_client_id: 'agent_backend',
    parser_status: 'error',
    raw_text: `backend_usage_fetch_failed :: ${message}`,
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

async function syncUsageForAuthProfile(slot, authProfile, activeSession, sharedActiveUsage = null) {
  const observedAt = nowIso();
  if (!slot || !authProfile) return null;
  if (authProfile.reauth_required) {
    return {
      parserStatus: 'skipped',
      observedAt,
      error: authProfile.last_error || 'AUTH_REAUTH_REQUIRED',
      errorKind: authProfile.last_error_kind || 'auth_invalid',
      reauthRequired: true
    };
  }
  if (isAuthProfileBackedOff(authProfile)) {
    return {
      parserStatus: 'skipped',
      observedAt,
      error: authProfile.last_error || 'BACKOFF_ACTIVE',
      errorKind: authProfile.last_error_kind || 'unknown',
      backoffUntil: authProfile.backoff_until || null
    };
  }

  try {
    let result;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        if (authProfile.is_active && activeSession && activeSession.activeSlotId === slot.id && activeSession.accountId) {
          result = sharedActiveUsage || await getUsageStatus();
        } else {
          result = await getUsageForProfile({
            authJson: decryptString(authProfile.auth_cipher),
            expectedAccountId: authProfile.account_id || slot.account_id || null,
            expectedIdentityKey: authProfile.identity_key || slot.identity_key || null
          });
          applyProfileIdentityGuard(slot, result);
          if (result.authJson) {
            updateAuthProfile(authProfile.id, {
              auth_cipher: encryptString(result.authJson),
              account_id: result.accountId || slot.account_id || null,
              identity_key: result.identityKey || authProfile.identity_key || slot.identity_key || null
            });
            if (authProfile.is_primary) {
              upsertProfile(
                slot.id,
                encryptString(result.authJson),
                result.accountId || slot.account_id || null,
                result.identityKey || authProfile.identity_key || slot.identity_key || null
              );
            }
          }
        }
        break;
      } catch (error) {
        const classification = classifyUsageError(error);
        if (!classification.retryable || attempt > 0) {
          throw Object.assign(error instanceof Error ? error : new Error(describeErrorValue(error)), {
            usageClassification: classification
          });
        }
        await wait(150 + Math.floor(Math.random() * 200));
      }
    }

    const usageSnapshot = result.usage;
    const resultObservedAt = result.observedAt || observedAt;
    updateAuthProfile(authProfile.id, {
      ...buildAuthProfileQuotaPatch(usageSnapshot, resultObservedAt),
      account_id: result.accountId || usageSnapshot.accountId || authProfile.account_id || slot.account_id || null,
      identity_key: result.identityKey || authProfile.identity_key || slot.identity_key || null,
      runtime_status: authProfile.is_active ? 'active' : quotaExhausted({
        quota_5h_pct: usageSnapshot.fiveHour ? usageSnapshot.fiveHour.pct : null,
        quota_5h_reset_at: usageSnapshot.fiveHour ? usageSnapshot.fiveHour.resetAt : null
      }) ? 'exhausted' : 'ready',
      last_error_kind: null,
      failure_count: 0,
      backoff_until: null,
      reauth_required: 0
    });
    syncSlotAuthAggregate(slot.id);
    if (authProfile.is_primary) {
      updateSlot(slot.id, {
        ...buildQuotaPatch(usageSnapshot, slot.is_active ? 'active' : 'ready', resultObservedAt),
        account_id: result.accountId || usageSnapshot.accountId || slot.account_id || null,
        identity_key: result.identityKey || slot.identity_key || null
      });
    }
    insertQuotaSampleForSlot(slot.id, usageSnapshot, resultObservedAt);

    return {
      ...usageSnapshot,
      observedAt: resultObservedAt,
      accountId: result.accountId || usageSnapshot.accountId || slot.account_id || null,
      identityKey: result.identityKey || authProfile.identity_key || slot.identity_key || null,
      email: result.email || usageSnapshot.email || slot.email || null,
      planType: result.planType || usageSnapshot.planType || null
    };
  } catch (error) {
    const classification = error && error.usageClassification
      ? error.usageClassification
      : classifyUsageError(error);
    const message = describeErrorValue(error);
    markUsageFailure(slot, observedAt, error, authProfile, classification);
    writeAudit('agent.usage_status_failed', { slotId: slot.id, message });
    return {
      parserStatus: 'error',
      observedAt,
      error: message,
      errorKind: classification.kind,
      reauthRequired: classification.terminal
    };
  }
}

async function syncUsageForSlot(slot, activeSession, sharedActiveUsage = null) {
  const profile = getPrimaryAuthProfileForSlot(slot.id);
  if (!profile) return null;
  return syncUsageForAuthProfile(slot, profile, activeSession, sharedActiveUsage);
}

function listRefreshTargets(slots, activeSession, options = {}) {
  const preferredSlotId = options.preferredSlotId || null;
  const mode = options.mode || 'auto';
  const targets = [];
  const seen = new Set();
  const addTarget = (slot, authProfile) => {
    if (!slot || !authProfile || seen.has(authProfile.id)) return;
    seen.add(authProfile.id);
    targets.push({ slot, authProfile });
  };

  let activeUsage = null;
  const activeSlot = activeSession && activeSession.activeSlotId
    ? slots.find((slot) => slot.id === activeSession.activeSlotId) || null
    : null;

  if (activeSlot) {
    const activeProfile = activeSlot.active_auth_profile_id
      ? getAuthProfileById(activeSlot.active_auth_profile_id)
      : getPrimaryAuthProfileForSlot(activeSlot.id);
    addTarget(activeSlot, activeProfile);
  }

  if (preferredSlotId) {
    const preferredSlot = slots.find((slot) => slot.id === preferredSlotId) || null;
    if (preferredSlot) {
      for (const authProfile of listAuthProfilesForSlot(preferredSlot.id)) {
        addTarget(preferredSlot, authProfile);
      }
    }
  }

  if (mode === 'auto' || mode === 'all') {
    const candidates = [];
    for (const slot of slots) {
      for (const authProfile of listAuthProfilesForSlot(slot.id)) {
        if (seen.has(authProfile.id)) continue;
        candidates.push({ slot, authProfile });
      }
    }
    candidates.sort((left, right) => {
      const leftTime = left.authProfile.last_seen_at ? new Date(left.authProfile.last_seen_at).getTime() : 0;
      const rightTime = right.authProfile.last_seen_at ? new Date(right.authProfile.last_seen_at).getTime() : 0;
      return leftTime - rightTime;
    });
    if (mode === 'all') {
      for (const candidate of candidates) addTarget(candidate.slot, candidate.authProfile);
    } else if (candidates[0]) {
      addTarget(candidates[0].slot, candidates[0].authProfile);
    }
  }

  return { activeSlot, targets, activeUsage };
}

async function runConcurrent(items, concurrency, worker) {
  const results = [];
  let index = 0;
  const count = Math.max(1, concurrency);
  const workers = new Array(Math.min(count, items.length || 1)).fill(null).map(async () => {
    while (index < items.length) {
      const currentIndex = index;
      index += 1;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  });
  await Promise.all(workers);
  return results;
}

async function syncAllManagedQuotas(activeSession, options = {}) {
  const slots = listSlots();
  let activeUsage = null;
  let refreshedCount = 0;
  let failedCount = 0;
  let lastObservedAt = null;

  const { activeSlot, targets } = listRefreshTargets(slots, activeSession, options);

  if (!targets.length && activeSession && activeSession.accountId) {
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
      const message = describeErrorValue(error);
      activeUsage = {
        parserStatus: 'error',
        observedAt: nowIso(),
        error: message
      };
      failedCount += 1;
      writeAudit('agent.usage_status_failed', { slotId: null, message });
    }
  }

  const results = await runConcurrent(
    targets,
    Math.max(1, config.quotaSyncConcurrency || 2),
    async ({ slot, authProfile }) => ({
      slotId: slot.id,
      authProfileId: authProfile.id,
      isActive: activeSlot ? slot.id === activeSlot.id && authProfile.is_active : false,
      usage: await syncUsageForAuthProfile(slot, authProfile, activeSession)
    })
  );

  for (const result of results) {
    if (!result || !result.usage) continue;
    const usage = result.usage;
    if (result.isActive) activeUsage = usage;
    lastObservedAt = usage.observedAt || lastObservedAt;
    if (usage.parserStatus === 'ok') refreshedCount += 1;
    else if (usage.parserStatus === 'error') failedCount += 1;
  }

  return {
    activeUsage,
    refreshedCount,
    failedCount,
    observedAt: lastObservedAt || nowIso(),
    refreshedAuthProfiles: results.map((item) => item.authProfileId)
  };
}

function enforceUniqueManagedProfiles() {
  const grouped = new Map();
  let changed = false;

  for (const slot of listSlots()) {
    for (const authProfile of listAuthProfilesForSlot(slot.id)) {
      const key = String(authProfile.identity_key || '').trim();
      if (!key) continue;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push({ slot, authProfile });
    }
  }

  for (const [identityKey, duplicates] of grouped.entries()) {
    if (duplicates.length <= 1) continue;
    const primary = duplicates.find((item) => item.authProfile.is_active) || duplicates.find((item) => item.authProfile.is_primary) || duplicates[0];
    for (const item of duplicates) {
      if (item.authProfile.id === primary.authProfile.id) continue;
      const message = buildDuplicateProfileMessage(identityKey, primary.slot, item.slot);
      const alreadyMarked = item.authProfile.last_error === message
        && item.authProfile.quota_5h_pct == null
        && item.authProfile.quota_week_pct == null
        && item.authProfile.freshness === 'stale';
      if (alreadyMarked) continue;
      markUsageFailure(item.slot, nowIso(), new Error(message), item.authProfile);
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
    const result = await syncAllManagedQuotas(activeSession, options);
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

function buildQuotaSourceStatusFromRefreshState(activeSession, refreshState) {
  const payload = refreshState || buildRuntimeRefreshPayload();
  if (payload.state === 'syncing') {
    return {
      mode: 'backend_api',
      state: 'syncing',
      message: '后台正在刷新额度',
      observedAt: payload.finished_at || null,
      planType: payload.plan_type || null,
      refreshedCount: payload.refreshed_count || 0,
      failedCount: payload.failed_count || 0
    };
  }
  if (payload.state === 'error' || payload.last_error) {
    return {
      mode: 'backend_api',
      state: 'error',
      message: payload.last_error,
      observedAt: payload.finished_at || null,
      planType: payload.plan_type || null,
      refreshedCount: payload.refreshed_count || 0,
      failedCount: payload.failed_count || 0
    };
  }
  if (!payload.finished_at) {
    return {
      mode: 'backend_api',
      state: 'idle',
      message: '等待额度同步',
      observedAt: null,
      planType: payload.plan_type || null,
      refreshedCount: 0,
      failedCount: 0
    };
  }
  return {
    mode: 'backend_api',
    state: payload.state === 'degraded' ? 'degraded' : 'online',
    message: payload.failed_count > 0
      ? `最近一次刷新中有 ${payload.failed_count} 个认证失败`
      : `最近一次刷新了 ${payload.refreshed_count || 0} 个认证`,
    observedAt: payload.finished_at,
    planType: payload.plan_type || null,
    refreshedCount: payload.refreshed_count || 0,
    failedCount: payload.failed_count || 0,
    email: activeSession ? activeSession.email || null : null,
    accountId: activeSession ? activeSession.accountId || null : null
  };
}

function buildStoredActiveSession() {
  const activeSlot = getActiveSlot();
  if (!activeSlot) {
    return {
      activeSlotId: null,
      accountId: null,
      identityKey: null,
      email: null
    };
  }
  return {
    activeSlotId: activeSlot.id,
    accountId: activeSlot.account_id || activeSlot.active_profile_account_id || null,
    identityKey: activeSlot.identity_key || activeSlot.active_profile_identity_key || null,
    email: activeSlot.email || null
  };
}

async function runRuntimeRefresh(trigger = 'manual', options = {}) {
  if (runtimeSchedulerState.refreshPromise) {
    return runtimeSchedulerState.refreshPromise;
  }

  const startedAt = nowIso();
  const lockExpiresAt = new Date(Date.now() + Math.max(config.agentRequestTimeoutMs || 5000, 15000)).toISOString();
  setRuntimeRefreshState({
    state: 'syncing',
    trigger,
    started_at: startedAt,
    finished_at: null,
    last_error: null
  }, lockExpiresAt);

  runtimeSchedulerState.refreshPromise = (async () => {
    try {
      const activeSession = await reconcileActiveSlotFromAgent();
      await syncPendingBootstrapSessions();
      cleanupStaleBootstrapSessions();
      cleanupCapturedBootstrapSessions();
      const syncResult = await getManagedQuotaSync(activeSession, {
        ...options,
        forceQuotaSync: true
      });
      if (enforceUniqueManagedProfiles()) {
        invalidateRuntimeSyncCache();
      }
      const finishedAt = nowIso();
      setRuntimeRefreshState({
        state: syncResult.failedCount > 0 ? 'degraded' : 'online',
        trigger,
        started_at: startedAt,
        finished_at: finishedAt,
        next_refresh_at: new Date(Date.now() + REFRESH_STALE_MS).toISOString(),
        last_duration_ms: new Date(finishedAt).getTime() - new Date(startedAt).getTime(),
        refreshed_count: syncResult.refreshedCount || 0,
        failed_count: syncResult.failedCount || 0,
        plan_type: syncResult.activeUsage && syncResult.activeUsage.planType ? syncResult.activeUsage.planType : null,
        last_error: null
      }, null);
      broadcast('admins', 'runtime_updated', { reason: 'runtime_refresh_completed', trigger });
      return syncResult;
    } catch (error) {
      const message = describeErrorValue(error);
      const finishedAt = nowIso();
      setRuntimeRefreshState({
        state: 'error',
        trigger,
        started_at: startedAt,
        finished_at: finishedAt,
        next_refresh_at: new Date(Date.now() + REFRESH_STALE_MS).toISOString(),
        last_duration_ms: new Date(finishedAt).getTime() - new Date(startedAt).getTime(),
        refreshed_count: 0,
        failed_count: 1,
        plan_type: null,
        last_error: message
      }, null);
      writeAudit('runtime.refresh_failed', { trigger, error: message });
      broadcast('admins', 'runtime_updated', { reason: 'runtime_refresh_failed', trigger, error: message });
      throw error;
    } finally {
      runtimeSchedulerState.refreshPromise = null;
    }
  })();

  return runtimeSchedulerState.refreshPromise;
}

function requestRuntimeRefresh(trigger = 'manual', options = {}) {
  void runRuntimeRefresh(trigger, options).catch(() => {});
  return getRuntimeRefreshState();
}

function queueRuntimeOperation(kind, metadata, runner) {
  upsertRuntimeLock(
    OPERATION_QUEUE_LOCK,
    'runtime_operations',
    {
      kind,
      state: 'queued',
      ...metadata
    },
    new Date(Date.now() + Math.max(config.switchLockMs || 60000, 60000)).toISOString()
  );

  runtimeSchedulerState.operationPromise = runtimeSchedulerState.operationPromise
    .then(async () => {
      upsertRuntimeLock(
        OPERATION_QUEUE_LOCK,
        'runtime_operations',
        {
          kind,
          state: 'running',
          ...metadata
        },
        new Date(Date.now() + Math.max(config.switchLockMs || 60000, 60000)).toISOString()
      );
      await runner();
      deleteRuntimeLock(OPERATION_QUEUE_LOCK);
    })
    .catch((error) => {
      writeAudit('runtime.operation_failed', { kind, error: describeErrorValue(error), ...metadata });
      deleteRuntimeLock(OPERATION_QUEUE_LOCK);
    });
}

function queueSlotSwitch(slotId, reason = 'manual_switch', options = {}) {
  const previous = getActiveSlot();
  const switchEventId = createSwitchEvent(previous ? previous.id : null, slotId, reason, 'queued', {
    reason,
    authProfileId: options.authProfileId || null
  });
  queueRuntimeOperation('switch', { slotId, switchEventId, authProfileId: options.authProfileId || null }, async () => {
    await activateSlot(slotId, reason, {
      ...options,
      switchEventId
    });
  });
  broadcast('admins', 'runtime_updated', { reason: 'switch_queued', slotId, switchEventId });
  return { switchEventId };
}

function queueSlotLogout(slotId, options = {}) {
  const operationId = `logout_${slotId}_${Date.now()}`;
  queueRuntimeOperation('logout', { slotId, operationId, authProfileId: options.authProfileId || null }, async () => {
    await logoutSlot(slotId, options);
  });
  broadcast('admins', 'runtime_updated', { reason: 'logout_queued', slotId, operationId });
  return { operationId };
}

async function activateSlot(slotId, reason = 'manual_switch', options = {}) {
  const slot = getSlotById(slotId);
  if (!slot) throw new Error('ACCOUNT_NOT_FOUND');
  const requestedAuthProfileId = options.authProfileId || null;
  const profile = requestedAuthProfileId
    ? getAuthProfileById(requestedAuthProfileId)
    : getPrimaryAuthProfileForSlot(slotId) || getProfile(slotId);
  if (!profile) throw new Error('PROFILE_NOT_FOUND');
  if (profile.slot_id && profile.slot_id !== slot.id) throw new Error('AUTH_PROFILE_NOT_FOUND');

  const previous = getActiveSlot();
  const switchEventId = options.switchEventId || createSwitchEvent(previous ? previous.id : null, slot.id, reason, 'starting', {
    reason,
    authProfileId: profile.id || null
  });
  upsertRuntimeLock('switch_lock', 'app', { slotId }, new Date(Date.now() + config.switchLockMs).toISOString());

  try {
    const result = await activateProfile({
      slotId: slot.id,
      authJson: decryptString(profile.auth_cipher),
      expectedAccountId: profile.account_id || slot.account_id || null,
      expectedIdentityKey: profile.identity_key || slot.identity_key || null
    });

    setActiveSlot(slot.id, profile.id || null);
    updateAuthProfile(profile.id, {
      is_active: 1,
      account_id: result.accountId || profile.account_id || slot.account_id || null,
      identity_key: result.identityKey || profile.identity_key || slot.identity_key || null,
      last_error: null
    });
    updateSlot(slot.id, {
      state: 'active',
      active_auth_profile_id: profile.id || null,
      account_id: result.accountId || slot.account_id || null,
      identity_key: result.identityKey || profile.identity_key || slot.identity_key || null,
      last_error: null
    });

    try {
      const usageResult = await getUsageStatus();
      updateAuthProfile(profile.id, {
        ...buildAuthProfileQuotaPatch(usageResult.usage, usageResult.observedAt || nowIso()),
        account_id: usageResult.accountId || usageResult.usage.accountId || result.accountId || profile.account_id || slot.account_id || null,
        identity_key: usageResult.identityKey || result.identityKey || profile.identity_key || slot.identity_key || null,
        is_active: 1
      });
      syncSlotAuthAggregate(slot.id);
      updateSlot(slot.id, {
        ...buildQuotaPatch(usageResult.usage, 'active', usageResult.observedAt || nowIso()),
        account_id: usageResult.accountId || usageResult.usage.accountId || result.accountId || slot.account_id || null,
        identity_key: usageResult.identityKey || result.identityKey || profile.identity_key || slot.identity_key || null
      });
      insertQuotaSampleForSlot(slot.id, usageResult.usage, usageResult.observedAt || nowIso());
    } catch (usageError) {
      const message = describeErrorValue(usageError);
      updateSlot(slot.id, {
        freshness: 'stale',
        last_error: message
      });
    }

    const activeAuthGeneration = bumpActiveAuthGeneration(reason, {
      slotId: slot.id,
      authProfileId: profile.id || null,
      switchEventId
    });
    completeSwitchEvent(switchEventId, 'completed', { accountId: result.accountId || null, authProfileId: profile.id || null });
    deleteRuntimeLock('switch_lock');
    clearAutoSwitchStatus();
    clearRuntimeAlert();
    invalidateRuntimeSyncCache();
    maybeDispatchInteractiveRecovery({
      reason,
      targetSlotId: slot.id,
      targetAuthProfileId: profile.id || null,
      activeAuthGeneration
    });
    broadcast('admins', 'runtime_updated', { reason: 'activate_slot', slotId: slot.id, authProfileId: profile.id || null });
    writeAudit('slot.activated', { slotId: slot.id, reason, authProfileId: profile.id || null });
    return result;
  } catch (error) {
    const message = describeErrorValue(error);
    completeSwitchEvent(switchEventId, 'failed', { error: message });
    deleteRuntimeLock('switch_lock');
    if (reason === 'auto_switch') {
      setAutoSwitchStatus({
        state: 'failed',
        from_slot_id: previous ? previous.id : null,
        to_slot_id: slot.id,
        to_auth_profile_id: profile.id || null,
        error: message
      });
    }
    updateSlot(slot.id, { state: 'error', last_error: message });
    broadcast('admins', 'runtime_updated', { reason: 'activate_slot_failed', slotId: slot.id, error: message });
    writeAudit('slot.activate_failed', { slotId: slot.id, reason, error: message });
    throw error;
  }
}

function getAutoSwitchStatus() {
  const lock = getRuntimeLock(AUTO_SWITCH_STATUS_LOCK);
  return lock && lock.payload ? lock.payload : null;
}

function setAutoSwitchStatus(payload) {
  upsertRuntimeLock(AUTO_SWITCH_STATUS_LOCK, 'auto_switch', {
    ...payload,
    updated_at: nowIso()
  }, null);
}

function clearAutoSwitchStatus() {
  deleteRuntimeLock(AUTO_SWITCH_STATUS_LOCK);
}

async function maybeAutoSwitch(trigger = 'timer', options = {}) {
  const settings = getRuntimeSettings();
  if (!settings.auto_switch_enabled) {
    clearAutoSwitchStatus();
    clearRuntimeAlert();
    return { state: 'disabled' };
  }

  const operationLock = getRuntimeLock(OPERATION_QUEUE_LOCK);
  const switchLock = getRuntimeLock('switch_lock');
  if (operationLock || switchLock) {
    return { state: 'busy' };
  }

  await runRuntimeRefresh('auto_switch_monitor', { mode: 'auto' });
  let activeSlot = getActiveSlot();
  if (!activeSlot) {
    clearAutoSwitchStatus();
    clearRuntimeAlert();
    return { state: 'no_active_slot' };
  }

  if (!isActiveSlotQuotaExhausted(activeSlot)) {
    clearAutoSwitchStatus();
    clearRuntimeAlert();
    return { state: 'healthy' };
  }

  await runRuntimeRefresh('auto_switch_candidates', { mode: 'all' });
  activeSlot = getActiveSlot();
  if (!activeSlot) {
    clearAutoSwitchStatus();
    clearRuntimeAlert();
    return { state: 'no_active_slot' };
  }

  const candidate = selectBestAutoSwitchCandidate(activeSlot);
  if (!candidate) {
    const existingStatus = getAutoSwitchStatus();
    if (existingStatus && existingStatus.state === 'no_candidate' && existingStatus.active_slot_id === activeSlot.id) {
      return { state: 'no_candidate' };
    }
    const existingAlert = getRuntimeAlerts()[0] || null;
    const alertPayload = buildRuntimeAlertPayload({
      id: existingAlert && existingAlert.kind === 'no_available_quota' ? existingAlert.id : crypto.randomUUID(),
      kind: 'no_available_quota',
      title: '无可用额度账号',
      message: `${normalizeEmail(activeSlot.email) || '当前活动账号'} 的额度已耗尽，但系统没有找到同时满足 5 小时额度和 1 周额度都大于 0 的可切换账号。请补充可用认证后再试。`,
      created_at: existingAlert && existingAlert.kind === 'no_available_quota' ? existingAlert.created_at : nowIso(),
      active_slot_id: activeSlot.id
    });
    upsertRuntimeAlert(alertPayload);
    setAutoSwitchStatus({
      state: 'no_candidate',
      active_slot_id: activeSlot.id,
      active_auth_profile_id: activeSlot.active_auth_profile_id || null,
      alert_id: alertPayload.id
    });
    const openIntent = getOpenResumeIntent();
    if (openIntent) {
      updateResumeIntent(openIntent.id, {
        bridge_session_id: options.bridgeSessionId || openIntent.bridge_session_id || null,
        source_slot_id: openIntent.source_slot_id || activeSlot.id,
        target_slot_id: null,
        status: 'blocked'
      });
      const primarySession = getPrimaryInteractiveBridgeSession();
      if (primarySession) {
        ensureBridgeAction(primarySession.id, 'blocked_all_accounts', {
          resumeIntentId: openIntent.id,
          activeAuthGeneration: getActiveAuthGeneration(),
          reason: openIntent.reason,
          message: alertPayload.message
        }, {
          matcher: (payload) => payload.resumeIntentId === openIntent.id
        });
      }
    }
    writeAudit('auto_switch.no_candidate', { activeSlotId: activeSlot.id });
    broadcast('admins', 'runtime_updated', { reason: 'auto_switch_no_candidate', slotId: activeSlot.id });
    return { state: 'no_candidate', alert: alertPayload };
  }

  clearRuntimeAlert();
  setAutoSwitchStatus({
    state: 'switching',
    from_slot_id: activeSlot.id,
    to_slot_id: candidate.slot.id,
    to_auth_profile_id: candidate.authProfile.id,
    trigger,
    bridge_session_id: options.bridgeSessionId || null,
    interruption_reason: options.interruptionReason || null
  });
  const openIntent = getOpenResumeIntent();
  if (openIntent) {
    updateResumeIntent(openIntent.id, {
      bridge_session_id: options.bridgeSessionId || openIntent.bridge_session_id || null,
      source_slot_id: openIntent.source_slot_id || activeSlot.id,
      target_slot_id: candidate.slot.id,
      status: 'switching'
    });
  }
  const result = queueSlotSwitch(candidate.slot.id, 'auto_switch', { authProfileId: candidate.authProfile.id });
  writeAudit('auto_switch.queued', {
    fromSlotId: activeSlot.id,
    toSlotId: candidate.slot.id,
    authProfileId: candidate.authProfile.id,
    trigger,
    bridgeSessionId: options.bridgeSessionId || null,
    interruptionReason: options.interruptionReason || null
  });
  return {
    state: 'queued',
    switchEventId: result.switchEventId,
    targetSlotId: candidate.slot.id,
    targetAuthProfileId: candidate.authProfile.id
  };
}

async function logoutSlot(slotId, options = {}) {
  const slot = getSlotById(slotId);
  if (!slot) throw new Error('ACCOUNT_NOT_FOUND');
  const authProfileId = options.authProfileId || null;
  const targetProfile = authProfileId ? getAuthProfileById(authProfileId) : null;
  if (authProfileId && (!targetProfile || targetProfile.slot_id !== slot.id)) {
    throw new Error('AUTH_PROFILE_NOT_FOUND');
  }

  const activeLogout = slot.is_active && (!authProfileId || slot.active_auth_profile_id === authProfileId);
  if (activeLogout) {
    await logoutActiveAuth();
    setActiveSlot(null);
  }

  if (authProfileId) {
    const wasPrimary = !!targetProfile.is_primary;
    deleteAuthProfile(authProfileId);
    const remainingProfiles = listAuthProfilesForSlot(slot.id);
    if (wasPrimary) {
      const nextPrimary = remainingProfiles[0] || null;
      if (nextPrimary) {
        setPrimaryAuthProfile(slot.id, nextPrimary.id);
        upsertProfile(slot.id, nextPrimary.auth_cipher, nextPrimary.account_id || null, nextPrimary.identity_key || null);
      }
    }
    if (!remainingProfiles.length) {
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
        is_active: 0,
        active_auth_profile_id: null
      });
    } else {
      syncSlotAuthAggregate(slot.id);
      const refreshedSlot = getSlotById(slot.id);
      updateSlot(slot.id, {
        state: deriveSlotState(refreshedSlot),
        last_error: null,
        is_active: refreshedSlot.is_active ? 1 : 0,
        active_auth_profile_id: refreshedSlot.active_auth_profile_id || null
      });
    }
  } else {
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
      is_active: 0,
      active_auth_profile_id: null
    });
  }
  invalidateRuntimeSyncCache();
  if (activeLogout) {
    bumpActiveAuthGeneration('logout_active_auth', {
      slotId: slot.id,
      authProfileId: authProfileId || null
    });
    maybeDispatchInteractiveRecovery({
      reason: 'logout_active_auth',
      targetSlotId: null,
      targetAuthProfileId: null
    });
  }
  broadcast('admins', 'runtime_updated', { reason: 'logout_slot', slotId: slot.id, authProfileId });
  writeAudit('slot.logged_out', { slotId: slot.id, authProfileId });
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
      if (status.error) nextPatch.error_text = describeErrorValue(status.error);
      updateBootstrapSession(session.id, nextPatch);
      changed = true;

      if (status.status === 'succeeded' || status.status === 'success_pending_capture') {
        const captured = await captureAuthProfile({ bootstrapId: session.id });
        const currentSlot = getSlotById(session.slot_id);
        const duplicateSlot = findDuplicateBootstrapSlot(session.slot_id, captured);
        const intent = String(session.intent || (session.auth_profile_id ? BOOTSTRAP_INTENTS.reauthWorkspace : BOOTSTRAP_INTENTS.createWorkspace)).trim() || BOOTSTRAP_INTENTS.createWorkspace;
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
        const existingAuthProfile = session.auth_profile_id
          ? getAuthProfileById(session.auth_profile_id)
          : null;
        const sameSlotProfiles = listAuthProfilesForSlot(session.slot_id);
        const matchedSameSlotProfile = sameSlotProfiles.find((profile) => (
          profile.identity_key
          && captured.identityKey
          && profile.identity_key === captured.identityKey
        )) || null;
        const requestedWorkspaceLabel = String(session.workspace_label || (existingAuthProfile && existingAuthProfile.workspace_label) || '').trim()
          || (sameSlotProfiles.length ? `认证 ${sameSlotProfiles.length + 1}` : '主认证');
        const duplicateWorkspaceProfile = sameSlotProfiles.find((profile) => (
          normalizeWorkspaceLabel(profile.workspace_label) === normalizeWorkspaceLabel(requestedWorkspaceLabel)
          && (!existingAuthProfile || profile.id !== existingAuthProfile.id)
        )) || null;
        if (intent === BOOTSTRAP_INTENTS.createWorkspace && (duplicateWorkspaceProfile || matchedSameSlotProfile)) {
          const duplicateMessage = buildWorkspaceAlreadyExistsMessage(
            (matchedSameSlotProfile && matchedSameSlotProfile.workspace_label)
            || (duplicateWorkspaceProfile && duplicateWorkspaceProfile.workspace_label)
            || requestedWorkspaceLabel
          );
          updateBootstrapSession(session.id, {
            status: 'failed',
            error_text: duplicateMessage,
            completed_at: nowIso(),
            log_tail: status.logTail || session.log_tail
          });
          updateSlot(session.slot_id, {
            state: deriveSlotState(currentSlot || getSlotById(session.slot_id)),
            last_error: duplicateMessage
          });
          writeAudit('bootstrap.duplicate_workspace_label', {
            bootstrapId: session.id,
            slotId: session.slot_id,
            workspaceLabel: requestedWorkspaceLabel
          });
          continue;
        }
        if ((intent === BOOTSTRAP_INTENTS.reauthWorkspace || intent === BOOTSTRAP_INTENTS.reauthPrimary) && !existingAuthProfile) {
          const missingTargetMessage = 'AUTH_PROFILE_NOT_FOUND';
          updateBootstrapSession(session.id, {
            status: 'failed',
            error_text: missingTargetMessage,
            completed_at: nowIso(),
            log_tail: status.logTail || session.log_tail
          });
          updateSlot(session.slot_id, {
            state: deriveSlotState(currentSlot || getSlotById(session.slot_id)),
            last_error: missingTargetMessage
          });
          continue;
        }
        if (
          (intent === BOOTSTRAP_INTENTS.reauthWorkspace || intent === BOOTSTRAP_INTENTS.reauthPrimary)
          && matchedSameSlotProfile
          && existingAuthProfile
          && matchedSameSlotProfile.id !== existingAuthProfile.id
        ) {
          const mismatchMessage = buildWorkspaceReauthMismatchMessage(existingAuthProfile.workspace_label || requestedWorkspaceLabel);
          updateBootstrapSession(session.id, {
            status: 'failed',
            error_text: mismatchMessage,
            completed_at: nowIso(),
            log_tail: status.logTail || session.log_tail
          });
          updateSlot(session.slot_id, {
            state: deriveSlotState(currentSlot || getSlotById(session.slot_id)),
            last_error: mismatchMessage
          });
          writeAudit('bootstrap.reauth_target_mismatch', {
            bootstrapId: session.id,
            slotId: session.slot_id,
            expectedAuthProfileId: existingAuthProfile.id,
            capturedIdentityKey: captured.identityKey || null,
            matchedAuthProfileId: matchedSameSlotProfile.id
          });
          continue;
        }
        if (
          (intent === BOOTSTRAP_INTENTS.reauthWorkspace || intent === BOOTSTRAP_INTENTS.reauthPrimary)
          && duplicateWorkspaceProfile
          && existingAuthProfile
          && duplicateWorkspaceProfile.id !== existingAuthProfile.id
        ) {
          const mismatchMessage = buildWorkspaceReauthMismatchMessage(existingAuthProfile.workspace_label || requestedWorkspaceLabel);
          updateBootstrapSession(session.id, {
            status: 'failed',
            error_text: mismatchMessage,
            completed_at: nowIso(),
            log_tail: status.logTail || session.log_tail
          });
          updateSlot(session.slot_id, {
            state: deriveSlotState(currentSlot || getSlotById(session.slot_id)),
            last_error: mismatchMessage
          });
          continue;
        }
        const isFirstProfile = sameSlotProfiles.length === 0;
        const workspaceLabel = existingAuthProfile
          ? (existingAuthProfile.workspace_label || requestedWorkspaceLabel)
          : requestedWorkspaceLabel;
        let authProfile = existingAuthProfile;
        if (authProfile) {
          updateAuthProfile(authProfile.id, {
            workspace_label: workspaceLabel,
            auth_cipher: encryptString(captured.authJson),
            account_id: captured.accountId || null,
            identity_key: captured.identityKey || null,
            freshness: 'stale',
            last_error: null,
            runtime_status: authProfile.is_active ? 'active' : 'ready',
            last_error_kind: null,
            failure_count: 0,
            backoff_until: null,
            reauth_required: 0
          });
        } else {
          authProfile = createAuthProfile({
            slot_id: session.slot_id,
            workspace_label: workspaceLabel,
            auth_cipher: encryptString(captured.authJson),
            account_id: captured.accountId || null,
            identity_key: captured.identityKey || null,
            is_primary: isFirstProfile,
            is_active: false,
            freshness: 'stale',
            last_error: null,
            runtime_status: 'ready',
            last_error_kind: null,
            failure_count: 0,
            backoff_until: null,
            reauth_required: 0
          });
        }
        if (authProfile.is_primary || isFirstProfile) {
          upsertProfile(
            session.slot_id,
            encryptString(captured.authJson),
            captured.accountId || null,
            captured.identityKey || null
          );
        }
        syncSlotAuthAggregate(session.slot_id);
        updateSlot(session.slot_id, {
          state: 'ready',
          active_auth_profile_id: currentSlot && currentSlot.is_active ? authProfile.id : currentSlot ? currentSlot.active_auth_profile_id || null : null,
          account_id: captured.accountId || null,
          identity_key: captured.identityKey || null,
          last_bootstrap_at: nowIso(),
          last_error: null
        });
        const refreshedSlot = getSlotById(session.slot_id);
        if (refreshedSlot && refreshedSlot.is_active && refreshedSlot.active_auth_profile_id === authProfile.id) {
          const activeAuthGeneration = bumpActiveAuthGeneration('bootstrap_capture', {
            slotId: session.slot_id,
            authProfileId: authProfile.id,
            bootstrapId: session.id
          });
          maybeDispatchInteractiveRecovery({
            reason: 'bootstrap_capture',
            targetSlotId: session.slot_id,
            targetAuthProfileId: authProfile.id,
            activeAuthGeneration
          });
        }
        invalidateRuntimeSyncCache();
        deleteBootstrapSession(session.id);
        writeAudit('bootstrap.captured', { bootstrapId: session.id, slotId: session.slot_id });
      } else if (status.status === 'failed') {
        const normalizedStatusError = describeErrorValue(status.error || null);
        const bootstrapFailureText = `${normalizedStatusError || ''}\n${status.logTail || ''}\n${session.error_text || ''}\n${session.log_tail || ''}`;
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
        updateSlot(session.slot_id, { state: 'auth_required', last_error: normalizedStatusError || 'bootstrap failed' });
        if (isDeviceAuthRateLimitedText(normalizedStatusError || status.logTail || session.error_text || session.log_tail)) {
          upsertRuntimeLock(
            'device_auth_cooldown',
            'openai_rate_limit',
            { error: normalizedStatusError || session.error_text || 'device auth rate limited' },
            new Date(Date.now() + DEVICE_AUTH_COOLDOWN_MS).toISOString()
          );
        }
      }
    } catch (error) {
      const message = describeErrorValue(error);
      updateBootstrapSession(session.id, {
        status: 'failed',
        error_text: message,
        completed_at: nowIso()
      });
      updateSlot(session.slot_id, { state: 'auth_required', last_error: message });
      writeAudit('bootstrap.sync_failed', { bootstrapId: session.id, error: message });
      changed = true;
    }
  }

  return changed;
}

async function buildRuntimeSnapshot(options = {}) {
  void options;
  const activeSession = buildStoredActiveSession();
  const runtimeRefresh = getRuntimeRefreshState();
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
    has_pending_bootstrap: pendingSlotIds.has(slot.id),
    auth_profiles: listAuthProfilesForSlot(slot.id).map((authProfile) => serializeAuthProfile(authProfile, slot)),
    needs_refresh: isSlotSnapshotStale(slot)
  }));
  const activeSlot = slots.find((slot) => slot.is_active) || null;
  const deviceAuthCooldown = getActiveDeviceAuthCooldownLock();

  return {
    now: nowIso(),
    serverTimeZone: config.serverTimeZone,
    activeSlot,
    activeSession,
    quotaSource: buildQuotaSourceStatusFromRefreshState(activeSession, runtimeRefresh),
    summary: buildRuntimeSummary(slots),
    slots,
    bootstrapSessions,
    deviceAuthCooldown,
    runtimeRefresh,
    settings: getRuntimeSettings(),
    alerts: getRuntimeAlerts(),
    nextAutoSwitchTarget: buildNextAutoSwitchTarget(activeSlot),
    autoSwitchStatus: getAutoSwitchStatus(),
    interactiveRecovery: buildInteractiveRecoverySummary(),
    switchLock: getRuntimeLock('switch_lock'),
    operationLock: getRuntimeLock(OPERATION_QUEUE_LOCK)
  };
}

module.exports = {
  acknowledgeRuntimeAlert,
  activateSlot,
  buildRuntimeSnapshot,
  buildInteractiveRecoverySummary,
  clearBootstrapTasks,
  chooseNextAvailableSlot,
  deleteBootstrapTask,
  deleteManagedAccount,
  deriveSlotState,
  dispatchBrowserAction,
  acknowledgeBridgeAction,
  getActiveAuthGeneration,
  getRuntimeRefreshState,
  getRuntimeSettings,
  handleBridgeHeartbeat,
  logoutSlot,
  maybeAutoSwitch,
  invalidateRuntimeSyncCache,
  queueSlotLogout,
  queueSlotSwitch,
  reconcileActiveSlotFromAgent,
  replayBridgeActionsForSession,
  requestRuntimeRefresh,
  runRuntimeRefresh,
  serializeAuthProfile,
  serializeSlot,
  syncPendingBootstrapSessions,
  updateRuntimeSettings,
  buildDuplicateBootstrapMessage,
  buildDuplicateProfileMessage,
  buildProfileEmailMismatchMessage
};
