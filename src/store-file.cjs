'use strict';

/**
 * Shared durable write for the local JSON stores and firmware artifacts.
 * The temp fd is fsynced before the atomic rename, and the directory is
 * fsynced after: without the directory fsync an unclean shutdown can lose
 * the rename even though the temp contents were committed.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function writeFileAtomicDurable(filePath, contents) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const token = crypto.randomBytes(8).toString('hex');
  const tmp = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${token}.tmp`
  );
  let pending = false;
  try {
    const fd = fs.openSync(tmp, 'wx', 0o600);
    pending = true;
    try {
      if (typeof contents === 'string') fs.writeFileSync(fd, contents, 'utf8');
      else fs.writeFileSync(fd, contents);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, filePath);
    pending = false;
    const dirFd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  } finally {
    if (pending) {
      try { fs.unlinkSync(tmp); } catch {
        // ignore tmp cleanup
      }
    }
  }
}

function writeTextFileAtomic(filePath, text) {
  writeFileAtomicDurable(filePath, text);
}

module.exports = { writeFileAtomicDurable, writeTextFileAtomic };
