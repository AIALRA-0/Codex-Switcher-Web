const state = {
  csrf: '',
  runtime: null,
  recentSwitches: [],
  recentSamples: [],
  switchLogPage: 1,
  sampleLogPage: 1,
  timeDisplayMode: 'local',
  serverTimeZone: 'UTC',
  refreshTimer: null,
  refreshCountdownTimer: null,
  eventSource: null,
  runtimeReloadTimer: null,
  deferredLogsLoadTimer: null,
  runtimeReloadOptions: null,
  loadingRuntime: false,
  refreshPending: false,
  queuedRuntimeReload: false,
  queuedRuntimeReloadOptions: null,
  openBootstrapLogIds: new Set(),
  selectedAccountId: null,
  toastId: 0,
  accountPrivacyEnabled: false,
  sessionEmail: '',
  refreshSeconds: 10,
  refreshCountdown: 10,
  accountSearch: '',
  accountSort: 'availability',
  accountFilter: 'all',
  accountLoginMethodFilter: 'all',
  settings: {
    autoSwitchEnabled: false
  },
  initialRefreshRequested: false,
  presentedAlertIds: new Set(),
  exchangeDestroyTimer: null,
  exchangeDestroyAt: null,
  exchangeStatus: null
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const LOG_PAGE_SIZE = 5;
const TIME_DISPLAY_STORAGE_KEY = 'codex-switcher-time-display-mode';
const ACCOUNT_PRIVACY_STORAGE_KEY = 'codex-switcher-account-privacy-enabled';
const REFRESH_SECONDS_STORAGE_KEY = 'codex-switcher-refresh-seconds';
const ACCOUNT_SORT_STORAGE_KEY = 'codex-switcher-account-sort';
const ACCOUNT_FILTER_STORAGE_KEY = 'codex-switcher-account-filter';
const ACCOUNT_LOGIN_METHOD_FILTER_STORAGE_KEY = 'codex-switcher-account-login-method-filter';
const ACCOUNT_SEARCH_STORAGE_KEY = 'codex-switcher-account-search';
const ANSI_PATTERN = /\u001B\[[0-9;]*m/g;
const EMAIL_TEXT_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const REFRESH_PRESET_VALUES = [0, 10, 30, 60];
const EXCHANGE_PASSPHRASE_TTL_MS = 60 * 1000;

function stripAnsi(text) {
  return String(text || '').replace(ANSI_PATTERN, '');
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeHtmlMultiline(value) {
  return escapeHtml(value).replace(/\n/g, '<br>');
}

function extractDeviceCode(text) {
  const match = stripAnsi(text).match(/\b([A-Z0-9]{4}-[A-Z0-9]{5})\b/);
  return match ? match[1] : '';
}

function shortId(value) {
  if (!value) return '--';
  const text = String(value);
  if (text.length <= 18) return text;
  return `${text.slice(0, 8)}...${text.slice(-6)}`;
}

function isAccountPrivacyEnabled() {
  return state.accountPrivacyEnabled === true;
}

function looksLikeEmail(value) {
  return EMAIL_PATTERN.test(String(value || '').trim());
}

function maskEmail(value) {
  const text = String(value || '').trim();
  if (!text) return '*****';
  const [localPart, domainPart = ''] = text.split('@');
  const domainParts = domainPart.split('.');
  const domainLabel = domainParts.shift() || '';
  const suffix = domainParts.length ? `.${domainParts.join('.')}` : '';
  const maskSegment = (segment) => {
    const normalized = String(segment || '').trim();
    if (!normalized) return '*****';
    return `${normalized.slice(0, 1)}*****`;
  };
  if (!domainPart) return maskSegment(localPart);
  return `${maskSegment(localPart)}@${maskSegment(domainLabel)}${suffix}`;
}

function displayEmailValue(value, options = {}) {
  const text = String(value || '').trim();
  const fallback = options.fallback || '--';
  if (!text) return fallback;
  if (options.reveal === true || !isAccountPrivacyEnabled()) return text;
  return looksLikeEmail(text) ? maskEmail(text) : text;
}

function maskEmailsInText(value) {
  return String(value || '').replace(EMAIL_TEXT_PATTERN, (match) => displayEmailValue(match));
}

function displayAccountName(account) {
  if (!account) return '未填写邮箱';
  const email = typeof account === 'string' ? account : account.email;
  return displayEmailValue(email, { fallback: '未填写邮箱' });
}

function isMainWorkspaceLabel(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  return /^(主\s*认证|主\s*工作区|main(?:\s*工作区)?)$/iu.test(text);
}

function displayWorkspaceLabel(value, fallback = '未命名工作区') {
  const text = String(value || '').trim();
  if (!text) return fallback;
  if (isMainWorkspaceLabel(text)) return 'Main';
  const withoutSuffix = text.replace(/\s*工作区$/u, '').trim();
  if (!withoutSuffix) return fallback;
  return withoutSuffix;
}

function displayWorkspaceNameForProfile(authProfile, fallback = '未命名') {
  const label = String(authProfile?.workspace_label || '').trim();
  const normalized = displayWorkspaceLabel(label, '');
  if (authProfile?.is_primary && !normalized) return 'Main';
  return normalized || fallback;
}

function loginMethodLabel(value) {
  const mapping = {
    email: '邮箱登录',
    google: 'Google 登录',
    apple: 'Apple 登录',
    microsoft: 'Microsoft 登录',
    phone: '手机登录'
  };
  return mapping[String(value || '').trim()] || '未设置登录方式';
}

function stateLabel(account) {
  const mapping = {
    draft: '待保存',
    active: '当前活动',
    ready: '已认证',
    auth_required: '待认证',
    exhausted: '5 小时额度用尽',
    error: '异常'
  };
  return mapping[account.display_state] || account.display_state || '--';
}

function stateTone(value) {
  const mapping = {
    draft: 'unknown',
    active: 'healthy',
    ready: 'healthy',
    auth_required: 'warning',
    exhausted: 'danger',
    error: 'danger'
  };
  return mapping[value] || 'unknown';
}

function freshnessLabel(value) {
  const mapping = {
    live: '刚刚同步',
    stale: '等待刷新',
    predicted: '预测值'
  };
  return mapping[value] || value || '等待刷新';
}

function currentTimeMode() {
  return state.timeDisplayMode === 'local' ? 'local' : 'server';
}

function timeZoneLabelFor(date, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      ...(timeZone ? { timeZone } : {}),
      timeZoneName: 'short'
    }).formatToParts(date);
    return parts.find((part) => part.type === 'timeZoneName')?.value || '';
  } catch (_) {
    return '';
  }
}

function formatAbsoluteDate(value, options = {}) {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const includeSeconds = options.includeSeconds === true;
  const baseOptions = {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    ...(includeSeconds ? { second: '2-digit' } : {})
  };

  if (options.mode === 'local') {
    const localText = new Intl.DateTimeFormat('zh-CN', baseOptions).format(date);
    const zoneLabel = timeZoneLabelFor(date);
    return zoneLabel ? `${localText} ${zoneLabel}` : localText;
  }

  const zone = options.mode === 'server' ? (state.serverTimeZone || 'UTC') : 'UTC';
  const text = new Intl.DateTimeFormat('zh-CN', {
    ...baseOptions,
    timeZone: zone
  }).format(date);
  const zoneLabel = options.mode === 'server'
    ? (timeZoneLabelFor(date, zone) || zone)
    : 'UTC';
  return `${text} ${zoneLabel}`;
}

function formatTimestampLines(value, options = {}) {
  if (!value) return '--';
  const includeSeconds = options.includeSeconds === true;
  const lines = [];
  if (currentTimeMode() === 'local') {
    lines.push(`本地时间 ${formatAbsoluteDate(value, {
      mode: 'local',
      includeSeconds
    })}`);
  }
  lines.push(`服务器时间 ${formatAbsoluteDate(value, {
    mode: 'server',
    includeSeconds
  })}`);
  lines.push(`UTC时间 ${formatAbsoluteDate(value, {
    mode: 'utc',
    includeSeconds
  })}`);
  return lines.join('\n');
}

function formatTimestamp(value, options = {}) {
  const primary = formatAbsoluteDate(value, {
    mode: currentTimeMode() === 'local' ? 'local' : 'server',
    includeSeconds: options.includeSeconds !== false
  });
  if (!options.includeUtc || currentTimeMode() !== 'local') return primary;
  return `${primary}\n${formatAbsoluteDate(value, {
    mode: 'utc',
    includeSeconds: options.includeSeconds !== false
  })}`;
}

function formatUtcTimestamp(value, options = {}) {
  return formatAbsoluteDate(value, {
    mode: 'utc',
    includeSeconds: options.includeSeconds !== false
  });
}

function displayResetLabel(resetLabel, resetAt, options = {}) {
  if (resetAt) {
    return formatTimestamp(resetAt, {
      includeSeconds: false,
      includeUtc: options.includeUtc === true
    });
  }
  return resetLabel || '--';
}

function buildResetTimeBlock(resetLabel, resetAt) {
  if (!resetAt) {
    return `重置时间\n服务器时间 ${resetLabel || '--'}\nUTC时间 ${resetLabel || '--'}`;
  }
  return `重置时间\n${formatTimestampLines(resetAt, { includeSeconds: false })}`;
}

function syncTimeDisplayButton() {
  const button = document.getElementById('timeDisplayToggleBtn');
  if (!button) return;
  button.textContent = currentTimeMode() === 'local' ? '时间显示：本地' : '时间显示：服务器';
}

function syncAccountPrivacyButton() {
  const button = document.getElementById('accountPrivacyToggleBtn');
  if (!button) return;
  button.textContent = isAccountPrivacyEnabled() ? '账号隐私：开' : '账号隐私：关';
}

function syncAutoSwitchButton() {
  const button = document.getElementById('autoSwitchToggleBtn');
  if (!button) return;
  button.textContent = state.settings && state.settings.autoSwitchEnabled ? '自动切换：开' : '自动切换：关';
}

function currentExchangePassphrase() {
  return String(
    document.getElementById('exchangeImportPassphraseInput')?.value
      || document.getElementById('exchangePassphraseInput')?.value
      || ''
  ).trim();
}

function exchangePassphraseInputs() {
  return ['exchangePassphraseInput', 'exchangeImportPassphraseInput']
    .map((id) => document.getElementById(id))
    .filter(Boolean);
}

function setExchangePassphraseValue(value = '') {
  const text = String(value || '');
  exchangePassphraseInputs().forEach((input) => {
    input.value = text;
  });
}

function updateExchangePassphraseMeta() {
  const node = document.getElementById('exchangePassphraseMeta');
  if (!node) return;
  if (!state.exchangeDestroyAt || !currentExchangePassphrase()) {
    node.textContent = '可手动输入已有口令，或点击生成后在 60 秒内使用';
    return;
  }
  const seconds = Math.max(0, Math.ceil((state.exchangeDestroyAt - Date.now()) / 1000));
  node.textContent = `${seconds}s 后自动销毁当前口令`;
}

function clearExchangePassphrase(options = {}) {
  if (state.exchangeDestroyTimer) {
    window.clearInterval(state.exchangeDestroyTimer);
    state.exchangeDestroyTimer = null;
  }
  state.exchangeDestroyAt = null;
  if (options.preserveValue !== true) setExchangePassphraseValue('');
  updateExchangePassphraseMeta();
}

function armExchangePassphraseDestroyTimer() {
  if (state.exchangeDestroyTimer) window.clearInterval(state.exchangeDestroyTimer);
  state.exchangeDestroyAt = Date.now() + EXCHANGE_PASSPHRASE_TTL_MS;
  updateExchangePassphraseMeta();
  state.exchangeDestroyTimer = window.setInterval(() => {
    if (!state.exchangeDestroyAt || Date.now() < state.exchangeDestroyAt) {
      updateExchangePassphraseMeta();
      return;
    }
    clearExchangePassphrase();
    showToast('交换口令已自动销毁，请按需重新生成', 'warning');
  }, 1000);
}

function isExchangeModalOpen() {
  return document.body.classList.contains('has-exchange-modal');
}

function setExchangeStatus(message = '', tone = 'info') {
  state.exchangeStatus = message ? { message, tone } : null;
  const node = document.getElementById('exchangeStatusBox');
  if (!node) return;
  if (!message) {
    node.className = 'exchange-modal__status hidden';
    node.textContent = '';
    return;
  }
  node.className = `exchange-modal__status exchange-modal__status--${tone}`;
  node.textContent = message;
}

function openExchangeModal() {
  const modal = document.getElementById('exchangeModal');
  if (!modal) return;
  setExchangeStatus();
  modal.classList.add('is-open');
  modal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('has-exchange-modal');
}

function closeExchangeModal() {
  const modal = document.getElementById('exchangeModal');
  if (!modal) return;
  modal.classList.remove('is-open');
  modal.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('has-exchange-modal');
  const fileInput = document.getElementById('exchangeFileInput');
  if (fileInput) fileInput.value = '';
  setExchangeStatus();
  clearExchangePassphrase();
}

async function generateExchangePassphrase() {
  const json = await api('/api/exchange/passphrase', { method: 'GET' });
  setExchangePassphraseValue(json.passphrase || '');
  armExchangePassphraseDestroyTimer();
  return json.passphrase || '';
}

function currentRefreshIntervalMs() {
  return Math.max(0, Number(state.refreshSeconds || 0)) * 1000;
}

function isAutoRefreshEnabled() {
  return Number(state.refreshSeconds || 0) > 0;
}

function syncRefreshControls() {
  const select = document.getElementById('refreshIntervalSelect');
  const customInput = document.getElementById('refreshCustomInput');
  if (!select || !customInput) return;
  const value = Number(state.refreshSeconds || 0);
  if (REFRESH_PRESET_VALUES.includes(value)) {
    select.value = String(value);
    customInput.classList.add('hidden');
  } else {
    select.value = 'custom';
    customInput.classList.remove('hidden');
    customInput.value = String(value || 10);
  }
}

function setRefreshSeconds(nextValue) {
  const numeric = Math.trunc(Number(nextValue));
  if (!Number.isFinite(numeric)) return;
  const clamped = Math.max(0, Math.min(600, numeric));
  state.refreshSeconds = clamped;
  state.refreshCountdown = clamped;
  try {
    window.localStorage.setItem(REFRESH_SECONDS_STORAGE_KEY, String(clamped));
  } catch (_) {
    // ignore localStorage failures
  }
  syncRefreshControls();
  startRuntimeRefreshLoop();
  renderRefreshNote();
}

function syncAccountFilterControls() {
  const searchInput = document.getElementById('accountSearchInput');
  const sortSelect = document.getElementById('accountSortSelect');
  const filterSelect = document.getElementById('accountFilterSelect');
  const loginMethodFilterSelect = document.getElementById('accountLoginMethodFilterSelect');
  if (searchInput) searchInput.value = state.accountSearch;
  if (sortSelect) sortSelect.value = state.accountSort;
  if (filterSelect) filterSelect.value = state.accountFilter;
  if (loginMethodFilterSelect) loginMethodFilterSelect.value = state.accountLoginMethodFilter;
}

function persistAccountFilterState() {
  try {
    window.localStorage.setItem(ACCOUNT_SEARCH_STORAGE_KEY, state.accountSearch);
    window.localStorage.setItem(ACCOUNT_FILTER_STORAGE_KEY, state.accountFilter);
    window.localStorage.setItem(ACCOUNT_LOGIN_METHOD_FILTER_STORAGE_KEY, state.accountLoginMethodFilter);
  } catch (_) {
    // ignore localStorage failures
  }
}

function resetAccountFiltersForNewAccount() {
  state.accountSearch = '';
  state.accountFilter = 'all';
  state.accountLoginMethodFilter = 'all';
  persistAccountFilterState();
  syncAccountFilterControls();
}

function refreshStatusText() {
  const refreshState = state.runtime && state.runtime.runtimeRefresh ? state.runtime.runtimeRefresh : {};
  if (refreshState.state === 'syncing' || state.refreshPending) return '后台刷新中';
  if (!state.runtime) return '等待首次快照';
  if (!isAutoRefreshEnabled()) return '自动刷新已关闭';
  return `${state.refreshCountdown}s 后自动刷新`;
}

function displayPlanType(value) {
  const text = String(value || '').trim();
  return text || '暂未识别';
}

function describePlanTypeSource(source = {}) {
  if (source.failedCount) return `有 ${source.failedCount} 个账号同步失败`;
  return '后端同步正常';
}

function interactiveRecoveryStateLabel(value) {
  const mapping = {
    idle: '空闲',
    pending: '检测到中断',
    switching: '自动切换中',
    queued: '已排队',
    recovering: '恢复原线程',
    resuming: '自动续跑中',
    completed: '已恢复',
    cancelled: '已取消',
    blocked: '无可用账号',
    no_candidate: '无可用账号',
    healthy: '正常',
    busy: '等待切换',
    disabled: '已关闭',
    failed: '恢复失败'
  };
  return mapping[String(value || '').trim()] || (String(value || '').trim() || '空闲');
}

function interactiveRecoveryTone(value) {
  const normalized = String(value || '').trim();
  if (['switching', 'queued', 'recovering', 'resuming', 'pending', 'busy'].includes(normalized)) return 'warning';
  if (['blocked', 'no_candidate', 'failed'].includes(normalized)) return 'danger';
  if (['completed', 'healthy'].includes(normalized)) return 'healthy';
  return 'unknown';
}

function interruptionReasonLabel(value) {
  const mapping = {
    quota_exhausted_after_completion: '本轮完成后额度耗尽',
    quota_exhausted_during_run: '执行中额度耗尽',
    auth_required: '需要重新认证',
    auth_required_during_run: '执行中掉出认证',
    compression_paused: '压缩后被认证墙打断',
    composer_unavailable: '输入区不可用'
  };
  return mapping[String(value || '').trim()] || (String(value || '').trim() || '未记录');
}

function describeInteractiveRecoverySummary(recovery = {}) {
  const parts = [];
  if (recovery.lastInterruptionReason) parts.push(interruptionReasonLabel(recovery.lastInterruptionReason));
  if (recovery.switchTargetSlotId) parts.push(`目标 ${slotLabelById(recovery.switchTargetSlotId)}`);
  const session = recovery.primaryBridgeSession || null;
  if (session) {
    if (session.focused) parts.push('主标签页在线');
    else if (session.visible) parts.push('标签页可见');
    else parts.push('标签页待激活');
  }
  return parts.join(' · ') || '等待新的中断信号';
}

function describeInteractiveRecoveryDetail(recovery = {}) {
  const parts = [];
  if (recovery.lastInterruptionReason) parts.push(`原因：${interruptionReasonLabel(recovery.lastInterruptionReason)}`);
  if (recovery.switchTargetSlotId) parts.push(`切换目标：${slotLabelById(recovery.switchTargetSlotId)}`);
  const session = recovery.primaryBridgeSession || null;
  if (session && session.threadTitle) parts.push(`线程：${session.threadTitle}`);
  if (session && session.lastSeenAt) parts.push(`桥接心跳 ${formatTimestamp(session.lastSeenAt, { includeSeconds: true })}`);
  if (!parts.length) return '当前没有待恢复的交互中断';
  return parts.join(' · ');
}

function renderRefreshNote() {
  const note = document.getElementById('autoRefreshNote');
  if (!note) return;
  const refreshState = state.runtime && state.runtime.runtimeRefresh ? state.runtime.runtimeRefresh : null;
  const finishedAt = refreshState && refreshState.finished_at ? formatTimestamp(refreshState.finished_at, { includeSeconds: true }) : '--';
  note.textContent = `刷新日志：${refreshStatusText()} · 最近完成 ${finishedAt}`;
}

function updateSettingsFromRuntime(runtime) {
  const settings = runtime && runtime.settings ? runtime.settings : {};
  state.settings.autoSwitchEnabled = !!settings.auto_switch_enabled;
  syncAutoSwitchButton();
}

async function acknowledgeRuntimeAlert(alertId) {
  if (!alertId || state.presentedAlertIds.has(alertId)) return;
  state.presentedAlertIds.add(alertId);
  try {
    await api(`/api/runtime/alerts/${encodeURIComponent(alertId)}/ack`, {
      method: 'POST',
      body: '{}'
    });
  } catch (_) {
    // ignore alert ack failures
  }
}

function presentRuntimeAlerts(runtime) {
  const alerts = Array.isArray(runtime && runtime.alerts) ? runtime.alerts : [];
  const alert = alerts[0];
  if (!alert || state.presentedAlertIds.has(alert.id)) return;
  window.alert(`${alert.title}\n\n${alert.message}`);
  void acknowledgeRuntimeAlert(alert.id);
}

function maybeRequestInitialRefresh() {
  if (state.initialRefreshRequested || !state.runtime || !isAutoRefreshEnabled()) return;
  const refreshState = state.runtime.runtimeRefresh || {};
  if (refreshState.state === 'syncing') {
    state.initialRefreshRequested = true;
    return;
  }
  const hasStaleSlot = Array.isArray(state.runtime.slots) && state.runtime.slots.some((slot) => slot.needs_refresh);
  if (!hasStaleSlot) return;
  state.initialRefreshRequested = true;
  triggerRuntimeRefresh('initial_dashboard', {
    slotId: state.selectedAccountId || null
  }).catch(console.error);
}

function bootstrapStatusText(status) {
  const mapping = {
    starting: '准备中',
    awaiting_user: '等待认证',
    success_pending_capture: '校验身份中',
    succeeded: '校验身份中',
    captured: '已完成',
    failed: '已失败',
    retrying_wrong_account: '重试中'
  };
  return mapping[status] || status || '--';
}

function bootstrapStatusTone(status) {
  if (status === 'captured') return 'healthy';
  if (status === 'failed') return 'expired';
  if (status === 'success_pending_capture' || status === 'succeeded') return 'warning';
  return 'warning';
}

async function startBootstrapTask(slotId, options = {}) {
  const result = await api(
    options.restart === true
      ? `/api/accounts/${slotId}/bootstrap/restart`
      : `/api/accounts/${slotId}/bootstrap`,
    {
      method: 'POST',
      body: JSON.stringify({
        authProfileId: options.authProfileId || null,
        workspaceLabel: options.workspaceLabel || null
      })
    }
  );
  scheduleRuntimeReload(10, { includeLogs: false });
  scheduleRuntimeReload(220);
  return result;
}

function mergeLoadOptions(current = {}, incoming = {}) {
  const safeCurrent = current && typeof current === 'object' ? current : {};
  const safeIncoming = incoming && typeof incoming === 'object' ? incoming : {};
  const currentFast = safeCurrent.fast === true;
  const incomingFast = safeIncoming.fast === true;
  const currentIncludeLogs = safeCurrent.includeLogs === false ? false : true;
  const incomingIncludeLogs = safeIncoming.includeLogs === false ? false : true;
  return {
    fast: currentFast && incomingFast,
    includeLogs: currentIncludeLogs && incomingIncludeLogs
  };
}

function scheduleRuntimeReload(delay = 0, options = {}) {
  if (state.runtimeReloadTimer) window.clearTimeout(state.runtimeReloadTimer);
  state.runtimeReloadOptions = mergeLoadOptions(state.runtimeReloadOptions, options);
  state.runtimeReloadTimer = window.setTimeout(() => {
    state.runtimeReloadTimer = null;
    const nextOptions = state.runtimeReloadOptions || {};
    state.runtimeReloadOptions = null;
    loadRuntime(nextOptions).catch(console.error);
  }, delay);
}

function scheduleDeferredLogsLoad(delay = 420) {
  if (state.deferredLogsLoadTimer) window.clearTimeout(state.deferredLogsLoadTimer);
  state.deferredLogsLoadTimer = window.setTimeout(() => {
    state.deferredLogsLoadTimer = null;
    loadRuntime().catch(console.error);
  }, delay);
}

function activeDeviceAuthCooldown() {
  const cooldown = state.runtime && state.runtime.deviceAuthCooldown ? state.runtime.deviceAuthCooldown : null;
  if (!cooldown || !cooldown.expires_at) return null;
  const expiresAt = new Date(cooldown.expires_at);
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) return null;
  return cooldown;
}

function isActiveBootstrapStatus(status) {
  return ['starting', 'awaiting_user', 'success_pending_capture', 'succeeded'].includes(status);
}

function activeBootstrapSession() {
  const sessions = state.runtime && Array.isArray(state.runtime.bootstrapSessions) ? state.runtime.bootstrapSessions : [];
  return sessions.find((session) => isActiveBootstrapStatus(session.status)) || null;
}

function subscriptionTone(status) {
  if (status === 'healthy') return 'healthy';
  if (status === 'warning') return 'warning';
  if (status === 'expired') return 'expired';
  return 'unknown';
}

function quotaTone(pct) {
  if (pct == null) return 'empty';
  const remaining = quotaRemainingPct(pct);
  if (remaining == null) return 'empty';
  if (remaining <= 10) return 'danger';
  if (remaining <= 30) return 'warning';
  return 'healthy';
}

function quotaValueText(pct) {
  return pct == null ? '--' : `${pct}%`;
}

function quotaRemainingPct(pct) {
  if (pct == null) return null;
  return Math.max(0, 100 - pct);
}

function quotaRemainingText(pct) {
  const remaining = quotaRemainingPct(pct);
  if (remaining == null) return '剩余 --';
  return `约剩余 ${remaining}%`;
}

function quotaRgb(pct) {
  const tone = quotaTone(pct);
  if (tone === 'healthy') return [18, 122, 72];
  if (tone === 'warning') return [198, 110, 18];
  if (tone === 'danger') return [211, 47, 47];
  return [148, 163, 184];
}

function quotaGaugeColor(pct) {
  const [r, g, b] = quotaRgb(pct);
  return `rgb(${r}, ${g}, ${b})`;
}

function quotaSurfaceColor(pct) {
  const tone = quotaTone(pct);
  if (tone === 'healthy') return 'linear-gradient(180deg, #ebfaf1 0%, #ffffff 100%)';
  if (tone === 'warning') return 'linear-gradient(180deg, #fff6e8 0%, #fffdf8 100%)';
  if (tone === 'danger') return 'linear-gradient(180deg, #fff1f1 0%, #ffffff 100%)';
  return 'linear-gradient(180deg, #f8fafc 0%, #ffffff 100%)';
}

function quotaBorderColor(pct) {
  const [r, g, b] = quotaRgb(pct);
  return `rgba(${r}, ${g}, ${b}, 0.24)`;
}

function quotaSoftColor(pct, alpha = 0.18) {
  const [r, g, b] = quotaRgb(pct);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function quotaSignalValue(pct) {
  const remaining = quotaRemainingPct(pct);
  return remaining == null ? '--' : `${remaining}%`;
}

function buildQuotaSignal(label, pct) {
  return `
    <div class="quota-signal ${quotaTone(pct)}" title="${escapeHtml(buildQuotaSignalTitle(label, pct))}">
      <span class="quota-signal__lamp" aria-hidden="true"></span>
      <span class="quota-signal__label">${label}</span>
      <strong>${quotaSignalValue(pct)}</strong>
    </div>
  `;
}

function buildAccountIndexSignals(account) {
  const profiles = Array.isArray(account.auth_profiles) ? account.auth_profiles.filter(Boolean) : [];
  const resolvedProfiles = profiles.length
    ? profiles
    : [{
        workspace_label: account.active_workspace_label || account.primary_workspace_label || 'Main',
        quota_5h_pct: account.quota_5h_pct,
        quota_week_pct: account.quota_week_pct,
        is_primary: true
      }];
  return `
    <div class="account-index-signal-list">
      ${resolvedProfiles.map((authProfile) => `
        <div class="account-index-signal-row">
          <span class="account-index-signal-row__label" title="${escapeHtml(displayWorkspaceNameForProfile(authProfile, 'Main'))}">${escapeHtml(displayWorkspaceNameForProfile(authProfile, 'Main'))}</span>
          ${buildQuotaSignal('5小时', authProfile.quota_5h_pct)}
          ${buildQuotaSignal('1周', authProfile.quota_week_pct)}
        </div>
      `).join('')}
    </div>
  `;
}

function logStateItems(kind) {
  return kind === 'switch' ? (state.recentSwitches || []) : (state.recentSamples || []);
}

function renderLogKind(kind) {
  if (kind === 'switch') renderSwitchLogs(logStateItems('switch'));
  else renderSampleLogs(logStateItems('sample'));
}

function jumpToLogPage(kind) {
  const input = document.getElementById(kind === 'switch' ? 'switchLogJumpInput' : 'sampleLogJumpInput');
  const items = logStateItems(kind);
  if (!input || !items.length) return;
  const raw = Number(input.value);
  if (!Number.isFinite(raw) || raw < 1) {
    showToast('请输入有效页码', 'warning');
    input.focus();
    return;
  }
  const totalPages = totalLogPages(items);
  const targetPage = Math.min(totalPages, Math.max(1, Math.trunc(raw)));
  if (kind === 'switch') state.switchLogPage = targetPage;
  else state.sampleLogPage = targetPage;
  renderLogKind(kind);
}

function buildQuotaSignalTitle(label, pct) {
  if (pct == null) return `${label} 暂无额度数据`;
  return `${label}已用 ${quotaValueText(pct)}，${quotaRemainingText(pct)}`;
}

function quotaGaugeTrackColor(pct) {
  return quotaSoftColor(pct, 0.18);
}

function buildGaugeSvg(pct, compact = false) {
  const remaining = quotaRemainingPct(pct);
  const progress = remaining == null ? 0 : Math.max(0, Math.min(100, remaining));
  const center = 80;
  const radius = compact ? 53 : 60;
  const angle = ((progress / 100) * 360) - 90;
  const radians = (angle * Math.PI) / 180;
  const markerX = center + Math.cos(radians) * radius;
  const markerY = center + Math.sin(radians) * radius;
  const gaugeColor = quotaGaugeColor(pct);
  const trackColor = quotaGaugeTrackColor(pct);

  return `
    <svg class="quota-gauge__svg" viewBox="0 0 160 160" aria-hidden="true" focusable="false">
      <circle class="quota-gauge__track" cx="${center}" cy="${center}" r="${radius}" fill="none" stroke="${trackColor}"></circle>
      <circle
        class="quota-gauge__progress"
        cx="${center}"
        cy="${center}"
        r="${radius}"
        pathLength="100"
        fill="none"
        stroke="${gaugeColor}"
        stroke-dasharray="${progress.toFixed(2)} 100"
        stroke-dashoffset="0"
        transform="rotate(-90 ${center} ${center})"
      ></circle>
      ${remaining == null ? '' : `<circle class="quota-gauge__marker" cx="${markerX.toFixed(2)}" cy="${markerY.toFixed(2)}" r="${compact ? 5.5 : 6.5}" fill="${gaugeColor}"></circle>`}
    </svg>
  `;
}

function parseJsonSafe(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch (_) {
    return null;
  }
}

function extractErrorMessage(value) {
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return '';
    if ((text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']'))) {
      const parsed = parseJsonSafe(text);
      if (parsed && parsed !== value) return extractErrorMessage(parsed);
    }
    return text;
  }
  if (value == null) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object') {
    return extractErrorMessage(value.error)
      || extractErrorMessage(value.message)
      || extractErrorMessage(value.code)
      || (() => {
        try {
          return JSON.stringify(value);
        } catch (_) {
          return String(value);
        }
      })();
  }
  return String(value).trim();
}

function humanizeBackendError(rawText) {
  const text = extractErrorMessage(rawText);
  if (text === 'UNKNOWN_BACKEND_ERROR') return '后端返回了不完整的错误响应，请重新操作一次；如果反复出现，我会继续沿着 server / agent 日志追具体原因';
  if (!text || text === '[object Object]') return '这条历史错误记录没有把原始原因展开完整；我已经修了新写入链路。请重新操作一次，新的错误会显示得更具体';
  if (/refresh_token_reused/i.test(text) || /refresh token has already been used to generate a new access token/i.test(text)) return '这个工作区的旧登录令牌已经失效了，通常是因为这份认证已经被新的登录态替换；请重新认证这个工作区';
  if (text === 'WORKSPACE_ALREADY_EXISTS') return '创建工作区失败，工作区已存在，请去对应工作区点重新认证';
  if (/^WORKSPACE_ALREADY_EXISTS:/i.test(text)) return text.replace(/^WORKSPACE_ALREADY_EXISTS:\s*/i, '');
  if (text === 'WORKSPACE_REAUTH_TARGET_MISMATCH') return '这次认证结果不属于目标工作区，系统不会自动覆盖别的工作区；请在正确的工作区卡片里点重新认证';
  if (/^WORKSPACE_REAUTH_TARGET_MISMATCH:/i.test(text)) return text.replace(/^WORKSPACE_REAUTH_TARGET_MISMATCH:\s*/i, '');
  if (text === 'ACCOUNT_EMAIL_DUPLICATE') return '已存在同邮箱账号，请直接使用原账号，或在原账号下新增工作区';
  if (text === 'WORKSPACE_LABEL_DUPLICATE') return '同一个账号下不能有两个同名工作区，请换一个工作区名称';
  if (/^WORKSPACE_LABEL_DUPLICATE:/i.test(text)) return text.replace(/^WORKSPACE_LABEL_DUPLICATE:\s*/i, '');
  if (text === 'EXCHANGE_DECRYPT_FAILED') return '交换文件解密失败，通常是口令不正确';
  if (text === 'UNSUPPORTED_ENCRYPTION') return '交换文件的加密方式当前不受支持';
  if (text === 'EXCHANGE_DUPLICATE_WORKSPACE') return '导入失败：目标账号下已经存在同名工作区';
  if (text === 'EXCHANGE_PROFILE_CONFLICT_OTHER_ACCOUNT') return '导入失败：交换文件中的工作区身份已绑定到另一个账号';
  if (text === 'FORBIDDEN') return '认证代理拒绝了请求，请检查本地 agent 共享密钥或代理权限配置';
  if (text === 'AUTH_AGENT_FORBIDDEN') return '认证代理拒绝了请求，请检查本地 agent 共享密钥或代理权限配置';
  if (text === 'AUTH_AGENT_UNAVAILABLE') return '认证代理暂时不可用，请确认本地 agent 进程与 socket 已正常启动';
  if (text === 'AGENT_REQUEST_TIMEOUT') return '认证代理响应超时，请稍后重试';
  if (/device auth timed out after 15 minutes/i.test(text)) return '设备码认证已超时（15 分钟），请重新认证并在 15 分钟内完成登录';
  if (/device-auth exited with code 1/i.test(text) || /device auth exited unexpectedly/i.test(text)) return 'Codex 登录进程提前退出了，请重新认证；如果连续出现，请检查本机 Codex CLI 登录环境';
  if (/deactivated_workspace/i.test(text)) return '工作区已失效，后端暂时无法读取这个账号的实时额度';
  if (/WHAM_REQUEST_FAILED_401/i.test(text)) return '后端登录态已失效，暂时无法读取实时额度';
  const match = text.match(/backend_usage_fetch_failed :: (.+)$/i);
  return maskEmailsInText(match ? match[1] : text);
}

function slotLabelById(slotId) {
  if (!slotId) return '未归档账号';
  const slots = state.runtime && Array.isArray(state.runtime.slots) ? state.runtime.slots : [];
  const slot = slots.find((item) => item.id === slotId);
  if (!slot) return slotId;
  return displayAccountName(slot);
}

function slotMetaById(slotId) {
  if (!slotId) return '';
  const slots = state.runtime && Array.isArray(state.runtime.slots) ? state.runtime.slots : [];
  const slot = slots.find((item) => item.id === slotId);
  if (!slot) return slotId;
  return loginMethodLabel(slot.login_method);
}

function switchStatusLabel(status) {
  const mapping = {
    starting: '进行中',
    completed: '已完成',
    failed: '失败'
  };
  return mapping[status] || status || '--';
}

function switchStatusTone(status) {
  if (status === 'completed') return 'healthy';
  if (status === 'failed') return 'expired';
  return 'warning';
}

function switchReasonLabel(reason) {
  const mapping = {
    manual_switch: '手动切换',
    auto_switch: '自动切换',
    bootstrap_capture: '认证接管'
  };
  return mapping[reason] || reason || '未知原因';
}

function quotaSyncStatusLabel(status) {
  if (status === 'ok') return '同步成功';
  if (status === 'error') return '同步失败';
  return '等待同步';
}

function quotaSyncStatusTone(status) {
  if (status === 'ok') return 'healthy';
  if (status === 'error') return 'expired';
  return 'warning';
}

function quotaLineDescription(label, pct, resetLabel, resetAt) {
  if (pct == null) return `${label} 暂无可用数据`;
  return `${label}已用 ${quotaValueText(pct)}，${quotaRemainingText(pct)}，${displayResetLabel(resetLabel, resetAt, { includeUtc: true })} 重置`;
}

function buildQuotaGaugeCard(label, pct, resetLabel, resetAt, options = {}) {
  const remaining = quotaRemainingPct(pct);
  const tone = quotaTone(pct);
  const usedText = pct == null ? '已用 --' : `${quotaValueText(pct)} 已用`;
  const note = pct == null
    ? '后端暂时没有返回这项额度'
    : buildResetTimeBlock(resetLabel, resetAt);
  return `
    <article class="quota-gauge-card ${options.compact ? 'quota-gauge-card--compact' : 'quota-gauge-card--hero'} ${tone}">
      <div class="quota-gauge-card__head">
        <div class="quota-gauge__title">${label}</div>
        <div class="quota-gauge__used">${usedText}</div>
      </div>
      <div class="quota-gauge-card__body">
        <div class="quota-gauge">
          ${buildGaugeSvg(pct, options.compact)}
          <div class="quota-gauge__inner">
            <strong>${remaining == null ? '--' : `${remaining}%`}</strong>
            <small>剩余</small>
          </div>
        </div>
      </div>
      <div class="quota-gauge__meta">
        <div class="quota-gauge__note">${escapeHtmlMultiline(note)}</div>
      </div>
    </article>
  `;
}

function totalLogPages(items) {
  return Math.max(1, Math.ceil(items.length / LOG_PAGE_SIZE));
}

function paginateLogs(items, page) {
  const totalPages = totalLogPages(items);
  const currentPage = Math.min(Math.max(page, 1), totalPages);
  const start = (currentPage - 1) * LOG_PAGE_SIZE;
  return {
    items: items.slice(start, start + LOG_PAGE_SIZE),
    currentPage,
    totalPages
  };
}

function updateLogPager(kind, totalItems, currentPage, totalPages) {
  const prevButton = document.getElementById(kind === 'switch' ? 'switchLogPrevBtn' : 'sampleLogPrevBtn');
  const nextButton = document.getElementById(kind === 'switch' ? 'switchLogNextBtn' : 'sampleLogNextBtn');
  const pageInfo = document.getElementById(kind === 'switch' ? 'switchLogPageInfo' : 'sampleLogPageInfo');
  const pageText = document.getElementById(kind === 'switch' ? 'switchLogPageText' : 'sampleLogPageText');
  const pageMeta = document.getElementById(kind === 'switch' ? 'switchLogPageMeta' : 'sampleLogPageMeta');
  const clearButton = document.getElementById(kind === 'switch' ? 'clearSwitchLogsBtn' : 'clearSampleLogsBtn');
  const jumpInput = document.getElementById(kind === 'switch' ? 'switchLogJumpInput' : 'sampleLogJumpInput');
  if (!prevButton || !nextButton || !pageInfo || !pageText || !pageMeta || !clearButton) return;
  prevButton.disabled = totalItems === 0 || currentPage <= 1;
  nextButton.disabled = totalItems === 0 || currentPage >= totalPages;
  clearButton.disabled = totalItems === 0;
  pageInfo.classList.toggle('disabled', totalItems === 0);
  pageInfo.dataset.totalPages = String(totalPages);
  pageInfo.dataset.currentPage = String(currentPage);
  pageText.textContent = totalItems === 0 ? '暂无记录' : `${currentPage} / ${totalPages} 页`;
  pageMeta.textContent = totalItems === 0 ? '' : `共 ${totalItems} 条`;
  if (jumpInput) {
    jumpInput.disabled = totalItems === 0;
    jumpInput.min = '1';
    jumpInput.max = String(totalPages);
    jumpInput.placeholder = totalItems === 0 ? '--' : String(currentPage);
    jumpInput.value = totalItems === 0 ? '' : String(currentPage);
  }
  setLogPageEditMode(kind, false);
}

function setLogPageEditMode(kind, editing) {
  const pageInfo = document.getElementById(kind === 'switch' ? 'switchLogPageInfo' : 'sampleLogPageInfo');
  const pageText = document.getElementById(kind === 'switch' ? 'switchLogPageText' : 'sampleLogPageText');
  const pageMeta = document.getElementById(kind === 'switch' ? 'switchLogPageMeta' : 'sampleLogPageMeta');
  const jumpInput = document.getElementById(kind === 'switch' ? 'switchLogJumpInput' : 'sampleLogJumpInput');
  if (!pageInfo || !pageText || !pageMeta || !jumpInput || pageInfo.classList.contains('disabled')) return;
  pageInfo.classList.toggle('is-editing', editing);
  pageText.classList.toggle('hidden', editing);
  pageMeta.classList.toggle('hidden', editing);
  jumpInput.classList.toggle('hidden', !editing);
  if (editing) {
    jumpInput.focus();
    jumpInput.select();
  }
}

function showToast(message, tone = 'success') {
  const viewport = document.getElementById('toastViewport');
  if (!viewport) return;
  const toast = document.createElement('div');
  toast.className = `toast toast--${tone}`;
  toast.dataset.toastId = String(++state.toastId);
  toast.textContent = message;
  viewport.appendChild(toast);
  window.setTimeout(() => {
    toast.classList.add('toast--closing');
    window.setTimeout(() => toast.remove(), 180);
  }, 2200);
}

function downloadJsonFile(filename, payload) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = window.URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => window.URL.revokeObjectURL(url), 0);
}

function setButtonBusy(button, pendingText) {
  if (!button) return () => {};
  const previousDisabled = button.disabled;
  const originalText = button.dataset.originalText || button.textContent;
  button.dataset.originalText = originalText;
  button.disabled = true;
  button.classList.add('is-busy');
  if (pendingText) button.textContent = pendingText;
  return () => {
    if (!button.isConnected) return;
    button.disabled = previousDisabled;
    button.classList.remove('is-busy');
    button.textContent = originalText;
  };
}

function explainError(error) {
  const message = extractErrorMessage(error && error.message ? error.message : error);
  if (message === 'UNKNOWN_BACKEND_ERROR') return '操作失败，后端返回了不完整的错误响应，请重试一次';
  if (!message || message === '[object Object]') return '操作失败，这次返回的是一条没有展开完整的历史错误；请重试一次，我现在会尽量给出具体原因';
  if (/refresh_token_reused/i.test(message) || /refresh token has already been used to generate a new access token/i.test(message)) return '这个工作区的旧登录令牌已经失效了，请重新认证这个工作区';
  if (message === 'SESSION_COOKIE_NOT_PERSISTED') return '登录态没有成功写入浏览器，请检查 Cookie 域名或 secure 配置';
  if (message === 'PASSPHRASE_REQUIRED') return '请输入交换口令后再继续';
  if (message === 'UNSUPPORTED_EXCHANGE_SCHEMA') return '交换文件版本不受支持';
  if (message === 'EXCHANGE_DECRYPT_FAILED') return '交换文件解密失败，请检查交换口令';
  if (message === 'UNSUPPORTED_ENCRYPTION') return '交换文件使用了当前不支持的加密方式';
  if (message === 'EXCHANGE_DUPLICATE_WORKSPACE') return '导入失败：目标账号下已经存在同名工作区';
  if (message === 'EXCHANGE_PROFILE_CONFLICT_OTHER_ACCOUNT') return '导入失败：交换文件中的工作区已经绑定到另一个账号';
  if (message === 'INVALID_EXCHANGE_PAYLOAD' || message === 'EXCHANGE_IMPORT_FAILED') return '交换文件无法解析，或口令不正确';
  if (message === 'DEVICE_AUTH_RATE_LIMITED') return '设备码请求过于频繁，请等待一分钟后再试，或先删除当前认证任务';
  if (message === 'BOOTSTRAP_ALREADY_ACTIVE') {
    const currentPendingBootstrap = activeBootstrapSession();
    return `当前已经有认证任务在进行：${displayEmailValue(currentPendingBootstrap && currentPendingBootstrap.email, { fallback: '另一个账号' })}；请先完成或删除当前任务`;
  }
  if (message === 'FORBIDDEN') return '认证代理拒绝了请求，请检查本地 agent 共享密钥或代理权限配置';
  if (message === 'AUTH_AGENT_FORBIDDEN') return '认证代理拒绝了请求，请检查本地 agent 共享密钥或代理权限配置';
  if (message === 'AUTH_AGENT_UNAVAILABLE') return '认证代理暂时不可用，请确认本地 agent 进程与 socket 已正常启动';
  if (message === 'AGENT_REQUEST_TIMEOUT') return '认证代理响应超时，请稍后重试';
  if (message === 'ACTIVE_ACCOUNT_CANNOT_BE_DELETED') return '当前正在使用的账号不能删除，请先切换或退出';
  if (message === 'ACTIVE_ACCOUNT_MUST_EXIT_FIRST') return '当前正在使用的账号不能直接修改邮箱或登录方式，请先退出';
  if (message === 'ACCOUNT_DATA_INCOMPLETE') return '请先把邮箱、登录方式和订阅到期日填写完整并保存';
  if (message === 'PROFILE_NOT_FOUND') return '这个账号还没有服务器留存，请先认证';
  if (message === 'ACCOUNT_EMAIL_DUPLICATE') return '已存在同邮箱账号，请不要重复创建；如需新增认证，请在原账号下新增工作区';
  if (message === 'WORKSPACE_LABEL_DUPLICATE') return '同一个账号下不能有两个同名工作区，请换一个工作区名称';
  if (message === 'WORKSPACE_ALREADY_EXISTS') return '创建工作区失败，工作区已存在，请去对应工作区点重新认证';
  if (message === 'WORKSPACE_REAUTH_TARGET_MISMATCH') return '这次认证结果不属于目标工作区，请在正确的工作区卡片里点重新认证';
  return humanizeBackendError(message);
}

async function runButtonAction(button, options, action) {
  const restore = setButtonBusy(button, options.pendingText);
  try {
    const result = await action();
    if (options.successText) {
      showToast(typeof options.successText === 'function' ? options.successText(result) : options.successText, 'success');
    }
    return result;
  } catch (error) {
    if (options.refreshOnError) {
      await loadRuntime().catch(() => {});
    }
    showToast(typeof options.errorText === 'function' ? options.errorText(error) : (options.errorText || explainError(error)), 'error');
    throw error;
  } finally {
    restore();
  }
}

async function api(path, options = {}) {
  return apiInternal(path, options, false);
}

async function apiInternal(path, options = {}, retried = false) {
  const method = String(options.method || 'GET').toUpperCase();
  if (!state.csrf && method !== 'GET' && method !== 'HEAD') {
    await refreshCsrf().catch(() => {});
  }
  const response = await fetch(path, {
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      ...(state.csrf ? { 'x-csrf-token': state.csrf } : {}),
      ...(options.headers || {})
    },
    ...options
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || json.ok === false) {
    if (!retried && method !== 'GET' && method !== 'HEAD' && (response.status === 403 || json.error === 'BAD_CSRF')) {
      await refreshCsrf().catch(() => {});
      return apiInternal(path, options, true);
    }
    throw new Error(extractErrorMessage(json.error) || `Request failed: ${response.status}`);
  }
  return json;
}

async function triggerRuntimeRefresh(trigger = 'manual', extra = {}) {
  const runtimeRefresh = state.runtime && state.runtime.runtimeRefresh ? state.runtime.runtimeRefresh : null;
  if (state.refreshPending || (runtimeRefresh && runtimeRefresh.state === 'syncing')) return;
  state.refreshPending = true;
  if (state.runtime) {
    state.runtime.runtimeRefresh = {
      ...(state.runtime.runtimeRefresh || {}),
      state: 'syncing',
      trigger,
      started_at: new Date().toISOString()
    };
  }
  renderRefreshNote();
  try {
    await api('/api/runtime/refresh', {
      method: 'POST',
      body: JSON.stringify({
        trigger,
        slotId: extra.slotId || null
      })
    });
    state.refreshCountdown = Number(state.refreshSeconds || 0);
    scheduleRuntimeReload(80, { includeLogs: false });
  } finally {
    state.refreshPending = false;
    renderRefreshNote();
  }
}

async function refreshCsrf() {
  const json = await fetch('/api/csrf', { credentials: 'include' }).then((res) => res.json());
  state.csrf = json.token;
}

function setSessionBadge(text) {
  const value = String(text || '').trim();
  if (value && value !== '未登录') state.sessionEmail = value;
  document.getElementById('sessionBadge').textContent = displayEmailValue(value, { fallback: value || '--' });
}

function renderSummary(runtime) {
  const summary = runtime.summary || {};
  const nextTargetInfo = runtime.nextAutoSwitchTarget || null;
  const nextTarget = nextTargetInfo && nextTargetInfo.slot_id
    ? slotLabelById(nextTargetInfo.slot_id)
    : nextTargetInfo && nextTargetInfo.state === 'no_candidate'
      ? '无可用候选'
      : nextTargetInfo && nextTargetInfo.state === 'no_active_slot'
        ? '暂无活动账号'
        : '自动切换已关闭';
  const nextTargetMeta = nextTargetInfo && nextTargetInfo.slot_id
    ? `${slotMetaById(nextTargetInfo.slot_id)} · ${displayWorkspaceLabel(nextTargetInfo.workspace_label, '主工作区')}`
    : nextTargetInfo && nextTargetInfo.state === 'no_candidate'
      ? '当前没有满足 5 小时和 1 周额度都大于 0 的候选账号'
      : nextTargetInfo && nextTargetInfo.state === 'no_active_slot'
        ? '需要先有一个当前活动账号，才能推导下一候选'
        : '自动切换当前关闭';
  const nextTargetTone = nextTargetInfo && nextTargetInfo.slot_id
    ? 'healthy'
    : nextTargetInfo && nextTargetInfo.state === 'no_candidate'
      ? 'danger'
      : 'unknown';
  document.getElementById('summaryGrid').innerHTML = `
    <article class="stat-card">
      <span class="stat-label">账号总数</span>
      <strong class="stat-value">${summary.totalAccounts || 0}</strong>
    </article>
    <article class="stat-card">
      <span class="stat-label">已认证</span>
      <strong class="stat-value">${summary.authenticatedAccounts || 0}</strong>
    </article>
    <article class="stat-card">
      <span class="stat-label">即将到期</span>
      <strong class="stat-value">${summary.expiringSoon || 0}</strong>
    </article>
    <article class="stat-card stat-card--${nextTargetTone}">
      <span class="stat-label">下个切换目标</span>
      <strong class="stat-value stat-value--compact">${escapeHtml(nextTarget)}</strong>
      <small class="stat-meta">${escapeHtml(nextTargetMeta)}</small>
    </article>
  `;
}

function renderRuntimeTimestamp(nowIso) {
  const node = document.getElementById('runtimeTimestamp');
  if (node) node.textContent = '';
  renderRefreshNote();
}

function renderActiveSlot(runtime) {
  const node = document.getElementById('activeSlotCard');
  const badge = document.getElementById('quotaSourceBadge');
  const active = runtime.activeSlot;
  const source = runtime.quotaSource || {};
  badge.textContent = source.state === 'online'
    ? '后端同步正常'
    : source.state === 'syncing'
      ? '后台刷新中'
    : source.state === 'degraded'
      ? '后端部分异常'
      : source.state === 'error'
        ? '后端同步失败'
        : '等待同步';
  badge.className = `inline-badge ${source.state || 'idle'}`;

  if (!active) {
    node.innerHTML = `
      <div class="active-empty">
        <strong>当前没有活动账号</strong>
        <p class="muted">当服务器上的 code-server 存在有效 Codex 登录态时，这里会自动识别并显示额度</p>
      </div>
    `;
    return;
  }

  node.innerHTML = `
    <div class="active-card">
      <div class="active-card__top">
        <div>
          <div class="active-card__label">当前账号</div>
          <h4>${displayAccountName(active)}</h4>
          <p class="muted">${loginMethodLabel(active.login_method)} · ${displayWorkspaceLabel(active.active_workspace_label || active.primary_workspace_label, '主工作区')}</p>
        </div>
        <div class="status-pill ${stateTone(active.display_state)}">${stateLabel(active)}</div>
      </div>
      <div class="quota-gauge-grid quota-gauge-grid--hero">
        ${buildQuotaGaugeCard('5 小时额度', active.quota_5h_pct, active.quota_5h_reset_label, active.quota_5h_reset_at)}
        ${buildQuotaGaugeCard('1 周额度', active.quota_week_pct, active.quota_week_reset_label, active.quota_week_reset_at)}
      </div>
      <div class="active-card__facts">
        <div class="fact-tile">
          <span>同步时间</span>
          <strong>${escapeHtml(formatTimestamp(active.last_seen_at, { includeSeconds: true }))}</strong>
          <small>${source.message || '后端实时读取'}</small>
        </div>
        <div class="fact-tile">
          <span>account_id</span>
          <strong class="mono" title="${active.account_id || '--'}">${shortId(active.account_id)}</strong>
          <small>${freshnessLabel(active.freshness)}</small>
        </div>
        <div class="fact-tile">
          <span>后端计划标识</span>
          <strong>${displayPlanType(source.planType)}</strong>
          <small>${describePlanTypeSource(source)}</small>
        </div>
      </div>
    </div>
  `;
}

function renderBootstrapSessions(sessions) {
  const node = document.getElementById('bootstrapList');
  const clearButton = document.getElementById('clearBootstrapTasksBtn');
  if (clearButton) {
    clearButton.classList.add('hidden');
    clearButton.disabled = sessions.length === 0;
  }
  if (!node) return;
  node.innerHTML = '';
}

function bootstrapSessionsForSlot(slotId) {
  const sessions = state.runtime && Array.isArray(state.runtime.bootstrapSessions)
    ? state.runtime.bootstrapSessions
    : [];
  return sessions.filter((session) => session.slot_id === slotId);
}

function latestBootstrapSessionForSlot(slotId) {
  return bootstrapSessionsForSlot(slotId)[0] || null;
}

function latestBootstrapSessionForAuthProfile(slotId, authProfileId) {
  return bootstrapSessionsForSlot(slotId)
    .find((session) => String(session.auth_profile_id || '') === String(authProfileId || '')) || null;
}

function unmatchedBootstrapSessionsForAccount(account) {
  const profiles = Array.isArray(account.auth_profiles) ? account.auth_profiles : [];
  const profileIds = new Set(profiles.map((profile) => String(profile.id || '')));
  return bootstrapSessionsForSlot(account.id).filter((session) => {
    const authProfileId = String(session.auth_profile_id || '').trim();
    if (!authProfileId) return true;
    return !profileIds.has(authProfileId);
  });
}

function bootstrapMessageText(account, session) {
  if (!session) return '';
  if (session.error_text) return '这个工作区的认证任务没有完成；你可以重新认证，或取消后重新创建。';
  if (session.status === 'captured') return '认证完成，资料已写回服务器。';
  if (session.status === 'success_pending_capture' || session.status === 'succeeded') return 'OpenAI 已授权，正在校验并接管服务器留存。';
  if (session.status === 'starting') return '正在生成设备码，请稍等。';
  const loginLabel = loginMethodLabel(account.login_method);
  return maskEmailsInText(`点击“打开认证页”即可进入 OpenAI 授权页，按 ${loginLabel} 方式完成授权。浏览器环境由你自己决定。`);
}

function buildInlineAuthProgress(account, session, options = {}) {
  if (!session) return '';

  const deviceCode = session
    ? (session.device_code || extractDeviceCode(session.log_tail || '') || '')
    : '';
  const authOpenUrl = session.auth_open_url || '';
  const targetEmail = account.email || session.email || '';
  const message = bootstrapMessageText(account, session);
  const restartLabel = session.status === 'failed' ? '重新认证' : '重新生成设备码';
  const workspaceLabel = displayWorkspaceLabel(options.workspaceLabel || session.workspace_label, '工作区认证');
  const authProfileId = String(options.authProfileId || session.auth_profile_id || '').trim();
  const title = String(options.title || `${workspaceLabel} 认证`).trim();

  return `
    <section class="account-auth-card">
      <div class="account-auth-card__top">
        <div class="account-auth-card__title">
          <h5>${escapeHtml(title)}</h5>
          <p class="muted">${escapeHtml(message)}</p>
        </div>
        <div class="account-auth-card__actions">
          <span class="status-pill ${bootstrapStatusTone(session.status)}">${escapeHtml(bootstrapStatusText(session.status))}</span>
        </div>
      </div>
      ${targetEmail ? `
        <div class="account-auth-code-row">
          <span class="muted">目标账号</span>
          <button type="button" class="device-code-chip inline-copy-target-email" data-target-email="${escapeHtml(targetEmail)}">
            <span class="mono">${escapeHtml(targetEmail)}</span>
            <span>复制</span>
          </button>
        </div>
      ` : ''}
      <div class="account-auth-code-row">
        <span class="muted">设备码</span>
        ${deviceCode
          ? `
            <button type="button" class="device-code-chip inline-copy-device-code" data-device-code="${deviceCode}">
              <span class="mono">${deviceCode}</span>
              <span>复制</span>
            </button>
          `
          : '<span class="device-code-empty">暂未拿到设备码</span>'}
        <span class="muted">最近更新 ${escapeHtml(formatTimestamp(session.updated_at))}</span>
      </div>
      <div class="account-auth-card__actions">
        ${authOpenUrl ? `<button type="button" class="secondary inline-open-auth-link" data-auth-open-url="${escapeHtml(authOpenUrl)}">打开认证页</button>` : ''}
        ${authOpenUrl ? `<button type="button" class="ghost inline-copy-auth-link" data-auth-open-url="${escapeHtml(authOpenUrl)}">复制认证链接</button>` : ''}
        <button
          type="button"
          class="ghost inline-restart-bootstrap"
          data-slot-id="${account.id}"
          data-auth-profile-id="${escapeHtml(authProfileId)}"
          data-workspace-label="${escapeHtml(workspaceLabel)}"
        >${restartLabel}</button>
        <button type="button" class="danger inline-delete-bootstrap-task" data-bootstrap-id="${session.id}">取消认证</button>
      </div>
      ${session && session.error_text ? `<div class="account-auth-error">${escapeHtml(humanizeBackendError(session.error_text))}</div>` : ''}
      ${session.log_tail ? `
        <details class="task-details" data-bootstrap-id="${session.id}" ${state.openBootstrapLogIds.has(session.id) ? 'open' : ''}>
          <summary>查看日志</summary>
          <pre>${stripAnsi(session.log_tail)}</pre>
        </details>
      ` : ''}
    </section>
  `;
}

function progressMarkup(label, pct, resetLabel) {
  return `
    <div class="quota-line ${quotaTone(pct)}">
      <div class="quota-line__top">
        <span>${label}</span>
        <strong>${quotaValueText(pct)}</strong>
      </div>
      <div class="quota-line__meta">${pct == null ? '后端还没有返回这项额度' : `${quotaRemainingText(pct)} · ${resetLabel} 重置`}</div>
    </div>
  `;
}

function buildQuotaPanel(source, options = {}) {
  const precise = source && Object.prototype.hasOwnProperty.call(source, 'precise')
    ? !!source.precise
    : source.freshness === 'live';
  const suppressError = options.suppressError === true;
  let quotaNote = '';
  if (!precise) {
    if (source.last_error) {
      quotaNote = suppressError ? '' : humanizeBackendError(source.last_error);
    } else {
      quotaNote = '后端暂时没有拿到实时额度，因此这里不会继续展示旧的历史值';
    }
  }
  return `
    <div class="quota-block__head">
      <strong>额度</strong>
      ${precise ? '' : `<span class="muted">${freshnessLabel(source.freshness)}</span>`}
    </div>
    <div class="quota-gauge-grid quota-gauge-grid--compact">
      ${buildQuotaGaugeCard('5 小时额度', source.quota_5h_pct, source.quota_5h_reset_label, source.quota_5h_reset_at)}
      ${buildQuotaGaugeCard('1 周额度', source.quota_week_pct, source.quota_week_reset_label, source.quota_week_reset_at)}
    </div>
    ${quotaNote ? `<div class="quota-note quota-note--warning">${escapeHtml(quotaNote)}</div>` : ''}
  `;
}

function authRuntimeStatusLabel(authProfile) {
  const status = String(authProfile.runtime_status || '').trim();
  const mapping = {
    active: '当前使用中',
    ready: '已认证',
    pending_auth: '认证中',
    stale: '等待刷新',
    exhausted: '额度耗尽',
    error: '异常',
    reauth_required: '需要重新认证'
  };
  return mapping[status] || '已认证';
}

function authRuntimeStatusTone(authProfile) {
  const status = String(authProfile.runtime_status || '').trim();
  if (status === 'error' || status === 'reauth_required') return 'danger';
  if (status === 'exhausted' || status === 'pending_auth' || status === 'stale') return 'warning';
  return 'healthy';
}

function buildWorkspaceMetaGrid(account, authProfile) {
  const statusText = authRuntimeStatusLabel(authProfile);
  const errorMarkup = authProfile.last_error && authProfile.last_error !== '无'
    ? `<div class="fact-row fact-row--error"><span>错误</span><strong>${escapeHtml(humanizeBackendError(authProfile.last_error))}</strong></div>`
    : '';
  return `
    <div class="fact-row">
      <span>当前状态</span>
      <strong>${escapeHtml(statusText)}</strong>
    </div>
    <div class="fact-row">
      <span>最后同步</span>
      <strong>${escapeHtml(formatTimestamp(authProfile.last_seen_at, { includeSeconds: true }))}</strong>
    </div>
    <div class="fact-row">
      <span>account_id</span>
      <strong class="mono" title="${authProfile.account_id || authProfile.identity_key || '--'}">${shortId(authProfile.account_id || authProfile.identity_key)}</strong>
    </div>
    ${errorMarkup}
  `;
}

function buildWorkspacePanel(account, authProfile) {
  const session = latestBootstrapSessionForAuthProfile(account.id, authProfile.id);
  const workspaceLabel = displayWorkspaceLabel(authProfile.workspace_label, '未命名工作区');
  const busy = !!(session && isActiveBootstrapStatus(session.status));
  return `
    <section class="workspace-panel ${authProfile.is_active ? 'workspace-panel--active' : ''}" data-auth-profile-id="${authProfile.id}">
      <div class="workspace-panel__header">
        <div class="workspace-panel__title">
          <h5>${escapeHtml(workspaceLabel)}</h5>
          <p class="muted">${loginMethodLabel(account.login_method)} · ${freshnessLabel(authProfile.freshness)}</p>
        </div>
        <div class="workspace-panel__badges">
          ${authProfile.is_primary ? '<span class="status-pill healthy">主工作区</span>' : ''}
          ${authProfile.is_active ? '<span class="status-pill healthy">当前使用中</span>' : ''}
          ${authProfile.availability === 'error' ? '<span class="status-pill danger">异常</span>' : ''}
        </div>
      </div>
      ${session ? buildInlineAuthProgress(account, session, {
        title: `${workspaceLabel} 认证`,
        workspaceLabel,
        authProfileId: authProfile.id
      }) : ''}
      <div class="workspace-panel__actions">
        <button type="button" class="ghost auth-profile-set-primary" data-auth-profile-id="${authProfile.id}" ${authProfile.is_primary || busy ? 'disabled' : ''}>设为主工作区</button>
        <button type="button" class="ghost auth-profile-rename" data-auth-profile-id="${authProfile.id}" ${busy ? 'disabled' : ''}>修改名称</button>
        ${busy ? '' : `<button type="button" class="secondary auth-profile-reauth" data-auth-profile-id="${authProfile.id}">重新认证</button>`}
        <button type="button" class="primary auth-profile-switch" data-auth-profile-id="${authProfile.id}" ${(authProfile.is_active || busy) ? 'disabled' : ''}>切换</button>
        <button type="button" class="danger auth-profile-delete" data-auth-profile-id="${authProfile.id}" ${busy ? 'disabled' : ''}>删除工作区</button>
      </div>
      <div class="workspace-panel__body">
        <section class="quota-panel">
          ${buildQuotaPanel(authProfile, { suppressError: !!authProfile.last_error })}
        </section>
        <div class="meta-grid workspace-meta-grid">
          ${buildWorkspaceMetaGrid(account, authProfile)}
        </div>
      </div>
    </section>
  `;
}

function buildPendingWorkspacePanel(account, session) {
  const workspaceLabel = displayWorkspaceLabel(session.workspace_label, '待完成工作区');
  return `
    <section class="workspace-panel workspace-panel--pending" data-bootstrap-id="${session.id}">
      <div class="workspace-panel__header">
        <div class="workspace-panel__title">
          <h5>${escapeHtml(workspaceLabel)}</h5>
          <p class="muted">这个工作区正在等待完成认证，完成后会自动变成正式工作区面板</p>
        </div>
        <div class="workspace-panel__badges">
          <span class="status-pill warning">${escapeHtml(bootstrapStatusText(session.status))}</span>
        </div>
      </div>
      ${buildInlineAuthProgress(account, session, {
        title: `${workspaceLabel} 认证`,
        workspaceLabel
      })}
      <div class="workspace-panel__body workspace-panel__body--single">
        <section class="quota-panel">
          <div class="quota-block__head">
            <strong>额度</strong>
            <span class="status-pill unknown">等待认证完成</span>
          </div>
          <div class="quota-note quota-note--warning">完成认证后，这个工作区会在这里显示自己的独立额度、认证状态和切换能力。</div>
        </section>
      </div>
    </section>
  `;
}

function buildWorkspacePanels(account) {
  const profiles = Array.isArray(account.auth_profiles) ? account.auth_profiles : [];
  const profileCards = profiles.map((authProfile) => buildWorkspacePanel(account, authProfile)).join('');
  const pendingCards = unmatchedBootstrapSessionsForAccount(account)
    .map((session) => buildPendingWorkspacePanel(account, session))
    .join('');
  return profileCards || pendingCards
    ? `${profileCards}${pendingCards}`
    : '<div class="empty-card"><strong>还没有工作区</strong><p class="muted">先保存资料，再在下方创建第一个工作区。</p></div>';
}

function buildAuthProfileCreatePanel(account) {
  const profiles = Array.isArray(account.auth_profiles) ? account.auth_profiles : [];
  const hasProfiles = profiles.length > 0;
  return `
    <section class="auth-profile-create-panel">
      <div class="auth-profile-create-panel__head">
        <h5>${hasProfiles ? '新增工作区' : '创建首个工作区'}</h5>
      </div>
      <div class="auth-profile-create">
        <label>
          <span>新增工作区名称</span>
          <input type="text" class="workspace-label-input" data-field="workspace_label" placeholder="例如：主工作区 / 客户 A / 研究环境" />
        </label>
        <button type="button" class="secondary create-auth-profile">${hasProfiles ? '添加工作区' : '创建首个工作区'}</button>
      </div>
    </section>
  `;
}

function stageChip(tone, text) {
  return `<span class="stage-chip ${tone}">${text}</span>`;
}

function buildStageStrip(account) {
  const savedReady = validateAccountFields({
    email: account.email || '',
    login_method: account.login_method || '',
    expires_at: account.expires_at || '',
    label: account.email || ''
  }).valid;

  return `
    ${stageChip(savedReady ? 'healthy' : 'warning', savedReady ? '资料已保存' : '先保存资料')}
    ${stageChip(account.has_pending_bootstrap ? 'warning' : account.has_profile ? 'healthy' : 'warning', account.has_pending_bootstrap ? '认证进行中' : account.has_profile ? '已完成认证' : '待认证')}
    ${stageChip(account.is_active ? 'healthy' : 'warning', account.is_active ? '当前正在使用' : '未切换')}
    ${stageChip(account.subscription_status === 'expired' ? 'danger' : account.subscription_status === 'warning' ? 'warning' : 'healthy', account.subscription_label || '未设置到期日')}
  `;
}

function sortAccounts(accounts) {
  const severity = { expired: 0, warning: 1, healthy: 2, unknown: 3 };
  const quotaRemaining = (account, key) => {
    const pct = Number(account[key]);
    if (!Number.isFinite(pct)) return -1;
    return Math.max(0, 100 - pct);
  };
  return [...accounts].sort((a, b) => {
    if (state.accountSort === 'quota_5h') return quotaRemaining(b, 'quota_5h_pct') - quotaRemaining(a, 'quota_5h_pct');
    if (state.accountSort === 'quota_7d') return quotaRemaining(b, 'quota_week_pct') - quotaRemaining(a, 'quota_week_pct');
    if (state.accountSort === 'name_asc') return String(displayAccountName(a) || a.id).localeCompare(String(displayAccountName(b) || b.id), 'zh-CN');
    if (state.accountSort === 'name_desc') return String(displayAccountName(b) || b.id).localeCompare(String(displayAccountName(a) || a.id), 'zh-CN');
    if (state.accountSort === 'expiry') {
      return String(a.expires_at || '9999-12-31').localeCompare(String(b.expires_at || '9999-12-31'));
    }
    if (!!a.is_active !== !!b.is_active) return a.is_active ? -1 : 1;
    if (!!a.has_profile !== !!b.has_profile) return a.has_profile ? -1 : 1;
    const sa = severity[a.subscription_status] ?? 9;
    const sb = severity[b.subscription_status] ?? 9;
    if (sa !== sb) return sa - sb;
    return String(displayAccountName(a) || a.id).localeCompare(String(displayAccountName(b) || b.id), 'zh-CN');
  });
}

function filterAccounts(accounts) {
  const search = String(state.accountSearch || '').trim().toLowerCase();
  return accounts.filter((account) => {
    if (state.accountFilter === 'available' && (!account.has_profile || account.display_state === 'error' || account.display_state === 'auth_required')) return false;
    if (state.accountFilter === 'pending' && !account.has_pending_bootstrap) return false;
    if (state.accountFilter === 'unauth' && (account.has_profile || account.display_state !== 'auth_required')) return false;
    if (state.accountFilter === 'error' && account.display_state !== 'error') return false;
    if (state.accountFilter === 'active' && !account.is_active) return false;
    if (state.accountLoginMethodFilter !== 'all' && String(account.login_method || '') !== state.accountLoginMethodFilter) return false;
    if (!search) return true;
    const haystacks = [
      account.email || '',
      account.label || '',
      loginMethodLabel(account.login_method),
      account.account_id || '',
      account.identity_key || '',
      ...(Array.isArray(account.auth_profiles) ? account.auth_profiles.flatMap((authProfile) => [
        authProfile.workspace_label || '',
        authProfile.account_id || '',
        authProfile.identity_key || ''
      ]) : [])
    ].join('\n').toLowerCase();
    return haystacks.includes(search);
  });
}

function buildAccountsView(accounts) {
  const visibleAccounts = sortAccounts(filterAccounts(accounts));
  const selectedId = ensureSelectedAccountId(visibleAccounts);
  return {
    visibleAccounts,
    selectedId,
    selectedAccount: visibleAccounts.find((account) => account.id === selectedId) || visibleAccounts[0] || null
  };
}

function isClientAccountDraft(slot) {
  return !String(slot.email || '').trim()
    || !String(slot.login_method || '').trim()
    || !String(slot.expires_at || '').trim();
}

function deriveClientDisplayState(slot) {
  if (slot.is_active) return 'active';
  if (isClientAccountDraft(slot)) return 'draft';
  if (!slot.has_profile) return 'auth_required';
  if (slot.state === 'error' && slot.last_error) return 'error';
  if (slot.quota_5h_pct >= 100 && slot.quota_5h_reset_at && new Date(slot.quota_5h_reset_at).getTime() > Date.now()) return 'exhausted';
  return 'ready';
}

function syncClientPendingBootstrapFlags() {
  if (!state.runtime || !Array.isArray(state.runtime.slots)) return;
  const sessions = Array.isArray(state.runtime.bootstrapSessions) ? state.runtime.bootstrapSessions : [];
  const pendingSlotIds = new Set(
    sessions
      .filter((session) => isActiveBootstrapStatus(session.status))
      .map((session) => session.slot_id)
  );
  state.runtime.slots.forEach((slot) => {
    slot.has_pending_bootstrap = pendingSlotIds.has(slot.id);
    slot.display_state = deriveClientDisplayState(slot);
  });
}

function renderRuntimeState(options = {}) {
  if (!state.runtime) return;
  const accountsView = buildAccountsView(state.runtime.slots || []);
  renderRuntimeTimestamp(state.runtime.now || new Date().toISOString());
  renderSummary(state.runtime);
  renderActiveSlot(state.runtime);
  renderBootstrapSessions(state.runtime.bootstrapSessions || []);
  renderAccountsSummary(state.runtime, accountsView);
  renderAccounts(state.runtime.slots || [], accountsView);
  if (options.includeLogs !== false) {
    renderSwitchLogs(state.recentSwitches || []);
    renderSampleLogs(state.recentSamples || []);
  }
}

function mutateRuntime(mutator, options = {}) {
  if (!state.runtime) return;
  mutator(state.runtime);
  state.runtime.now = new Date().toISOString();
  syncClientPendingBootstrapFlags();
  renderRuntimeState(options);
}

function optimisticBootstrapStart(result) {
  if (!state.runtime || !result || !result.bootstrapSession) return;
  const session = {
    ...result.bootstrapSession,
    auth_open_url: result.authOpenUrl || ''
  };
  mutateRuntime((runtime) => {
    const sessions = Array.isArray(runtime.bootstrapSessions) ? runtime.bootstrapSessions : [];
    runtime.bootstrapSessions = [
      session,
      ...sessions.filter((item) => {
        if (item.id === session.id) return false;
        if (item.slot_id !== session.slot_id) return true;
        if (String(item.auth_profile_id || '') !== String(session.auth_profile_id || '')) return true;
        return String(item.workspace_label || '') !== String(session.workspace_label || '');
      })
    ];
    const slot = (runtime.slots || []).find((item) => item.id === session.slot_id);
    if (slot) {
      slot.last_error = null;
      slot.state = 'auth_required';
    }
  }, { includeLogs: false });
}

function optimisticBootstrapDelete(bootstrapId) {
  if (!state.runtime || !bootstrapId) return;
  mutateRuntime((runtime) => {
    const sessions = Array.isArray(runtime.bootstrapSessions) ? runtime.bootstrapSessions : [];
    const target = sessions.find((item) => item.id === bootstrapId);
    runtime.bootstrapSessions = sessions.filter((item) => item.id !== bootstrapId);
    if (target) {
      const slot = (runtime.slots || []).find((item) => item.id === target.slot_id);
      if (slot) {
        slot.last_error = null;
        slot.state = slot.has_profile ? 'ready' : 'auth_required';
      }
    }
  }, { includeLogs: false });
}

function normalizeFieldValue(name, value) {
  const normalized = String(value || '').trim();
  if (name === 'email') return normalized.toLowerCase();
  return normalized;
}

function readCardFieldSnapshot(card) {
  const values = {};
  card.querySelectorAll('[data-field]').forEach((field) => {
    values[field.dataset.field] = normalizeFieldValue(field.dataset.field, field.value);
  });
  values.label = values.email || '';
  return values;
}

function readSavedFieldSnapshot(card) {
  return {
    email: normalizeFieldValue('email', card.dataset.savedEmail || ''),
    login_method: normalizeFieldValue('login_method', card.dataset.savedLoginMethod || 'email'),
    expires_at: normalizeFieldValue('expires_at', card.dataset.savedExpiresAt || ''),
    label: normalizeFieldValue('label', card.dataset.savedEmail || '')
  };
}

function isCardDirty(card) {
  const current = readCardFieldSnapshot(card);
  const saved = readSavedFieldSnapshot(card);
  return ['email', 'login_method', 'expires_at'].some((key) => current[key] !== saved[key]);
}

function validateAccountFields(snapshot) {
  const errors = [];
  if (!snapshot.email) errors.push('请先填写邮箱');
  else if (!EMAIL_PATTERN.test(snapshot.email)) errors.push('邮箱格式不正确');
  if (!snapshot.login_method || !['email', 'google', 'apple', 'microsoft', 'phone'].includes(snapshot.login_method)) errors.push('请选择登录方式');
  if (!snapshot.expires_at) errors.push('请设置订阅到期日');
  else if (!DATE_PATTERN.test(snapshot.expires_at)) errors.push('订阅到期日格式不正确');
  return {
    valid: errors.length === 0,
    errors
  };
}

function isSavedSnapshotReady(card) {
  return validateAccountFields(readSavedFieldSnapshot(card)).valid;
}

function syncFieldValidity(card, showInvalid) {
  const snapshot = readCardFieldSnapshot(card);
  card.querySelectorAll('[data-field]').forEach((field) => {
    const name = field.dataset.field;
    let invalid = false;
    if (name === 'email') invalid = !snapshot.email || !EMAIL_PATTERN.test(snapshot.email);
    if (name === 'login_method') invalid = !snapshot.login_method || !['email', 'google', 'apple', 'microsoft', 'phone'].includes(snapshot.login_method);
    if (name === 'expires_at') invalid = !snapshot.expires_at || !DATE_PATTERN.test(snapshot.expires_at);
    const visibleInvalid = showInvalid && invalid;
    field.classList.toggle('field-invalid', visibleInvalid);
    field.setAttribute('aria-invalid', visibleInvalid ? 'true' : 'false');
  });
}

function flowHintText(card) {
  const draft = readCardFieldSnapshot(card);
  const draftValidation = validateAccountFields(draft);
  const dirty = isCardDirty(card);
  const savedReady = isSavedSnapshotReady(card);
  const hasProfile = card.dataset.hasProfile === '1';
  const hasPendingBootstrap = card.dataset.hasPendingBootstrap === '1';
  const isActive = card.dataset.isActive === '1';
  const cooldown = activeDeviceAuthCooldown();
  const currentPendingBootstrap = activeBootstrapSession();
  const blockedByOtherBootstrap = currentPendingBootstrap && currentPendingBootstrap.slot_id !== card.dataset.accountId;

  if (dirty && !draftValidation.valid) return `${draftValidation.errors[0]}，补全后再保存`;
  if (dirty) return '资料已修改，下一步先保存';
  if (!savedReady) return '先把资料填完整并保存';
  if (hasPendingBootstrap) return '当前有工作区认证进行中，请先完成或删除当前任务';
  if (blockedByOtherBootstrap) return `当前正在认证 ${displayEmailValue(currentPendingBootstrap.email, { fallback: '另一个账号' })}，请先完成或删除该任务`;
  if (cooldown) return `设备码请求过于频繁，请等待到 ${formatTimestamp(cooldown.expires_at)} 后再试`;
  if (!hasProfile) return '资料已保存';
  if (isActive) return '资料已保存';
  return '资料已保存';
}

function updateAccountCardState(card) {
  const draft = readCardFieldSnapshot(card);
  const draftValidation = validateAccountFields(draft);
  const dirty = isCardDirty(card);
  const savedReady = isSavedSnapshotReady(card);
  const hasProfile = card.dataset.hasProfile === '1';
  const hasPendingBootstrap = card.dataset.hasPendingBootstrap === '1';
  const isActive = card.dataset.isActive === '1';
  const cooldown = activeDeviceAuthCooldown();
  const currentPendingBootstrap = activeBootstrapSession();
  const blockedByOtherBootstrap = currentPendingBootstrap && currentPendingBootstrap.slot_id !== card.dataset.accountId;

  const saveButton = card.querySelector('.save-account');
  const logoutButton = card.querySelector('.logout-account');
  const deleteButton = card.querySelector('.delete-account');
  const createWorkspaceButton = card.querySelector('.create-auth-profile');
  const flowNode = card.querySelector('.flow-hint');

  const canSave = dirty && draftValidation.valid;
  const canCreateWorkspace = !dirty && savedReady && !hasPendingBootstrap && !blockedByOtherBootstrap && !cooldown;
  const canLogout = !dirty && savedReady && hasProfile;
  const canDelete = !dirty && !isActive;

  saveButton.disabled = !canSave;
  logoutButton.disabled = !canLogout;
  deleteButton.disabled = !canDelete;
  if (createWorkspaceButton) createWorkspaceButton.disabled = !canCreateWorkspace;
  flowNode.textContent = flowHintText(card);

  syncFieldValidity(card, dirty);
}

function ensureSelectedAccountId(accounts) {
  const ids = new Set(accounts.map((account) => account.id));
  if (state.selectedAccountId && ids.has(state.selectedAccountId)) return state.selectedAccountId;
  const active = accounts.find((account) => account.is_active);
  state.selectedAccountId = active ? active.id : (accounts[0] ? accounts[0].id : null);
  return state.selectedAccountId;
}

function renderAccountIndex(accounts, view = buildAccountsView(accounts)) {
  const host = document.getElementById('accountIndexList');
  const visibleAccounts = view.visibleAccounts;
  if (!accounts.length) {
    host.innerHTML = `
      <div class="empty-card">
        <strong>还没有账号</strong>
        <p class="muted">点击“新建账号”开始录入邮箱、登录方式和到期日</p>
      </div>
    `;
    return;
  }
  if (!visibleAccounts.length) {
    host.innerHTML = `
      <div class="empty-card">
        <strong>没有匹配结果</strong>
        <p class="muted">试试调整搜索词、排序或过滤条件</p>
      </div>
    `;
    return;
  }

  const selectedId = view.selectedId;
  host.innerHTML = visibleAccounts.map((account) => `
    <button type="button" class="account-index-item ${account.id === selectedId ? 'selected' : ''}" data-account-id="${account.id}">
      <div class="account-index-item__top">
        <strong>${displayAccountName(account)}</strong>
        <span class="status-pill ${stateTone(account.display_state)}">${stateLabel(account)}</span>
      </div>
      ${buildAccountIndexSignals(account)}
      <div class="account-index-item__meta">
        <span>${loginMethodLabel(account.login_method)} · ${account.auth_profile_count || 0} 个认证</span>
        <span class="status-pill ${subscriptionTone(account.subscription_status)}">${account.subscription_label || '未设置到期日'}</span>
      </div>
    </button>
  `).join('');
}

function renderAccountDetail(account) {
  const host = document.getElementById('accountDetailHost');
  const template = document.getElementById('accountCardTemplate');
  host.innerHTML = '';

  if (!account) {
    host.innerHTML = `
      <div class="empty-card">
        <strong>请选择一个账号</strong>
        <p class="muted">左侧点选账号后，这里会显示资料、额度和操作按钮</p>
      </div>
    `;
    return;
  }

  const fragment = template.content.cloneNode(true);
  const root = fragment.querySelector('.account-card');

  root.dataset.accountId = account.id;
  root.dataset.hasProfile = account.has_profile ? '1' : '0';
  root.dataset.hasPendingBootstrap = account.has_pending_bootstrap ? '1' : '0';
  root.dataset.isActive = account.is_active ? '1' : '0';
  root.dataset.savedLabel = account.email || '';
  root.dataset.savedEmail = account.email || '';
  root.dataset.savedLoginMethod = account.login_method || 'email';
  root.dataset.savedExpiresAt = account.expires_at || '';
  root.dataset.state = account.display_state || '';

  fragment.querySelector('.account-title').textContent = displayAccountName(account);
  fragment.querySelector('.account-subtitle').textContent = `${loginMethodLabel(account.login_method)} · ${freshnessLabel(account.freshness)}`;
  fragment.querySelector('.account-badge').textContent = stateLabel(account);
  fragment.querySelector('.account-badge').classList.add(stateTone(account.display_state));
  fragment.querySelector('.delete-account').textContent = '删除账号';
  fragment.querySelector('.account-stage-strip').innerHTML = buildStageStrip(account);
  fragment.querySelector('.subscription-dot').classList.add(subscriptionTone(account.subscription_status));
  fragment.querySelector('.detail-email-title').textContent = displayAccountName(account);
  fragment.querySelector('.detail-state-text').textContent = stateLabel(account);
  const emailField = fragment.querySelector('[data-field="email"]');
  emailField.value = account.email || '';
  emailField.type = isAccountPrivacyEnabled() ? 'password' : 'email';
  emailField.placeholder = isAccountPrivacyEnabled() ? '账号隐私已开启' : '';
  fragment.querySelector('[data-field="login_method"]').value = account.login_method || 'email';
  fragment.querySelector('[data-field="expires_at"]').value = account.expires_at || '';
  fragment.querySelector('.workspace-panels-host').innerHTML = buildWorkspacePanels(account);
  fragment.querySelector('.auth-profile-create-host').innerHTML = buildAuthProfileCreatePanel(account);

  host.appendChild(fragment);
  updateAccountCardState(host.querySelector('.account-card'));
}

function renderAccountIndexSelection(selectedId) {
  document.querySelectorAll('#accountIndexList .account-index-item').forEach((button) => {
    button.classList.toggle('selected', button.dataset.accountId === selectedId);
  });
}

function renderAccounts(accounts, view = buildAccountsView(accounts)) {
  renderAccountIndex(accounts, view);
  if (!view.visibleAccounts.length) {
    renderAccountDetail(null);
    return;
  }
  renderAccountDetail(view.selectedAccount || null);
  bindDynamicHandlers();
}

function renderSwitchLogs(items) {
  const node = document.getElementById('switchLogList');
  if (!items.length) {
    state.switchLogPage = 1;
    updateLogPager('switch', 0, 1, 1);
    node.innerHTML = '<div class="empty-card"><strong>暂无切换记录</strong><p class="muted">点击账号卡片中的“切换”后，这里会留下记录</p></div>';
    return;
  }
  const paged = paginateLogs(items, state.switchLogPage);
  state.switchLogPage = paged.currentPage;
  updateLogPager('switch', items.length, paged.currentPage, paged.totalPages);
  node.innerHTML = paged.items.map((item) => `
    <article class="log-item">
      <div class="log-item__top">
        <div class="log-item__headline">
          <strong>${switchReasonLabel(item.trigger_reason)}</strong>
          <span class="muted">${formatTimestamp(item.created_at)}</span>
        </div>
        <span class="status-pill ${switchStatusTone(item.status)}">${switchStatusLabel(item.status)}</span>
      </div>
      <div class="log-item__summary">从 <strong>${escapeHtml(slotLabelById(item.from_slot_id))}</strong> 切到 <strong>${escapeHtml(slotLabelById(item.to_slot_id))}</strong></div>
      <div class="log-item__chips">
        <span class="log-chip">${escapeHtml(slotMetaById(item.from_slot_id) || '来源未知')}</span>
        <span class="log-chip">${escapeHtml(slotMetaById(item.to_slot_id) || '目标未知')}</span>
      </div>
      ${item.detail && item.detail.error ? `<div class="log-item__note">${escapeHtml(maskEmailsInText(item.detail.error))}</div>` : ''}
    </article>
  `).join('');
}

function renderSampleLogs(items) {
  const node = document.getElementById('sampleLogList');
  if (!items.length) {
    state.sampleLogPage = 1;
    updateLogPager('sample', 0, 1, 1);
    node.innerHTML = '<div class="empty-card"><strong>暂无额度快照</strong><p class="muted">页面加载后会立即刷新一次已认证账号的额度</p></div>';
    return;
  }
  const paged = paginateLogs(items, state.sampleLogPage);
  state.sampleLogPage = paged.currentPage;
  updateLogPager('sample', items.length, paged.currentPage, paged.totalPages);
  node.innerHTML = paged.items.map((item) => `
    <article class="log-item">
      <div class="log-item__top">
        <div class="log-item__headline">
          <strong>${escapeHtml(slotLabelById(item.slot_id))}</strong>
          <span class="muted">${formatTimestamp(item.observed_at || item.created_at)}</span>
        </div>
        <span class="status-pill ${quotaSyncStatusTone(item.parser_status)}">${quotaSyncStatusLabel(item.parser_status)}</span>
      </div>
      <div class="log-item__summary">
        ${item.parser_status === 'ok'
          ? escapeHtmlMultiline(`${quotaLineDescription('5 小时', item.quota_5h_pct, item.quota_5h_reset_label, item.quota_5h_reset_at)}\n${quotaLineDescription('1 周', item.quota_week_pct, item.quota_week_reset_label, item.quota_week_reset_at)}`)
          : escapeHtmlMultiline(humanizeBackendError(item.raw_text))}
      </div>
      <div class="log-item__chips">
        <span class="log-chip">${escapeHtml(parseJsonSafe(item.raw_text)?.plan_type || '计划未知')}</span>
        <span class="log-chip">${escapeHtml(item.slot_id || '未归档账号')}</span>
      </div>
    </article>
  `).join('');
}

function renderAccountsSummary(runtime, view = buildAccountsView(runtime.slots || [])) {
  const summary = runtime.summary || {};
  const visibleCount = view.visibleAccounts.length;
  document.getElementById('accountsSummaryText').textContent = `显示 ${visibleCount} / 全部 ${summary.totalAccounts || 0} · 已认证 ${summary.authenticatedAccounts || 0} · 即将到期 ${summary.expiringSoon || 0} · 已到期 ${summary.expiredAccounts || 0}`;
}

async function loadRuntime(options = {}) {
  if (options.includeLogs !== false && state.deferredLogsLoadTimer) {
    window.clearTimeout(state.deferredLogsLoadTimer);
    state.deferredLogsLoadTimer = null;
  }
  if (state.loadingRuntime) {
    state.queuedRuntimeReload = true;
    state.queuedRuntimeReloadOptions = mergeLoadOptions(state.queuedRuntimeReloadOptions, options);
    return;
  }

  state.loadingRuntime = true;
  try {
    const query = new URLSearchParams();
    if (options.includeLogs === false) query.set('includeLogs', '0');
    const path = query.size ? `/api/runtime?${query.toString()}` : '/api/runtime';
    const json = await api(path, { method: 'GET' });
    state.runtime = json.runtime;
    state.serverTimeZone = json.runtime && json.runtime.serverTimeZone ? json.runtime.serverTimeZone : 'UTC';
    if (Array.isArray(json.recentSwitches)) state.recentSwitches = json.recentSwitches;
    if (Array.isArray(json.recentSamples)) state.recentSamples = json.recentSamples;

    syncClientPendingBootstrapFlags();
    updateSettingsFromRuntime(json.runtime);
    renderRuntimeState({ includeLogs: options.includeLogs !== false });
    presentRuntimeAlerts(json.runtime);
  } finally {
    state.loadingRuntime = false;
    if (state.queuedRuntimeReload) {
      state.queuedRuntimeReload = false;
      const nextOptions = state.queuedRuntimeReloadOptions || {};
      state.queuedRuntimeReloadOptions = null;
      loadRuntime(nextOptions).catch(console.error);
    }
  }
}

function bindDynamicHandlers() {
  document.querySelectorAll('.account-card [data-field]').forEach((field) => {
    const eventName = field.tagName === 'SELECT' ? 'change' : 'input';
    field[`on${eventName}`] = () => updateAccountCardState(field.closest('.account-card'));
  });

  document.querySelectorAll('.save-account').forEach((button) => {
    button.onclick = async () => {
      const card = button.closest('.account-card');
      const accountId = card.dataset.accountId;
      const payload = readCardFieldSnapshot(card);
      await runButtonAction(button, {
        pendingText: '保存中...',
        successText: '账号资料已保存'
      }, async () => {
        const result = await api(`/api/accounts/${accountId}`, {
          method: 'PATCH',
          body: JSON.stringify(payload)
        });
        mutateRuntime((runtime) => {
          runtime.slots = (runtime.slots || []).map((slot) => slot.id === accountId ? { ...slot, ...result.account } : slot);
        }, { includeLogs: false });
        scheduleRuntimeReload(10, { includeLogs: false });
        scheduleRuntimeReload(220);
      }).catch(() => {});
    };
  });

  document.querySelectorAll('.create-auth-profile').forEach((button) => {
    button.onclick = async () => {
      const card = button.closest('.account-card');
      await startWorkspaceBootstrapFromCard(card, button).catch(() => {});
    };
  });

  document.querySelectorAll('.logout-account').forEach((button) => {
    button.onclick = async () => {
      const card = button.closest('.account-card');
      const accountId = card.dataset.accountId;
      await runButtonAction(button, {
        pendingText: '提交退出...',
        successText: '已受理退出留存'
      }, async () => {
        await api(`/api/accounts/${accountId}/logout`, {
          method: 'POST',
          body: '{}'
        });
        scheduleRuntimeReload(10, { includeLogs: false });
        scheduleRuntimeReload(220);
      }).catch(() => {});
    };
  });

  document.querySelectorAll('.delete-account').forEach((button) => {
    button.onclick = async () => {
      const card = button.closest('.account-card');
      const accountId = card.dataset.accountId;
      const label = card.querySelector('.account-title').textContent.trim();
      if (!window.confirm(`确定删除 ${label} 吗？这会同时删除服务器上保存的 profile、认证任务和临时认证文件`)) return;
      await runButtonAction(button, {
        pendingText: '删除中...',
        successText: '账号及后台留存已删除'
      }, async () => {
        await api(`/api/accounts/${accountId}`, {
          method: 'DELETE',
          body: '{}'
        });
        mutateRuntime((runtime) => {
          runtime.slots = (runtime.slots || []).filter((slot) => slot.id !== accountId);
        }, { includeLogs: false });
        if (state.selectedAccountId === accountId) state.selectedAccountId = null;
        scheduleRuntimeReload(10, { includeLogs: false });
        scheduleRuntimeReload(220);
      }).catch(() => {});
    };
  });

  document.querySelectorAll('.auth-profile-switch').forEach((button) => {
    button.onclick = async () => {
      const card = button.closest('.account-card');
      const accountId = card.dataset.accountId;
      const authProfileId = button.dataset.authProfileId || '';
      await runButtonAction(button, {
        pendingText: '提交切换...',
        successText: '已受理认证切换'
      }, async () => {
        await api(`/api/accounts/${accountId}/switch`, {
          method: 'POST',
          body: JSON.stringify({ authProfileId })
        });
        scheduleRuntimeReload(10, { includeLogs: false });
        scheduleRuntimeReload(220);
      }).catch(() => {});
    };
  });

  document.querySelectorAll('.auth-profile-reauth').forEach((button) => {
    button.onclick = async () => {
      const card = button.closest('.account-card');
      const accountId = card.dataset.accountId;
      const authProfileId = button.dataset.authProfileId || '';
      await runButtonAction(button, {
        pendingText: '重置认证中...',
        successText: '新的设备码已生成'
      }, async () => {
        const result = await startBootstrapTask(accountId, {
          restart: true,
          authProfileId
        });
        optimisticBootstrapStart(result);
      }).catch(() => {});
    };
  });

  document.querySelectorAll('.auth-profile-set-primary').forEach((button) => {
    button.onclick = async () => {
      const card = button.closest('.account-card');
      const accountId = card.dataset.accountId;
      const authProfileId = button.dataset.authProfileId || '';
      await runButtonAction(button, {
        pendingText: '设置中...',
        successText: '已设为主工作区'
      }, async () => {
        await api(`/api/accounts/${accountId}/auth-profiles/${authProfileId}/primary`, {
          method: 'POST',
          body: '{}'
        });
        scheduleRuntimeReload(10, { includeLogs: false });
        scheduleRuntimeReload(220);
      }).catch(() => {});
    };
  });

  document.querySelectorAll('.auth-profile-rename').forEach((button) => {
    button.onclick = async () => {
      const card = button.closest('.account-card');
      const accountId = card.dataset.accountId;
      const authProfileId = button.dataset.authProfileId || '';
      const workspacePanel = button.closest('.workspace-panel');
      const currentLabel = workspacePanel?.querySelector('.workspace-panel__title h5')?.textContent?.trim() || '';
      const nextLabel = window.prompt('修改工作区名称', currentLabel);
      if (nextLabel == null) return;
      const workspaceLabel = String(nextLabel).trim();
      if (!workspaceLabel) {
        showToast('工作区名称不能为空', 'warning');
        return;
      }
      await runButtonAction(button, {
        pendingText: '保存中...',
        successText: '工作区名称已更新'
      }, async () => {
        await api(`/api/accounts/${accountId}/auth-profiles/${authProfileId}`, {
          method: 'PATCH',
          body: JSON.stringify({ workspaceLabel })
        });
        scheduleRuntimeReload(10, { includeLogs: false });
        scheduleRuntimeReload(220);
      }).catch(() => {});
    };
  });

  document.querySelectorAll('.auth-profile-delete').forEach((button) => {
    button.onclick = async () => {
      const card = button.closest('.account-card');
      const accountId = card.dataset.accountId;
      const authProfileId = button.dataset.authProfileId || '';
      if (!window.confirm('确定删除这个工作区认证吗？')) return;
      await runButtonAction(button, {
        pendingText: '删除中...',
        successText: '工作区已移除'
      }, async () => {
        await api(`/api/accounts/${accountId}/auth-profiles/${authProfileId}`, {
          method: 'DELETE',
          body: '{}'
        });
        scheduleRuntimeReload(10, { includeLogs: false });
        scheduleRuntimeReload(220);
      }).catch(() => {});
    };
  });

  document.querySelectorAll('.inline-copy-device-code').forEach((button) => {
    button.onclick = async () => {
      const code = button.dataset.deviceCode || '';
      if (!code || code === '--') return;
      try {
        await navigator.clipboard.writeText(code);
        showToast(`设备码 ${code} 已复制`, 'success');
      } catch (_) {
        showToast(`设备码：${code}`, 'warning');
      }
    };
  });

  document.querySelectorAll('.inline-copy-target-email').forEach((button) => {
    button.onclick = async () => {
      const email = button.dataset.targetEmail || '';
      if (!email) return;
      try {
        await navigator.clipboard.writeText(email);
        showToast(`目标账号 ${email} 已复制`, 'success');
      } catch (_) {
        showToast(`目标账号：${email}`, 'warning');
      }
    };
  });

  document.querySelectorAll('.inline-copy-auth-link').forEach((button) => {
    button.onclick = async () => {
      const url = button.dataset.authOpenUrl || '';
      if (!url) return;
      try {
        await navigator.clipboard.writeText(url);
        showToast('认证链接已复制', 'success');
      } catch (_) {
        showToast(url, 'warning');
      }
    };
  });

  document.querySelectorAll('.inline-open-auth-link').forEach((button) => {
    button.onclick = async () => {
      const url = button.dataset.authOpenUrl || '';
      if (!url) return;
      window.open(url, '_blank', 'noopener');
      showToast('认证链接已在新标签打开', 'success');
    };
  });

  document.querySelectorAll('.inline-restart-bootstrap').forEach((button) => {
    button.onclick = async () => {
      const slotId = button.dataset.slotId || '';
      const authProfileId = button.dataset.authProfileId || '';
      const workspaceLabel = button.dataset.workspaceLabel || '';
      if (!slotId) return;
      await runButtonAction(button, {
        pendingText: '重置中...',
        successText: '新的设备码已生成'
      }, async () => {
        const result = await startBootstrapTask(slotId, {
          restart: true,
          authProfileId: authProfileId || null,
          workspaceLabel: workspaceLabel || null
        });
        optimisticBootstrapStart(result);
      }).catch(() => {});
    };
  });

  document.querySelectorAll('.inline-delete-bootstrap-task').forEach((button) => {
    button.onclick = async () => {
      const bootstrapId = button.dataset.bootstrapId || '';
      if (!bootstrapId) return;
      await runButtonAction(button, {
        pendingText: '清除中...',
        successText: '认证任务已清除',
        refreshOnError: true
      }, async () => {
        optimisticBootstrapDelete(bootstrapId);
        await api(`/api/bootstrap-sessions/${bootstrapId}`, {
          method: 'DELETE',
          body: '{}'
        });
        state.openBootstrapLogIds.delete(bootstrapId);
        scheduleRuntimeReload(10, { includeLogs: false });
        scheduleRuntimeReload(220);
      }).catch(() => {});
    };
  });

  document.querySelectorAll('.task-details').forEach((details) => {
    details.ontoggle = () => {
      const bootstrapId = details.dataset.bootstrapId;
      if (!bootstrapId) return;
      if (details.open) state.openBootstrapLogIds.add(bootstrapId);
      else state.openBootstrapLogIds.delete(bootstrapId);
    };
  });
}

function focusWorkspaceCreatePanel(card) {
  if (!card) return;
  const panel = card.querySelector('.auth-profile-create-panel');
  const input = card.querySelector('.workspace-label-input');
  panel?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  input?.focus();
}

async function startWorkspaceBootstrapFromCard(card, button) {
  if (!card || !button) return;
  const accountId = card.dataset.accountId;
  const workspaceInput = card.querySelector('.workspace-label-input');
  const workspaceLabel = String(workspaceInput?.value || '').trim();
  const hasProfile = card.dataset.hasProfile === '1';

  if (hasProfile && !workspaceLabel) {
    workspaceInput?.focus();
    showToast('请先填写工作区名称，再创建新的工作区认证', 'warning');
    return;
  }

  await runButtonAction(button, {
    pendingText: '创建任务中...',
    successText: hasProfile ? '工作区认证任务已创建' : '认证任务已创建，直接打开认证页即可继续',
    refreshOnError: true
  }, async () => {
    const result = await startBootstrapTask(accountId, {
      restart: false,
      workspaceLabel
    });
    if (workspaceInput) workspaceInput.value = '';
    optimisticBootstrapStart(result);
  });
}

function startRuntimeRefreshLoop() {
  if (state.refreshTimer) clearInterval(state.refreshTimer);
  if (state.refreshCountdownTimer) clearInterval(state.refreshCountdownTimer);
  state.refreshTimer = null;
  state.refreshCountdownTimer = null;

  const seconds = Number(state.refreshSeconds || 0);
  state.refreshCountdown = seconds;
  renderRefreshNote();

  if (seconds <= 0) return;

  state.refreshCountdownTimer = window.setInterval(() => {
    const runtimeRefresh = state.runtime && state.runtime.runtimeRefresh ? state.runtime.runtimeRefresh : null;
    if (state.loadingRuntime || state.refreshPending || (runtimeRefresh && runtimeRefresh.state === 'syncing')) {
      renderRefreshNote();
      return;
    }
    state.refreshCountdown = Math.max(0, Number(state.refreshCountdown || seconds) - 1);
    renderRefreshNote();
    if (state.refreshCountdown <= 0) {
      state.refreshCountdown = seconds;
      triggerRuntimeRefresh('auto', {
        slotId: state.selectedAccountId || null
      }).catch(console.error);
    }
  }, 1000);
}

function startEventStream() {
  if (state.eventSource) state.eventSource.close();
  const source = new EventSource('/api/events/stream', { withCredentials: true });
  source.addEventListener('runtime_updated', () => {
    scheduleRuntimeReload(40);
  });
  source.onerror = () => {};
  state.eventSource = source;
}

async function initDashboard(session) {
  state.initialRefreshRequested = false;
  document.body.classList.remove('is-login-mode');
  document.getElementById('loginPanel').classList.add('hidden');
  document.getElementById('dashboardPanel').classList.remove('hidden');
  document.getElementById('createAccountBtn').classList.remove('hidden');
  document.getElementById('logoutBtn').classList.remove('hidden');
  document.getElementById('refreshControlHost').classList.remove('hidden');
  document.getElementById('exchangeModalToggleBtn').classList.remove('hidden');
  document.getElementById('autoSwitchToggleBtn').classList.remove('hidden');
  document.getElementById('timeDisplayToggleBtn').classList.remove('hidden');
  document.getElementById('accountPrivacyToggleBtn').classList.remove('hidden');
  setSessionBadge(session.user.email);
  syncRefreshControls();
  syncAccountFilterControls();
  syncAutoSwitchButton();
  renderRuntimeTimestamp(new Date().toISOString());
  await loadRuntime({ includeLogs: false }).catch(console.error);
  maybeRequestInitialRefresh();
  scheduleDeferredLogsLoad();
  startRuntimeRefreshLoop();
  startEventStream();
}

async function initApp() {
  try {
    const stored = window.localStorage.getItem(TIME_DISPLAY_STORAGE_KEY);
    if (stored === 'local' || stored === 'server') state.timeDisplayMode = stored;
  } catch (_) {
    state.timeDisplayMode = 'local';
  }
  try {
    state.accountPrivacyEnabled = window.localStorage.getItem(ACCOUNT_PRIVACY_STORAGE_KEY) === '1';
  } catch (_) {
    state.accountPrivacyEnabled = false;
  }
  try {
    const refreshStoredRaw = window.localStorage.getItem(REFRESH_SECONDS_STORAGE_KEY);
    if (refreshStoredRaw != null && refreshStoredRaw !== '') {
      const refreshStored = Number(refreshStoredRaw);
      if (Number.isFinite(refreshStored)) state.refreshSeconds = Math.max(0, Math.min(600, Math.trunc(refreshStored)));
    }
  } catch (_) {
    state.refreshSeconds = 10;
  }
  state.refreshCountdown = state.refreshSeconds;
  try {
    const storedSort = window.localStorage.getItem(ACCOUNT_SORT_STORAGE_KEY);
    if (storedSort) state.accountSort = storedSort;
  } catch (_) {
    state.accountSort = 'availability';
  }
  try {
    const storedFilter = window.localStorage.getItem(ACCOUNT_FILTER_STORAGE_KEY);
    if (storedFilter) state.accountFilter = storedFilter;
  } catch (_) {
    state.accountFilter = 'all';
  }
  try {
    const storedLoginMethodFilter = window.localStorage.getItem(ACCOUNT_LOGIN_METHOD_FILTER_STORAGE_KEY);
    if (storedLoginMethodFilter) state.accountLoginMethodFilter = storedLoginMethodFilter;
  } catch (_) {
    state.accountLoginMethodFilter = 'all';
  }
  try {
    state.accountSearch = window.localStorage.getItem(ACCOUNT_SEARCH_STORAGE_KEY) || '';
  } catch (_) {
    state.accountSearch = '';
  }
  syncTimeDisplayButton();
  syncAccountPrivacyButton();
  syncAutoSwitchButton();
  syncRefreshControls();
  syncAccountFilterControls();
  const sessionPromise = fetch('/api/session', { credentials: 'include' }).then((res) => res.json());
  refreshCsrf().catch(() => {});
  const session = await sessionPromise;
  if (!session.authenticated) {
    document.body.classList.add('is-login-mode');
    document.getElementById('loginPanel').classList.remove('hidden');
    document.getElementById('dashboardPanel').classList.add('hidden');
    document.getElementById('createAccountBtn').classList.add('hidden');
    document.getElementById('logoutBtn').classList.add('hidden');
    document.getElementById('refreshControlHost').classList.add('hidden');
    document.getElementById('exchangeModalToggleBtn').classList.add('hidden');
    document.getElementById('autoSwitchToggleBtn').classList.add('hidden');
    document.getElementById('timeDisplayToggleBtn').classList.add('hidden');
    document.getElementById('accountPrivacyToggleBtn').classList.add('hidden');
    setSessionBadge('未登录');
    return;
  }

  await initDashboard(session);
}

document.getElementById('loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  await refreshCsrf();
  const submitButton = event.submitter || event.currentTarget.querySelector('button[type="submit"]');
  await runButtonAction(submitButton, {
    pendingText: '登录中...',
    successText: '登录成功'
  }, async () => {
    await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        email: document.getElementById('loginEmail').value,
        password: document.getElementById('loginPassword').value
      })
    });
    const session = await fetch('/api/session', { credentials: 'include' }).then((res) => res.json());
    if (!session.authenticated) {
      throw new Error('SESSION_COOKIE_NOT_PERSISTED');
    }
    await initDashboard(session);
  }).catch(() => {});
});

document.getElementById('logoutBtn').addEventListener('click', async () => {
  const button = document.getElementById('logoutBtn');
  await runButtonAction(button, {
    pendingText: '退出中...',
    successText: '已退出后台'
  }, async () => {
    await api('/api/auth/logout', { method: 'POST', body: '{}' });
    window.location.reload();
  }).catch(() => {});
});

document.getElementById('createAccountBtn').addEventListener('click', async () => {
  const button = document.getElementById('createAccountBtn');
  await runButtonAction(button, {
    pendingText: '新建中...',
    successText: '已创建空白账号'
  }, async () => {
    const result = await api('/api/accounts', {
      method: 'POST',
      body: '{}'
    });
    resetAccountFiltersForNewAccount();
    state.selectedAccountId = result.account.id;
    if (state.runtime) {
      mutateRuntime((runtime) => {
        runtime.slots = [result.account, ...(runtime.slots || [])];
      }, { includeLogs: false });
    }
    scheduleRuntimeReload(10, { includeLogs: false });
    scheduleRuntimeReload(220);
  }).catch(() => {});
});

document.getElementById('timeDisplayToggleBtn').addEventListener('click', () => {
  state.timeDisplayMode = currentTimeMode() === 'local' ? 'server' : 'local';
  try {
    window.localStorage.setItem(TIME_DISPLAY_STORAGE_KEY, state.timeDisplayMode);
  } catch (_) {
    // ignore localStorage failures
  }
  syncTimeDisplayButton();
  if (state.runtime) {
    renderRuntimeTimestamp(state.runtime.now);
    renderActiveSlot(state.runtime);
    renderAccounts(state.runtime.slots || []);
    renderSwitchLogs(state.recentSwitches || []);
    renderSampleLogs(state.recentSamples || []);
  }
});

document.getElementById('accountPrivacyToggleBtn').addEventListener('click', () => {
  state.accountPrivacyEnabled = !isAccountPrivacyEnabled();
  try {
    window.localStorage.setItem(ACCOUNT_PRIVACY_STORAGE_KEY, state.accountPrivacyEnabled ? '1' : '0');
  } catch (_) {
    // ignore localStorage failures
  }
  syncAccountPrivacyButton();
  if (state.runtime) renderRuntimeState();
  setSessionBadge(state.sessionEmail || '未登录');
});

document.getElementById('accountIndexList').addEventListener('click', (event) => {
  const button = event.target.closest('.account-index-item');
  if (!button || !state.runtime) return;
  const accountId = button.dataset.accountId || null;
  if (!accountId || accountId === state.selectedAccountId) return;
  state.selectedAccountId = accountId;
  renderAccountIndexSelection(accountId);
  const selectedAccount = (state.runtime.slots || []).find((account) => account.id === accountId) || null;
  renderAccountDetail(selectedAccount);
  bindDynamicHandlers();
});

document.getElementById('manualRefreshBtn').addEventListener('click', async () => {
  const button = document.getElementById('manualRefreshBtn');
  await runButtonAction(button, {
    pendingText: '刷新中...',
    successText: '已提交后台刷新'
  }, async () => {
    await triggerRuntimeRefresh('manual', {
      slotId: state.selectedAccountId || null
    });
  }).catch(() => {});
});

document.getElementById('exchangeModalForm').addEventListener('submit', (event) => {
  event.preventDefault();
});

document.getElementById('exchangeModalToggleBtn').addEventListener('click', async () => {
  openExchangeModal();
  setExchangeStatus();
  document.getElementById('exchangePassphraseInput')?.focus();
});

document.getElementById('exchangeModalCloseBtn').addEventListener('click', () => {
  closeExchangeModal();
});

document.getElementById('exchangeModal').addEventListener('click', (event) => {
  if (event.target.id === 'exchangeModal') closeExchangeModal();
});

document.getElementById('exchangeGenerateBtn').addEventListener('click', async () => {
  const button = document.getElementById('exchangeGenerateBtn');
  const restore = setButtonBusy(button, '生成中...');
  setExchangeStatus();
  try {
    const passphrase = await generateExchangePassphrase();
    const input = document.getElementById('exchangePassphraseInput');
    input?.focus();
    input?.select();
    setExchangeStatus('新的交换口令已生成', 'success');
    return passphrase;
  } catch (error) {
    setExchangeStatus(explainError(error), 'error');
  } finally {
    restore();
  }
});

document.getElementById('exchangeCopyBtn').addEventListener('click', async () => {
  const passphrase = currentExchangePassphrase();
  if (!passphrase) {
    showToast('请先生成或输入交换口令', 'warning');
    return;
  }
  try {
    await navigator.clipboard.writeText(passphrase);
    showToast('交换口令已复制', 'success');
  } catch (_) {
    showToast(passphrase, 'warning');
  }
});

document.getElementById('exportExchangeBtn').addEventListener('click', async () => {
  const button = document.getElementById('exportExchangeBtn');
  const passphrase = currentExchangePassphrase();
  if (!passphrase) {
    setExchangeStatus('请先生成或输入交换口令', 'warning');
    return;
  }
  const restore = setButtonBusy(button, '导出中...');
  setExchangeStatus();
  try {
    const result = await api('/api/exchange/export', {
      method: 'POST',
      body: JSON.stringify({
        passphrase,
        source: 'codex-switcher-web-ui'
      })
    });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    downloadJsonFile(`codex-switcher-export-${stamp}.json`, result.exportData);
    setExchangeStatus('交换文件已导出', 'success');
    closeExchangeModal();
  } catch (error) {
    setExchangeStatus(explainError(error), 'error');
  } finally {
    restore();
  }
});

document.getElementById('importExchangeBtn').addEventListener('click', () => {
  const passphrase = currentExchangePassphrase();
  if (!passphrase) {
    setExchangeStatus('请先生成或输入交换口令', 'warning');
    document.getElementById('exchangeImportPassphraseInput')?.focus();
    return;
  }
  document.getElementById('exchangeFileInput').click();
});

document.getElementById('exchangeFileInput').addEventListener('change', async (event) => {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  const button = document.getElementById('importExchangeBtn');
  const passphrase = currentExchangePassphrase();
  const strategy = document.getElementById('exchangeImportStrategySelect').value || 'merge';
  try {
    const raw = await file.text();
    const data = JSON.parse(raw);
    const restore = setButtonBusy(button, '导入中...');
    setExchangeStatus();
    try {
      await api('/api/exchange/import', {
        method: 'POST',
        body: JSON.stringify({
          passphrase,
          strategy,
          data
        })
      });
      scheduleRuntimeReload(10);
      scheduleRuntimeReload(220);
      setExchangeStatus('交换文件已导入', 'success');
      closeExchangeModal();
    } catch (error) {
      setExchangeStatus(explainError(error), 'error');
    } finally {
      restore();
    }
  } catch (error) {
    setExchangeStatus(explainError(error), 'error');
  } finally {
    event.target.value = '';
  }
});

['exchangePassphraseInput', 'exchangeImportPassphraseInput'].forEach((id) => {
  const input = document.getElementById(id);
  if (!input) return;
  input.addEventListener('input', (event) => {
    const value = String(event.target.value || '');
    exchangePassphraseInputs().forEach((node) => {
      if (node !== event.target) node.value = value;
    });
    if (value.trim()) armExchangePassphraseDestroyTimer();
    else clearExchangePassphrase({ preserveValue: false });
  });
});

document.getElementById('autoSwitchToggleBtn').addEventListener('click', async () => {
  const button = document.getElementById('autoSwitchToggleBtn');
  const nextValue = !(state.settings && state.settings.autoSwitchEnabled);
  await runButtonAction(button, {
    pendingText: nextValue ? '开启中...' : '关闭中...',
    successText: nextValue ? '自动切换已开启' : '自动切换已关闭'
  }, async () => {
    const result = await api('/api/runtime/settings', {
      method: 'PATCH',
      body: JSON.stringify({
        autoSwitchEnabled: nextValue
      })
    });
    state.settings.autoSwitchEnabled = !!(result.settings && result.settings.auto_switch_enabled);
    syncAutoSwitchButton();
  }).catch(() => {});
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && isExchangeModalOpen()) {
    closeExchangeModal();
  }
});

document.getElementById('refreshIntervalSelect').addEventListener('change', (event) => {
  const value = event.target.value;
  if (value === 'custom') {
    const customInput = document.getElementById('refreshCustomInput');
    customInput.classList.remove('hidden');
    customInput.focus();
    customInput.select();
    return;
  }
  setRefreshSeconds(Number(value));
});

document.getElementById('refreshCustomInput').addEventListener('change', (event) => {
  setRefreshSeconds(Number(event.target.value || 10));
});

document.getElementById('refreshCustomInput').addEventListener('blur', (event) => {
  setRefreshSeconds(Number(event.target.value || 10));
});

document.getElementById('accountSearchInput').addEventListener('input', (event) => {
  state.accountSearch = event.target.value || '';
  try {
    window.localStorage.setItem(ACCOUNT_SEARCH_STORAGE_KEY, state.accountSearch);
  } catch (_) {
    // ignore localStorage failures
  }
  if (state.runtime) renderRuntimeState({ includeLogs: false });
});

document.getElementById('accountSortSelect').addEventListener('change', (event) => {
  state.accountSort = event.target.value || 'availability';
  try {
    window.localStorage.setItem(ACCOUNT_SORT_STORAGE_KEY, state.accountSort);
  } catch (_) {
    // ignore localStorage failures
  }
  if (state.runtime) renderRuntimeState({ includeLogs: false });
});

document.getElementById('accountFilterSelect').addEventListener('change', (event) => {
  state.accountFilter = event.target.value || 'all';
  try {
    window.localStorage.setItem(ACCOUNT_FILTER_STORAGE_KEY, state.accountFilter);
  } catch (_) {
    // ignore localStorage failures
  }
  if (state.runtime) renderRuntimeState({ includeLogs: false });
});

document.getElementById('accountLoginMethodFilterSelect').addEventListener('change', (event) => {
  state.accountLoginMethodFilter = event.target.value || 'all';
  try {
    window.localStorage.setItem(ACCOUNT_LOGIN_METHOD_FILTER_STORAGE_KEY, state.accountLoginMethodFilter);
  } catch (_) {
    // ignore localStorage failures
  }
  if (state.runtime) renderRuntimeState({ includeLogs: false });
});

const clearBootstrapTasksBtn = document.getElementById('clearBootstrapTasksBtn');
if (clearBootstrapTasksBtn) {
  clearBootstrapTasksBtn.addEventListener('click', async () => {
    const button = clearBootstrapTasksBtn;
    const sessions = state.runtime && Array.isArray(state.runtime.bootstrapSessions) ? state.runtime.bootstrapSessions : [];
    if (!sessions.length) return;
    if (!window.confirm(`确定一键清除全部 ${sessions.length} 个认证任务吗？正在进行中的认证也会被终止`)) return;
    await runButtonAction(button, {
      pendingText: '清除中...',
      successText: `已清除 ${sessions.length} 个认证任务`
    }, async () => {
      await api('/api/bootstrap-sessions', {
        method: 'DELETE',
        body: '{}'
      });
      state.openBootstrapLogIds.clear();
      scheduleRuntimeReload(10, { includeLogs: false });
      scheduleRuntimeReload(220);
    }).catch(() => {});
  });
}

document.getElementById('switchLogPrevBtn').addEventListener('click', () => {
  state.switchLogPage = Math.max(1, state.switchLogPage - 1);
  renderSwitchLogs(state.recentSwitches || []);
});

document.getElementById('switchLogNextBtn').addEventListener('click', () => {
  state.switchLogPage += 1;
  renderSwitchLogs(state.recentSwitches || []);
});

document.getElementById('switchLogPageInfo').addEventListener('click', () => {
  setLogPageEditMode('switch', true);
});

document.getElementById('switchLogPageInfo').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    setLogPageEditMode('switch', true);
  }
});

document.getElementById('switchLogJumpInput').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    jumpToLogPage('switch');
  } else if (event.key === 'Escape') {
    event.preventDefault();
    setLogPageEditMode('switch', false);
  }
});

document.getElementById('switchLogJumpInput').addEventListener('blur', () => {
  jumpToLogPage('switch');
});

document.getElementById('sampleLogPrevBtn').addEventListener('click', () => {
  state.sampleLogPage = Math.max(1, state.sampleLogPage - 1);
  renderSampleLogs(state.recentSamples || []);
});

document.getElementById('sampleLogNextBtn').addEventListener('click', () => {
  state.sampleLogPage += 1;
  renderSampleLogs(state.recentSamples || []);
});

document.getElementById('sampleLogPageInfo').addEventListener('click', () => {
  setLogPageEditMode('sample', true);
});

document.getElementById('sampleLogPageInfo').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    setLogPageEditMode('sample', true);
  }
});

document.getElementById('sampleLogJumpInput').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    jumpToLogPage('sample');
  } else if (event.key === 'Escape') {
    event.preventDefault();
    setLogPageEditMode('sample', false);
  }
});

document.getElementById('sampleLogJumpInput').addEventListener('blur', () => {
  jumpToLogPage('sample');
});

document.getElementById('clearSwitchLogsBtn').addEventListener('click', async () => {
  const button = document.getElementById('clearSwitchLogsBtn');
  const count = (state.recentSwitches || []).length;
  if (!count) return;
  if (!window.confirm(`确定清空最近 ${count} 条切换记录吗？这个操作不可恢复`)) return;
  await runButtonAction(button, {
    pendingText: '清空中...',
    successText: `已清空 ${count} 条切换记录`
  }, async () => {
    state.switchLogPage = 1;
    await api('/api/logs/switches', {
      method: 'DELETE',
      body: '{}'
    });
    scheduleRuntimeReload(10);
  }).catch(() => {});
});

document.getElementById('clearSampleLogsBtn').addEventListener('click', async () => {
  const button = document.getElementById('clearSampleLogsBtn');
  const count = (state.recentSamples || []).length;
  if (!count) return;
  if (!window.confirm(`确定清空最近 ${count} 条额度快照吗？这个操作不可恢复`)) return;
  await runButtonAction(button, {
    pendingText: '清空中...',
    successText: `已清空 ${count} 条额度快照`
  }, async () => {
    state.sampleLogPage = 1;
    await api('/api/logs/quota-samples', {
      method: 'DELETE',
      body: '{}'
    });
    scheduleRuntimeReload(10);
  }).catch(() => {});
});

initApp().catch(console.error);
