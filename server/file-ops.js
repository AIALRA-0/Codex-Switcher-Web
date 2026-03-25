'use strict';

const fs = require('fs');
const path = require('path');

function atomicWriteFile(targetPath, content, options = {}) {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });
  const tempPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  const mode = Number.isInteger(options.mode) ? options.mode : 0o600;
  fs.writeFileSync(tempPath, content, { mode });
  if (Number.isInteger(options.uid) || Number.isInteger(options.gid)) {
    const uid = Number.isInteger(options.uid) ? options.uid : -1;
    const gid = Number.isInteger(options.gid) ? options.gid : -1;
    fs.chownSync(tempPath, uid, gid);
  }
  fs.renameSync(tempPath, targetPath);
  if (Number.isInteger(options.uid) || Number.isInteger(options.gid)) {
    const uid = Number.isInteger(options.uid) ? options.uid : -1;
    const gid = Number.isInteger(options.gid) ? options.gid : -1;
    fs.chownSync(targetPath, uid, gid);
  }
  fs.chmodSync(targetPath, mode);
}

module.exports = {
  atomicWriteFile
};
