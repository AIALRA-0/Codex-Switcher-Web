'use strict';

function buildUserscript(config) {
  const appUrl = String(config.appUrl || 'https://codex.example.com').trim() || 'https://codex.example.com';
  const workspaceUrl = String(config.codeWorkspaceUrl || 'https://code.example.com/?workspace=/workspace/default.code-workspace').trim()
    || 'https://code.example.com/?workspace=/workspace/default.code-workspace';
  let appHost = 'codex.example.com';
  let workspaceOrigin = 'https://code.example.com';
  try {
    appHost = new URL(appUrl).host || appHost;
  } catch (_) {
    // ignore invalid app url
  }
  try {
    workspaceOrigin = new URL(workspaceUrl).origin || workspaceOrigin;
  } catch (_) {
    // ignore invalid workspace url
  }
  return `// ==UserScript==
// @name         Codex Switcher Bridge
// @namespace    ${appUrl}
// @version      1.1.1
// @description  Bridge Codex quota readings and auth automation into the configured Codex Switcher app
// @match        ${workspaceOrigin}/*
// @match        https://auth.openai.com/*
// @downloadURL  ${appUrl}/codex-switcher.user.js
// @updateURL    ${appUrl}/codex-switcher.user.js
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @connect      ${appHost}
// ==/UserScript==

(function () {
  'use strict';

  const APP_URL = ${JSON.stringify(appUrl)};
  const WORKSPACE_URL = ${JSON.stringify(workspaceUrl)};
  const WORKSPACE_ORIGIN = ${JSON.stringify(workspaceOrigin)};
  const AUTH_DEVICE_URL = ${JSON.stringify(config.authDeviceUrl)};
  const POLL_INTERVAL_MS = ${config.browserPollIntervalMs};
  const SAMPLE_INTERVAL_MS = ${config.quotaSampleIntervalMs};
  const BROWSER_TOKEN_KEY = 'codex_switcher_browser_token';
  const CLIENT_ID_KEY = 'codex_switcher_client_id';
  const PENDING_BOOTSTRAP_KEY = 'codex_switcher_pending_bootstrap';

  function gmGet(key, fallback) {
    try {
      const value = GM_getValue(key);
      return value == null ? fallback : value;
    } catch (_) {
      return fallback;
    }
  }

  function gmSet(key, value) {
    try { GM_setValue(key, value); } catch (_) {}
  }

  function gmDelete(key) {
    try { GM_deleteValue(key); } catch (_) {}
  }

  function normalizeSpace(text) {
    return String(text || '').replace(/\\u200b/g, '').replace(/\\s+/g, ' ').trim();
  }

  function request(method, url, options = {}) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url,
        headers: {
          'x-codex-switcher-origin': location.origin,
          ...(options.headers || {})
        },
        data: options.data,
        onload: (response) => {
          try {
            const json = response.responseText ? JSON.parse(response.responseText) : {};
            resolve({ status: response.status, json });
          } catch (error) {
            reject(error);
          }
        },
        onerror: reject
      });
    });
  }

  function getBrowserToken() {
    return gmGet(BROWSER_TOKEN_KEY, '');
  }

  function getPendingBootstrap() {
    return gmGet(PENDING_BOOTSTRAP_KEY, null);
  }

  function loadPendingBootstrapFromHash() {
    const match = location.hash.match(/codex-switcher-bootstrap=([^&]+)/);
    if (!match) return;
    try {
      let b64 = decodeURIComponent(match[1]).replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      const decoded = JSON.parse(atob(b64));
      setPendingBootstrap(decoded);
      history.replaceState(null, document.title, location.pathname + location.search);
    } catch (error) {
      console.error('[CodexSwitcher] failed to decode bootstrap hash', error);
    }
  }

  function setPendingBootstrap(patch) {
    const current = getPendingBootstrap() || {};
    gmSet(PENDING_BOOTSTRAP_KEY, Object.assign({}, current, patch, { updatedAt: new Date().toISOString() }));
  }

  function clearPendingBootstrap() {
    gmDelete(PENDING_BOOTSTRAP_KEY);
  }

  async function handleBindTokenFromHash() {
    if (!location.hash.includes('codex-switcher-bind=')) return;
    const match = location.hash.match(/codex-switcher-bind=([^&]+)/);
    if (!match) return;
    const bindCode = decodeURIComponent(match[1]);
    try {
      const { json } = await request('POST', APP_URL + '/api/browser-clients/register', {
        headers: { 'content-type': 'application/json' },
        data: JSON.stringify({
          bindCode,
          pageUrl: location.href,
          userAgent: navigator.userAgent,
          label: navigator.platform || 'Browser'
        })
      });
      if (json && json.ok) {
        gmSet(BROWSER_TOKEN_KEY, json.browserToken);
        gmSet(CLIENT_ID_KEY, json.clientId);
        history.replaceState(null, document.title, location.pathname + location.search);
        alert('Codex Switcher 浏览器绑定成功');
      } else {
        alert('Codex Switcher 浏览器绑定失败');
      }
    } catch (error) {
      console.error('[CodexSwitcher] bind failed', error);
    }
  }

  function parseResetLabelToIso(label) {
    const clean = normalizeSpace(label);
    if (!clean) return null;
    const now = new Date();
    const tzOffset = now.getTimezoneOffset();

    let match = clean.match(/^(\\d{1,2}):(\\d{2})$/);
    if (match) {
      const hour = Number(match[1]);
      const minute = Number(match[2]);
      const target = new Date(now);
      target.setHours(hour, minute, 0, 0);
      if (target.getTime() <= now.getTime()) {
        target.setDate(target.getDate() + 1);
      }
      return { resetAt: target.toISOString(), timezoneOffsetMinutes: tzOffset };
    }

    match = clean.match(/^(\\d{1,2})月(\\d{1,2})日$/);
    if (match) {
      const month = Number(match[1]) - 1;
      const date = Number(match[2]);
      const target = new Date(now.getFullYear(), month, date, 0, 0, 0, 0);
      if (target.getTime() < new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).getTime()) {
        target.setFullYear(target.getFullYear() + 1);
      }
      return { resetAt: target.toISOString(), timezoneOffsetMinutes: tzOffset };
    }

    return { resetAt: null, timezoneOffsetMinutes: tzOffset };
  }

  function extractQuotaFromMenuText(text) {
    const normalized = normalizeSpace(text);
    const pattern = /(5 小时|1 周)\\s+(\\d{1,3}\\s*%)\\s*[·•]?\\s*([0-9]{1,2}:\\d{2}|\\d{1,2}月\\d{1,2}日)/g;
    const rows = [];
    let match;
    while ((match = pattern.exec(normalized)) !== null) {
      const timing = parseResetLabelToIso(match[3]);
      rows.push({
        label: match[1],
        pct: Number((match[2].match(/\\d+/) || [])[0]),
        resetLabel: normalizeSpace(match[3]),
        resetAt: timing.resetAt
      });
    }
    const fiveHour = rows.find((row) => row.label === '5 小时') || null;
    const week = rows.find((row) => row.label === '1 周') || null;
    return {
      parserStatus: fiveHour && week ? 'ok' : 'unknown',
      fiveHour,
      week,
      rawText: normalized
    };
  }

  function findElementByText(selector, regex) {
    return Array.from(document.querySelectorAll(selector)).find((node) => regex.test(normalizeSpace(node.innerText || node.textContent)));
  }

  function setInputValue(input, value) {
    if (!input || value == null || input.disabled || input.readOnly) return false;
    const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
    if (descriptor && typeof descriptor.set === 'function') {
      descriptor.set.call(input, String(value));
    } else {
      input.value = String(value);
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  function clickIfPossible(node) {
    if (!node || node.disabled || node.getAttribute('aria-disabled') === 'true') return false;
    node.click();
    return true;
  }

  function isVisible(node) {
    if (!node) return false;
    if (node.hidden) return false;
    const style = window.getComputedStyle ? window.getComputedStyle(node) : null;
    if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
    return !!(node.offsetWidth || node.offsetHeight || node.getClientRects().length);
  }

  async function sampleQuota() {
    const browserToken = getBrowserToken();
    if (!browserToken) return;

    try {
      const localButton = findElementByText('button, [role="button"]', /^本地$/);
      if (!localButton) {
        await postQuotaSample({ parserStatus: 'unknown', rawText: 'missing-local-button', pageUrl: location.href });
        return;
      }
      localButton.click();
      await new Promise((resolve) => setTimeout(resolve, 200));

      const quotaToggle = findElementByText('[role="menuitem"], button, div', /剩余额度/);
      if (quotaToggle) {
        quotaToggle.click();
        await new Promise((resolve) => setTimeout(resolve, 200));
      }

      const menu = Array.from(document.querySelectorAll('[role="menu"], [data-radix-menu-content], div'))
        .filter((node) => /5 小时|1 周|剩余额度/.test(normalizeSpace(node.innerText || node.textContent)))
        .sort((a, b) => (b.innerText || '').length - (a.innerText || '').length)[0];

      const parsed = extractQuotaFromMenuText(menu ? menu.innerText || menu.textContent : document.body.innerText);
      await postQuotaSample({
        parserStatus: parsed.parserStatus,
        quota_5h_pct: parsed.fiveHour ? parsed.fiveHour.pct : null,
        quota_5h_reset_at: parsed.fiveHour ? parsed.fiveHour.resetAt : null,
        quota_5h_reset_label: parsed.fiveHour ? parsed.fiveHour.resetLabel : null,
        quota_week_pct: parsed.week ? parsed.week.pct : null,
        quota_week_reset_at: parsed.week ? parsed.week.resetAt : null,
        quota_week_reset_label: parsed.week ? parsed.week.resetLabel : null,
        raw_text: parsed.rawText,
        observed_at: new Date().toISOString(),
        pageUrl: location.href
      });
    } catch (error) {
      console.error('[CodexSwitcher] quota sample failed', error);
      await postQuotaSample({
        parserStatus: 'unknown',
        raw_text: String(error && error.message ? error.message : error),
        observed_at: new Date().toISOString(),
        pageUrl: location.href
      });
    }
  }

  async function postQuotaSample(payload) {
    const browserToken = getBrowserToken();
    if (!browserToken) return;
    await request('POST', APP_URL + '/api/quota-samples', {
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + browserToken
      },
      data: JSON.stringify(payload)
    });
  }

  async function postWorkspaceReady() {
    const browserToken = getBrowserToken();
    if (!browserToken) return;
    await request('POST', APP_URL + '/api/browser-clients/workspace-ready', {
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + browserToken
      },
      data: JSON.stringify({
        pageUrl: location.href,
        userAgent: navigator.userAgent
      })
    });
  }

  async function pollActions() {
    const browserToken = getBrowserToken();
    if (!browserToken) return;
    try {
      const { json } = await request('GET', APP_URL + '/api/browser-clients/poll', {
        headers: {
          authorization: 'Bearer ' + browserToken
        }
      });
      if (!json || !json.ok || !Array.isArray(json.actions)) return;
      for (const action of json.actions) {
        await handleAction(action);
      }
    } catch (error) {
      console.error('[CodexSwitcher] poll failed', error);
    }
  }

  async function handleAction(action) {
    const payload = action.payload || {};
    switch (action.type) {
      case 'reload_requested':
        location.href = payload.url || WORKSPACE_URL;
        break;
      case 'open_device_auth':
        setPendingBootstrap(payload);
        window.open(payload.url || AUTH_DEVICE_URL, '_blank', 'noopener');
        break;
      case 'select_login_method':
        setPendingBootstrap(payload);
        break;
      case 'prefill_email':
        setPendingBootstrap(payload);
        break;
      case 'switch_started':
      case 'switch_completed':
      case 'switch_failed':
        console.info('[CodexSwitcher]', action.type, payload);
        break;
      default:
        break;
    }
  }

  function isDeviceCodePage() {
    const deviceForm = document.querySelector('form[action*="/deviceauth/authorize_code"]');
    const segmentedInputs = document.querySelectorAll('input[name^="character_"]');
    const hiddenUserCode = document.querySelector('input[name="user_code"], input[name="user_code_text"]');
    return !!(deviceForm || segmentedInputs.length >= 9 || hiddenUserCode);
  }

  function isLoginOptionsPage() {
    const loginForm = document.querySelector('form[aria-label="Pick a log in option"]');
    const emailInput = document.querySelector([
      'form[aria-label="Pick a log in option"] input[name="email"]',
      'input[id$="-email"]',
      'input[type="email"]',
      'input[name="email"]',
      'input[autocomplete="email"]'
    ].join(', '));
    const googleButton = document.querySelector([
      'button[name="intent"][value="google"]',
      'button[data-dd-action-name*="Google"]'
    ].join(', '));
    return !!(loginForm && (emailInput || googleButton));
  }

  function fillDeviceCodeIfPossible(deviceCode) {
    const compact = String(deviceCode || '').replace(/[^A-Za-z0-9]/g, '');
    const dashed = compact.length >= 9
      ? compact.slice(0, 4) + '-' + compact.slice(4, 9)
      : compact;
    const inputs = Array.from(document.querySelectorAll([
      'input[name^="character_"]',
      'input[id*="character_"]',
      'input[aria-label*="代码字符"]',
      'input[aria-label*="Code character"]'
    ].join(', ')));
    if (compact.length < 9) return false;

    const hiddenDashedInput = document.querySelector('input[name="user_code"]');
    const hiddenCompactInput = document.querySelector('input[name="user_code_text"]');
    if (hiddenDashedInput) setInputValue(hiddenDashedInput, dashed);
    if (hiddenCompactInput) setInputValue(hiddenCompactInput, compact);

    if (inputs.length >= 9) {
      inputs.slice(0, 9).forEach((input, index) => {
        input.focus();
        setInputValue(input, compact[index] || '');
      });
    } else {
      const singleInput = document.querySelector([
        'form[action*="/deviceauth/authorize_code"] input[name="user_code_text"]',
        'form[action*="/deviceauth/authorize_code"] input[name="user_code"]',
        'form[action*="/deviceauth/authorize_code"] input[type="text"][maxlength="9"]'
      ].join(', '));
      if (!singleInput) return false;
      singleInput.focus();
      if (!setInputValue(singleInput, compact)) return false;
    }
    const submit = document.querySelector('button[type="submit"], button[name="intent"][value="device"], button[name="intent"][value="email"]')
      || findElementByText('button', /继续|Continue/);
    clickIfPossible(submit);
    return true;
  }

  function clickGoogleIfPossible() {
    const googleButton = document.querySelector([
      'button[name="intent"][value="google"]',
      'button[data-dd-action-name*="Google"]',
      'button[aria-label*="Google"]',
      'form[aria-label="Pick a log in option"] button[name="intent"][value="google"]'
    ].join(', ')) || findElementByText(
      'button, [role="button"], a',
      /继续使用\s*Google\s*登录|Continue with Google|Google/
    );
    return clickIfPossible(googleButton);
  }

  function fillEmailIfPossible(email) {
    const emailInput = document.querySelector([
      'form[aria-label="Pick a log in option"] input[name="email"]',
      'input[id$="-email"]',
      'input[type="email"]',
      'input[name="username"]',
      'input[name="email"]',
      'input[autocomplete="username"]',
      'input[autocomplete="email"]',
      'input[inputmode="email"]'
    ].join(', '));
    if (!isVisible(emailInput) || !email) return false;
    emailInput.focus();
    if (!setInputValue(emailInput, email)) return false;
    const continueButton = document.querySelector([
      'form[aria-label="Pick a log in option"] button[name="intent"][value="email"]',
      'button[type="submit"][name="intent"][value="email"]',
      'button[data-dd-action-name="Continue"]'
    ].join(', ')) || findElementByText('button, [role="button"], input[type="submit"]', /继续|Continue/);
    if (clickIfPossible(continueButton)) return true;
    if (emailInput.form && typeof emailInput.form.requestSubmit === 'function') {
      emailInput.form.requestSubmit();
      return true;
    }
    emailInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', which: 13, keyCode: 13, bubbles: true }));
    emailInput.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', which: 13, keyCode: 13, bubbles: true }));
    return true;
  }

  function automateAuthPage() {
    const pending = getPendingBootstrap();
    if (!pending) return;
    if (pending.updatedAt && Date.now() - new Date(pending.updatedAt).getTime() > 30 * 60 * 1000) {
      clearPendingBootstrap();
      return;
    }

    if (isDeviceCodePage()) {
      fillDeviceCodeIfPossible(pending.deviceCode);
      return;
    }

    if (!isLoginOptionsPage()) return;

    if (pending.requestedAction === 'fill_device_code') return;

    if (pending.loginMethod === 'google' || pending.requestedAction === 'select_login_method') {
      if (clickGoogleIfPossible()) return;
    }

    if (pending.loginMethod === 'email' || pending.requestedAction === 'prefill_email') {
      fillEmailIfPossible(pending.email);
    }
  }

  async function initCodePage() {
    await handleBindTokenFromHash();
    await postWorkspaceReady();
    await sampleQuota();
    setInterval(pollActions, POLL_INTERVAL_MS);
    setInterval(sampleQuota, SAMPLE_INTERVAL_MS);
  }

  function initAuthPage() {
    loadPendingBootstrapFromHash();
    setInterval(automateAuthPage, 1500);
  }

  if (location.origin === WORKSPACE_ORIGIN) {
    initCodePage();
  } else if (location.origin === 'https://auth.openai.com') {
    initAuthPage();
  }
})();
`;
}

module.exports = {
  buildUserscript
};
