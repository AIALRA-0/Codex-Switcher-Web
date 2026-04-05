'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { buildAuthWorkspaceNoVncPath, buildManagedAuthUrl } = require('./auth-workspace-shared');

const execFileAsync = promisify(execFile);
const VIOLENTMONKEY_ID = '{aecec67f-0d10-4fa7-b7c7-609a2db280cf}';
const VIOLENTMONKEY_URL = 'https://addons.mozilla.org/firefox/downloads/latest/violentmonkey/addon-violentmonkey-latest.xpi';
const AUTH_FIELD_X_RATIO = 0.5;
const AUTH_EMAIL_Y_RATIO = 0.286;
const AUTH_CODE_X_RATIO = 0.43;
const AUTH_CODE_Y_RATIO = 0.405;
const AUTH_CODE_CONTINUE_X_RATIO = 0.58;
const AUTH_CODE_CONTINUE_Y_RATIO = 0.77;
const AUTH_PAGE_Y_RATIO = 0.42;
const AUTH_GOOGLE_Y_RATIO = 0.56;

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isIgnorableFirefoxTitle(title) {
  return /^(Mozilla Firefox|Firefox|Firefox View — Mozilla Firefox)$/i.test(String(title || '').trim());
}

function sanitizeSlotId(slotId) {
  return String(slotId || 'workspace').replace(/[^a-zA-Z0-9_.-]+/g, '-');
}

function parseBytes(value) {
  if (!value) return 0;
  const text = String(value).trim();
  if (/^\d+$/.test(text)) return Number(text);
  const match = text.match(/^(\d+(?:\.\d+)?)([kKmMgG])$/);
  if (!match) return 0;
  const number = Number(match[1]);
  const unit = match[2].toLowerCase();
  const factor = unit === 'k' ? 1024 : unit === 'm' ? 1024 ** 2 : 1024 ** 3;
  return Math.round(number * factor);
}

function readAvailableMemoryBytes() {
  try {
    const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
    const match = meminfo.match(/^MemAvailable:\s+(\d+)\s+kB$/m);
    if (match) return Number(match[1]) * 1024;
  } catch (_) {
    // ignore and fall back
  }

  try {
    const statm = fs.readFileSync('/proc/self/statm', 'utf8').trim().split(/\s+/);
    const pages = Number(statm[1] || 0);
    return pages * 4096;
  } catch (_) {
    return 0;
  }
}

function buildNoVncPath(accessToken) {
  return buildAuthWorkspaceNoVncPath(accessToken);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
}

function shellQuote(value) {
  return `'${String(value == null ? '' : value).replace(/'/g, `'\"'\"'`)}'`;
}

async function downloadFile(url, targetPath) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`DOWNLOAD_FAILED:${response.status}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  fs.writeFileSync(targetPath, Buffer.from(arrayBuffer));
}

function createAuthWorkspaceManager(options = {}) {
  const dockerBinary = options.dockerBinary || '/usr/bin/docker';
  const image = options.image || 'jlesage/firefox:latest';
  const webHostPort = Number(options.noVncHostPort || 29110);
  const memoryFloorBytes = Number(options.memoryFloorBytes || (1536 * 1024 * 1024));
  const workspaceIdleTtlMs = Number(options.workspaceIdleTtlMs || (20 * 60 * 1000));
  const webReadyTimeoutMs = Number(options.webReadyTimeoutMs || (90 * 1000));
  const browserPrefix = options.containerPrefix || 'codex-auth';
  const workspaceRoot = options.workspaceRoot || '/var/lib/codex-switcher/auth-workspaces';
  const assetRoot = options.assetRoot || '/var/lib/codex-switcher/auth-workspace-assets';
  const displayWidth = Number(options.displayWidth || 1440);
  const displayHeight = Number(options.displayHeight || 900);
  const firefoxZoom = String(options.firefoxZoom || '1.18').trim() || '1.18';
  const userscriptHostUrl = String(options.userscriptHostUrl || '').trim();
  const getBootstrapSession = typeof options.getBootstrapSession === 'function'
    ? options.getBootstrapSession
    : () => null;

  let activeWorkspace = null;

  async function runDocker(args) {
    const { stdout, stderr } = await execFileAsync(dockerBinary, args, {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024
    });
    return {
      stdout: String(stdout || '').trim(),
      stderr: String(stderr || '').trim()
    };
  }

  async function safeDocker(args) {
    try {
      return await runDocker(args);
    } catch (error) {
      return {
        stdout: '',
        stderr: error.stderr || error.message || 'docker command failed'
      };
    }
  }

  async function isWorkspaceContainerRunning(workspace) {
    if (!workspace || !workspace.containerName) return false;
    const { stdout } = await safeDocker([
      'inspect',
      '-f',
      '{{.State.Running}}',
      workspace.containerName
    ]);
    return String(stdout || '').trim() === 'true';
  }

  function workspaceConfigDir(slotId) {
    return path.join(workspaceRoot, sanitizeSlotId(slotId));
  }

  function assetPath(name) {
    return path.join(assetRoot, name);
  }

  function resetWorkspaceDir(dirPath) {
    fs.rmSync(dirPath, { recursive: true, force: true });
    ensureDir(dirPath);
  }

  async function ensureUserscriptAssets() {
    ensureDir(assetRoot);
    const xpiPath = assetPath('violentmonkey.xpi');
    const policiesPath = assetPath('policies.json');

    if (!fs.existsSync(xpiPath) || fs.statSync(xpiPath).size < 1024) {
      await downloadFile(VIOLENTMONKEY_URL, xpiPath);
    }

    const policiesJson = JSON.stringify({
      policies: {
        ExtensionSettings: {
          '*': { installation_mode: 'allowed' },
          [VIOLENTMONKEY_ID]: {
            installation_mode: 'force_installed',
            install_url: 'file:///opt/codex-switcher-assets/violentmonkey.xpi'
          }
        },
        Preferences: {
          'extensions.autoDisableScopes': { Value: 0, Status: 'locked' }
        }
      }
    }, null, 2);

    if (!fs.existsSync(policiesPath) || fs.readFileSync(policiesPath, 'utf8') !== policiesJson) {
      fs.writeFileSync(policiesPath, policiesJson);
    }

    return { xpiPath, policiesPath };
  }

  async function cleanupStaleContainers() {
    const { stdout } = await safeDocker([
      'ps',
      '-aq',
      '--filter',
      `name=${browserPrefix}-`
    ]);
    const ids = stdout.split(/\s+/).filter(Boolean);
    if (ids.length) {
      await safeDocker(['rm', '-f', ...ids]);
    }
  }

  async function waitForBrowserReady() {
    const started = Date.now();
    while ((Date.now() - started) < webReadyTimeoutMs) {
      try {
        const response = await fetch(`http://127.0.0.1:${webHostPort}/`, {
          redirect: 'manual'
        });
        if (response.ok || response.status === 301 || response.status === 302 || response.status === 401) {
          return;
        }
      } catch (_) {
        // keep polling
      }
      await sleep(1000);
    }
    throw new Error('AUTH_WORKSPACE_BROWSER_NOT_READY');
  }

  function buildWorkspaceSnapshot(includeSecret = false) {
    if (!activeWorkspace) return { ok: true, active: false };
    const bootstrap = getBootstrapSession(activeWorkspace.bootstrapId) || null;
    const snapshot = {
      ok: true,
      active: true,
      slotId: activeWorkspace.slotId,
      email: activeWorkspace.email,
      loginMethod: activeWorkspace.loginMethod,
      bootstrapId: activeWorkspace.bootstrapId,
      state: activeWorkspace.state,
      message: activeWorkspace.message || null,
      noVncPath: activeWorkspace.noVncPath || null,
      expiresAt: activeWorkspace.expiresAt,
      availableMemoryBytes: activeWorkspace.availableMemoryBytes || null,
      minimumMemoryBytes: memoryFloorBytes,
      browserReady: !!activeWorkspace.browserReady,
      deviceCode: bootstrap ? (bootstrap.deviceCode || null) : null,
      verificationUri: bootstrap ? (bootstrap.verificationUri || null) : null,
      error: activeWorkspace.error || null
    };
    if (includeSecret) {
      snapshot.containerName = activeWorkspace.containerName;
      snapshot.configDir = activeWorkspace.configDir;
    }
    return snapshot;
  }

  function touchWorkspace() {
    if (!activeWorkspace) return;
    activeWorkspace.expiresAt = new Date(Date.now() + workspaceIdleTtlMs).toISOString();
    if (activeWorkspace.idleTimer) clearTimeout(activeWorkspace.idleTimer);
    activeWorkspace.idleTimer = setTimeout(() => {
      stopActiveWorkspace('idle_timeout').catch(() => {});
    }, workspaceIdleTtlMs);
    activeWorkspace.idleTimer.unref?.();
  }

  async function reconcileActiveWorkspace() {
    if (!activeWorkspace) return null;
    const isRunning = await isWorkspaceContainerRunning(activeWorkspace);
    if (isRunning) return activeWorkspace;
    await stopActiveWorkspace('container_missing');
    return null;
  }

  async function runInWorkspace(workspace, shellCommand) {
    return runDocker([
      'exec',
      workspace.containerName,
      'sh',
      '-lc',
      shellCommand
    ]);
  }

  async function listWorkspaceWindows(workspace) {
    const { stdout } = await runInWorkspace(workspace, `
      DISPLAY=:0 xdotool search --onlyvisible --name ".*Firefox.*" 2>/dev/null | while read id; do
        title=$(DISPLAY=:0 xdotool getwindowname "$id" 2>/dev/null | tr '\n' ' ')
        eval "$(DISPLAY=:0 xdotool getwindowgeometry --shell "$id" 2>/dev/null || true)"
        printf '%s|%s|%s|%s|%s|%s\n' "$id" "$title" "\${X:-0}" "\${Y:-0}" "\${WIDTH:-0}" "\${HEIGHT:-0}"
      done
    `);

    return String(stdout || '')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [windowId, title, x, y, width, height] = line.split('|');
        return {
          windowId: String(windowId || '').trim(),
          title: String(title || '').trim(),
          x: Number(x || 0),
          y: Number(y || 0),
          width: Number(width || 0),
          height: Number(height || 0)
        };
      })
      .filter((item) => item.windowId && item.width >= 1000 && item.height >= 700);
  }

  async function resolveWorkspaceWindow(workspace) {
    const windows = await listWorkspaceWindows(workspace);
    const match = windows.find((item) => /OpenAI/i.test(item.title))
      || windows.find((item) => /^Mozilla Firefox$/i.test(item.title))
      || windows.find((item) => /Mozilla Firefox$/i.test(item.title) && !/Firefox View/i.test(item.title))
      || windows.find((item) => !/Violentmonkey|Close Firefox/i.test(item.title))
      || windows.find((item) => !/Violentmonkey/i.test(item.title))
      || windows[0];
    if (!match) {
      throw new Error('AUTH_WORKSPACE_WINDOW_NOT_FOUND');
    }
    return match;
  }

  async function waitForWorkspaceTitleChange(workspace, initialTitle, patterns = [], timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    let latestTitle = initialTitle;
    while (Date.now() < deadline) {
      const info = await resolveWorkspaceWindow(workspace);
      latestTitle = info.title;
      if (patterns.some((pattern) => pattern.test(latestTitle))) {
        return { ok: true, title: latestTitle };
      }
      if (
        latestTitle
        && latestTitle !== initialTitle
        && !/Welcome back - OpenAI/i.test(latestTitle)
        && !isIgnorableFirefoxTitle(latestTitle)
      ) {
        return { ok: true, title: latestTitle };
      }
      await sleep(320);
    }
    return { ok: false, title: latestTitle };
  }

  async function closeWorkspaceAuxiliaryWindows(workspace) {
    const windows = await listWorkspaceWindows(workspace);
    for (const item of windows) {
      if (!/Violentmonkey/i.test(item.title)) continue;
      await runInWorkspace(
        workspace,
        `DISPLAY=:0 xdotool windowactivate --sync ${shellQuote(item.windowId)} key --delay 120 ctrl+w`
      );
      await sleep(200);
    }
  }

  async function tryActionStrategies(workspace, strategies, waitOptions = {}) {
    const initialTitle = (await resolveWorkspaceWindow(workspace)).title;
    for (const strategy of strategies) {
      await strategy();
      const result = await waitForWorkspaceTitleChange(
        workspace,
        initialTitle,
        waitOptions.patterns || [],
        waitOptions.timeoutMs || 5000
      );
      if (result.ok) return result;
      await sleep(220);
    }
    throw new Error(waitOptions.error || 'AUTH_WORKSPACE_ASSIST_FAILED');
  }

  async function focusWorkspaceWindow(workspace, windowId) {
    await runInWorkspace(
      workspace,
      `DISPLAY=:0 xdotool windowactivate --sync ${shellQuote(windowId)}`
    );
  }

  async function clickWorkspacePercent(workspace, xRatio, yRatio) {
    const windowInfo = await resolveWorkspaceWindow(workspace);
    const relX = Math.max(24, Math.round(windowInfo.width * xRatio));
    const relY = Math.max(24, Math.round(windowInfo.height * yRatio));
    await runInWorkspace(
      workspace,
      `DISPLAY=:0 xdotool windowactivate --sync ${shellQuote(windowInfo.windowId)} mousemove --window ${shellQuote(windowInfo.windowId)} ${relX} ${relY} click 1`
    );
    await sleep(180);
  }

  async function keyWorkspace(workspace, ...keys) {
    const windowInfo = await resolveWorkspaceWindow(workspace);
    await runInWorkspace(
      workspace,
      `DISPLAY=:0 xdotool windowactivate --sync ${shellQuote(windowInfo.windowId)} key --delay 120 --window ${shellQuote(windowInfo.windowId)} ${keys.map(shellQuote).join(' ')}`
    );
    await sleep(140);
  }

  async function typeWorkspace(workspace, text, delay = 28) {
    const windowInfo = await resolveWorkspaceWindow(workspace);
    await runInWorkspace(
      workspace,
      `DISPLAY=:0 xdotool windowactivate --sync ${shellQuote(windowInfo.windowId)} type --delay ${Math.max(1, Number(delay) || 28)} --clearmodifiers --window ${shellQuote(windowInfo.windowId)} ${shellQuote(text)}`
    );
    await sleep(180);
  }

  async function typeTextIntoFocusedWorkspace(workspace, text) {
    const nextText = String(text || '');
    if (!nextText) {
      return {
        ok: false,
        action: 'type_text',
        message: '没有可发送到远程浏览器的文本'
      };
    }
    await typeWorkspace(workspace, nextText);
    workspace.message = `已发送文本到远程浏览器：${nextText.length > 16 ? `${nextText.slice(0, 16)}...` : nextText}`;
    workspace.error = null;
    touchWorkspace();
    return {
      ok: true,
      action: 'type_text',
      message: workspace.message
    };
  }

  async function pressWorkspaceKey(workspace, keyName, label) {
    const normalizedKey = String(keyName || '').trim();
    if (!normalizedKey) {
      throw new Error('AUTH_WORKSPACE_KEY_REQUIRED');
    }
    await keyWorkspace(workspace, normalizedKey);
    workspace.message = label || `已向远程浏览器发送 ${normalizedKey}`;
    workspace.error = null;
    touchWorkspace();
    return {
      ok: true,
      action: 'press_key',
      message: workspace.message
    };
  }

  async function fillDeviceCodeViaAutoAdvance(workspace, compactCode) {
    const firstGroup = compactCode.slice(0, 4);
    const secondGroup = compactCode.slice(4, 9);
    await typeWorkspace(workspace, firstGroup, 120);
    await sleep(220);
    await keyWorkspace(workspace, 'Tab');
    await sleep(180);
    await typeWorkspace(workspace, secondGroup, 120);
    await sleep(420);
    await clickWorkspacePercent(workspace, AUTH_CODE_CONTINUE_X_RATIO, AUTH_CODE_CONTINUE_Y_RATIO);
    await sleep(260);
  }

  async function assistWorkspaceEmailLogin(workspace, email) {
    const targetEmail = String(email || workspace.email || '').trim().toLowerCase();
    if (!targetEmail) throw new Error('AUTH_WORKSPACE_EMAIL_REQUIRED');
    await tryActionStrategies(workspace, [
      async () => {
        await clickWorkspacePercent(workspace, AUTH_FIELD_X_RATIO, AUTH_EMAIL_Y_RATIO);
        await sleep(180);
        await keyWorkspace(workspace, 'ctrl+a', 'BackSpace');
        await typeWorkspace(workspace, targetEmail);
        await sleep(180);
        await keyWorkspace(workspace, 'Return');
      },
      async () => {
        await clickWorkspacePercent(workspace, AUTH_FIELD_X_RATIO, AUTH_PAGE_Y_RATIO);
        await sleep(180);
        await keyWorkspace(workspace, 'Tab');
        await typeWorkspace(workspace, targetEmail);
        await sleep(180);
        await keyWorkspace(workspace, 'Return');
      },
      async () => {
        await clickWorkspacePercent(workspace, AUTH_FIELD_X_RATIO, AUTH_EMAIL_Y_RATIO + 0.03);
        await sleep(180);
        await typeWorkspace(workspace, targetEmail);
        await sleep(180);
        await keyWorkspace(workspace, 'Return');
      }
    ], {
      patterns: [/Enter your password/i, /Verify your identity/i, /Sign in - Google/i],
      error: 'AUTH_WORKSPACE_EMAIL_ASSIST_FAILED'
    });
    workspace.message = `已自动填入 ${targetEmail} 并点击 Continue`;
    workspace.error = null;
    touchWorkspace();
    return {
      ok: true,
      action: 'assist_login_email',
      message: workspace.message
    };
  }

  async function assistWorkspaceGoogleLogin(workspace) {
    await tryActionStrategies(workspace, [
      async () => {
        await clickWorkspacePercent(workspace, AUTH_FIELD_X_RATIO, AUTH_GOOGLE_Y_RATIO);
        await sleep(180);
        await keyWorkspace(workspace, 'Return');
      },
      async () => {
        await clickWorkspacePercent(workspace, AUTH_FIELD_X_RATIO, AUTH_PAGE_Y_RATIO);
        await sleep(180);
        await keyWorkspace(workspace, 'Tab', 'Tab', 'Tab', 'Return');
      },
      async () => {
        await clickWorkspacePercent(workspace, AUTH_FIELD_X_RATIO, AUTH_GOOGLE_Y_RATIO);
        await sleep(260);
        await clickWorkspacePercent(workspace, AUTH_FIELD_X_RATIO, AUTH_GOOGLE_Y_RATIO);
      }
    ], {
      patterns: [/Google/i, /Choose an account/i, /Sign in/i],
      timeoutMs: 10000,
      error: 'AUTH_WORKSPACE_GOOGLE_ASSIST_FAILED'
    });
    await sleep(3200);
    const settledTitle = (await resolveWorkspaceWindow(workspace)).title;
    if (/Welcome back - OpenAI/i.test(settledTitle) || isIgnorableFirefoxTitle(settledTitle)) {
      throw new Error('AUTH_WORKSPACE_GOOGLE_ASSIST_FAILED');
    }
    workspace.message = '已自动点击 Google 登录按钮';
    workspace.error = null;
    touchWorkspace();
    return {
      ok: true,
      action: 'assist_google_login',
      message: workspace.message
    };
  }

  async function assistWorkspaceDeviceCode(workspace, deviceCode) {
    const compactCode = String(deviceCode || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    if (!compactCode) throw new Error('AUTH_WORKSPACE_DEVICE_CODE_REQUIRED');
    const initialTitle = (await resolveWorkspaceWindow(workspace)).title;
    const strategies = [
      async () => {
        await clickWorkspacePercent(workspace, AUTH_CODE_X_RATIO, AUTH_CODE_Y_RATIO);
        await sleep(220);
        await fillDeviceCodeViaAutoAdvance(workspace, compactCode);
      },
      async () => {
        await clickWorkspacePercent(workspace, AUTH_CODE_X_RATIO, AUTH_CODE_Y_RATIO);
        await sleep(180);
        await keyWorkspace(workspace, 'Home');
        await fillDeviceCodeViaAutoAdvance(workspace, compactCode);
      },
      async () => {
        await clickWorkspacePercent(workspace, AUTH_CODE_X_RATIO, AUTH_CODE_Y_RATIO);
        await sleep(180);
        await typeWorkspace(workspace, compactCode, 120);
        await sleep(420);
        await clickWorkspacePercent(workspace, AUTH_CODE_CONTINUE_X_RATIO, AUTH_CODE_CONTINUE_Y_RATIO);
      },
      async () => {
        await clickWorkspacePercent(workspace, AUTH_CODE_CONTINUE_X_RATIO, AUTH_CODE_CONTINUE_Y_RATIO);
        await sleep(180);
        await keyWorkspace(workspace, 'Return');
      }
    ];

    let settledTitle = initialTitle;
    for (const strategy of strategies) {
      await strategy();
      await sleep(1800);
      settledTitle = (await resolveWorkspaceWindow(workspace)).title;
      if (
        settledTitle
        && settledTitle !== initialTitle
        && !/Use your device code/i.test(settledTitle)
        && !isIgnorableFirefoxTitle(settledTitle)
      ) {
        break;
      }
    }

    if (
      !settledTitle
      || settledTitle === initialTitle
      || /Use your device code/i.test(settledTitle)
      || isIgnorableFirefoxTitle(settledTitle)
    ) {
      throw new Error('AUTH_WORKSPACE_DEVICE_CODE_ASSIST_FAILED');
    }
    workspace.message = `已自动填入设备码 ${compactCode} 并提交 Continue`;
    workspace.error = null;
    touchWorkspace();
    return {
      ok: true,
      action: 'fill_device_code',
      message: workspace.message,
      title: settledTitle
    };
  }

  async function primeWorkspaceLogin(workspace) {
    if (!workspace || !workspace.browserReady) return;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        if (attempt) await sleep(900);
        else await sleep(workspace.loginMethod === 'google' ? 15000 : 1600);
        if (workspace.loginMethod === 'google') {
          await assistWorkspaceGoogleLogin(workspace);
          return;
        }
        await assistWorkspaceEmailLogin(workspace, workspace.email);
        return;
      } catch (error) {
        workspace.error = error.message || 'AUTH_WORKSPACE_AUTO_ASSIST_FAILED';
        if (attempt === 3) {
          workspace.message = '认证台已启动，但自动辅助未确认成功；请点右侧按钮重试一次';
        }
      }
    }
  }

  function buildWorkspaceBootstrapPayload(workspace, overrides = {}) {
    const bootstrap = getBootstrapSession(workspace.bootstrapId) || null;
    const deviceCode = Object.prototype.hasOwnProperty.call(overrides, 'deviceCode')
      ? overrides.deviceCode
      : (bootstrap ? bootstrap.deviceCode : null);
    return {
      slotId: workspace.slotId,
      email: String(
        Object.prototype.hasOwnProperty.call(overrides, 'email')
          ? overrides.email
          : workspace.email || ''
      ).trim().toLowerCase(),
      loginMethod: String(
        Object.prototype.hasOwnProperty.call(overrides, 'loginMethod')
          ? overrides.loginMethod
          : workspace.loginMethod || 'email'
      ).trim().toLowerCase(),
      deviceCode: deviceCode ? String(deviceCode).trim() : '',
      requestedAction: String(overrides.requestedAction || '').trim(),
      updatedAt: nowIso()
    };
  }

  function describeRequestedAction(requestedAction, payload) {
    if (requestedAction === 'select_login_method') {
      return '远程认证台已就绪，将按 Google 登录方式自动辅助';
    }
    if (requestedAction === 'fill_device_code') {
      const deviceCode = String(payload.deviceCode || '').trim();
      return deviceCode
        ? `远程认证台已刷新，等待自动填入设备码 ${deviceCode}`
        : '远程认证台已刷新，等待自动填入设备码';
    }
    const email = String(payload.email || '').trim().toLowerCase();
    return email
      ? `远程认证台已就绪，将自动填入 ${email} 并继续`
      : '远程认证台已就绪，请在左侧完成 OpenAI 登录';
  }

  async function openManagedAuthUrl(workspace, managedAuthUrl) {
    const targetUrl = String(managedAuthUrl || '').trim();
    if (!targetUrl) throw new Error('AUTH_WORKSPACE_URL_REQUIRED');
    const windowInfo = await resolveWorkspaceWindow(workspace);
    await runInWorkspace(
      workspace,
      `DISPLAY=:0 xdotool windowactivate --sync ${shellQuote(windowInfo.windowId)} key --delay 120 ctrl+l`
    );
    await sleep(220);
    await runInWorkspace(
      workspace,
      `DISPLAY=:0 xdotool windowactivate --sync ${shellQuote(windowInfo.windowId)} type --delay 12 --clearmodifiers --window ${shellQuote(windowInfo.windowId)} ${shellQuote(targetUrl)}`
    );
    await sleep(180);
    await runInWorkspace(
      workspace,
      `DISPLAY=:0 xdotool windowactivate --sync ${shellQuote(windowInfo.windowId)} key --delay 120 --window ${shellQuote(windowInfo.windowId)} Return`
    );
    await sleep(650);
  }

  async function installUserscriptInWorkspace(workspace) {
    void workspace;
    void userscriptHostUrl;
    return false;
  }

  async function refreshWorkspaceAuthUrl(workspace, overrides = {}) {
    const payload = buildWorkspaceBootstrapPayload(workspace, overrides);
    const managedAuthUrl = buildManagedAuthUrl('https://auth.openai.com/codex/device', payload.email, payload);
    await openManagedAuthUrl(workspace, managedAuthUrl);
    workspace.message = describeRequestedAction(payload.requestedAction, payload);
    workspace.error = null;
    touchWorkspace();
    return payload;
  }

  async function performWorkspaceAction(workspace, action, payload = {}) {
    const normalizedAction = String(action || '').trim();
    if (!normalizedAction) throw new Error('AUTH_WORKSPACE_ACTION_REQUIRED');

    if (normalizedAction === 'assist_google_login') {
      workspace.loginMethod = 'google';
      return assistWorkspaceGoogleLogin(workspace);
    }

    if (normalizedAction === 'assist_login_email' || normalizedAction === 'fill_email') {
      workspace.loginMethod = 'email';
      if (payload.email) workspace.email = String(payload.email).trim().toLowerCase();
      return assistWorkspaceEmailLogin(workspace, payload.email || workspace.email);
    }

    if (normalizedAction === 'fill_device_code') {
      return assistWorkspaceDeviceCode(workspace, payload.deviceCode);
    }

    if (normalizedAction === 'type_text') {
      return typeTextIntoFocusedWorkspace(workspace, payload.text);
    }

    if (normalizedAction === 'press_enter') {
      return pressWorkspaceKey(workspace, 'Return', '已向远程浏览器发送 Enter');
    }

    if (normalizedAction === 'press_backspace') {
      return pressWorkspaceKey(workspace, 'BackSpace', '已向远程浏览器发送 Backspace');
    }

    if (normalizedAction === 'press_tab') {
      return pressWorkspaceKey(workspace, 'Tab', '已向远程浏览器发送 Tab');
    }

    throw new Error('AUTH_WORKSPACE_ACTION_UNKNOWN');
  }

  async function launchWorkspace(workspace) {
    resetWorkspaceDir(workspace.configDir);
    const { xpiPath, policiesPath } = await ensureUserscriptAssets();
    const initialPayload = buildWorkspaceBootstrapPayload(workspace, {
      requestedAction: workspace.loginMethod === 'google' ? 'select_login_method' : 'prefill_email'
    });
    const initialManagedAuthUrl = buildManagedAuthUrl(
      'https://auth.openai.com/codex/device',
      initialPayload.email,
      initialPayload
    );

    const { stdout } = await runDocker([
      'run',
      '-d',
      '--rm',
      '--name',
      workspace.containerName,
      '-p',
      `127.0.0.1:${webHostPort}:5800`,
      '--shm-size=1g',
      '-e',
      'USER_ID=0',
      '-e',
      'GROUP_ID=0',
      '-e',
      'TZ=Etc/UTC',
      '-e',
      'LANG=zh_CN.UTF-8',
      '-e',
      'LC_ALL=zh_CN.UTF-8',
      '-e',
      'WEB_AUTHENTICATION=0',
      '-e',
      'WEB_FILE_MANAGER=0',
      '-e',
      'WEB_TERMINAL=0',
      '-e',
      'WEB_AUDIO=0',
      '-e',
      'SECURE_CONNECTION=0',
      '-e',
      `DISPLAY_WIDTH=${displayWidth}`,
      '-e',
      `DISPLAY_HEIGHT=${displayHeight}`,
      '-e',
      'VNC_LISTENING_PORT=-1',
      '-e',
      `FF_OPEN_URL=${initialManagedAuthUrl}`,
      '-e',
      `FF_PREF_1=layout.css.devPixelsPerPx="${firefoxZoom}"`,
      '-e',
      'FF_PREF_2=browser.zoom.siteSpecific=false',
      '-e',
      'FF_PREF_3=datareporting.policy.dataSubmissionPolicyBypassNotification=true',
      '-e',
      'FF_PREF_4=toolkit.telemetry.reportingpolicy.firstRun=false',
      '-e',
      'FF_PREF_5=app.normandy.first_run=false',
      '-e',
      'FF_PREF_6=browser.aboutwelcome.enabled=false',
      '-e',
      'FF_PREF_7=toolkit.legacyUserProfileCustomizations.stylesheets=true',
      '-v',
      '/usr/share/fonts/truetype/wqy:/usr/share/fonts/truetype/wqy:ro',
      '-v',
      `${xpiPath}:/opt/codex-switcher-assets/violentmonkey.xpi:ro`,
      '-v',
      `${policiesPath}:/usr/lib/firefox/distribution/policies.json:ro`,
      '-v',
      `${workspace.configDir}:/config:rw`,
      image
    ]);

    workspace.containerId = stdout;
    await waitForBrowserReady();
    workspace.userscriptInstalled = false;
    await closeWorkspaceAuxiliaryWindows(workspace);
    workspace.message = describeRequestedAction(initialPayload.requestedAction, initialPayload);
    workspace.error = null;
    workspace.browserReady = true;
    workspace.state = 'ready_for_login';
    touchWorkspace();
    await primeWorkspaceLogin(workspace);
  }

  async function stopActiveWorkspace(reason = 'stopped') {
    if (!activeWorkspace) return { ok: true, stopped: false };
    const current = activeWorkspace;
    activeWorkspace = null;

    if (current.idleTimer) clearTimeout(current.idleTimer);
    await safeDocker(['rm', '-f', current.containerName]);
    fs.rmSync(current.configDir, { recursive: true, force: true });
    return { ok: true, stopped: true, reason, slotId: current.slotId };
  }

  async function start(input = {}) {
    const slotId = String(input.slotId || '').trim();
    if (!slotId) throw new Error('AUTH_WORKSPACE_SLOT_REQUIRED');

    const currentWorkspace = await reconcileActiveWorkspace();

    if (currentWorkspace && currentWorkspace.slotId !== slotId) {
      throw new Error(`AUTH_WORKSPACE_BUSY:${currentWorkspace.slotId}`);
    }

    const availableMemoryBytes = readAvailableMemoryBytes();
    if (availableMemoryBytes && availableMemoryBytes < memoryFloorBytes) {
      throw new Error('AUTH_WORKSPACE_MEMORY_LOW');
    }

    if (currentWorkspace && currentWorkspace.slotId === slotId) {
      currentWorkspace.bootstrapId = input.bootstrapId || currentWorkspace.bootstrapId;
      currentWorkspace.email = String(input.email || currentWorkspace.email || '').trim().toLowerCase();
      currentWorkspace.loginMethod = input.loginMethod || currentWorkspace.loginMethod || 'email';
      currentWorkspace.state = currentWorkspace.state || 'awaiting_user';
      currentWorkspace.availableMemoryBytes = availableMemoryBytes;
      touchWorkspace();
      return buildWorkspaceSnapshot();
    }

    await cleanupStaleContainers();

    activeWorkspace = {
      slotId,
      email: String(input.email || '').trim().toLowerCase(),
      loginMethod: input.loginMethod || 'email',
      bootstrapId: input.bootstrapId || null,
      state: 'preparing_workspace',
      message: '正在启动远程认证台...',
      containerName: `${browserPrefix}-${sanitizeSlotId(slotId)}`,
      containerId: null,
      configDir: workspaceConfigDir(slotId),
      noVncPath: null,
      browserReady: false,
      idleTimer: null,
      availableMemoryBytes,
      error: null,
      startedAt: nowIso(),
      expiresAt: new Date(Date.now() + workspaceIdleTtlMs).toISOString()
    };

    try {
      await launchWorkspace(activeWorkspace);
      return buildWorkspaceSnapshot();
    } catch (error) {
      activeWorkspace.error = error.message;
      await stopActiveWorkspace('launch_failed');
      throw error;
    }
  }

  async function reset(input = {}) {
    const slotId = String(input.slotId || '').trim();
    if (!slotId) throw new Error('AUTH_WORKSPACE_SLOT_REQUIRED');
    const currentWorkspace = await reconcileActiveWorkspace();
    if (currentWorkspace && currentWorkspace.slotId !== slotId) {
      throw new Error(`AUTH_WORKSPACE_BUSY:${currentWorkspace.slotId}`);
    }

    await stopActiveWorkspace('reset');
    return start({
      slotId,
      email: input.email,
      loginMethod: input.loginMethod,
      bootstrapId: input.bootstrapId
    });
  }

  function updateState(input = {}) {
    if (!activeWorkspace) return buildWorkspaceSnapshot();
    if (input.slotId && activeWorkspace.slotId !== input.slotId) return buildWorkspaceSnapshot();
    if (input.state) activeWorkspace.state = input.state;
    if (Object.prototype.hasOwnProperty.call(input, 'message')) activeWorkspace.message = input.message || null;
    if (Object.prototype.hasOwnProperty.call(input, 'error')) activeWorkspace.error = input.error || null;
    touchWorkspace();
    return buildWorkspaceSnapshot();
  }

  async function stop(input = {}) {
    const currentWorkspace = await reconcileActiveWorkspace();
    if (!currentWorkspace) return { ok: true, active: false };
    if (input.slotId && currentWorkspace.slotId !== input.slotId) {
      throw new Error('AUTH_WORKSPACE_NOT_FOUND');
    }
    await stopActiveWorkspace(input.reason || 'manual_stop');
    return { ok: true, active: false };
  }

  async function action(input = {}) {
    const slotId = String(input.slotId || '').trim();
    if (!slotId) throw new Error('AUTH_WORKSPACE_SLOT_REQUIRED');
    const currentWorkspace = await reconcileActiveWorkspace();
    if (!currentWorkspace || currentWorkspace.slotId !== slotId) {
      throw new Error('AUTH_WORKSPACE_NOT_FOUND');
    }
    const result = await performWorkspaceAction(currentWorkspace, input.action, input);
    touchWorkspace();
    return {
      ...buildWorkspaceSnapshot(),
      actionResult: result
    };
  }

  async function status(slotId) {
    const currentWorkspace = await reconcileActiveWorkspace();
    if (slotId && (!currentWorkspace || currentWorkspace.slotId !== slotId)) {
      return { ok: true, active: false };
    }
    if (currentWorkspace) touchWorkspace();
    return buildWorkspaceSnapshot();
  }

  return {
    action,
    cleanupStaleContainers,
    readAvailableMemoryBytes,
    reset,
    start,
    status,
    stop,
    updateState
  };
}

module.exports = {
  buildNoVncPath,
  createAuthWorkspaceManager,
  parseBytes,
  readAvailableMemoryBytes,
  sanitizeSlotId
};
