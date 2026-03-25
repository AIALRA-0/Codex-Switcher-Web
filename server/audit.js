'use strict';

const fs = require('fs');
const path = require('path');
const { config } = require('./config');

fs.mkdirSync(path.dirname(config.auditLogPath), { recursive: true });

function sanitizeDetail(detail = {}) {
  const clone = JSON.parse(JSON.stringify(detail || {}));
  const blocked = [
    'access_token',
    'refresh_token',
    'id_token',
    'authJson',
    'auth_json',
    'sessionSecret',
    'password',
    'token'
  ];
  for (const key of blocked) {
    if (Object.prototype.hasOwnProperty.call(clone, key)) {
      clone[key] = '[redacted]';
    }
  }
  return clone;
}

function writeAudit(event, detail = {}) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    event,
    detail: sanitizeDetail(detail)
  });
  fs.appendFileSync(config.auditLogPath, `${line}\n`);
}

module.exports = {
  writeAudit
};
