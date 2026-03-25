'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { atomicWriteFile } = require('../server/file-ops');

test('atomicWriteFile replaces file content atomically enough for single-process usage', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-switcher-file-'));
  const filePath = path.join(dir, 'auth.json');
  atomicWriteFile(filePath, '{"a":1}');
  atomicWriteFile(filePath, '{"a":2}');
  assert.equal(fs.readFileSync(filePath, 'utf8'), '{"a":2}');
  fs.rmSync(dir, { recursive: true, force: true });
});
