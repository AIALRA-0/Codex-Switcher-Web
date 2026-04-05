'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const { chromium } = require('playwright-core');
const { config } = require('./config');
const { writeAudit } = require('./audit');
const { broadcast } = require('./sse');
const { listSlots } = require('./db');
const { serializeSlot, activateSlot } = require('./service');
const {
  createAutomationRun,
  createIssueBatch,
  createRunEvent,
  findOpenBatchForRepoConfig,
  getActiveAutomationRunForRepo,
  getAutomationRun,
  getIssueBatch,
  getIssueConfigSnapshot,
  getRepoSession,
  listActiveAutomationRuns,
  listIssueBatches,
  listRepoAutomationRuns,
  listRepoIssueBatches,
  listRepoSessions,
  listRunEvents,
  updateAutomationRun,
  updateIssueBatch,
  updateRepoSession,
  upsertIssueConfigSnapshot,
  upsertRepoSession
} = require('./automation-db');
const {
  RUN_STATES,
  buildBatchSummary,
  buildConfigFingerprint,
  buildRepoKey,
  clampBatchWindowMs,
  loadPromptTemplate,
  normalizeIssueConfig,
  nowIso,
  parseCodexControlCommand,
  parseIssueConfig,
  parseRepoKey,
  pickPreferredSlot,
  renderIssueBodyWithConfig,
  renderPrompt,
  sanitizeCommitSummary,
  shouldRolloverRepoSession,
  stableHash,
  summarizeIssueList
} = require('./automation-helpers');

function randomId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function sanitizeFsSegment(value) {
  return String(value || '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'repo';
}

function gitRead(repoPath, args) {
  const result = spawnSync('git', ['-C', repoPath, ...args], {
    encoding: 'utf8',
    timeout: 20_000
  });
  if (result.status !== 0) return null;
  return String(result.stdout || '').trim() || null;
}

function readGitState(repoPath) {
  return {
    head: gitRead(repoPath, ['rev-parse', 'HEAD']),
    upstream: gitRead(repoPath, ['rev-parse', '@{upstream}'])
  };
}

function parseWorkspaceLocation(rawUrl) {
  try {
    const url = new URL(String(rawUrl || ''));
    return {
      origin: url.origin,
      pathname: url.pathname,
      folder: decodeURIComponent(url.searchParams.get('folder') || url.searchParams.get('workspace') || '')
    };
  } catch (_) {
    return {
      origin: '',
      pathname: '',
      folder: ''
    };
  }
}

function isSameWorkspaceLocation(currentUrl, targetUrl) {
  const current = parseWorkspaceLocation(currentUrl);
  const target = parseWorkspaceLocation(targetUrl);
  if (!target.origin) return String(currentUrl || '') === String(targetUrl || '');
  if (current.origin !== target.origin || current.pathname !== target.pathname) return false;
  if (target.folder) return current.folder === target.folder;
  return true;
}

function normalizeVisibleText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

class ForgejoClient {
  constructor(baseUrl, token) {
    this.baseUrl = String(baseUrl || '').replace(/\/+$/, '');
    this.token = token || '';
  }

  async request(pathname, options = {}) {
    const url = pathname.startsWith('http') ? pathname : `${this.baseUrl}${pathname}`;
    const response = await fetch(url, {
      method: options.method || 'GET',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `token ${this.token}`,
        ...(options.headers || {})
      },
      body: options.body ? JSON.stringify(options.body) : undefined
    });

    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (_) {
      json = null;
    }

    if (!response.ok) {
      const message = json && json.message ? json.message : `FORGEJO_${response.status}`;
      throw new Error(message);
    }
    return json;
  }

  async listOpenIssues(owner, repo) {
    const json = await this.request(`/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?state=open`);
    return Array.isArray(json) ? json.filter((issue) => !issue.pull_request) : [];
  }

  async getIssue(owner, repo, issueNumber) {
    return this.request(`/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${encodeURIComponent(issueNumber)}`);
  }

  async updateIssue(owner, repo, issueNumber, patch) {
    return this.request(`/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${encodeURIComponent(issueNumber)}`, {
      method: 'PATCH',
      body: patch
    });
  }

  async createIssueComment(owner, repo, issueNumber, body) {
    return this.request(`/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${encodeURIComponent(issueNumber)}/comments`, {
      method: 'POST',
      body: { body }
    });
  }

  async listIssueComments(owner, repo, issueNumber, since) {
    const search = since ? `?since=${encodeURIComponent(since)}` : '';
    const json = await this.request(`/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${encodeURIComponent(issueNumber)}/comments${search}`);
    return Array.isArray(json) ? json : [];
  }
}

class CodeSessionManager {
  constructor(service) {
    this.service = service;
    this.sessions = new Map();
  }

  async stopAll() {
    const entries = [...this.sessions.values()];
    await Promise.all(entries.map(async (session) => {
      try {
        if (session.context) await session.context.close();
      } catch (_) {}
    }));
    this.sessions.clear();
  }

  async ensureSession(repoSession) {
    let cached = this.sessions.get(repoSession.repo_key);
    if (cached && cached.context) {
      try {
        const page = cached.page && !cached.page.isClosed()
          ? cached.page
          : (cached.context.pages()[0] || await cached.context.newPage());
        if (page && !page.isClosed()) {
          cached.page = page;
          return cached;
        }
      } catch (_) {
        try {
          await cached.context.close();
        } catch (_) {}
        this.sessions.delete(repoSession.repo_key);
      }
    }

    fs.mkdirSync(path.dirname(repoSession.browser_profile_dir), { recursive: true, mode: 0o755 });
    const browserEnvHome = path.join(config.dataDir, 'browser-home');
    const browserEnvCache = path.join(config.dataDir, 'browser-cache');
    fs.mkdirSync(browserEnvHome, { recursive: true, mode: 0o755 });
    fs.mkdirSync(browserEnvCache, { recursive: true, mode: 0o755 });
    const context = await chromium.launchPersistentContext(repoSession.browser_profile_dir, {
      executablePath: config.automationBrowserExecutablePath,
      headless: config.codeServerHeadless,
      chromiumSandbox: false,
      ignoreHTTPSErrors: true,
      viewport: { width: 1440, height: 960 },
      env: {
        ...process.env,
        HOME: browserEnvHome,
        XDG_CONFIG_HOME: browserEnvHome,
        XDG_CACHE_HOME: browserEnvCache
      },
      args: [
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--mute-audio',
        '--disable-crashpad',
        '--disable-crash-reporter',
        '--no-sandbox'
      ]
    });
    const page = context.pages()[0] || await context.newPage();
    cached = { context, page, repoKey: repoSession.repo_key };
    context.on('close', () => {
      const current = this.sessions.get(repoSession.repo_key);
      if (current && current.context === context) this.sessions.delete(repoSession.repo_key);
    });
    page.on('close', () => {
      const current = this.sessions.get(repoSession.repo_key);
      if (current && current.context === context) current.page = null;
    });
    page.on('crash', () => {
      const current = this.sessions.get(repoSession.repo_key);
      if (current && current.context === context) current.page = null;
    });
    this.sessions.set(repoSession.repo_key, cached);
    return cached;
  }

  async ensureWorkspace(repoSession) {
    const session = await this.ensureSession(repoSession);
    let { page } = session;
    if (!page || page.isClosed()) {
      page = session.context.pages()[0] || await session.context.newPage();
      session.page = page;
    }

    if (!page.url() || !isSameWorkspaceLocation(page.url(), repoSession.workspace_url)) {
      await page.goto(repoSession.workspace_url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    }

    if (await page.locator('input[type="password"]').count()) {
      if (!config.codeServerPassword) throw new Error('CODE_SERVER_PASSWORD_MISSING');
      await page.locator('input[type="password"]').fill(config.codeServerPassword);
      await page.getByRole('button').first().click();
      await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => {});
      await page.waitForTimeout(4000);
    }

    await this.ensureUiReady(page);
    const snapshot = await this.collectSnapshot(page);
    updateRepoSession(repoSession.repo_key, {
      last_seen_at: nowIso(),
      status: snapshot.running ? 'executing' : 'idle',
      thread_title: snapshot.sessionTitle || repoSession.thread_title || null,
      last_error: null
    });
    return { ...session, snapshot };
  }

  async getComposerState(page) {
    return page.evaluate(() => {
      const textbox = Array.from(document.querySelectorAll('[role="textbox"]'))
        .find((el) => /Chat Input/i.test(String(el.getAttribute('aria-label') || '')));
      const sendButton = Array.from(document.querySelectorAll('[role="button"]'))
        .find((el) => /发送|Send/i.test(String(el.getAttribute('aria-label') || '')));
      const bodyText = String(document.body.innerText || document.body.textContent || '');
      return {
        hasTextbox: !!textbox,
        hasSendButton: !!sendButton,
        sendEnabled: !!sendButton
          && !String(sendButton.className || '').includes('disabled')
          && String(sendButton.getAttribute('aria-disabled') || '').toLowerCase() !== 'true',
        authRequired: /Your Code:\s*[A-Z0-9-]{4,}/i.test(bodyText)
          || /device code/i.test(bodyText)
          || /Sign in to OpenAI/i.test(bodyText)
          || /登录.*OpenAI/i.test(bodyText)
          || /使用设备代码/i.test(bodyText),
        bodySnippet: bodyText.replace(/\s+/g, ' ').slice(0, 800)
      };
    });
  }

  async waitForSendEnabled(page, attempts = 20, delayMs = 250) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const state = await this.getComposerState(page);
      if (state.authRequired) throw new Error('CODEX_AUTH_REQUIRED');
      if (state.sendEnabled) return true;
      await page.waitForTimeout(delayMs);
    }
    return false;
  }

  async ensureUiReady(page) {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await page.evaluate(() => {
        const allButtons = Array.from(document.querySelectorAll('a, button, [role="button"]'));
        for (const button of allButtons) {
          const text = String(button.textContent || '').trim();
          const aria = String(button.getAttribute && (button.getAttribute('aria-label') || '') || '');
          if (/信任工作区并继续|Yes, I trust the authors|是，我信任此作者|Trust Workspace/i.test(text) || /Trust Workspace/i.test(aria)) {
            button.click();
          }
          if (/关闭横幅|Close Banner/i.test(aria)) button.click();
          if (/清除通知|Clear Notifications/i.test(aria)) button.click();
          if (/Manage Unsafe Repositories/i.test(text)) {
            const cancel = allButtons.find((candidate) => /取消|Cancel/i.test(String(candidate.textContent || '').trim()));
            if (cancel) cancel.click();
          }
        }

        const toggleChat = allButtons.find((button) => /Toggle Chat/i.test(String(button.getAttribute && button.getAttribute('aria-label') || '')));
        const hasTextbox = Array.from(document.querySelectorAll('[role="textbox"]'))
          .some((el) => /Chat Input/i.test(String(el.getAttribute('aria-label') || '')));
        if (!hasTextbox && toggleChat) toggleChat.click();
      });
      await page.waitForTimeout(800);
      const state = await this.getComposerState(page);
      if (state.authRequired) throw new Error('CODEX_AUTH_REQUIRED');
      if (state.hasTextbox && state.hasSendButton) return;
    }
    const finalState = await this.getComposerState(page).catch(() => null);
    if (finalState && finalState.authRequired) throw new Error('CODEX_AUTH_REQUIRED');
    if (finalState && finalState.hasTextbox && !finalState.hasSendButton) {
      throw new Error('CODEX_SEND_BUTTON_UNAVAILABLE');
    }
    throw new Error('CODEX_CHAT_INPUT_UNAVAILABLE');
  }

  async openNewSession(page) {
    await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('a, button, [role="button"]'));
      const button = buttons.find((candidate) => {
        const text = String(candidate.textContent || '').trim();
        const aria = String(candidate.getAttribute && (candidate.getAttribute('aria-label') || '') || '');
        return text === 'New Session' || /新建聊天|New Session/i.test(aria);
      });
      if (button) button.click();
    });
    await page.waitForTimeout(1200);
  }

  async applyModel(page, model) {
    if (!model || model === 'default') return { applied: 'default' };

    await page.evaluate(() => {
      const button = Array.from(document.querySelectorAll('[role="button"]'))
        .find((candidate) => /Pick Model/i.test(String(candidate.getAttribute('aria-label') || '')));
      if (button) button.click();
    });
    await page.waitForTimeout(600);

    const options = await page.evaluate(() => Array.from(document.querySelectorAll('[role="menuitemcheckbox"], [role="option"], .monaco-list-row'))
      .map((el) => ({
        text: String(el.textContent || '').trim(),
        aria: String(el.getAttribute('aria-label') || '').trim()
      }))
      .filter((item) => item.text || item.aria));

    const matched = options.find((item) => {
      const text = `${item.text} ${item.aria}`.toLowerCase();
      return text.includes(model.toLowerCase());
    });
    if (!matched) throw new Error(`MODEL_UNSUPPORTED:${model}`);

    await page.evaluate((target) => {
      const option = Array.from(document.querySelectorAll('[role="menuitemcheckbox"], [role="option"], .monaco-list-row'))
        .find((candidate) => {
          const text = `${candidate.textContent || ''} ${candidate.getAttribute('aria-label') || ''}`.toLowerCase();
          return text.includes(target.toLowerCase());
        });
      if (option) option.click();
    }, model);
    await page.waitForTimeout(400);
    return { applied: model };
  }

  async applyReasoning(_page, reasoningEffort) {
    if (!reasoningEffort || reasoningEffort === 'default') return { applied: 'default' };
    throw new Error(`REASONING_UNSUPPORTED:${reasoningEffort}`);
  }

  async focusInput(page) {
    await page.evaluate(() => {
      const textbox = Array.from(document.querySelectorAll('[role="textbox"]'))
        .find((el) => /Chat Input/i.test(String(el.getAttribute('aria-label') || '')));
      if (textbox) textbox.focus();
    });
    await page.waitForTimeout(150);
  }

  async clearInput(page) {
    await this.focusInput(page);
    await page.keyboard.press('Control+A').catch(() => {});
    await page.keyboard.press('Backspace').catch(() => {});
    await page.waitForTimeout(120);
  }

  async typePrompt(page, prompt) {
    await this.clearInput(page);
    await this.focusInput(page);
    await page.keyboard.insertText(prompt);
    if (await this.waitForSendEnabled(page, 20, 250)) return;

    await this.clearInput(page);
    const insertedViaDom = await page.evaluate((value) => {
      const textbox = Array.from(document.querySelectorAll('[role="textbox"]'))
        .find((el) => /Chat Input/i.test(String(el.getAttribute('aria-label') || '')));
      if (!textbox) return false;
      textbox.focus();
      if (typeof document.execCommand === 'function') {
        const inserted = document.execCommand('insertText', false, value);
        if (inserted) return true;
      }
      textbox.textContent = value;
      textbox.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        cancelable: true,
        data: value,
        inputType: 'insertFromPaste'
      }));
      textbox.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }, prompt).catch(() => false);
    if (insertedViaDom && await this.waitForSendEnabled(page, 12, 250)) return;

    await this.focusInput(page);
    await page.keyboard.type(' ', { delay: 2 });
    await page.keyboard.press('Backspace');
    if (await this.waitForSendEnabled(page, 10, 250)) return;

    throw new Error('PROMPT_INPUT_NOT_ACCEPTED');
  }

  async collectSnapshot(page) {
    return page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('[role="button"]'));
      const latestRequest = Array.from(document.querySelectorAll('.monaco-list-row.request'))
        .map((el) => String(el.textContent || '').trim())
        .filter(Boolean)
        .at(-1) || '';
      const latestResponse = Array.from(document.querySelectorAll('.interactive-item-container, .interactive-response, .chat-markdown-part'))
        .map((el) => String(el.textContent || '').trim())
        .filter(Boolean)
        .at(-1) || '';
      const sessionTitleButton = buttons.find((el) => /Pick Agent Session/i.test(String(el.getAttribute('aria-label') || '')));
      const stopButton = buttons.find((el) => /取消|Stop|Cancel/i.test(String(el.getAttribute('aria-label') || '')));
      const modelButton = buttons.find((el) => /Pick Model/i.test(String(el.getAttribute('aria-label') || '')));
      return {
        title: document.title,
        sessionTitle: sessionTitleButton ? String(sessionTitleButton.textContent || '').trim() : '',
        latestRequest,
        latestResponse,
        running: !!stopButton,
        modelLabel: modelButton ? String(modelButton.textContent || '').trim() : '',
        restrictedMode: document.body.textContent.includes('受限模式'),
        authRequired: /Your Code:\s*[A-Z0-9-]{4,}/i.test(String(document.body.innerText || document.body.textContent || ''))
          || /device code/i.test(String(document.body.innerText || document.body.textContent || '')),
        currentUrl: location.href
      };
    });
  }

  async waitForRunCompletion(page, repoKey, runId, promptText) {
    const startedAt = Date.now();
    let previousResponse = '';
    let stableTicks = 0;
    let lastSnapshot = await this.collectSnapshot(page);
    const normalizedPrompt = normalizeVisibleText(promptText);
    this.service.recordRunEvent(runId, repoKey, 'tool_started', {
      tool: 'codex_agent',
      sessionTitle: lastSnapshot.sessionTitle || null
    });

    while (Date.now() - startedAt < 45 * 60 * 1000) {
      await page.waitForTimeout(1200);
      await this.ensureUiReady(page).catch(() => {});
      const snapshot = await this.collectSnapshot(page);
      if (snapshot.latestResponse && snapshot.latestResponse !== previousResponse) {
        previousResponse = snapshot.latestResponse;
        stableTicks = 0;
        this.service.recordRunEvent(runId, repoKey, 'assistant_delta', {
          text: snapshot.latestResponse,
          sessionTitle: snapshot.sessionTitle || null
        });
      } else {
        stableTicks += 1;
      }

      lastSnapshot = snapshot;
      const normalizedLatestRequest = normalizeVisibleText(snapshot.latestRequest);
      const requestMatches = !!normalizedLatestRequest && (
        normalizedLatestRequest === normalizedPrompt
        || normalizedPrompt.includes(normalizedLatestRequest)
        || normalizedLatestRequest.includes(normalizedPrompt)
      );
      if (!snapshot.running && requestMatches && snapshot.latestResponse && stableTicks >= 2) {
        this.service.recordRunEvent(runId, repoKey, 'run_completed', {
          text: snapshot.latestResponse,
          sessionTitle: snapshot.sessionTitle || null
        });
        return snapshot;
      }
    }

    throw new Error('RUN_TIMEOUT');
  }

  async runPrompt(repoSession, runId, prompt, options = {}) {
    const { page } = await this.ensureWorkspace(repoSession);
    if (options.newThread) await this.openNewSession(page);
    await this.applyModel(page, options.model || 'default');
    await this.applyReasoning(page, options.reasoningEffort || 'default');
    await this.typePrompt(page, prompt);
    await page.keyboard.press('Enter');
    return this.waitForRunCompletion(page, repoSession.repo_key, runId, prompt);
  }
}

class AutomationService {
  constructor() {
    this.enabled = !!(config.automationEnabled && config.forgejoToken);
    this.forgejo = new ForgejoClient(config.forgejoBaseUrl, config.forgejoToken);
    this.sessionManager = new CodeSessionManager(this);
    this.pollTimer = null;
    this.repoRunLocks = new Set();
  }

  start() {
    if (!this.enabled) {
      writeAudit('automation.disabled', { enabled: config.automationEnabled, hasForgejoToken: !!config.forgejoToken });
      return;
    }
    fs.mkdirSync(config.automationSessionRoot, { recursive: true, mode: 0o755 });
    this.syncRepoCatalog();
    this.pollTimer = setInterval(() => {
      this.poll().catch((error) => {
        writeAudit('automation.poll_failed', { message: error.message });
      });
    }, Math.max(5_000, config.automationPollIntervalMs));
    this.pollTimer.unref();
    this.poll().catch((error) => {
      writeAudit('automation.poll_failed', { message: error.message });
    });
  }

  async stop() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    await this.sessionManager.stopAll();
  }

  recordRunEvent(runId, repoKey, eventType, payload = {}) {
    const persistedRun = runId ? getAutomationRun(runId) : null;
    const event = persistedRun
      ? createRunEvent({
        run_id: runId,
        repo_key: repoKey,
        event_type: eventType,
        payload
      })
      : {
        id: null,
        run_id: runId || null,
        repo_key: repoKey,
        event_type: eventType,
        payload,
        created_at: nowIso()
      };
    broadcast('admins', 'runtime_updated', { kind: 'automation', repoKey, runId, eventType });
    broadcast('automation_console', 'automation_event', event);
    return event;
  }

  requireForgejoProxy(req, res, next) {
    if (req.get('x-codex-forgejo-proxy-token') !== config.forgejoProxyToken) {
      return res.status(403).json({ ok: false, error: 'FORGEJO_PROXY_FORBIDDEN' });
    }
    return next();
  }

  requireBridgeProxy(req, res, next) {
    if (req.get('x-codex-bridge-proxy-token') !== config.bridgeProxyToken) {
      return res.status(403).json({ ok: false, error: 'BRIDGE_PROXY_FORBIDDEN' });
    }
    return next();
  }

  listManagedProjectEntries() {
    try {
      const raw = fs.readFileSync(config.managedProjectsStatePath, 'utf8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed.entries) ? parsed.entries : [];
    } catch (error) {
      writeAudit('automation.managed_projects_read_failed', { message: error.message });
      return [];
    }
  }

  syncRepoCatalog() {
    const entries = this.listManagedProjectEntries();
    for (const entry of entries) {
      if (!entry || !entry.forgejo_repo || !entry.path || !fs.existsSync(entry.path)) continue;
      const [owner, repo] = String(entry.forgejo_repo || '').split('/');
      if (!owner || !repo) continue;
      const repoKey = buildRepoKey(owner, repo);
      const localPath = entry.path;
      const browserProfileDir = path.join(
        config.automationSessionRoot,
        sanitizeFsSegment(owner),
        sanitizeFsSegment(repo)
      );
      const workspaceUrl = `${config.codeOrigin}/?folder=${encodeURIComponent(localPath)}`;
      upsertRepoSession({
        repo_key: repoKey,
        owner,
        repo_name: repo,
        local_path: localPath,
        workspace_url: workspaceUrl,
        browser_profile_dir: browserProfileDir,
        status: getRepoSession(repoKey)?.status || 'idle',
        paused: getRepoSession(repoKey)?.paused || false,
        prompt_version: config.automationPromptVersion
      });
    }
  }

  async poll() {
    if (!this.enabled) return;
    this.syncRepoCatalog();

    const repoSessions = listRepoSessions();
    for (const repoSession of repoSessions) {
      const activeRun = getActiveAutomationRunForRepo(repoSession.repo_key);
      if (repoSession.paused) continue;
      if (activeRun && ['planning', 'executing'].includes(activeRun.state)) continue;
      if (activeRun && activeRun.state === 'waiting_user') {
        await this.checkWaitingUserRun(repoSession, activeRun);
        continue;
      }
      await this.scanRepoIssues(repoSession);
    }

    await this.promoteReadyBatches();
    await this.launchQueuedRuns();
  }

  async scanRepoIssues(repoSession) {
    const issues = await this.forgejo.listOpenIssues(repoSession.owner, repoSession.repo_name);
    const activeBatches = listRepoIssueBatches(repoSession.repo_key, 100)
      .filter((batch) => ['batching', 'queued', 'planning', 'waiting_user', 'executing', 'blocked_quota'].includes(batch.state));

    for (const issue of issues) {
      const parsed = parseIssueConfig(issue.body || '');
      const configSnapshot = normalizeIssueConfig(parsed.config);
      upsertIssueConfigSnapshot({
        repo_key: repoSession.repo_key,
        issue_number: issue.number,
        issue_api_id: issue.id,
        title: issue.title || '',
        issue_updated_at: issue.updated_at || issue.updated_at_unix || null,
        body_hash: stableHash(issue.body || ''),
        config: configSnapshot,
        state: issue.state || 'open',
        last_polled_at: nowIso()
      });

      if (!configSnapshot.auto_run) continue;

      const alreadyTracked = activeBatches.some((batch) => (batch.issue_numbers || []).includes(issue.number));
      if (alreadyTracked) continue;
      await this.enqueueIssue(repoSession, issue, configSnapshot);
    }
  }

  async enqueueIssue(repoSession, issue, issueConfig) {
    const fingerprint = buildConfigFingerprint(issueConfig);
    const existing = findOpenBatchForRepoConfig(repoSession.repo_key, fingerprint);
    const windowMs = clampBatchWindowMs(
      config.automationBatchWindowMs,
      config.automationBatchWindowMinMs,
      config.automationBatchWindowMaxMs,
      90_000
    );

    if (existing) {
      if (!(existing.issue_numbers || []).includes(issue.number)) {
        updateIssueBatch(existing.id, {
          issue_numbers: [...existing.issue_numbers, issue.number],
          ready_at: new Date(Date.now() + windowMs).toISOString(),
          metadata: {
            ...existing.metadata,
            issues: {
              ...(existing.metadata.issues || {}),
              [issue.number]: {
                title: issue.title || '',
                updated_at: issue.updated_at || null
              }
            }
          }
        });
        this.recordRunEvent(existing.id, repoSession.repo_key, 'queue_updated', {
          batchId: existing.id,
          issueNumbers: [...existing.issue_numbers, issue.number]
        });
      }
      return getIssueBatch(existing.id);
    }

    const batch = createIssueBatch({
      id: randomId('batch'),
      repo_key: repoSession.repo_key,
      state: 'batching',
      config_fingerprint: fingerprint,
      plan_mode: !!issueConfig.plan_mode,
      model: issueConfig.model,
      reasoning_effort: issueConfig.reasoning_effort,
      issue_numbers: [issue.number],
      ready_at: new Date(Date.now() + windowMs).toISOString(),
      metadata: {
        issues: {
          [issue.number]: {
            title: issue.title || '',
            updated_at: issue.updated_at || null
          }
        }
      }
    });
    this.recordRunEvent(batch.id, repoSession.repo_key, 'queue_updated', {
      batchId: batch.id,
      issueNumbers: batch.issue_numbers
    });
    return batch;
  }

  async promoteReadyBatches() {
    const batching = listIssueBatches(['batching'], 500);
    const now = Date.now();
    for (const batch of batching) {
      const readyAtMs = Date.parse(batch.ready_at || 0);
      if (Number.isFinite(readyAtMs) && readyAtMs <= now) {
        updateIssueBatch(batch.id, { state: 'queued' });
      }
    }
  }

  async launchQueuedRuns() {
    const queued = listIssueBatches(['queued', 'blocked_quota'], 500);
    for (const batch of queued) {
      if (this.repoRunLocks.has(batch.repo_key)) continue;
      const repoSession = getRepoSession(batch.repo_key);
      if (!repoSession || repoSession.paused) continue;
      const activeRun = getActiveAutomationRunForRepo(batch.repo_key);
      if (activeRun && ['planning', 'executing', 'waiting_user'].includes(activeRun.state)) continue;
      void this.runBatch(batch.id);
    }
  }

  resolveRuntimeModel(batch) {
    if (!batch || !batch.model || batch.model === 'default') return 'default';
    return batch.model;
  }

  resolveRuntimeReasoning(batch) {
    return batch && batch.reasoning_effort ? batch.reasoning_effort : 'default';
  }

  async selectSlotForRun() {
    const activeRuns = listActiveAutomationRuns().filter((run) => ['planning', 'executing'].includes(run.state));
    const slots = listSlots().map(serializeSlot);
    const activeSlot = slots.find((slot) => slot.is_active);
    if (activeRuns.length > 0) {
      return activeSlot || pickPreferredSlot(slots);
    }

    const preferred = pickPreferredSlot(slots);
    if (!preferred) return null;
    if (!preferred.is_active) {
      await activateSlot(preferred.id, 'automation_batch').catch((error) => {
        throw new Error(`ACCOUNT_SWITCH_FAILED:${error.message}`);
      });
    }
    return pickPreferredSlot(listSlots().map(serializeSlot)) || preferred;
  }

  async ensureRepoPrimer(repoSession) {
    if (Number(repoSession.batch_count || 0) > 0 && repoSession.thread_title) return;
    const primerPrompt = renderPrompt(loadPromptTemplate('repo-primer'), {
      repo_key: repoSession.repo_key,
      local_path: repoSession.local_path,
      workspace_url: repoSession.workspace_url
    });
    const runId = randomId('primer');
    const snapshot = await this.sessionManager.runPrompt(repoSession, runId, primerPrompt, {
      model: 'default',
      reasoningEffort: 'default'
    });
    updateRepoSession(repoSession.repo_key, {
      thread_title: snapshot.sessionTitle || repoSession.thread_title || 'Primer Session',
      last_seen_at: nowIso(),
      status: 'idle'
    });
  }

  async maybeRolloverRepoSession(repoSession) {
    const decision = shouldRolloverRepoSession(repoSession, config.automationPromptVersion);
    if (!decision.rollover) return getRepoSession(repoSession.repo_key);

    const handoffPrompt = renderPrompt(loadPromptTemplate('rollover-handoff'), {
      repo_key: repoSession.repo_key
    });
    const runId = randomId('handoff');
    const snapshot = await this.sessionManager.runPrompt(repoSession, runId, handoffPrompt, {
      model: 'default',
      reasoningEffort: 'default',
      newThread: false
    });
    const next = updateRepoSession(repoSession.repo_key, {
      handoff_summary: snapshot.latestResponse || '',
      thread_started_at: nowIso(),
      thread_title: snapshot.sessionTitle || repoSession.thread_title || null,
      prompt_version: config.automationPromptVersion,
      consecutive_failures: 0
    });
    await this.sessionManager.openNewSession((await this.sessionManager.ensureWorkspace(next)).page);
    return next;
  }

  async buildBatchIssueDetails(batch) {
    const repoSession = getRepoSession(batch.repo_key);
    const issues = [];
    for (const issueNumber of batch.issue_numbers || []) {
      const issue = await this.forgejo.getIssue(repoSession.owner, repoSession.repo_name, issueNumber);
      issues.push(issue);
    }
    return issues;
  }

  parseSummaryFromAssistant(text) {
    const raw = String(text || '').trim();
    const lines = raw.split(/\r?\n/);
    const summary = lines.find((line) => /^SUMMARY:/i.test(line)) || raw.slice(0, 400);
    const result = lines.find((line) => /^RESULT:/i.test(line)) || '';
    const validation = lines.find((line) => /^VALIDATION:/i.test(line)) || '';
    const commit = lines.find((line) => /^COMMIT:/i.test(line)) || '';
    return {
      summary: summary.replace(/^SUMMARY:\s*/i, '').trim() || raw.slice(0, 400),
      result: result.replace(/^RESULT:\s*/i, '').trim().toLowerCase(),
      validation: validation.replace(/^VALIDATION:\s*/i, '').trim(),
      commit: commit.replace(/^COMMIT:\s*/i, '').trim()
    };
  }

  async postPlanWaitingComment(repoSession, issues, snapshot) {
    const summary = this.parseSummaryFromAssistant(snapshot.latestResponse || '');
    const body = [
      `Codex 已完成计划阶段，正在等待人工确认。`,
      '',
      summary.summary || '已生成计划。',
      '',
      '可在任一相关 issue 评论：',
      '- `/codex approve`',
      '- `/codex revise <text>`',
      '- `/codex cancel`'
    ].join('\n');
    await Promise.all(issues.map((issue) => this.forgejo.createIssueComment(repoSession.owner, repoSession.repo_name, issue.number, body)));
  }

  async postSuccessComments(repoSession, issues, gitStateAfter, snapshot) {
    const summary = this.parseSummaryFromAssistant(snapshot.latestResponse || '');
    const commit = gitStateAfter.head || summary.commit || 'unknown';
    const body = [
      `Codex automation 已完成修复并推送。`,
      '',
      `Commit: \`${commit}\``,
      summary.summary ? `Summary: ${summary.summary}` : '',
      summary.validation ? `Validation: ${summary.validation}` : ''
    ].filter(Boolean).join('\n');

    await Promise.all(issues.map(async (issue) => {
      await this.forgejo.createIssueComment(repoSession.owner, repoSession.repo_name, issue.number, body);
      await this.forgejo.updateIssue(repoSession.owner, repoSession.repo_name, issue.number, { state: 'closed' });
    }));
  }

  async postFailureComments(repoSession, issues, errorText, snapshot) {
    const summary = snapshot ? this.parseSummaryFromAssistant(snapshot.latestResponse || snapshot.latest_assistant_text || '') : { summary: '' };
    const body = [
      'Codex automation 未能完成此次修复，问题保持打开。',
      '',
      errorText ? `Error: ${errorText}` : '',
      summary.summary ? `Latest summary: ${summary.summary}` : ''
    ].filter(Boolean).join('\n');
    await Promise.all(issues.map((issue) => this.forgejo.createIssueComment(repoSession.owner, repoSession.repo_name, issue.number, body)));
  }

  async runBatch(batchId) {
    const batch = getIssueBatch(batchId);
    if (!batch) return;
    if (this.repoRunLocks.has(batch.repo_key)) return;

    this.repoRunLocks.add(batch.repo_key);
    let run = null;
    let repoSession = getRepoSession(batch.repo_key);

    try {
      if (!repoSession || repoSession.paused) return;
      repoSession = await this.maybeRolloverRepoSession(repoSession);
      await this.ensureRepoPrimer(repoSession);

      const issues = await this.buildBatchIssueDetails(batch);
      const slot = await this.selectSlotForRun();
      if (!slot) {
        updateIssueBatch(batch.id, {
          state: 'blocked_quota',
          error_text: 'NO_SLOT_AVAILABLE'
        });
        run = createAutomationRun({
          id: randomId('run'),
          batch_id: batch.id,
          repo_key: batch.repo_key,
          state: 'blocked_quota',
          phase: 'execute',
          slot_id: null,
          model: this.resolveRuntimeModel(batch),
          reasoning_effort: this.resolveRuntimeReasoning(batch),
          plan_mode: batch.plan_mode,
          started_at: nowIso()
        });
        this.recordRunEvent(run.id, batch.repo_key, 'account_switch_blocked', {
          reason: 'NO_SLOT_AVAILABLE'
        });
        return;
      }

      const approvedAt = batch.metadata && batch.metadata.approved_at;
      const phase = batch.plan_mode && !approvedAt ? 'plan' : 'execute';
      const promptText = renderPrompt(loadPromptTemplate(phase === 'plan' ? 'plan-mode' : 'batch-execution'), {
        repo_key: batch.repo_key,
        issue_list: summarizeIssueList(issues),
        issue_ids: issues.map((issue) => `#${issue.number}`).join(', '),
        batch_summary: sanitizeCommitSummary(buildBatchSummary(issues)),
        revision_note: (batch.metadata && batch.metadata.revision_note) || 'None'
      });

      const gitStateBefore = readGitState(repoSession.local_path);
      run = createAutomationRun({
        id: randomId('run'),
        batch_id: batch.id,
        repo_key: batch.repo_key,
        state: phase === 'plan' ? 'planning' : 'executing',
        phase,
        slot_id: slot.id,
        model: this.resolveRuntimeModel(batch),
        reasoning_effort: this.resolveRuntimeReasoning(batch),
        plan_mode: batch.plan_mode,
        prompt_text: promptText,
        commit_before: gitStateBefore.head,
        started_at: nowIso()
      });
      updateIssueBatch(batch.id, {
        state: phase === 'plan' ? 'planning' : 'executing',
        started_at: nowIso(),
        error_text: null
      });
      updateRepoSession(repoSession.repo_key, {
        status: phase === 'plan' ? 'planning' : 'executing'
      });

      const snapshot = await this.sessionManager.runPrompt(repoSession, run.id, promptText, {
        model: this.resolveRuntimeModel(batch),
        reasoningEffort: this.resolveRuntimeReasoning(batch)
      });

      const gitStateAfter = readGitState(repoSession.local_path);
      updateAutomationRun(run.id, {
        state: phase === 'plan' ? 'waiting_user' : 'succeeded',
        latest_assistant_text: snapshot.latestResponse || '',
        commit_after: gitStateAfter.head || null,
        completed_at: phase === 'plan' ? null : nowIso()
      });

      if (phase === 'plan') {
        updateIssueBatch(batch.id, {
          state: 'waiting_user',
          error_text: null,
          metadata: {
            ...batch.metadata,
            plan_generated_at: nowIso()
          }
        });
        await this.postPlanWaitingComment(repoSession, issues, snapshot);
      } else {
        const pushed = !!(gitStateAfter.head && gitStateAfter.upstream && gitStateAfter.head === gitStateAfter.upstream);
        if (gitStateBefore.head && gitStateAfter.head && gitStateBefore.head !== gitStateAfter.head && pushed) {
          updateIssueBatch(batch.id, {
            state: 'succeeded',
            completed_at: nowIso(),
            error_text: null
          });
          updateRepoSession(repoSession.repo_key, {
            status: 'idle',
            batch_count: Number(repoSession.batch_count || 0) + 1,
            consecutive_failures: 0,
            thread_title: snapshot.sessionTitle || repoSession.thread_title || null,
            last_seen_at: nowIso(),
            last_error: null
          });
          await this.postSuccessComments(repoSession, issues, gitStateAfter, snapshot);
        } else {
          updateIssueBatch(batch.id, {
            state: 'failed',
            completed_at: nowIso(),
            error_text: pushed ? 'NO_COMMIT_CREATED' : 'COMMIT_NOT_PUSHED'
          });
          updateAutomationRun(run.id, {
            state: 'failed',
            completed_at: nowIso(),
            last_error: pushed ? 'NO_COMMIT_CREATED' : 'COMMIT_NOT_PUSHED'
          });
          updateRepoSession(repoSession.repo_key, {
            status: 'idle',
            consecutive_failures: Number(repoSession.consecutive_failures || 0) + 1,
            last_error: pushed ? 'NO_COMMIT_CREATED' : 'COMMIT_NOT_PUSHED'
          });
          await this.postFailureComments(repoSession, issues, pushed ? 'NO_COMMIT_CREATED' : 'COMMIT_NOT_PUSHED', snapshot);
        }
      }
    } catch (error) {
      if (run) {
        updateAutomationRun(run.id, {
          state: error.message.startsWith('MODEL_UNSUPPORTED:') || error.message.startsWith('REASONING_UNSUPPORTED:')
            ? 'failed'
            : 'failed',
          completed_at: nowIso(),
          last_error: error.message
        });
      }
      updateIssueBatch(batch.id, {
        state: error.message === 'NO_SLOT_AVAILABLE' ? 'blocked_quota' : 'failed',
        completed_at: nowIso(),
        error_text: error.message
      });
      updateRepoSession(batch.repo_key, {
        status: 'idle',
        consecutive_failures: Number((getRepoSession(batch.repo_key) || {}).consecutive_failures || 0) + 1,
        last_error: error.message
      });

      try {
        const failedRepo = getRepoSession(batch.repo_key);
        if (failedRepo) {
          const issues = await this.buildBatchIssueDetails(batch);
          await this.postFailureComments(failedRepo, issues, error.message, run ? getAutomationRun(run.id) : null);
        }
      } catch (_) {}
      if (run) this.recordRunEvent(run.id, batch.repo_key, 'run_failed', { error: error.message });
    } finally {
      this.repoRunLocks.delete(batch.repo_key);
    }
  }

  async checkWaitingUserRun(repoSession, run) {
    const batch = getIssueBatch(run.batch_id);
    if (!batch) return;
    const since = run.started_at || nowIso();
    const commands = [];

    for (const issueNumber of batch.issue_numbers || []) {
      const comments = await this.forgejo.listIssueComments(repoSession.owner, repoSession.repo_name, issueNumber, since);
      for (const comment of comments) {
        const parsed = parseCodexControlCommand(comment.body || '');
        if (!parsed) continue;
        commands.push({
          ...parsed,
          created_at: comment.created_at || comment.updated_at || nowIso(),
          issue_number: issueNumber
        });
      }
    }

    commands.sort((a, b) => Date.parse(b.created_at || 0) - Date.parse(a.created_at || 0));
    const latest = commands[0];
    if (!latest) return;

    this.recordRunEvent(run.id, repoSession.repo_key, 'approval_resolved', latest);

    if (latest.kind === 'cancel') {
      updateAutomationRun(run.id, {
        state: 'failed',
        completed_at: nowIso(),
        last_error: 'USER_CANCELLED'
      });
      updateIssueBatch(batch.id, {
        state: 'failed',
        completed_at: nowIso(),
        error_text: 'USER_CANCELLED'
      });
      const issues = await this.buildBatchIssueDetails(batch);
      await this.postFailureComments(repoSession, issues, 'USER_CANCELLED', null);
      return;
    }

    updateAutomationRun(run.id, {
      state: 'succeeded',
      completed_at: nowIso()
    });
    updateIssueBatch(batch.id, {
      state: 'queued',
      metadata: {
        ...batch.metadata,
        approved_at: nowIso(),
        revision_note: latest.kind === 'revise' ? latest.note : (batch.metadata.revision_note || '')
      }
    });
  }

  getDashboardSnapshot() {
    const repos = listRepoSessions().map((repoSession) => {
      const batches = listRepoIssueBatches(repoSession.repo_key, 50);
      const activeRun = getActiveAutomationRunForRepo(repoSession.repo_key);
      return {
        ...repoSession,
        batches,
        activeRun
      };
    });
    return {
      ok: true,
      now: nowIso(),
      repos
    };
  }

  getRunDetails(runId) {
    const run = getAutomationRun(runId);
    if (!run) return null;
    return {
      run,
      events: listRunEvents(runId, 1000)
    };
  }

  async readIssueConfig(owner, repo, issueNumber) {
    const repoKey = buildRepoKey(owner, repo);
    const snapshot = getIssueConfigSnapshot(repoKey, issueNumber);
    if (snapshot) {
      return {
        issue_number: issueNumber,
        repo_key: repoKey,
        config: normalizeIssueConfig(snapshot.config),
        title: snapshot.title || ''
      };
    }

    const issue = await this.forgejo.getIssue(owner, repo, issueNumber);
    const parsed = parseIssueConfig(issue.body || '');
    const normalized = normalizeIssueConfig(parsed.config);
    upsertIssueConfigSnapshot({
      repo_key: repoKey,
      issue_number: issueNumber,
      issue_api_id: issue.id,
      title: issue.title || '',
      issue_updated_at: issue.updated_at || null,
      body_hash: stableHash(issue.body || ''),
      config: normalized,
      state: issue.state || 'open',
      last_polled_at: nowIso()
    });
    return {
      issue_number: issueNumber,
      repo_key: repoKey,
      config: normalized,
      title: issue.title || ''
    };
  }

  async updateIssueConfig(owner, repo, issueNumber, configPatch) {
    const issue = await this.forgejo.getIssue(owner, repo, issueNumber);
    const parsed = parseIssueConfig(issue.body || '');
    const nextConfig = normalizeIssueConfig({
      ...parsed.config,
      ...configPatch
    }, { fillUpdatedAt: true });
    const nextBody = renderIssueBodyWithConfig(issue.body || '', nextConfig);
    const updated = await this.forgejo.updateIssue(owner, repo, issueNumber, { body: nextBody });
    const repoKey = buildRepoKey(owner, repo);
    upsertIssueConfigSnapshot({
      repo_key: repoKey,
      issue_number: issueNumber,
      issue_api_id: updated.id,
      title: updated.title || '',
      issue_updated_at: updated.updated_at || null,
      body_hash: stableHash(updated.body || ''),
      config: nextConfig,
      state: updated.state || 'open',
      last_polled_at: nowIso()
    });
    return {
      issue_number: issueNumber,
      repo_key: repoKey,
      config: nextConfig,
      title: updated.title || ''
    };
  }

  async postIssueCommand(owner, repo, issueNumber, commandText) {
    await this.forgejo.createIssueComment(owner, repo, issueNumber, commandText);
    return { ok: true };
  }

  retryBatch(batchId) {
    const batch = getIssueBatch(batchId);
    if (!batch) return null;
    return updateIssueBatch(batchId, {
      state: 'queued',
      completed_at: null,
      error_text: null
    });
  }

  toggleRepoPause(repoKey, paused) {
    return updateRepoSession(repoKey, {
      paused: !!paused,
      status: paused ? 'idle' : getRepoSession(repoKey)?.status || 'idle'
    });
  }

  recordBridgeHeartbeat(payload = {}) {
    const pageUrl = String(payload.pageUrl || '');
    let defaultInteractivePath = '';
    try {
      defaultInteractivePath = decodeURIComponent(new URL(config.codeWorkspaceUrl).searchParams.get('workspace') || '');
    } catch (_) {}
    const match = pageUrl.match(/[?&](folder|workspace)=([^&]+)/);
    if (!match) {
      return payload.workspaceKind === 'interactive_default'
        ? {
            workspace_kind: 'interactive_default',
            status: payload.running ? 'executing' : 'idle',
            last_seen_at: nowIso(),
            thread_title: payload.sessionTitle || null
          }
        : null;
    }
    const resolvedPath = decodeURIComponent(match[2] || '');
    if (defaultInteractivePath && resolvedPath === defaultInteractivePath) {
      return {
        workspace_kind: 'interactive_default',
        local_path: resolvedPath,
        status: payload.running ? 'executing' : 'idle',
        last_seen_at: nowIso(),
        thread_title: payload.sessionTitle || null
      };
    }
    const repoSession = listRepoSessions().find((entry) => entry.local_path === resolvedPath);
    if (!repoSession) return null;
    return updateRepoSession(repoSession.repo_key, {
      last_seen_at: nowIso(),
      status: payload.running ? 'executing' : getRepoSession(repoSession.repo_key)?.status || 'idle',
      thread_title: payload.sessionTitle || repoSession.thread_title || null
    });
  }
}

let automationService = null;

function getAutomationService() {
  if (!automationService) automationService = new AutomationService();
  return automationService;
}

module.exports = {
  RUN_STATES,
  getAutomationService
};
