'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { buildCodeBridge } = require('../server/code-bridge-template');

function waitFor(check, timeoutMs = 4000, intervalMs = 40) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      try {
        const result = check();
        if (result) return resolve(result);
      } catch (error) {
        return reject(error);
      }
      if (Date.now() - started >= timeoutMs) {
        return reject(new Error('Timed out waiting for condition'));
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

function createBridgeHarness(options = {}) {
  const dom = new JSDOM(`<!doctype html><html><body><div id="app"></div></body></html>`, {
    url: 'https://code.example.com/?workspace=/workspace/default.code-workspace',
    pretendToBeVisual: true,
    runScripts: 'dangerously'
  });
  const { window } = dom;
  const { document } = window;
  const fetchCalls = [];
  const acks = [];
  const eventSources = [];
  const clicks = {
    openChat: 0,
    refreshSession: 0,
    newSession: 0,
    send: 0
  };
  const requests = [];

  class FakeEventSource {
    constructor(url) {
      this.url = url;
      this.listeners = new Map();
      eventSources.push(this);
    }

    addEventListener(type, handler) {
      const handlers = this.listeners.get(type) || [];
      handlers.push(handler);
      this.listeners.set(type, handlers);
    }

    emit(type, payload) {
      const handlers = this.listeners.get(type) || [];
      for (const handler of handlers) {
        handler({ data: JSON.stringify(payload) });
      }
    }

    close() {}
  }

  const renderChatUi = () => {
    const existing = document.querySelector('#chat-surface');
    if (existing) return existing;

    const surface = document.createElement('div');
    surface.id = 'chat-surface';

    const refreshButton = document.createElement('button');
    refreshButton.setAttribute('aria-label', '刷新智能体会话');
    refreshButton.textContent = '刷新智能体会话';
    refreshButton.addEventListener('click', () => {
      clicks.refreshSession += 1;
      document.body.dataset.authRequired = 'false';
    });

    const newSessionButton = document.createElement('button');
    newSessionButton.textContent = 'New Session';
    newSessionButton.setAttribute('aria-label', 'New Session');
    newSessionButton.setAttribute('title', 'New Session');
    newSessionButton.setAttribute('data-command', 'chat.openNewSession');
    newSessionButton.className = 'action-item codicon-plus';
    newSessionButton.addEventListener('click', () => {
      clicks.newSession += 1;
      nativeTextbox.textContent = '';
      imeTextarea.value = '';
      sendButton.className = 'action-label disabled codicon codicon-send';
      sendButton.setAttribute('aria-disabled', 'true');
    });

    const nativeTextbox = document.createElement('div');
    nativeTextbox.className = 'native-edit-context';
    nativeTextbox.setAttribute('role', 'textbox');
    nativeTextbox.setAttribute('aria-label', 'Chat Input (Agent), edit files in your workspace. Press Enter to send out the request.');

    const imeTextarea = document.createElement('textarea');
    imeTextarea.className = 'ime-text-area';
    imeTextarea.setAttribute('readonly', 'true');
    imeTextarea.addEventListener('input', () => {
      nativeTextbox.textContent = imeTextarea.value;
      if (imeTextarea.value.trim()) {
        sendButton.className = 'action-label codicon codicon-send';
        sendButton.setAttribute('aria-disabled', 'false');
      } else {
        sendButton.className = 'action-label disabled codicon codicon-send';
        sendButton.setAttribute('aria-disabled', 'true');
      }
    });

    const sendButton = document.createElement('a');
    sendButton.className = 'action-label disabled codicon codicon-send';
    sendButton.setAttribute('aria-label', '发送 [Alt] 发送到新聊天 (Ctrl+Shift+Enter)');
    sendButton.setAttribute('aria-disabled', 'true');
    sendButton.addEventListener('click', () => {
      clicks.send += 1;
      if (sendButton.getAttribute('aria-disabled') === 'true') return;
      const row = document.createElement('div');
      row.className = 'monaco-list-row request';
      row.textContent = nativeTextbox.textContent;
      document.body.appendChild(row);
      requests.push(nativeTextbox.textContent);
    });

    surface.appendChild(refreshButton);
    surface.appendChild(newSessionButton);
    surface.appendChild(nativeTextbox);
    surface.appendChild(imeTextarea);
    surface.appendChild(sendButton);
    document.body.appendChild(surface);
    return surface;
  };

  const openChatButton = document.createElement('button');
  openChatButton.textContent = '打开聊天';
  openChatButton.addEventListener('click', () => {
    clicks.openChat += 1;
    renderChatUi();
  });
  document.body.appendChild(openChatButton);

  const toggleChatButton = document.createElement('button');
  toggleChatButton.setAttribute('aria-label', '聊天 (Ctrl+Alt+I)');
  toggleChatButton.textContent = '聊天';
  toggleChatButton.addEventListener('click', () => {
    clicks.openChat += 1;
    renderChatUi();
  });
  document.body.appendChild(toggleChatButton);

  if (options.chatOpen) {
    renderChatUi();
  }

  window.EventSource = FakeEventSource;
  window.InputEvent = window.InputEvent || window.Event;
  window.fetch = async (url, init = {}) => {
    fetchCalls.push({ url, init });
    if (String(url).includes('/actions/') && String(url).includes('/ack')) {
      const body = init.body ? JSON.parse(init.body) : {};
      acks.push(body);
      return {
        ok: true,
        json: async () => ({ ok: true, action: body })
      };
    }
    return {
      ok: true,
      json: async () => ({
        ok: true,
        activeAuthGeneration: 2,
        interactiveRecovery: {},
        session: { id: 'bridge_test_session' }
      })
    };
  };

  const script = buildCodeBridge();
  window.eval(script);
  window.dispatchEvent(new window.Event('load'));

  return {
    window,
    document,
    acks,
    clicks,
    requests,
    eventSources,
    fetchCalls,
    cleanup() {
      for (const source of eventSources) {
        if (source && typeof source.close === 'function') source.close();
      }
      window.close();
    }
  };
}

test('bridge recover_same_thread opens localized chat entrypoint and completes without manual reload', async (t) => {
  const harness = createBridgeHarness({ chatOpen: false });
  t.after(() => harness.cleanup());
  const source = harness.eventSources[0];
  assert.ok(source, 'expected EventSource to be created');

  source.emit('bridge_action', {
    id: 'action_recover_same_thread',
    action_type: 'recover_same_thread',
    payload: {
      activeAuthGeneration: 2
    }
  });

  await waitFor(() => harness.acks.length >= 1);
  assert.ok(harness.clicks.openChat >= 1);
  assert.deepEqual(harness.acks[0], {
    status: 'completed',
    result: {
      canResume: true,
      recoveredSameThread: true,
      activeAuthGenerationSeen: 2
    }
  });
});

test('bridge open_new_thread_and_resume uses new session plus ime textarea path and submits prompt', async (t) => {
  const harness = createBridgeHarness({ chatOpen: true });
  t.after(() => harness.cleanup());
  const source = harness.eventSources[0];
  assert.ok(source, 'expected EventSource to be created');

  source.emit('bridge_action', {
    id: 'action_open_new_thread',
    action_type: 'open_new_thread_and_resume',
    payload: {
      prompt: '请继续执行 bridge-e2e-resume',
      activeAuthGeneration: 2
    }
  });

  await waitFor(() => harness.acks.length >= 1);
  assert.ok(harness.clicks.newSession >= 1);
  assert.ok(harness.clicks.send >= 1);
  assert.equal(harness.requests.length, 1);
  assert.equal(harness.requests[0], '请继续执行 bridge-e2e-resume');
  assert.deepEqual(harness.acks[0], {
    status: 'completed',
    result: {
      sent: true,
      newThread: true,
      activeAuthGenerationSeen: 2
    }
  });
});
