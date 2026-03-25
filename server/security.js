'use strict';

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { config } = require('./config');

function createAesKey(secret) {
  return crypto.createHash('sha256').update(secret).digest();
}

function encryptString(data) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', createAesKey(config.profileEncryptionKey), iv);
  const encrypted = Buffer.concat([cipher.update(data, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

function decryptString(payload) {
  const buffer = Buffer.from(payload, 'base64');
  const iv = buffer.subarray(0, 12);
  const tag = buffer.subarray(12, 28);
  const encrypted = buffer.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', createAesKey(config.profileEncryptionKey), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

function hashToken(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function randomToken(size = 32) {
  return crypto.randomBytes(size).toString('hex');
}

function timingSafeEqualHex(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function genCSRF(req) {
  if (!req.session.csrf) req.session.csrf = randomToken(16);
  return req.session.csrf;
}

function verifyCSRF(req, res, next) {
  const token = req.get('x-csrf-token');
  if (!token || !req.session || !req.session.csrf || !timingSafeEqualHex(token, req.session.csrf)) {
    return res.status(403).json({ ok: false, error: 'BAD_CSRF' });
  }
  return next();
}

function assertAuth(req, res, next) {
  if (req.session && req.session.adminUserId) return next();
  return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
}

async function hashPassword(password) {
  return bcrypt.hash(password, 12);
}

async function verifyPassword(password, passwordHash) {
  return bcrypt.compare(password, passwordHash);
}

module.exports = {
  assertAuth,
  decryptString,
  encryptString,
  genCSRF,
  hashPassword,
  hashToken,
  randomToken,
  verifyCSRF,
  verifyPassword
};
