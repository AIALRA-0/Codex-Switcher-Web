'use strict';

const fs = require('fs');
const path = require('path');

function atomicWriteFile(targetPath, content) {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });
  const tempPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, content, { mode: 0o600 });
  fs.renameSync(tempPath, targetPath);
}

module.exports = {
  atomicWriteFile
};
