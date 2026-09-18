/**
 * G75 lighting effect memory (custom region offset 728 length 112).
 * Marker <light@v2> is TEN bytes; counts at 10/11/12, records at 13.
 * Local fallback is a bounded file store with device/profile isolation.
 * Does not implement the vendor mutating support probe at offset 968.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const storeFile = require('./store-file.cjs');

const LIGHT_MEMORY_MARKER = Buffer.from('<light@v2>', 'ascii');
const LIGHT_MEMORY_OFFSET = 728;
const LIGHT_MEMORY_LENGTH = 112;
const CUSTOM_PARAM_SIZE = 1024;
const LIGHT_MEMORY_MAX_RECORDS = 16;
const LIGHT_MEMORY_SCHEMA_VERSION = '1.0.0';
const MAX_LOCAL_FILE_BYTES = 64 * 1024;
const MAX_LOCAL_DEVICES = 32;
const HEX_COLOR_REGEX = /^#[0-9A-Fa-f]{6}$/;

function emptyStore() {
  return { main: [], side: [], side2: [] };
}

function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map((x) => (x & 0xFF).toString(16).padStart(2, '0')).join('').toUpperCase();
}

function hexToRgb(hex) {
  if (!hex || typeof hex !== 'string' || !HEX_COLOR_REGEX.test(hex)) return { r: 0, g: 0, b: 0 };
  const clean = hex.replace('#', '');
  return {
    r: parseInt(clean.substring(0, 2), 16),
    g: parseInt(clean.substring(2, 4), 16),
    b: parseInt(clean.substring(4, 6), 16)
  };
}

function clampByte(n) {
  return Math.max(0, Math.min(255, n | 0));
}

function uniqueBy(arr, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of arr) {
    const k = keyFn(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

function parseMainRecord(bytes) {
  const flags = bytes[4] & 0xFF;
  return {
    effect: bytes[0] & 0xFF,
    hexColor: rgbToHex(bytes[1], bytes[2], bytes[3]),
    speed: flags >> 4,
    direction: (flags >> 1) & 7,
    customColorDisabled: Boolean(flags & 1),
    brightness: bytes[5] & 0xFF,
    flags
  };
}

function parseSideRecord(bytes) {
  const flags = bytes[4] & 0xFF;
  return {
    sideEffect: bytes[0] & 0xFF,
    sideHexColor: rgbToHex(bytes[1], bytes[2], bytes[3]),
    sideSpeed: flags >> 4,
    sideCustomColorDisabled: Boolean(flags & 1),
    sideBrightness: bytes[5] & 0xFF,
    flags
  };
}

function encodeFlagsFromFields(speed, directionBits, disabled, previousFlags, preserveDirHighBits) {
  const prev = Number.isInteger(previousFlags) ? previousFlags & 0xFF : 0;
  const nibble = Number.isInteger(speed) ? (speed & 15) : (prev >> 4);
  const bit0 = disabled ? 1 : 0;
  const preserved = preserveDirHighBits ? (prev & 0x0C) : 0;
  const dir = Number.isInteger(directionBits) ? (directionBits & 7) : ((prev >> 1) & 7);
  const dirBits = preserveDirHighBits ? (((dir & 1) << 1) | preserved) : ((dir & 7) << 1);
  return (nibble << 4) | dirBits | bit0;
}

function encodeMainRecord(rec) {
  const rgb = hexToRgb(rec.hexColor);
  const flags = Number.isInteger(rec.flags)
    ? rec.flags & 0xFF
    : encodeFlagsFromFields(rec.speed, rec.direction ? 1 : 0, rec.customColorDisabled, 0, false);
  return [rec.effect & 0xFF, rgb.r, rgb.g, rgb.b, flags, clampByte(rec.brightness)];
}

function encodeSideRecord(rec) {
  const rgb = hexToRgb(rec.sideHexColor);
  const flags = Number.isInteger(rec.flags)
    ? rec.flags & 0xFF
    : encodeFlagsFromFields(rec.sideSpeed, 0, rec.sideCustomColorDisabled, 0, false);
  return [rec.sideEffect & 0xFF, rgb.r, rgb.g, rgb.b, flags, clampByte(rec.sideBrightness)];
}

function encodeSide2Record(rec) {
  const rgb = hexToRgb(rec.hexColor);
  const flags = Number.isInteger(rec.flags)
    ? rec.flags & 0xFF
    : encodeFlagsFromFields(rec.speed, 0, rec.customColorDisabled, 0, false);
  return [rec.effect & 0xFF, rgb.r, rgb.g, rgb.b, flags, clampByte(rec.brightness)];
}

function markerMatches(buf) {
  if (!buf || buf.length < LIGHT_MEMORY_MARKER.length) return false;
  for (let i = 0; i < LIGHT_MEMORY_MARKER.length; i++) {
    if (buf[i] !== LIGHT_MEMORY_MARKER[i]) return false;
  }
  return true;
}

function parseLightMemory(buf) {
  if (!buf || buf.length !== LIGHT_MEMORY_LENGTH) {
    return { valid: false, error: `Lighting memory must be exactly ${LIGHT_MEMORY_LENGTH} bytes`, store: emptyStore() };
  }
  const raw = Buffer.from(buf);
  if (!markerMatches(raw)) {
    return { valid: true, empty: true, backendHint: 'hardware-empty', store: emptyStore(), raw };
  }
  const mainCount = raw[10];
  const sideCount = raw[11];
  const side2Count = raw[12];
  if (![mainCount, sideCount, side2Count].every((n) => Number.isInteger(n) && n >= 0 && n <= LIGHT_MEMORY_MAX_RECORDS)) {
    return { valid: false, error: 'Malformed lighting memory counts', store: emptyStore(), raw };
  }
  const total = mainCount + sideCount + side2Count;
  const needed = 13 + total * 6;
  if (needed > LIGHT_MEMORY_LENGTH) {
    return { valid: false, error: 'Lighting memory counts exceed the 112-byte region', store: emptyStore(), raw };
  }
  const store = emptyStore();
  let off = 13;
  for (let i = 0; i < mainCount; i++, off += 6) {
    store.main.push(parseMainRecord(raw.subarray(off, off + 6)));
  }
  for (let i = 0; i < sideCount; i++, off += 6) {
    store.side.push(parseSideRecord(raw.subarray(off, off + 6)));
  }
  for (let i = 0; i < side2Count; i++, off += 6) {
    store.side2.push(parseMainRecord(raw.subarray(off, off + 6)));
  }
  return { valid: true, empty: total === 0, store, raw };
}

function normalizeLightMemory(store) {
  const src = store && typeof store === 'object' ? store : emptyStore();
  const mainIn = Array.isArray(src.main) ? src.main.filter((r) => r && typeof r === 'object') : [];
  const sideIn = Array.isArray(src.side) ? src.side.filter((r) => r && typeof r === 'object') : [];
  const side2In = Array.isArray(src.side2) ? src.side2.filter((r) => r && typeof r === 'object') : [];
  const main = uniqueBy(mainIn, (r) => r.effect);
  const side = uniqueBy(sideIn, (r) => r.sideEffect);
  const side2 = uniqueBy(side2In, (r) => r.effect);
  const outMain = [];
  const outSide = [];
  const outSide2 = [];
  let i = 0;
  let j = 0;
  let k = 0;
  const total = () => outMain.length + outSide.length + outSide2.length;
  while ((i < main.length || j < side.length || k < side2.length) && total() < LIGHT_MEMORY_MAX_RECORDS) {
    if (i < main.length && total() < LIGHT_MEMORY_MAX_RECORDS) outMain.push(main[i++]);
    if (j < side.length && total() < LIGHT_MEMORY_MAX_RECORDS) outSide.push(side[j++]);
    if (k < side2.length && total() < LIGHT_MEMORY_MAX_RECORDS) outSide2.push(side2[k++]);
  }
  return { main: outMain, side: outSide, side2: outSide2 };
}

function serializeLightMemory(store, priorBuf = null) {
  const normalized = normalizeLightMemory(store);
  const out = Buffer.alloc(LIGHT_MEMORY_LENGTH, 0);
  if (priorBuf && priorBuf.length === LIGHT_MEMORY_LENGTH) {
    Buffer.from(priorBuf).copy(out);
  }
  LIGHT_MEMORY_MARKER.copy(out, 0);
  out[10] = normalized.main.length;
  out[11] = normalized.side.length;
  out[12] = normalized.side2.length;
  let off = 13;
  for (const rec of normalized.main) {
    Buffer.from(encodeMainRecord(rec)).copy(out, off);
    off += 6;
  }
  for (const rec of normalized.side) {
    Buffer.from(encodeSideRecord(rec)).copy(out, off);
    off += 6;
  }
  for (const rec of normalized.side2) {
    Buffer.from(encodeSide2Record(rec)).copy(out, off);
    off += 6;
  }
  return out;
}

function lightingMemoryOffset(profileIndex) {
  return (profileIndex * CUSTOM_PARAM_SIZE) + LIGHT_MEMORY_OFFSET;
}

function recordFromMainLighting(lighting, previous) {
  const flags = encodeFlagsFromFields(
    lighting.speed,
    lighting.direction ? 1 : 0,
    Boolean(lighting.customColorDisabled),
    previous && previous.flags,
    Number.isInteger(previous && previous.flags)
  );
  return {
    effect: lighting.effect,
    hexColor: lighting.hexColor || '#000000',
    speed: lighting.speed,
    direction: (flags >> 1) & 7,
    customColorDisabled: Boolean(lighting.customColorDisabled),
    brightness: lighting.brightness,
    flags
  };
}

function recordFromSideLighting(lighting, previous) {
  const flags = encodeFlagsFromFields(
    lighting.sideSpeed,
    0,
    Boolean(lighting.sideCustomColorDisabled),
    previous && previous.flags,
    Number.isInteger(previous && previous.flags)
  );
  return {
    sideEffect: lighting.sideEffect,
    sideHexColor: lighting.sideHexColor || '#000000',
    sideSpeed: lighting.sideSpeed,
    sideCustomColorDisabled: Boolean(lighting.sideCustomColorDisabled),
    sideBrightness: lighting.sideBrightness,
    flags
  };
}

function rememberLighting(store, lighting, options = {}) {
  const hasSide = options.hasSide !== false;
  const next = {
    main: Array.isArray(store && store.main) ? store.main.slice() : [],
    side: hasSide && Array.isArray(store && store.side) ? store.side.slice() : [],
    side2: Array.isArray(store && store.side2) ? store.side2.slice() : []
  };
  if (!hasSide) next.side = [];
  if (lighting && Number.isInteger(lighting.brightness) && lighting.brightness > 0) {
    const prev = next.main.find((r) => r.effect === lighting.effect);
    const rec = recordFromMainLighting(lighting, prev);
    next.main = [rec, ...next.main.filter((r) => r.effect !== rec.effect)];
  }
  if (hasSide && lighting && Number.isInteger(lighting.sideBrightness) && lighting.sideBrightness > 0) {
    const prev = next.side.find((r) => r.sideEffect === lighting.sideEffect);
    const rec = recordFromSideLighting(lighting, prev);
    next.side = [rec, ...next.side.filter((r) => r.sideEffect !== rec.sideEffect)];
  }
  return normalizeLightMemory(next);
}

function clampLightingSpeed(n) {
  if (!Number.isInteger(n)) return undefined;
  return Math.max(0, Math.min(4, n));
}

function clampLightingBrightness(n) {
  if (!Number.isInteger(n)) return undefined;
  return Math.max(0, Math.min(100, n));
}

function restoreMainSelection(store, effectId, current = {}) {
  const rec = (store && store.main || []).find((r) => r.effect === effectId);
  const brightness = clampLightingBrightness((rec && rec.brightness) || current.brightness || 100);
  const fields = { effect: effectId, brightness };
  if (rec) {
    const speed = clampLightingSpeed(rec.speed);
    if (speed !== undefined) fields.speed = speed;
    if (rec.direction !== undefined) fields.direction = rec.direction ? 1 : 0;
    if (rec.customColorDisabled !== undefined) fields.customColorDisabled = Boolean(rec.customColorDisabled);
    if (rec.hexColor) fields.hexColor = rec.hexColor;
  }
  return fields;
}

function restoreSideSelection(store, sideEffect, current = {}) {
  const rec = (store && store.side || []).find((r) => r.sideEffect === sideEffect);
  const sideBrightness = clampLightingBrightness((rec && rec.sideBrightness) || current.sideBrightness || 100);
  const fields = { sideEffect, sideBrightness };
  if (rec) {
    const speed = clampLightingSpeed(rec.sideSpeed);
    if (speed !== undefined) fields.sideSpeed = speed;
    if (rec.sideCustomColorDisabled !== undefined) {
      fields.sideCustomColorDisabled = Boolean(rec.sideCustomColorDisabled);
    }
    if (rec.sideHexColor) fields.sideHexColor = rec.sideHexColor;
  }
  return fields;
}

function shouldPersistLightingMemory(params) {
  if (!params || typeof params !== 'object') return false;
  const keys = Object.keys(params);
  if (keys.length === 0) return false;
  return keys.some((k) => k !== 'calibrationRgb');
}

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function isUint8(n) {
  return Number.isInteger(n) && n >= 0 && n <= 255;
}

function validateMainOrSide2Record(rec, kind) {
  if (!isPlainObject(rec)) return { valid: false, error: `${kind} records must be objects` };
  const allowed = new Set(['effect', 'hexColor', 'speed', 'direction', 'customColorDisabled', 'brightness', 'flags']);
  for (const key of Object.keys(rec)) {
    if (!allowed.has(key)) return { valid: false, error: `${kind} unknown property "${key}"` };
  }
  if (!isUint8(rec.effect)) return { valid: false, error: `${kind} effect must be integer 0..255` };
  if (typeof rec.hexColor !== 'string' || !HEX_COLOR_REGEX.test(rec.hexColor)) {
    return { valid: false, error: `${kind} hexColor must be #RRGGBB` };
  }
  if (!isUint8(rec.brightness)) return { valid: false, error: `${kind} brightness must be integer 0..255` };
  if (rec.speed !== undefined && !(Number.isInteger(rec.speed) && rec.speed >= 0 && rec.speed <= 15)) {
    return { valid: false, error: `${kind} speed must be integer 0..15` };
  }
  if (rec.direction !== undefined && !(Number.isInteger(rec.direction) && rec.direction >= 0 && rec.direction <= 7)) {
    return { valid: false, error: `${kind} direction must be integer 0..7` };
  }
  if (rec.customColorDisabled !== undefined && typeof rec.customColorDisabled !== 'boolean') {
    return { valid: false, error: `${kind} customColorDisabled must be boolean` };
  }
  if (rec.flags !== undefined && !isUint8(rec.flags)) {
    return { valid: false, error: `${kind} flags must be integer 0..255` };
  }
  return { valid: true };
}

function validateSideRecord(rec, kind) {
  if (!isPlainObject(rec)) return { valid: false, error: `${kind} records must be objects` };
  const allowed = new Set(['sideEffect', 'sideHexColor', 'sideSpeed', 'sideCustomColorDisabled', 'sideBrightness', 'flags']);
  for (const key of Object.keys(rec)) {
    if (!allowed.has(key)) return { valid: false, error: `${kind} unknown property "${key}"` };
  }
  if (!isUint8(rec.sideEffect)) return { valid: false, error: `${kind} sideEffect must be integer 0..255` };
  if (typeof rec.sideHexColor !== 'string' || !HEX_COLOR_REGEX.test(rec.sideHexColor)) {
    return { valid: false, error: `${kind} sideHexColor must be #RRGGBB` };
  }
  if (!isUint8(rec.sideBrightness)) return { valid: false, error: `${kind} sideBrightness must be integer 0..255` };
  if (rec.sideSpeed !== undefined && !(Number.isInteger(rec.sideSpeed) && rec.sideSpeed >= 0 && rec.sideSpeed <= 15)) {
    return { valid: false, error: `${kind} sideSpeed must be integer 0..15` };
  }
  if (rec.sideCustomColorDisabled !== undefined && typeof rec.sideCustomColorDisabled !== 'boolean') {
    return { valid: false, error: `${kind} sideCustomColorDisabled must be boolean` };
  }
  if (rec.flags !== undefined && !isUint8(rec.flags)) {
    return { valid: false, error: `${kind} flags must be integer 0..255` };
  }
  return { valid: true };
}

function validateRecordList(list, kind, validator) {
  if (!Array.isArray(list)) return { valid: false, error: `${kind} must be an array` };
  if (list.length > LIGHT_MEMORY_MAX_RECORDS) {
    return { valid: false, error: `${kind} exceeds ${LIGHT_MEMORY_MAX_RECORDS} records` };
  }
  for (const rec of list) {
    const recVal = validator(rec, kind);
    if (!recVal.valid) return recVal;
  }
  return { valid: true };
}

function validateImportedLightingMemory(value) {
  if (value === undefined) return { valid: true, omitted: true };
  if (!isPlainObject(value)) {
    return { valid: false, error: 'lightingMemory must be a plain object when present' };
  }
  const allowed = new Set(['version', 'main', 'side', 'side2']);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      return { valid: false, error: `Unknown lightingMemory key: "${key}"` };
    }
  }
  if (value.version !== undefined && value.version !== LIGHT_MEMORY_SCHEMA_VERSION) {
    return { valid: false, error: `Unsupported lightingMemory.version: "${value.version}"` };
  }
  if (value.main !== undefined) {
    const recVal = validateRecordList(value.main, 'lightingMemory.main', validateMainOrSide2Record);
    if (!recVal.valid) return recVal;
  }
  if (value.side !== undefined) {
    const recVal = validateRecordList(value.side, 'lightingMemory.side', validateSideRecord);
    if (!recVal.valid) return recVal;
  }
  if (value.side2 !== undefined) {
    const recVal = validateRecordList(value.side2, 'lightingMemory.side2', validateMainOrSide2Record);
    if (!recVal.valid) return recVal;
  }
  return {
    valid: true,
    store: normalizeLightMemory({
      main: value.main || [],
      side: value.side || [],
      side2: value.side2 || []
    })
  };
}

function deviceIdentity(device = {}) {
  const vid = Number.isInteger(device.vendorId) ? device.vendorId : 0;
  const pid = Number.isInteger(device.productId) ? device.productId : 0;
  const serial = device.serialNumber == null ? '' : String(device.serialNumber).trim();
  if (serial) {
    return { key: `${vid}:${pid}:sn:${serial}`, kind: 'serial', durable: true, serial };
  }
  const hidPath = device.path == null ? '' : String(device.path).trim();
  if (hidPath) {
    return { key: `${vid}:${pid}:path:${hidPath}`, kind: 'path', durable: false, path: hidPath };
  }
  return { key: `${vid}:${pid}:unscoped`, kind: 'unscoped', durable: false };
}

function deviceStorageKey(device = {}) {
  return deviceIdentity(device).key;
}

function describeMemoryIdentity(device = {}, fallback = 'hardware') {
  const id = deviceIdentity(device);
  if (fallback === 'local') {
    if (id.kind === 'serial') {
      return `On this Mac for serial ${id.serial}. Not written to the keyboard.`;
    }
    if (id.kind === 'path') {
      return 'On this Mac for this USB connection. The path can change after reconnect, so this is not a durable keyboard identity.';
    }
    return 'On this Mac for this product ID only. Two keyboards of this model cannot be told apart.';
  }
  if (id.kind === 'serial') {
    return 'On this keyboard. A successful read does not prove writes.';
  }
  if (id.kind === 'path') {
    return 'On the keyboard. This connection has no serial number, so This Mac memories would not be a durable keyboard identity.';
  }
  return 'On the keyboard. This connection has no serial number.';
}

function defaultLocalPath() {
  try {
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') {
      return path.join(app.getPath('userData'), 'lighting-memory.json');
    }
  } catch {
    // node unit tests
  }
  return path.join(os.tmpdir(), 'maicong-lighting-memory.json');
}

function emptyFile() {
  return { version: LIGHT_MEMORY_SCHEMA_VERSION, devices: {} };
}

function parseLocalDocument(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return { ok: true, missing: true, data: emptyFile() };
    }
    const st = fs.statSync(filePath);
    if (!st.isFile() || st.size > MAX_LOCAL_FILE_BYTES) {
      return {
        ok: false,
        unwritable: true,
        recovered: true,
        error: 'Lighting memory local file exceeds the bounded size'
      };
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    if (Buffer.byteLength(raw, 'utf8') > MAX_LOCAL_FILE_BYTES) {
      return {
        ok: false,
        unwritable: true,
        recovered: true,
        error: 'Lighting memory local file exceeds the bounded size'
      };
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return {
        ok: false,
        unwritable: true,
        recovered: true,
        error: err.message || 'Lighting memory local file is not valid JSON'
      };
    }
    if (!isPlainObject(parsed) || !isPlainObject(parsed.devices)) {
      return {
        ok: false,
        unwritable: true,
        recovered: true,
        error: 'Lighting memory local file is malformed'
      };
    }
    if (parsed.version !== undefined && parsed.version !== LIGHT_MEMORY_SCHEMA_VERSION) {
      return {
        ok: false,
        unwritable: true,
        recovered: true,
        error: `Unsupported lighting memory file version: "${parsed.version}"`
      };
    }
    const deviceKeys = Object.keys(parsed.devices);
    if (deviceKeys.length > MAX_LOCAL_DEVICES) {
      return {
        ok: false,
        unwritable: true,
        recovered: true,
        error: 'Lighting memory local file has too many devices'
      };
    }
    return { ok: true, data: parsed };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: true, missing: true, data: emptyFile() };
    return { ok: false, unwritable: true, recovered: true, error: err.message || String(err) };
  }
}

function loadLocalFile(filePath) {
  const doc = parseLocalDocument(filePath);
  if (!doc.ok) {
    return { ...emptyFile(), recovered: true, unwritable: true, error: doc.error };
  }
  return doc.data;
}

function saveLocalFileAtomic(filePath, data) {
  const text = JSON.stringify(data, null, 2);
  if (Buffer.byteLength(text, 'utf8') > MAX_LOCAL_FILE_BYTES) {
    throw new Error('Lighting memory local file would exceed the bounded size');
  }
  storeFile.writeTextFileAtomic(filePath, text);
}

function readLocalProfile(filePath, deviceKey, profileIndex) {
  const doc = parseLocalDocument(filePath);
  if (!doc.ok) return emptyStore();
  const device = doc.data.devices && doc.data.devices[deviceKey];
  const rec = device && device.profiles && device.profiles[String(profileIndex)];
  if (!rec || typeof rec !== 'object') return emptyStore();
  const val = validateImportedLightingMemory({
    version: LIGHT_MEMORY_SCHEMA_VERSION,
    main: rec.main,
    side: rec.side,
    side2: rec.side2
  });
  if (!val.valid) return emptyStore();
  return val.store;
}

function writeLocalProfile(filePath, deviceKey, profileIndex, store) {
  if (!Number.isInteger(profileIndex) || profileIndex < 0 || profileIndex > 3) {
    throw new Error('Lighting memory profile index must be 0..3');
  }
  const val = validateImportedLightingMemory({
    version: LIGHT_MEMORY_SCHEMA_VERSION,
    ...normalizeLightMemory(store)
  });
  if (!val.valid) throw new Error(val.error || 'Invalid lighting memory store');
  const doc = parseLocalDocument(filePath);
  if (!doc.ok) {
    throw new Error(`${doc.error || 'Local lighting memory file is unreadable'}; existing file was left unchanged`);
  }
  const file = doc.data;
  if (!file.devices) file.devices = {};
  if (!file.devices[deviceKey]) {
    if (Object.keys(file.devices).length >= MAX_LOCAL_DEVICES) {
      throw new Error('Lighting memory local store is at the device limit');
    }
    file.devices[deviceKey] = { profiles: {} };
  }
  if (!isPlainObject(file.devices[deviceKey])) file.devices[deviceKey] = { profiles: {} };
  if (!isPlainObject(file.devices[deviceKey].profiles)) file.devices[deviceKey].profiles = {};
  file.devices[deviceKey].profiles[String(profileIndex)] = val.store;
  file.version = LIGHT_MEMORY_SCHEMA_VERSION;
  saveLocalFileAtomic(filePath, file);
  return file.devices[deviceKey].profiles[String(profileIndex)];
}

function readDeviceFallback(filePath, deviceKey) {
  const doc = parseLocalDocument(filePath);
  if (!doc.ok) {
    return { fallback: 'hardware', recovered: true, unwritable: true, error: doc.error };
  }
  const device = doc.data.devices && doc.data.devices[deviceKey];
  const fallback = device && device.fallback === 'local' ? 'local' : 'hardware';
  return { fallback, recovered: false, unwritable: false };
}

function writeDeviceFallback(filePath, deviceKey, fallback, identity = {}) {
  if (fallback !== 'hardware' && fallback !== 'local') {
    throw new Error('Lighting memory fallback must be hardware or local');
  }
  const doc = parseLocalDocument(filePath);
  if (!doc.ok) {
    throw new Error(`${doc.error || 'Local lighting memory file is unreadable'}; existing file was left unchanged`);
  }
  const file = doc.data;
  if (!file.devices) file.devices = {};
  if (!file.devices[deviceKey]) {
    if (Object.keys(file.devices).length >= MAX_LOCAL_DEVICES) {
      throw new Error('Lighting memory local store is at the device limit');
    }
    file.devices[deviceKey] = { profiles: {} };
  }
  if (!isPlainObject(file.devices[deviceKey])) file.devices[deviceKey] = { profiles: {} };
  file.devices[deviceKey].fallback = fallback;
  if (identity.kind) file.devices[deviceKey].identityKind = identity.kind;
  if (identity.durable !== undefined) file.devices[deviceKey].durable = Boolean(identity.durable);
  file.version = LIGHT_MEMORY_SCHEMA_VERSION;
  saveLocalFileAtomic(filePath, file);
  return { fallback, persisted: true };
}

function matchingDeviceKeys(file, device = {}, deviceKey) {
  const keys = [];
  if (!file.devices) return keys;
  if (deviceKey && file.devices[deviceKey]) keys.push(deviceKey);
  const vid = Number.isInteger(device.vendorId) ? device.vendorId : null;
  const pid = Number.isInteger(device.productId) ? device.productId : null;
  if (vid === null || pid === null) return keys;
  const legacyPrefix = `${vid}:${pid}:fw:`;
  for (const k of Object.keys(file.devices)) {
    if (k.startsWith(legacyPrefix) && !keys.includes(k)) keys.push(k);
  }
  return keys;
}

function clearLocalProfiles(filePath, deviceKey, profileIndex = null, device = {}) {
  const doc = parseLocalDocument(filePath);
  if (!doc.ok) return { cleared: false, error: doc.error, preserved: true };
  const file = doc.data;
  const keys = matchingDeviceKeys(file, device, deviceKey);
  if (keys.length === 0) return { cleared: false };
  for (const k of keys) {
    if (profileIndex === null || profileIndex === undefined) {
      delete file.devices[k];
    } else if (file.devices[k] && file.devices[k].profiles) {
      delete file.devices[k].profiles[String(profileIndex)];
    }
  }
  saveLocalFileAtomic(filePath, file);
  return { cleared: true };
}

function exportLightingMemory(store) {
  const normalized = normalizeLightMemory(store || emptyStore());
  return {
    version: LIGHT_MEMORY_SCHEMA_VERSION,
    main: normalized.main,
    side: normalized.side,
    side2: normalized.side2
  };
}

module.exports = {
  LIGHT_MEMORY_MARKER,
  LIGHT_MEMORY_OFFSET,
  LIGHT_MEMORY_LENGTH,
  CUSTOM_PARAM_SIZE,
  LIGHT_MEMORY_MAX_RECORDS,
  LIGHT_MEMORY_SCHEMA_VERSION,
  MAX_LOCAL_FILE_BYTES,
  MAX_LOCAL_DEVICES,
  emptyStore,
  parseLightMemory,
  serializeLightMemory,
  normalizeLightMemory,
  lightingMemoryOffset,
  rememberLighting,
  restoreMainSelection,
  restoreSideSelection,
  shouldPersistLightingMemory,
  validateImportedLightingMemory,
  deviceStorageKey,
  deviceIdentity,
  describeMemoryIdentity,
  defaultLocalPath,
  loadLocalFile,
  parseLocalDocument,
  readLocalProfile,
  writeLocalProfile,
  readDeviceFallback,
  writeDeviceFallback,
  clearLocalProfiles,
  exportLightingMemory
};
