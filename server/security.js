'use strict';

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { config } = require('./config');
const PORTABLE_SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };
const PORTABLE_PASSPHRASE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

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

function ensurePassphrase(passphrase) {
  const value = String(passphrase || '');
  if (!value) throw new Error('PASSPHRASE_REQUIRED');
  return value;
}

function derivePortableKey(passphrase, salt) {
  return crypto.scryptSync(ensurePassphrase(passphrase), salt, 32, PORTABLE_SCRYPT_PARAMS);
}

function encryptWithPassphrase(data, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = derivePortableKey(passphrase, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(String(data), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    kdf: 'scrypt',
    kdf_params: { ...PORTABLE_SCRYPT_PARAMS },
    cipher: 'aes-256-gcm',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    payload: encrypted.toString('base64')
  };
}

function decryptWithPassphrase(envelope, passphrase) {
  if (!envelope || envelope.kdf !== 'scrypt' || envelope.cipher !== 'aes-256-gcm') {
    throw new Error('UNSUPPORTED_ENCRYPTION');
  }
  const salt = Buffer.from(String(envelope.salt || ''), 'base64');
  const iv = Buffer.from(String(envelope.iv || ''), 'base64');
  const tag = Buffer.from(String(envelope.tag || ''), 'base64');
  const payload = Buffer.from(String(envelope.payload || ''), 'base64');
  const key = derivePortableKey(passphrase, salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(payload), decipher.final()]).toString('utf8');
}

function hashToken(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function randomToken(size = 32) {
  return crypto.randomBytes(size).toString('hex');
}

function generatePortablePassphrase(length = 10) {
  const size = Math.max(6, Math.min(18, Math.trunc(length) || 10));
  const bytes = crypto.randomBytes(size);
  let text = '';
  for (let index = 0; index < size; index += 1) {
    text += PORTABLE_PASSPHRASE_ALPHABET[bytes[index] % PORTABLE_PASSPHRASE_ALPHABET.length];
  }
  if (size <= 5) return text;
  return `${text.slice(0, 5)}-${text.slice(5)}`;
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
  decryptWithPassphrase,
  decryptString,
  encryptWithPassphrase,
  encryptString,
  generatePortablePassphrase,
  genCSRF,
  hashPassword,
  hashToken,
  randomToken,
  verifyCSRF,
  verifyPassword
};
