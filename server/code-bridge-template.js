'use strict';

const { config } = require('./config');

const DEFAULT_RECOVERY_PROMPT = '中断了，请继续严格按照原来规划完成全部任务';

function resolveDefaultInteractiveWorkspacePath() {
  try {
    const url = new URL(config.codeWorkspaceUrl);
    return decodeURIComponent(url.searchParams.get('workspace') || url.searchParams.get('folder') || '').trim();
  } catch (_) {
    return '';
  }
}

function buildCodeBridge() {
  const defaultInteractiveWorkspacePath = resolveDefaultInteractiveWorkspacePath();
  return `(function () {
  'use strict';

  if (window.top !== window.self) return;
  if (window.__codexCodeBridgeLoaded) return;
  window.__codexCodeBridgeLoaded = true;

  const API_BASE = '/_codex_switcher/api';
  const VERSION = 'v2';
  const DEFAULT_INTERACTIVE_WORKSPACE_PATH = ${JSON.stringify(defaultInteractiveWorkspacePath)};
  const HEARTBEAT_INTERVAL_MS = 5000;
  const FALLBACK_RECOVERY_PROMPT = ${JSON.stringify(DEFAULT_RECOVERY_PROMPT)};

  const state = {
    sessionId: null,
    eventSource: null,
    heartbeatTimer: null,
    sendDisabledTicks: 0,
    activeAuthGenerationSeen: 0,
    bannerNode: null,
    inflightActions: new Set(),
    processedActions: new Set()
  };

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function randomId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    return 'bridge_' + Math.random().toString(16).slice(2) + Date.now().toString(16);
  }

  function getSessionId() {
    if (state.sessionId) return state.sessionId;
    const key = 'codex_switcher_bridge_session_id';
    try {
      const existing = window.localStorage.getItem(key);
      if (existing) {
        state.sessionId = existing;
        return existing;
      }
    } catch (_) {}
    const next = 'bridge_' + randomId().replace(/-/g, '').slice(0, 24);
    try {
      window.localStorage.setItem(key, next);
    } catch (_) {}
    state.sessionId = next;
    return next;
  }

  function normalizeText(value) {
    return String(value || '').replace(/\\s+/g, ' ').trim();
  }

  function request(path, options = {}) {
    return fetch(API_BASE + path, {
      method: options.method || 'GET',
      headers: {
        'content-type': 'application/json',
        'x-codex-switcher-origin': location.origin
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      credentials: 'omit'
    }).then(async (response) => {
      const json = await response.json().catch(() => ({}));
      if (!response.ok || json.ok === false) {
        const message = (json && (json.error || json.message)) || ('Bridge request failed (' + response.status + ')');
        throw new Error(String(message));
      }
      return json;
    });
  }

  function findButton(matcher) {
    return Array.from(document.querySelectorAll('a, button, [role="button"]')).find((el) => {
      const text = normalizeText(el.textContent || '');
      const aria = normalizeText((el.getAttribute && (el.getAttribute('aria-label') || '')) || '');
      const title = normalizeText((el.getAttribute && (el.getAttribute('title') || '')) || '');
      return matcher({ text, aria, title, el });
    }) || null;
  }

  function findActionElement(matcher, selectors) {
    const seen = new Set();
    const nodes = [];
    const selectorList = selectors || ['a', 'button', '[role="button"]', '[aria-label]', '[title]'];
    for (const selector of selectorList) {
      for (const node of document.querySelectorAll(selector)) {
        if (!node || seen.has(node)) continue;
        seen.add(node);
        nodes.push(node);
      }
    }
    return nodes.find((el) => {
      const text = normalizeText(el.textContent || '');
      const aria = normalizeText((el.getAttribute && (el.getAttribute('aria-label') || '')) || '');
      const title = normalizeText((el.getAttribute && (el.getAttribute('title') || '')) || '');
      return matcher({ text, aria, title, el });
    }) || null;
  }

  function getImeTextarea() {
    return document.querySelector('.ime-text-area');
  }

  function getTextbox() {
    return Array.from(document.querySelectorAll('[role="textbox"]')).find((el) => /Chat Input/i.test(String(el.getAttribute('aria-label') || '')))
      || document.querySelector('textarea');
  }

  function getSendButton() {
    return findButton(({ aria, text, title, el }) => /发送|Send/i.test(aria)
      || /发送|Send/i.test(text)
      || /发送|Send/i.test(title)
      || String(el.className || '').includes('codicon-send')
      || String(el.className || '').includes('send-button-container'));
  }

  function getChatLauncher() {
    return findButton(({ aria, text }) => /Toggle Chat/i.test(aria)
      || /聊天\\s*\\(Ctrl\\+Alt\\+I\\)/i.test(aria)
      || text === '打开聊天'
      || text === '聊天');
  }

  function getRefreshAgentSessionButton() {
    return findButton(({ aria, text, title }) => /刷新智能体会话|Refresh Agent Session/i.test(aria)
      || /刷新智能体会话|Refresh Agent Session/i.test(text)
      || /刷新智能体会话|Refresh Agent Session/i.test(title));
  }

  function getNewSessionButton() {
    const looksLikeNewSession = (value) => /^(New Session|New Chat|新建聊天|新建会话|开启新聊天)$/i.test(normalizeText(value || ''));
    return findActionElement(({ aria, text, title, el }) => {
      const hasSendMarker = /发送|Send/i.test([aria, text, title].join(' '));
      if (hasSendMarker) return false;
      return looksLikeNewSession(text)
        || looksLikeNewSession(aria)
        || looksLikeNewSession(title)
        || String(el.className || '').includes('codicon-plus')
        || /chat\\.openNewSession|chat\\.newSession/i.test(String(el.getAttribute && (el.getAttribute('data-command') || '')));
    },
    ['button', 'a', '[role="button"]', '[aria-label]', '[title]', '[data-command]']);
  }

  function deriveWorkspaceKind(pageUrl) {
    try {
      const parsed = new URL(pageUrl, location.origin);
      const workspacePath = decodeURIComponent(parsed.searchParams.get('workspace') || parsed.searchParams.get('folder') || '').trim();
      if (!workspacePath) return 'unknown';
      if (DEFAULT_INTERACTIVE_WORKSPACE_PATH && workspacePath === DEFAULT_INTERACTIVE_WORKSPACE_PATH) {
        return 'interactive_default';
      }
      return 'managed_repo';
    } catch (_) {
      return 'unknown';
    }
  }

  function readDraftPrompt(textbox) {
    if (!textbox) return '';
    if (typeof textbox.value === 'string' && textbox.value) return normalizeText(textbox.value);
    return normalizeText(textbox.innerText || textbox.textContent || '');
  }

  function collectSnapshot() {
    const requestRows = Array.from(document.querySelectorAll('.monaco-list-row.request'))
      .map((el) => normalizeText(el.textContent || ''))
      .filter(Boolean);
    const responses = Array.from(document.querySelectorAll('.interactive-item-container, .interactive-response, .chat-markdown-part'))
      .map((el) => normalizeText(el.textContent || ''))
      .filter(Boolean);
    const bodyText = String(document.body.innerText || document.body.textContent || '');
    const sessionTitleButton = findButton(({ aria }) => /Pick Agent Session/i.test(aria));
    const stopButton = findButton(({ aria, text }) => /取消|Stop|Cancel/i.test(aria) || /取消|Stop|Cancel/i.test(text));
    const modelButton = findButton(({ aria }) => /Pick Model/i.test(aria));
    const sendButton = getSendButton();
    const textbox = getTextbox();

    return {
      version: VERSION,
      sessionId: getSessionId(),
      workspaceKind: deriveWorkspaceKind(location.href),
      pageUrl: location.href,
      title: document.title,
      sessionTitle: sessionTitleButton ? normalizeText(sessionTitleButton.textContent || '') : '',
      latestRequest: requestRows.length ? requestRows[requestRows.length - 1] : '',
      latestResponse: responses.length ? responses[responses.length - 1] : '',
      draftPrompt: readDraftPrompt(textbox),
      running: !!stopButton,
      modelLabel: modelButton ? normalizeText(modelButton.textContent || '') : '',
      restrictedMode: bodyText.includes('受限模式'),
      authRequired: /Your Code:\\s*[A-Z0-9-]{4,}/i.test(bodyText)
        || /device code/i.test(bodyText)
        || /Sign in to OpenAI/i.test(bodyText)
        || /登录.*OpenAI/i.test(bodyText)
        || /使用设备代码/i.test(bodyText),
      hasChatInput: !!textbox,
      hasSendButton: !!sendButton,
      sendEnabled: !!sendButton
        && !String(sendButton.className || '').includes('disabled')
        && String(sendButton.getAttribute('aria-disabled') || '').toLowerCase() !== 'true',
      visible: !document.hidden,
      focused: typeof document.hasFocus === 'function' ? document.hasFocus() : true,
      bodyText
    };
  }

  function detectInterruptionReason(snapshot) {
    if (!snapshot || snapshot.workspaceKind !== 'interactive_default') {
      state.sendDisabledTicks = 0;
      return null;
    }
    const bodyText = String(snapshot.bodyText || '');
    if (/额度.*用完|quota.*exhaust|out of quota|usage limit|rate limit reached/i.test(bodyText)) {
      return snapshot.running ? 'quota_exhausted_during_run' : 'quota_exhausted_after_completion';
    }
    if (snapshot.authRequired) {
      if (/压缩|compress|summary|summar/i.test(bodyText)) return 'compression_paused';
      return snapshot.running ? 'auth_required_during_run' : 'auth_required';
    }
    if (snapshot.hasChatInput && !snapshot.sendEnabled && !snapshot.running) {
      if (!normalizeText(snapshot.draftPrompt || '')) {
        state.sendDisabledTicks = 0;
        return null;
      }
      state.sendDisabledTicks += 1;
      if (state.sendDisabledTicks >= 3) return 'composer_unavailable';
      return null;
    }
    state.sendDisabledTicks = 0;
    return null;
  }

  function ensureBanner() {
    if (state.bannerNode && document.body.contains(state.bannerNode)) return state.bannerNode;
    const node = document.createElement('div');
    node.id = 'codex-switcher-bridge-banner';
    node.style.cssText = [
      'position:fixed',
      'top:16px',
      'right:16px',
      'z-index:2147483647',
      'max-width:360px',
      'padding:10px 14px',
      'border-radius:12px',
      'font:500 13px/1.45 ui-sans-serif,system-ui,-apple-system,sans-serif',
      'box-shadow:0 12px 28px rgba(15,23,42,0.18)',
      'background:#0f172a',
      'color:#fff',
      'opacity:0',
      'transform:translateY(-8px)',
      'transition:opacity 160ms ease,transform 160ms ease',
      'pointer-events:none'
    ].join(';');
    document.body.appendChild(node);
    state.bannerNode = node;
    return node;
  }

  function showBanner(message, tone) {
    const node = ensureBanner();
    node.textContent = String(message || '').trim();
    node.style.background = tone === 'warning' ? '#92400e' : tone === 'error' ? '#991b1b' : '#0f172a';
    node.style.opacity = '1';
    node.style.transform = 'translateY(0)';
    window.clearTimeout(node.__hideTimer);
    node.__hideTimer = window.setTimeout(() => {
      node.style.opacity = '0';
      node.style.transform = 'translateY(-8px)';
    }, tone === 'warning' || tone === 'error' ? 9000 : 5000);
  }

  function clickIfPossible(node) {
    if (!node) return false;
    try {
      node.click();
      return true;
    } catch (_) {
      return false;
    }
  }

  function dismissWorkspaceTrustDialogs() {
    const buttons = Array.from(document.querySelectorAll('a, button, [role="button"]'));
    for (const button of buttons) {
      const text = normalizeText(button.textContent || '');
      const aria = normalizeText((button.getAttribute && button.getAttribute('aria-label')) || '');
      if (/信任工作区并启用所有功能|Yes, I trust the authors|是，我信任此作者|Trust Workspace/i.test(text) || /Trust Workspace/i.test(aria)) {
        clickIfPossible(button);
      }
      if (/关闭横幅|Close Banner/i.test(aria)) clickIfPossible(button);
      if (/清除通知|Clear Notifications/i.test(aria)) clickIfPossible(button);
    }
  }

  async function ensureUiReady(attempts = 10) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      dismissWorkspaceTrustDialogs();
      const toggleChat = getChatLauncher();
      const refreshSession = getRefreshAgentSessionButton();
      const snapshot = collectSnapshot();
      if (snapshot.authRequired) {
        clickIfPossible(refreshSession);
        await sleep(800);
        continue;
      }
      if (snapshot.hasChatInput && snapshot.hasSendButton) return true;
      if (!snapshot.hasChatInput && toggleChat) clickIfPossible(toggleChat);
      await sleep(800);
    }
    const snapshot = collectSnapshot();
    return snapshot.hasChatInput && snapshot.hasSendButton && !snapshot.authRequired;
  }

  function focusInput() {
    let textbox = getTextbox();
    if (!textbox) {
      clickIfPossible(getChatLauncher());
      textbox = getTextbox();
    }
    if (textbox && typeof textbox.focus === 'function') textbox.focus();
    return textbox;
  }

  function clearTextbox(textbox) {
    if (!textbox) return false;
    try {
      textbox.focus();
      if (typeof document.execCommand === 'function') {
        document.execCommand('selectAll', false);
        document.execCommand('delete', false);
      }
    } catch (_) {}
    if (typeof textbox.value === 'string') textbox.value = '';
    textbox.textContent = '';
    textbox.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, data: '', inputType: 'deleteContentBackward' }));
    textbox.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  async function waitForSendEnabled(attempts = 20, delayMs = 250) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const snapshot = collectSnapshot();
      if (snapshot.authRequired) return false;
      if (snapshot.sendEnabled) return true;
      await sleep(delayMs);
    }
    return false;
  }

  async function injectPrompt(prompt) {
    const textbox = focusInput();
    if (!textbox) return false;
    const imeTextarea = getImeTextarea();
    clearTextbox(textbox);
    if (imeTextarea) {
      try {
        imeTextarea.removeAttribute('readonly');
        imeTextarea.focus();
        imeTextarea.value = prompt;
        imeTextarea.dispatchEvent(new InputEvent('input', {
          bubbles: true,
          cancelable: true,
          data: prompt,
          inputType: 'insertText'
        }));
        imeTextarea.dispatchEvent(new Event('change', { bubbles: true }));
      } catch (_) {}
    }
    try {
      if (typeof textbox.value === 'string') {
        textbox.value = prompt;
      } else if (!imeTextarea && typeof document.execCommand === 'function') {
        const inserted = document.execCommand('insertText', false, prompt);
        if (!inserted) textbox.textContent = prompt;
      } else {
        textbox.textContent = prompt;
      }
      textbox.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        cancelable: true,
        data: prompt,
        inputType: 'insertFromPaste'
      }));
      textbox.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (_) {
      return false;
    }
    if (await waitForSendEnabled(20, 250)) return true;
    try {
      textbox.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true }));
      textbox.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', code: 'Space', bubbles: true }));
    } catch (_) {}
    return waitForSendEnabled(10, 250);
  }

  function clickSend() {
    const sendButton = getSendButton();
    if (sendButton && String(sendButton.getAttribute('aria-disabled') || '').toLowerCase() !== 'true') {
      return clickIfPossible(sendButton);
    }
    const textbox = getTextbox();
    if (!textbox) return false;
    try {
      textbox.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', which: 13, keyCode: 13, bubbles: true }));
      textbox.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', which: 13, keyCode: 13, bubbles: true }));
      return true;
    } catch (_) {
      return false;
    }
  }

  function shouldSkipDuplicateResume(payload, snapshot) {
    const targetRequest = normalizeText(payload.latestRequest || '');
    const currentRequest = normalizeText(snapshot.latestRequest || '');
    if (!targetRequest || !currentRequest || targetRequest !== currentRequest) return false;
    const previousResponse = normalizeText(payload.latestResponse || '');
    const currentResponse = normalizeText(snapshot.latestResponse || '');
    return !!currentResponse && currentResponse !== previousResponse;
  }

  async function ackAction(actionId, status, result) {
    await request('/actions/' + encodeURIComponent(actionId) + '/ack', {
      method: 'POST',
      body: {
        status,
        result: result || {}
      }
    });
  }

  async function recoverSameThread(action) {
    const payload = action.payload || {};
    state.activeAuthGenerationSeen = Math.max(state.activeAuthGenerationSeen, Number(payload.activeAuthGeneration || 0));
    showBanner('认证已切换，正在自动恢复当前对话…', 'info');
    clickIfPossible(getRefreshAgentSessionButton());
    const ready = await ensureUiReady(12);
    if (!ready) {
      await ackAction(action.id, 'failed', {
        fallbackRequired: true,
        error: 'SAME_THREAD_NOT_READY'
      });
      return { handled: true };
    }
    await ackAction(action.id, 'completed', {
      canResume: true,
      recoveredSameThread: true,
      activeAuthGenerationSeen: state.activeAuthGenerationSeen
    });
    showBanner('当前对话已恢复，继续执行中…', 'info');
    return { handled: true };
  }

  async function resumePrompt(action, newThread) {
    const payload = action.payload || {};
    const ready = await ensureUiReady(12);
    if (!ready) {
      await ackAction(action.id, 'failed', {
        fallbackRequired: true,
        error: 'CHAT_UI_NOT_READY'
      });
      return { handled: true };
    }
    if (newThread) {
      const newSessionButton = getNewSessionButton();
      if (!clickIfPossible(newSessionButton)) {
        await ackAction(action.id, 'failed', {
          error: 'NEW_SESSION_UNAVAILABLE'
        });
        return { handled: true };
      }
      await sleep(1200);
      if (!await ensureUiReady(10)) {
        await ackAction(action.id, 'failed', {
          error: 'NEW_SESSION_NOT_READY'
        });
        return { handled: true };
      }
    }
    const snapshot = collectSnapshot();
    if (shouldSkipDuplicateResume(payload, snapshot)) {
      await ackAction(action.id, 'skipped', {
        duplicate: true
      });
      return { handled: true };
    }
    const prompt = normalizeText(payload.prompt || payload.recoverySummary || FALLBACK_RECOVERY_PROMPT) || FALLBACK_RECOVERY_PROMPT;
    const inserted = await injectPrompt(prompt);
    if (!inserted) {
      await ackAction(action.id, 'failed', {
        fallbackRequired: !newThread,
        error: 'PROMPT_INPUT_NOT_ACCEPTED'
      });
      return { handled: true };
    }
    if (!clickSend()) {
      await ackAction(action.id, 'failed', {
        fallbackRequired: !newThread,
        error: 'SEND_BUTTON_UNAVAILABLE'
      });
      return { handled: true };
    }
    state.activeAuthGenerationSeen = Math.max(state.activeAuthGenerationSeen, Number(payload.activeAuthGeneration || 0));
    await ackAction(action.id, 'completed', {
      sent: true,
      newThread: !!newThread,
      activeAuthGenerationSeen: state.activeAuthGenerationSeen
    });
    showBanner(newThread ? '已自动新开线程并继续任务' : '已自动继续刚才中断的任务', 'info');
    return { handled: true };
  }

  async function handleAction(action) {
    if (!action || !action.id || state.inflightActions.has(action.id)) return;
    if (state.processedActions.has(action.id)) return;
    state.inflightActions.add(action.id);
    try {
      if (action.action_type === 'auth_switched') {
        const payload = action.payload || {};
        state.activeAuthGenerationSeen = Math.max(state.activeAuthGenerationSeen, Number(payload.activeAuthGeneration || 0));
        showBanner('已检测到后台切换账号，正在恢复对话…', 'info');
        await ackAction(action.id, 'completed', {
          activeAuthGenerationSeen: state.activeAuthGenerationSeen
        });
        state.processedActions.add(action.id);
        return;
      }
      if (action.action_type === 'recover_same_thread') {
        const result = await recoverSameThread(action);
        if (result && result.deferred) return;
        state.processedActions.add(action.id);
        return;
      }
      if (action.action_type === 'resume_prompt') {
        await resumePrompt(action, false);
        state.processedActions.add(action.id);
        return;
      }
      if (action.action_type === 'open_new_thread_and_resume') {
        await resumePrompt(action, true);
        state.processedActions.add(action.id);
        return;
      }
      if (action.action_type === 'blocked_all_accounts') {
        const payload = action.payload || {};
        showBanner(payload.message || '暂无可用额度账号，已暂停自动续跑', 'warning');
        await ackAction(action.id, 'completed', {
          blocked: true
        });
        state.processedActions.add(action.id);
        return;
      }
      await ackAction(action.id, 'completed', {});
      state.processedActions.add(action.id);
    } catch (error) {
      console.error('[CodexBridge] action failed', error);
      try {
        await ackAction(action.id, 'failed', {
          error: String(error && error.message ? error.message : error)
        });
      } catch (_) {}
      state.processedActions.add(action.id);
    } finally {
      state.inflightActions.delete(action.id);
    }
  }

  async function postHeartbeat(endpoint) {
    const snapshot = collectSnapshot();
    const interruptionReason = detectInterruptionReason(snapshot);
    const payload = {
      sessionId: snapshot.sessionId,
      workspaceKind: snapshot.workspaceKind,
      pageUrl: snapshot.pageUrl,
      title: snapshot.title,
      sessionTitle: snapshot.sessionTitle,
      latestRequest: snapshot.latestRequest,
      latestResponse: snapshot.latestResponse,
      draftPrompt: snapshot.draftPrompt,
      running: snapshot.running,
      authRequired: snapshot.authRequired,
      sendEnabled: snapshot.sendEnabled,
      visible: snapshot.visible,
      focused: snapshot.focused,
      interruptionReason,
      activeAuthGenerationSeen: state.activeAuthGenerationSeen,
      userAgent: navigator.userAgent
    };
    const response = await request(endpoint, {
      method: 'POST',
      body: payload
    });
    state.activeAuthGenerationSeen = Math.max(state.activeAuthGenerationSeen, Number(response.activeAuthGeneration || 0));
    if (interruptionReason) {
      showBanner('检测到会话被额度/认证打断，正在尝试无感恢复…', 'warning');
    }
    return response;
  }

  function connectEventStream() {
    if (state.eventSource) state.eventSource.close();
    const source = new EventSource(API_BASE + '/events/stream?sessionId=' + encodeURIComponent(getSessionId()), { withCredentials: false });
    source.addEventListener('hello', (event) => {
      try {
        const data = JSON.parse(event.data || '{}');
        state.activeAuthGenerationSeen = Math.max(state.activeAuthGenerationSeen, Number(data.activeAuthGeneration || 0));
      } catch (_) {}
    });
    source.addEventListener('bridge_action', (event) => {
      try {
        const action = JSON.parse(event.data || '{}');
        void handleAction(action);
      } catch (error) {
        console.error('[CodexBridge] invalid action payload', error);
      }
    });
    source.onerror = () => {};
    state.eventSource = source;
  }

  function startHeartbeatLoop() {
    if (state.heartbeatTimer) window.clearInterval(state.heartbeatTimer);
    state.heartbeatTimer = window.setInterval(() => {
      postHeartbeat('/thread-health').catch((error) => {
        console.debug('[CodexBridge] heartbeat failed', error);
      });
    }, HEARTBEAT_INTERVAL_MS);
  }

  function kick() {
    postHeartbeat('/workspace-ready').catch((error) => {
      console.debug('[CodexBridge] workspace-ready failed', error);
    });
  }

  window.__codexBridge = {
    version: VERSION,
    collectSnapshot,
    getSessionId
  };

  connectEventStream();
  startHeartbeatLoop();
  window.addEventListener('load', kick, { once: true });
  window.addEventListener('focus', kick);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) kick();
  });
})();`;
}

module.exports = {
  buildCodeBridge
};
