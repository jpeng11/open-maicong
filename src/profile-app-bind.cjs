'use strict';

/**
 * Host-side G75 game/app auto-bind.
 *
 * Vendor hub (1833 `eu` / delete dialog) talks to the Windows parent via
 * COMMAND_GET_IS_BIND_EXE and COMMAND_DELETE_BIND_CONFIG. There is no GLW
 * opcode. This Mac store is the same function: one onboard slot per app
 * bundle, activate that slot when the app is frontmost.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const lightingMemory = require('./lighting-memory.cjs');

const SCHEMA = 'maicong.g75v2.app-bind';
const SCHEMA_VERSION = '1.0.0';
const MAX_BINDS = 4;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_DEVICES = 32;
const BUNDLE_RE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,253}$/;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function defaultLocalPath() {
  try {
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') {
      return path.join(app.getPath('userData'), 'profile-app-binds.json');
    }
  } catch {
    // node unit tests
  }
  return path.join(os.tmpdir(), 'maicong-profile-app-binds.json');
}

function emptyFile() {
  return { schema: SCHEMA, version: SCHEMA_VERSION, devices: {} };
}

function deviceStorageKey(device) {
  return lightingMemory.deviceStorageKey(device);
}

function normalizeBundleId(value) {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  if (!id || !BUNDLE_RE.test(id)) return null;
  return id;
}

function parseProfileIndex(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 3) return null;
  return n;
}

function normalizeBind(raw) {
  if (!isPlainObject(raw)) return null;
  const profileIndex = parseProfileIndex(raw.profileIndex);
  const bundleId = normalizeBundleId(raw.bundleId);
  if (profileIndex == null || !bundleId) return null;
  const displayName = typeof raw.displayName === 'string' && raw.displayName.trim()
    ? raw.displayName.trim().slice(0, 80)
    : bundleId;
  const appPath = typeof raw.appPath === 'string' && raw.appPath.trim()
    ? raw.appPath.trim().slice(0, 1024)
    : null;
  return { profileIndex, bundleId, displayName, appPath };
}

function validateBinds(list) {
  if (!Array.isArray(list)) return { valid: false, error: 'App bind list is malformed' };
  if (list.length > MAX_BINDS) return { valid: false, error: 'Too many app binds' };
  const seenSlot = new Set();
  const seenBundle = new Set();
  const binds = [];
  for (const raw of list) {
    const bind = normalizeBind(raw);
    if (!bind) return { valid: false, error: 'App bind entry is malformed' };
    if (seenSlot.has(bind.profileIndex)) {
      return { valid: false, error: 'Each onboard profile can link to only one app' };
    }
    if (seenBundle.has(bind.bundleId.toLowerCase())) {
      return { valid: false, error: 'Each app can link to only one onboard profile' };
    }
    seenSlot.add(bind.profileIndex);
    seenBundle.add(bind.bundleId.toLowerCase());
    binds.push(bind);
  }
  return { valid: true, binds };
}

function readDevice(filePath, deviceKey) {
  if (typeof deviceKey !== 'string' || !deviceKey) {
    return { ok: false, binds: [], error: 'Device identity is missing' };
  }
  try {
    if (!filePath || !fs.existsSync(filePath)) {
      return { ok: true, missing: true, binds: [] };
    }
    const st = fs.statSync(filePath);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) {
      return { ok: false, binds: [], unwritable: true, error: 'App bind file exceeds the bounded size' };
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!isPlainObject(parsed) || !isPlainObject(parsed.devices)) {
      return { ok: false, binds: [], unwritable: true, error: 'App bind file is malformed' };
    }
    if (Object.keys(parsed.devices).length > MAX_DEVICES) {
      return { ok: false, binds: [], unwritable: true, error: 'App bind file has too many devices' };
    }
    const device = parsed.devices[deviceKey];
    if (!device) return { ok: true, binds: [] };
    const checked = validateBinds(device.binds);
    if (!checked.valid) {
      return { ok: false, binds: [], unwritable: true, error: checked.error };
    }
    return { ok: true, binds: checked.binds };
  } catch (err) {
    return { ok: false, binds: [], unwritable: true, error: err.message || 'App bind file is unreadable' };
  }
}

function writeDevice(filePath, deviceKey, binds) {
  if (typeof deviceKey !== 'string' || !deviceKey) {
    throw new Error('Device identity is missing');
  }
  const checked = validateBinds(binds);
  if (!checked.valid) throw new Error(checked.error);
  let file = emptyFile();
  if (filePath && fs.existsSync(filePath)) {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed) || !isPlainObject(parsed.devices)) {
      throw new Error('App bind file is malformed');
    }
    file = parsed;
    file.schema = SCHEMA;
    file.version = SCHEMA_VERSION;
    if (!isPlainObject(file.devices)) file.devices = {};
  }
  if (checked.binds.length === 0) {
    delete file.devices[deviceKey];
  } else {
    file.devices[deviceKey] = { binds: cloneJson(checked.binds) };
  }
  const json = JSON.stringify(file, null, 2);
  if (Buffer.byteLength(json, 'utf8') > MAX_FILE_BYTES) {
    throw new Error('App bind file exceeds the bounded size');
  }
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, json, 'utf8');
  fs.renameSync(tmp, filePath);
  return checked.binds;
}

function bindForProfile(binds, profileIndex) {
  const idx = parseProfileIndex(profileIndex);
  if (idx == null || !Array.isArray(binds)) return null;
  return binds.find((row) => row.profileIndex === idx) || null;
}

function bindForBundle(binds, bundleId) {
  const id = normalizeBundleId(bundleId);
  if (!id || !Array.isArray(binds)) return null;
  const lower = id.toLowerCase();
  return binds.find((row) => row.bundleId.toLowerCase() === lower) || null;
}

function setBind(binds, spec) {
  const next = normalizeBind(spec);
  if (!next) return { valid: false, error: 'App bind requires an onboard slot 0..3 and a bundle id' };
  const current = Array.isArray(binds) ? binds.slice() : [];
  const without = current.filter((row) => (
    row.profileIndex !== next.profileIndex
    && row.bundleId.toLowerCase() !== next.bundleId.toLowerCase()
  ));
  without.push(next);
  const checked = validateBinds(without);
  if (!checked.valid) return checked;
  return { valid: true, binds: checked.binds, bind: next };
}

function deleteBind(binds, profileIndex) {
  const idx = parseProfileIndex(profileIndex);
  if (idx == null) return { valid: false, error: 'profileIndex must be 0..3' };
  const current = Array.isArray(binds) ? binds.slice() : [];
  const removed = current.find((row) => row.profileIndex === idx) || null;
  const next = current.filter((row) => row.profileIndex !== idx);
  return { valid: true, binds: next, removed, changed: Boolean(removed) };
}

function matchFrontmost(binds, frontmost) {
  const id = frontmost && (frontmost.bundleId || frontmost.id);
  const hit = bindForBundle(binds, id);
  if (!hit) return null;
  return hit;
}

function profileIndexFromOnboardKey(key) {
  if (typeof key !== 'string') return null;
  const match = /^KeyboardProfile@keyboard@(\d+)$/.exec(key);
  if (!match) return null;
  return parseProfileIndex(match[1]);
}

function parseLsappinfo(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const bundle = /CFBundleIdentifier\s*=\s*"([^"]+)"/i.exec(text)
    || /"CFBundleIdentifier"\s*=\s*"([^"]+)"/i.exec(text);
  if (!bundle) return null;
  const name = /LSDisplayName\s*=\s*"([^"]+)"/i.exec(text)
    || /"LSDisplayName"\s*=\s*"([^"]+)"/i.exec(text);
  return {
    bundleId: bundle[1],
    displayName: name ? name[1] : bundle[1]
  };
}

module.exports = {
  SCHEMA,
  SCHEMA_VERSION,
  MAX_BINDS,
  defaultLocalPath,
  emptyFile,
  deviceStorageKey,
  normalizeBundleId,
  parseProfileIndex,
  normalizeBind,
  validateBinds,
  readDevice,
  writeDevice,
  bindForProfile,
  bindForBundle,
  setBind,
  deleteBind,
  matchFrontmost,
  profileIndexFromOnboardKey,
  parseLsappinfo
};
