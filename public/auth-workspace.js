const workspaceState = {
  slotId: '',
  token: '',
  pollTimer: null,
  toastId: 0,
  autoCloseTimer: null,
  closeRequested: false,
  lastWorkspace: null,
  lastBootstrapSession: null
};

function isEmbeddedWorkspace() {
  return window.self !== window.top;
}

function notifyWorkspaceParent(eventName, detail = {}) {
  if (!isEmbeddedWorkspace()) return;
  window.parent.postMessage({
    source: 'codex-switcher-auth-workspace',
    event: eventName,
    slotId: workspaceState.slotId,
    ...detail
  }, '*');
}

function workspaceEscapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function showWorkspaceToast(message, tone = 'success') {
  const viewport = document.getElementById('workspaceToastViewport');
  const toast = document.createElement('div');
  toast.className = `toast toast--${tone}`;
  toast.dataset.toastId = String(++workspaceState.toastId);
  toast.textContent = message;
  viewport.appendChild(toast);
  window.setTimeout(() => {
    toast.classList.add('toast--closing');
    window.setTimeout(() => toast.remove(), 180);
  }, 2600);
}

function authStageText(state) {
  const mapping = {
    preparing_workspace: '正在准备远程浏览器',
    ready_for_login: '远程认证台已就绪',
    awaiting_user: '等待你在认证台中完成登录',
    verifying_identity: '正在校验本次授权身份',
    retrying_wrong_account: '已重置认证台，请重新登录目标账号',
    captured: '认证已完成',
    failed: '认证未完成'
  };
  return mapping[state] || state || '--';
}

function authStageTone(state) {
  if (state === 'captured') return 'healthy';
  if (state === 'failed') return 'expired';
  return 'warning';
}

function bootstrapStatusText(status) {
  const mapping = {
    starting: '准备中',
    awaiting_user: '等待认证',
    success_pending_capture: '校验身份中',
    succeeded: '校验身份中',
    captured: '已完成',
    failed: '已失败'
  };
  return mapping[status] || status || '--';
}

function formatWorkspaceTime(value) {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: 'UTC'
  }).format(date) + ' UTC';
}

async function workspaceApi(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      ...(workspaceState.token ? { authorization: `Bearer ${workspaceState.token}` } : {}),
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {})
    },
    ...options
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || json.ok === false) {
    throw new Error(json.error || `Request failed: ${response.status}`);
  }
  return json;
}

function renderWorkspace(workspace, bootstrapSession) {
  if (workspace) workspaceState.lastWorkspace = workspace;
  if (bootstrapSession) workspaceState.lastBootstrapSession = bootstrapSession;

  const effectiveWorkspace = workspace || workspaceState.lastWorkspace || null;
  const effectiveBootstrap = bootstrapSession || workspaceState.lastBootstrapSession || null;
  const stateText = authStageText(effectiveWorkspace && effectiveWorkspace.state);
  const stateTone = authStageTone(effectiveWorkspace && effectiveWorkspace.state);
  const noVncPath = effectiveWorkspace && effectiveWorkspace.noVncPath ? effectiveWorkspace.noVncPath : '';
  const loginMethod = String(
    (effectiveBootstrap && effectiveBootstrap.login_method)
    || (effectiveWorkspace && effectiveWorkspace.loginMethod)
    || 'email'
  ).trim().toLowerCase();
  const frame = document.getElementById('novncFrame');
  const frameWrap = document.getElementById('browserFrameWrap');
  const placeholder = document.getElementById('browserPlaceholder');
  const badge = document.getElementById('workspaceStateBadge');
  const assistEmailBtn = document.getElementById('assistEmailBtn');
  const assistGoogleBtn = document.getElementById('assistGoogleBtn');

  document.getElementById('targetEmail').textContent = effectiveBootstrap && effectiveBootstrap.email ? effectiveBootstrap.email : '--';
  document.getElementById('deviceCode').textContent = effectiveBootstrap && effectiveBootstrap.device_code ? effectiveBootstrap.device_code : '--';
  document.getElementById('workspaceStageText').textContent = stateText;
  document.getElementById('workspaceMessage').textContent = effectiveWorkspace && effectiveWorkspace.message ? effectiveWorkspace.message : '等待远程认证台状态...';
  document.getElementById('bootstrapStatusText').textContent = bootstrapStatusText(effectiveBootstrap && effectiveBootstrap.status);
  document.getElementById('bootstrapUpdatedAt').textContent = formatWorkspaceTime(effectiveBootstrap && effectiveBootstrap.updated_at);
  document.getElementById('workspaceExpiresAt').textContent = formatWorkspaceTime(effectiveWorkspace && effectiveWorkspace.expiresAt);

  assistEmailBtn.classList.toggle('hidden', loginMethod === 'google');
  assistGoogleBtn.classList.toggle('hidden', loginMethod !== 'google');

  badge.className = `status-pill ${stateTone}`;
  badge.textContent = stateText;

  const browserVisible = !!(
    effectiveWorkspace
    && effectiveWorkspace.workspaceActive !== false
    && effectiveWorkspace.state !== 'failed'
    && effectiveWorkspace.state !== 'captured'
    && noVncPath
  );

  frameWrap.classList.toggle('hidden', !browserVisible);
  placeholder.classList.toggle('hidden', browserVisible);
  if (browserVisible && frame.dataset.src !== noVncPath) {
    frame.src = noVncPath;
    frame.dataset.src = noVncPath;
  }

  if (!browserVisible) {
    placeholder.innerHTML = `
      <strong>${effectiveWorkspace && effectiveWorkspace.state === 'captured' ? '认证已经完成' : '认证台暂不可用'}</strong>
      <p class="muted">${workspaceEscapeHtml(effectiveWorkspace && effectiveWorkspace.message ? effectiveWorkspace.message : '这次认证会话已经结束')}</p>
    `;
  }

  notifyWorkspaceParent('state', {
    workspaceState: effectiveWorkspace && effectiveWorkspace.state ? effectiveWorkspace.state : null,
    workspaceMessage: effectiveWorkspace && effectiveWorkspace.message ? effectiveWorkspace.message : null,
    bootstrapStatus: effectiveBootstrap && effectiveBootstrap.status ? effectiveBootstrap.status : null
  });
}

function scheduleWorkspaceAutoClose() {
  if (workspaceState.closeRequested) return;
  workspaceState.closeRequested = true;
  if (workspaceState.autoCloseTimer) clearTimeout(workspaceState.autoCloseTimer);
  showWorkspaceToast('认证成功，认证台即将自动关闭', 'success');
  notifyWorkspaceParent('captured');
  if (isEmbeddedWorkspace()) return;
  workspaceState.autoCloseTimer = window.setTimeout(() => {
    window.close();
    window.setTimeout(() => {
      if (!window.closed) {
        window.location.replace('/');
      }
    }, 240);
  }, 1200);
}

async function pollWorkspace() {
  if (!workspaceState.slotId || !workspaceState.token) return;
  try {
    const json = await workspaceApi(`/api/auth-workspaces/${encodeURIComponent(workspaceState.slotId)}`);
    renderWorkspace(json.workspace, json.bootstrapSession);
    if (json.workspace && json.workspace.state === 'captured') {
      scheduleWorkspaceAutoClose();
    }
    if (json.workspace && (json.workspace.state === 'captured' || json.workspace.state === 'failed')) {
      if (workspaceState.pollTimer) {
        clearInterval(workspaceState.pollTimer);
        workspaceState.pollTimer = null;
      }
    }
  } catch (error) {
    renderWorkspace({
      state: 'failed',
      message: error.message,
      workspaceActive: false
    }, null);
  }
}

async function resetWorkspace() {
  const button = document.getElementById('resetWorkspaceBtn');
  button.disabled = true;
  const oldText = button.textContent;
  button.textContent = '重置中...';
  try {
    await workspaceApi(`/api/auth-workspaces/${encodeURIComponent(workspaceState.slotId)}/reset`, {
      method: 'POST',
      body: '{}'
    });
    showWorkspaceToast('远程认证台已重置，新的设备码正在生效', 'success');
    await pollWorkspace();
  } catch (error) {
    showWorkspaceToast(error.message, 'error');
  } finally {
    button.disabled = false;
    button.textContent = oldText;
  }
}

async function runWorkspaceAction(action, button, pendingText, extraBody = {}) {
  if (!workspaceState.slotId || !workspaceState.token || !button) return;
  button.disabled = true;
  const oldText = button.textContent;
  button.textContent = pendingText;
  try {
    const json = await workspaceApi(`/api/auth-workspaces/${encodeURIComponent(workspaceState.slotId)}/actions`, {
      method: 'POST',
      body: JSON.stringify({
        action,
        ...extraBody
      })
    });
    if (json.workspace) {
      renderWorkspace(json.workspace, null);
    }
    showWorkspaceToast(
      (json.actionResult && json.actionResult.message) || '已发送认证台辅助操作',
      'success'
    );
    await pollWorkspace();
  } catch (error) {
    showWorkspaceToast(error.message, 'error');
  } finally {
    button.disabled = false;
    button.textContent = oldText;
  }
}

async function closeWorkspace() {
  const button = document.getElementById('closeWorkspaceBtn');
  button.disabled = true;
  const oldText = button.textContent;
  button.textContent = '关闭中...';
  try {
    await workspaceApi(`/api/auth-workspaces/${encodeURIComponent(workspaceState.slotId)}`, {
      method: 'DELETE'
    });
    showWorkspaceToast('认证台已关闭', 'success');
    renderWorkspace({
      state: 'failed',
      message: '认证台已手动关闭',
      workspaceActive: false
    }, null);
    workspaceState.closeRequested = false;
    notifyWorkspaceParent('closed');
    if (workspaceState.pollTimer) {
      clearInterval(workspaceState.pollTimer);
      workspaceState.pollTimer = null;
    }
  } catch (error) {
    showWorkspaceToast(error.message, 'error');
  } finally {
    button.disabled = false;
    button.textContent = oldText;
  }
}

async function copyDeviceCode() {
  const value = document.getElementById('deviceCode').textContent.trim();
  if (!value || value === '--') return;
  try {
    await navigator.clipboard.writeText(value);
    showWorkspaceToast(`设备码 ${value} 已复制`, 'success');
  } catch (_) {
    showWorkspaceToast(`设备码：${value}`, 'warning');
  }
}

async function copyTargetEmail() {
  const value = document.getElementById('targetEmail').textContent.trim();
  if (!value || value === '--') return;
  try {
    await navigator.clipboard.writeText(value);
    showWorkspaceToast(`目标账号 ${value} 已复制`, 'success');
  } catch (_) {
    showWorkspaceToast(`目标账号：${value}`, 'warning');
  }
}

function parseWorkspaceContext() {
  const pathMatch = window.location.pathname.match(/\/auth-workspace\/([^/]+)/);
  workspaceState.slotId = pathMatch ? decodeURIComponent(pathMatch[1]) : '';
  workspaceState.token = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('token') || '';
}

function initWorkspace() {
  parseWorkspaceContext();
  if (!workspaceState.slotId || !workspaceState.token) {
    renderWorkspace({
      state: 'failed',
      message: '这个认证台链接无效，请回到 Codex Switcher 重新进入认证台',
      workspaceActive: false
    }, null);
    return;
  }

  document.getElementById('copyTargetEmailBtn').addEventListener('click', copyTargetEmail);
  document.getElementById('copyDeviceCodeBtn').addEventListener('click', copyDeviceCode);
  document.getElementById('resetWorkspaceBtn').addEventListener('click', resetWorkspace);
  document.getElementById('closeWorkspaceBtn').addEventListener('click', () => {
    closeWorkspace().catch(() => {});
  });
  document.getElementById('assistEmailBtn').addEventListener('click', (event) => {
    runWorkspaceAction('assist_login_email', event.currentTarget, '处理中...').catch(() => {});
  });
  document.getElementById('assistGoogleBtn').addEventListener('click', (event) => {
    runWorkspaceAction('assist_google_login', event.currentTarget, '处理中...').catch(() => {});
  });
  document.getElementById('fillDeviceCodeBtn').addEventListener('click', (event) => {
    const deviceCode = document.getElementById('deviceCode').textContent.trim();
    runWorkspaceAction('fill_device_code', event.currentTarget, '填入中...', { deviceCode }).catch(() => {});
  });

  window.addEventListener('message', (event) => {
    const payload = event.data;
    if (!payload || payload.source !== 'codex-switcher-auth-workspace-parent') return;
    if (payload.command === 'close') {
      closeWorkspace().catch(() => {});
    }
  });

  window.addEventListener('beforeunload', () => {
    if (workspaceState.pollTimer) clearInterval(workspaceState.pollTimer);
    if (workspaceState.autoCloseTimer) clearTimeout(workspaceState.autoCloseTimer);
  });

  pollWorkspace().catch(console.error);
  workspaceState.pollTimer = setInterval(() => {
    pollWorkspace().catch(() => {});
  }, 3000);
  notifyWorkspaceParent('ready');
}

initWorkspace();
