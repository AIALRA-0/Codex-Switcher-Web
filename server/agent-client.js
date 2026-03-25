'use strict';

const http = require('http');
const { config } = require('./config');

function requestAgent(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const req = http.request({
      socketPath: config.agentSocketPath,
      path: pathname,
      method,
      headers: {
        'content-type': 'application/json',
        'content-length': payload ? String(payload.length) : '0',
        'x-agent-token': config.agentSharedSecret
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = {};
        try {
          json = raw ? JSON.parse(raw) : {};
        } catch (error) {
          return reject(new Error(`Agent returned invalid JSON: ${error.message}`));
        }
        if (res.statusCode >= 400 || json.ok === false) {
          const message = json.error || `Agent request failed (${res.statusCode})`;
          return reject(new Error(message));
        }
        resolve(json);
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function activateProfile(input) {
  return requestAgent('POST', '/activate_profile', input);
}

function rollbackProfile(input) {
  return requestAgent('POST', '/rollback_profile', input);
}

function startDeviceAuth(input) {
  return requestAgent('POST', '/start_device_auth', input);
}

function getBootstrapStatus(bootstrapId) {
  return requestAgent('GET', `/bootstrap_status?id=${encodeURIComponent(bootstrapId)}`);
}

function cancelBootstrap(input) {
  return requestAgent('POST', '/cancel_bootstrap', input);
}

function captureAuthProfile(input) {
  return requestAgent('POST', '/capture_auth_profile', input);
}

function getLoginStatus() {
  return requestAgent('GET', '/login_status');
}

function getUsageStatus() {
  return requestAgent('GET', '/usage_status');
}

function getUsageForProfile(input) {
  return requestAgent('POST', '/usage_for_profile', input);
}

function logoutActiveAuth() {
  return requestAgent('POST', '/logout_active_auth', {});
}

function startAuthWorkspace(input) {
  return requestAgent('POST', '/auth_workspace/start', input);
}

function resetAuthWorkspace(input) {
  return requestAgent('POST', '/auth_workspace/reset', input);
}

function stopAuthWorkspace(input) {
  return requestAgent('POST', '/auth_workspace/stop', input);
}

function updateAuthWorkspaceState(input) {
  return requestAgent('POST', '/auth_workspace/state', input);
}

function getAuthWorkspaceStatus(slotId) {
  return requestAgent('GET', `/auth_workspace/status?slotId=${encodeURIComponent(slotId || '')}`);
}

function runAuthWorkspaceAction(input) {
  return requestAgent('POST', '/auth_workspace/action', input);
}

module.exports = {
  activateProfile,
  getAuthWorkspaceStatus,
  cancelBootstrap,
  captureAuthProfile,
  getBootstrapStatus,
  getLoginStatus,
  getUsageForProfile,
  getUsageStatus,
  logoutActiveAuth,
  resetAuthWorkspace,
  rollbackProfile,
  runAuthWorkspaceAction,
  startAuthWorkspace,
  stopAuthWorkspace,
  startDeviceAuth,
  updateAuthWorkspaceState
};
