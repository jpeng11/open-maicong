/**
 * G75 local GIF animation lighting library and native image-to-key mapper.
 * Reverse-engineered from official Cizhou/MCHOSE vendor bundles:
 * UI1833 Module 82492 (K), UI2233 Module 50746 (Yz / xW), readable 38506-38680 (Te aliases).
 * Selected-name region is GLW custom JSON offset 840 length 56 (CMD 241/242).
 * Storage isolated per device key in userData/gif-library.json.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { G75_V2_LIGHTING_ENTRIES } = require('./layout-g75v2.cjs');
const { decodeGif, MAX_GIF_BYTES } = require('./gif-decoder.cjs');
const stillLibrary = require('./still-library.cjs');
const storeFile = require('./store-file.cjs');

const DATA_SCOPE = 'LightingEffectProfile';
const GIF_TYPE = 'gif';
const LOCAL_TYPE = 'localstorage';
const MODEL = 'g75_v2';
const SCHEMA_VERSION = '1.0.0';
const MIN_NAME_LENGTH = 2;
const MAX_NAME_LENGTH = 15;
const MAX_GIF_ITEMS = 20;
const MAX_LIGHT_KEY_COUNT = 128;
const MAX_FRAMES = 128;
const MAX_FRAME_DATA = 128;
const MAX_LOCAL_FILE_BYTES = 512 * 1024; // 512 KiB bounded size
const MAX_LOCAL_DEVICES = 32;
const SELECTED_LIGHT_OFFSET = 840;
const SELECTED_LIGHT_LENGTH = 56;
const CUSTOM_PARAM_SIZE = 1024;
const HEX_COLOR_REGEX = /^#[0-9A-Fa-f]{6}$/;
const KEY_PREFIX = 'LightingEffectProfile@gif@';

// G75 frame aliases (Te g75V2 spaceKeys + Fn alias code 1, readable 38506-38674)
const G75_FRAME_ALIASES = [
  { name: 'space2', code: 301, index: 45 },
  { name: 'space3', code: 302, index: 61 }
];
const FN_FRAME_ALIAS_CODE = 1;
const FN_SLOT = 85;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function formatName(value) {
  return String(value == null ? '' : value).trim();
}

function translateName(item) {
  if (item == null) return '';
  if (typeof item === 'string') return formatName(item);
  if (!isPlainObject(item)) return '';
  const extra = isPlainObject(item.extra) ? item.extra : {};
  return formatName(extra.displayName || item.name);
}

function normalizeHex(value) {
  if (typeof value !== 'string' || !HEX_COLOR_REGEX.test(value)) return null;
  return value.toUpperCase();
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function emptyGifData() {
  return {
    dataScope: DATA_SCOPE,
    type: GIF_TYPE,
    frames: [{ duration: 100, data: [] }],
    isPreset: false
  };
}

function cloneGifData(src) {
  const raw = isPlainObject(src) && src.dataScope
    ? src
    : (isPlainObject(src) && isPlainObject(src.data) ? src.data : src);
  if (!isPlainObject(raw)) return raw;
  return {
    dataScope: raw.dataScope,
    type: GIF_TYPE,
    frames: Array.isArray(raw.frames) ? cloneJson(raw.frames) : raw.frames,
    isPreset: false
  };
}

function cloneExtra(extra) {
  const src = isPlainObject(extra) ? extra : {};
  return {
    displayName: formatName(src.displayName || ''),
    lightScopeType: src.lightScopeType === 'side' || src.lightScopeType === 'side2' ? src.lightScopeType : 'main',
    sideLightMode: 'custom',
    sideLight2Mode: 'custom',
    confirmShareFailed: false
  };
}

// xW helper: {code,color} -> {code,selectColor} (UI2233 module 50746)
function xW(colors) {
  if (!Array.isArray(colors)) return [];
  return colors.map((entry) => ({
    code: entry.code,
    selectColor: entry.selectColor || entry.color
  }));
}

// Yz helper: player {dur,colors} -> library {duration,data} (UI2233 module 50746)
function Yz(playerFrames) {
  if (!Array.isArray(playerFrames)) return [];
  return playerFrames.map((frame) => ({
    duration: frame.dur != null ? frame.dur : 16,
    data: (frame.colors || []).map((c) => ({
      code: c.code,
      selectColor: c.color
    }))
  }));
}

// UC helper: library frames -> player (readable ~2709)
function libraryFramesToPlayer(frames) {
  if (!Array.isArray(frames)) return [];
  return frames.map((frame) => {
    const data = Array.isArray(frame && frame.data) ? frame.data : [];
    return {
      dur: frame && frame.duration != null ? frame.duration : 16,
      colors: data
        .map((entry) => {
          if (typeof entry === 'string') return null;
          if (!isPlainObject(entry)) return null;
          return {
            code: entry.code,
            color: Object.prototype.hasOwnProperty.call(entry, 'selectColor')
              ? entry.selectColor
              : entry.color
          };
        })
        .filter((entry) => entry != null)
    };
  });
}

function validateFrameEntry(entry, pathLabel) {
  if (typeof entry === 'string') {
    return { valid: false, error: `${pathLabel} string entries are not stored by the GIF library writer` };
  }
  if (!isPlainObject(entry)) {
    return { valid: false, error: `${pathLabel} must be an object with code and selectColor` };
  }
  if (!Number.isInteger(entry.code)) {
    return { valid: false, error: `${pathLabel} code must be an integer` };
  }
  const color = normalizeHex(entry.selectColor || entry.color);
  if (!color) {
    return { valid: false, error: `${pathLabel} selectColor must be #RRGGBB` };
  }
  const allowed = new Set(['code', 'selectColor', 'color', 'name']);
  for (const key of Object.keys(entry)) {
    if (!allowed.has(key)) {
      return { valid: false, error: `${pathLabel} unknown field "${key}"` };
    }
  }
  return { valid: true, entry: { code: entry.code, selectColor: color, name: typeof entry.name === 'string' ? entry.name : undefined } };
}

function validateGifData(value) {
  if (!isPlainObject(value)) {
    return { valid: false, error: 'GIF data must be a plain object' };
  }
  const allowed = new Set(['dataScope', 'type', 'frames', 'isPreset']);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      return { valid: false, error: `Unknown GIF data field "${key}"` };
    }
  }
  if (value.dataScope !== DATA_SCOPE) {
    return { valid: false, error: 'GIF dataScope must be LightingEffectProfile' };
  }
  if (value.type !== GIF_TYPE) {
    return { valid: false, error: 'GIF library rejects non-gif types' };
  }
  if (value.isPreset !== undefined && value.isPreset !== false) {
    return { valid: false, error: 'Local GIF items must have isPreset false' };
  }
  if (!Array.isArray(value.frames) || value.frames.length === 0) {
    return { valid: false, error: 'GIF frames must be a nonempty array' };
  }
  if (value.frames.length > MAX_FRAMES) {
    return { valid: false, error: `GIF frames exceed ${MAX_FRAMES}` };
  }

  const frames = [];
  for (let i = 0; i < value.frames.length; i++) {
    const frame = value.frames[i];
    if (!isPlainObject(frame) || !Array.isArray(frame.data)) {
      return { valid: false, error: `GIF frames[${i}].data must be an array` };
    }
    for (const frameKey of Object.keys(frame)) {
      if (frameKey !== 'data' && frameKey !== 'duration') {
        return { valid: false, error: `GIF frames[${i}] unknown field "${frameKey}"` };
      }
    }
    if (frame.data.length > MAX_FRAME_DATA) {
      return { valid: false, error: `GIF frames[${i}].data exceeds ${MAX_FRAME_DATA} entries` };
    }

    const data = [];
    const seen = new Set();
    for (let j = 0; j < frame.data.length; j++) {
      const checked = validateFrameEntry(frame.data[j], `frames[${i}].data[${j}]`);
      if (!checked.valid) return checked;
      if (seen.has(checked.entry.code)) continue;
      seen.add(checked.entry.code);
      const next = { code: checked.entry.code, selectColor: checked.entry.selectColor };
      if (checked.entry.name) next.name = checked.entry.name;
      data.push(next);
    }

    const out = { data };
    if (frame.duration !== undefined) {
      if (!Number.isFinite(frame.duration) || frame.duration < 0) {
        return { valid: false, error: `GIF frames[${i}].duration must be a non-negative number` };
      }
      out.duration = Math.round(frame.duration);
    } else {
      out.duration = 100;
    }
    frames.push(out);
  }

  return {
    valid: true,
    data: {
      dataScope: DATA_SCOPE,
      type: GIF_TYPE,
      frames,
      isPreset: false
    }
  };
}

/**
 * Maps a single RGBA frame buffer to G75 lighting key entries.
 * Derives physical coordinates from documented G75 layout geometry.
 * Preserves space2 (301), space3 (302), Fn1 (1), and factory keycodes.
 */
function emptySnapshot(deviceKey = null) {
  return {
    items: [],
    deviceKey,
    unwritable: false,
    error: null,
    remaining: MAX_GIF_ITEMS,
    count: 0,
    max: MAX_GIF_ITEMS,
    selectedKey: null,
    selectedPair: ['gif', '']
  };
}

function suggestImportedName(rawName, items) {
  let base = formatName(rawName).replace(/\.[Gg][Ii][Ff]$/, '');
  if (base.length > MAX_NAME_LENGTH) base = base.slice(0, MAX_NAME_LENGTH);
  if (base.length < MIN_NAME_LENGTH) base = 'GIF';
  const existing = new Set((items || []).map((item) => translateName(item)));
  if (!existing.has(base)) return base;
  for (let i = 2; i < 100; i++) {
    const suffix = String(i);
    const trimmed = base.slice(0, Math.max(MIN_NAME_LENGTH, MAX_NAME_LENGTH - suffix.length));
    const candidate = (trimmed + suffix).slice(0, MAX_NAME_LENGTH);
    if (!existing.has(candidate) && candidate.length >= MIN_NAME_LENGTH) return candidate;
  }
  throw new Error('Could not allocate a unique GIF name');
}

function mapRgbaFrameToKeyColors(rgba, width, height) {
  const keys = G75_V2_LIGHTING_ENTRIES;
  if (!keys || keys.length === 0) return [];

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (const k of keys) {
    if (k.x < minX) minX = k.x;
    if (k.x + k.w > maxX) maxX = k.x + k.w;
    if (k.y < minY) minY = k.y;
    if (k.y + k.h > maxY) maxY = k.y + k.h;
  }

  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;

  const data = [];
  const seenCodes = new Set();

  for (const k of keys) {
    // Resolve vendor frame code
    let frameCode = k.code;
    if (k.slot === 45) {
      frameCode = 301; // space2 alias
    } else if (k.slot === 53) {
      frameCode = 44;  // space center
    } else if (k.slot === 61) {
      frameCode = 302; // space3 alias
    } else if (k.slot === FN_SLOT) {
      frameCode = FN_FRAME_ALIAS_CODE; // Fn frame alias 1
    }

    if (seenCodes.has(frameCode)) continue;

    // Center sampling with bounds clamping
    const cx = (k.x + k.w / 2 - minX) / spanX;
    const cy = (k.y + k.h / 2 - minY) / spanY;
    const px = Math.min(width - 1, Math.max(0, Math.floor(cx * width)));
    const py = Math.min(height - 1, Math.max(0, Math.floor(cy * height)));

    const idx = (py * width + px) * 4;
    const r = rgba[idx];
    const g = rgba[idx + 1];
    const b = rgba[idx + 2];
    const a = rgba[idx + 3];

    // If transparent or completely black, skip or mark black
    if (a < 128 || (r === 0 && g === 0 && b === 0)) {
      continue;
    }

    const hex = '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1).toUpperCase();
    seenCodes.add(frameCode);
    data.push({
      code: frameCode,
      name: k.name,
      selectColor: hex
    });
  }

  return data;
}

/**
 * Imports a raw GIF buffer, decodes it, maps each frame to G75 key codes,
 * and formats the resulting LightingEffectProfile gif object.
 */
function importGifBuffer(buf) {
  if (!buf || !(buf instanceof Uint8Array || Buffer.isBuffer(buf))) {
    throw new TypeError('GIF buffer must be a Buffer or Uint8Array');
  }
  if (buf.length > MAX_GIF_BYTES) {
    throw new RangeError('GIF file size exceeds 5MB limit');
  }
  const frames = [];
  decodeGif(buf, {
    retainFrames: false,
    onFrame(frame) {
      if (frames.length >= MAX_FRAMES) {
        throw new RangeError(`GIF frames exceed ${MAX_FRAMES}`);
      }
      frames.push({
        duration: Math.max(16, frame.duration || 100),
        data: mapRgbaFrameToKeyColors(frame.rgba, frame.width, frame.height)
      });
    }
  });
  if (frames.length === 0) {
    throw new Error('GIF does not contain any valid image frames');
  }
  return {
    dataScope: DATA_SCOPE,
    type: GIF_TYPE,
    isPreset: false,
    frames
  };
}

function checkName(name, items, options = {}) {
  const formatted = formatName(name);
  if (!formatted) return { valid: false, error: 'Effect name cannot be empty' };
  if (formatted.length < MIN_NAME_LENGTH || formatted.length > MAX_NAME_LENGTH) {
    return {
      valid: false,
      error: `Lighting name must be ${MIN_NAME_LENGTH}–${MAX_NAME_LENGTH} characters`
    };
  }
  const allowConflict = Boolean(options.allowConflict);
  const ignoreKey = options.ignoreKey || null;
  if (!allowConflict) {
    const conflict = (items || []).some((item) => {
      if (ignoreKey && item.key === ignoreKey) return false;
      return translateName(item) === formatted;
    });
    if (conflict) return { valid: false, error: 'Effect name already exists' };
  }
  return { valid: true, name: formatted };
}

function createKey(existing = []) {
  const used = new Set((existing || []).map((item) => item.key));
  for (let i = 0; i < 8; i++) {
    const key = KEY_PREFIX + crypto.randomUUID();
    if (!used.has(key)) return key;
  }
  throw new Error('Could not allocate a GIF library key');
}

function makeItem(name, data, extra, key, items) {
  const checked = checkName(name, items);
  if (!checked.valid) return checked;
  const source = data === undefined || data === null ? emptyGifData() : data;
  const validated = validateGifData(source);
  if (!validated.valid) return validated;
  const itemKey = key || createKey(items);
  const meta = cloneExtra({ ...extra, displayName: extra && extra.displayName ? extra.displayName : checked.name });
  meta.displayName = checked.name;
  return {
    valid: true,
    item: {
      key: itemKey,
      name: checked.name,
      type: LOCAL_TYPE,
      profileIndex: -1,
      data: validated.data,
      extra: meta
    }
  };
}

function defaultLocalPath() {
  try {
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') {
      return path.join(app.getPath('userData'), 'gif-library.json');
    }
  } catch {
    // node unit tests
  }
  return path.join(os.tmpdir(), 'maicong-gif-library.json');
}

function emptyFile() {
  return { version: SCHEMA_VERSION, devices: {} };
}

function parseLocalDocument(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return { ok: true, missing: true, data: emptyFile() };
    }
    const st = fs.statSync(filePath);
    if (!st.isFile() || st.size > MAX_LOCAL_FILE_BYTES) {
      return { ok: false, unwritable: true, recovered: true, error: 'GIF library local file exceeds the bounded size' };
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    if (Buffer.byteLength(raw, 'utf8') > MAX_LOCAL_FILE_BYTES) {
      return { ok: false, unwritable: true, recovered: true, error: 'GIF library local file exceeds the bounded size' };
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return { ok: false, unwritable: true, recovered: true, error: err.message || 'GIF library local file is not valid JSON' };
    }
    if (!isPlainObject(parsed) || !isPlainObject(parsed.devices)) {
      return { ok: false, unwritable: true, recovered: true, error: 'GIF library local file is malformed' };
    }
    for (const key of Object.keys(parsed)) {
      if (key !== 'version' && key !== 'devices') {
        return { ok: false, unwritable: true, recovered: true, error: `Unknown GIF library file field "${key}"` };
      }
    }
    if (parsed.version !== undefined && parsed.version !== SCHEMA_VERSION) {
      return { ok: false, unwritable: true, recovered: true, error: `Unsupported GIF library file version: "${parsed.version}"` };
    }
    if (Object.keys(parsed.devices).length > MAX_LOCAL_DEVICES) {
      return { ok: false, unwritable: true, recovered: true, error: 'GIF library local file has too many devices' };
    }
    return { ok: true, data: parsed };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: true, missing: true, data: emptyFile() };
    return { ok: false, unwritable: true, recovered: true, error: err.message || String(err) };
  }
}

function saveLocalFileAtomic(filePath, data) {
  const text = JSON.stringify(data, null, 2);
  if (Buffer.byteLength(text, 'utf8') > MAX_LOCAL_FILE_BYTES) {
    throw new Error('GIF library local file would exceed the bounded size');
  }
  storeFile.writeTextFileAtomic(filePath, text);
}

function validateStoredItem(raw, seenKeys) {
  if (!isPlainObject(raw)) {
    return { valid: false, error: 'GIF library item must be a plain object' };
  }
  const allowed = new Set(['key', 'name', 'type', 'profileIndex', 'data', 'extra']);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      return { valid: false, error: `Unknown GIF library item field "${key}"` };
    }
  }
  if (typeof raw.key !== 'string' || !raw.key.startsWith(KEY_PREFIX)) {
    return { valid: false, error: 'GIF library item key is missing or malformed' };
  }
  if (seenKeys.has(raw.key)) {
    return { valid: false, error: `GIF library has a duplicate key "${raw.key}"` };
  }
  if (raw.type !== LOCAL_TYPE) {
    return { valid: false, error: 'GIF library item type must be localstorage' };
  }
  if (raw.profileIndex !== -1) {
    return { valid: false, error: 'GIF library item profileIndex must be -1' };
  }
  const name = formatName(raw.name);
  if (name.length < MIN_NAME_LENGTH || name.length > MAX_NAME_LENGTH) {
    return { valid: false, error: `GIF item name "${name}" is invalid` };
  }
  const dataRes = validateGifData(raw.data);
  if (!dataRes.valid) return dataRes;

  const extra = cloneExtra(raw.extra);
  extra.displayName = name;

  seenKeys.add(raw.key);
  return {
    valid: true,
    item: {
      key: raw.key,
      name,
      type: LOCAL_TYPE,
      profileIndex: -1,
      data: dataRes.data,
      extra
    }
  };
}

function readDeviceItems(filePath, deviceKey) {
  const docRes = parseLocalDocument(filePath);
  if (!docRes.ok) {
    return { ok: false, unwritable: true, error: docRes.error, items: [] };
  }
  const doc = docRes.data || emptyFile();
  const rec = doc.devices && doc.devices[deviceKey];
  if (!rec) {
    return { ok: true, items: [] };
  }
  if (!isPlainObject(rec) || !Array.isArray(rec.items)) {
    return { ok: false, unwritable: true, error: 'Device record in GIF library is malformed', items: [] };
  }
  if (rec.items.length > MAX_GIF_ITEMS) {
    return { ok: false, unwritable: true, error: `Device has ${rec.items.length} GIF items, exceeding cap of ${MAX_GIF_ITEMS}`, items: [] };
  }
  const items = [];
  const seenKeys = new Set();
  const seenNames = new Set();
  for (let i = 0; i < rec.items.length; i++) {
    const checked = validateStoredItem(rec.items[i], seenKeys);
    if (!checked.valid) {
      return { ok: false, unwritable: true, error: `GIF item [${i}] invalid: ${checked.error}`, items: [] };
    }
    if (seenNames.has(checked.item.name)) {
      return { ok: false, unwritable: true, error: `Duplicate name "${checked.item.name}" in device items`, items: [] };
    }
    seenNames.add(checked.item.name);
    items.push(checked.item);
  }
  return { ok: true, items };
}

function writeDeviceItems(filePath, deviceKey, items) {
  const docRes = parseLocalDocument(filePath);
  if (!docRes.ok) {
    throw new Error(`Cannot write to GIF library: ${docRes.error}`);
  }
  const doc = docRes.data || emptyFile();
  if (!doc.devices) doc.devices = {};
  doc.devices[deviceKey] = {
    model: MODEL,
    updatedAt: new Date().toISOString(),
    items: cloneJson(items)
  };
  saveLocalFileAtomic(filePath, doc);
}

function deviceStorageKey(device) {
  return stillLibrary.deviceStorageKey(device);
}

function snapshot(deviceKey, filePath = defaultLocalPath()) {
  const res = readDeviceItems(filePath, deviceKey);
  if (!res.ok) {
    return {
      items: [],
      deviceKey,
      unwritable: true,
      error: res.error,
      remaining: 0
    };
  }
  return {
    items: res.items.map((i) => ({
      key: i.key,
      name: i.name,
      type: i.type,
      profileIndex: i.profileIndex,
      data: cloneGifData(i.data),
      extra: cloneExtra(i.extra),
      frameCount: i.data.frames.length,
      duration: i.data.frames.reduce((acc, f) => acc + (f.duration || 100), 0)
    })),
    deviceKey,
    unwritable: false,
    error: null,
    remaining: Math.max(0, MAX_GIF_ITEMS - res.items.length)
  };
}

function createGif(name, data, extra, key, deviceKey, filePath = defaultLocalPath()) {
  const current = readDeviceItems(filePath, deviceKey);
  if (!current.ok) {
    return { success: false, error: current.error, unwritable: true };
  }
  if (current.items.length >= MAX_GIF_ITEMS) {
    return { success: false, error: `GIF library reached maximum capacity of ${MAX_GIF_ITEMS}` };
  }
  const made = makeItem(name, data, extra, key, current.items);
  if (!made.valid) {
    return { success: false, error: made.error };
  }
  const nextItems = [made.item, ...current.items];
  try {
    writeDeviceItems(filePath, deviceKey, nextItems);
  } catch (err) {
    return { success: false, error: err.message || String(err) };
  }
  return { success: true, item: made.item, snapshot: snapshot(deviceKey, filePath) };
}

function renameGif(key, newName, deviceKey, filePath = defaultLocalPath()) {
  const current = readDeviceItems(filePath, deviceKey);
  if (!current.ok) {
    return { success: false, error: current.error, unwritable: true };
  }
  const idx = current.items.findIndex((item) => item.key === key);
  if (idx === -1) {
    return { success: false, error: 'GIF library item not found' };
  }
  const checked = checkName(newName, current.items, { ignoreKey: key });
  if (!checked.valid) {
    return { success: false, error: checked.error };
  }
  const updated = cloneJson(current.items[idx]);
  const prevName = updated.name;
  updated.name = checked.name;
  if (!updated.extra) updated.extra = {};
  updated.extra.displayName = checked.name;

  const nextItems = current.items.slice();
  nextItems[idx] = updated;
  try {
    writeDeviceItems(filePath, deviceKey, nextItems);
  } catch (err) {
    return { success: false, error: err.message || String(err) };
  }
  return {
    success: true,
    item: updated,
    prevName,
    snapshot: snapshot(deviceKey, filePath)
  };
}

function updateGifData(key, updater, deviceKey, filePath = defaultLocalPath()) {
  const current = readDeviceItems(filePath, deviceKey);
  if (!current.ok) {
    return { success: false, error: current.error, unwritable: true };
  }
  const idx = current.items.findIndex((item) => item.key === key);
  if (idx === -1) {
    return { success: false, error: 'GIF library item not found' };
  }
  const existing = current.items[idx];
  const nextRaw = typeof updater === 'function' ? updater(cloneJson(existing)) : updater;
  const validated = validateGifData(nextRaw.data || nextRaw);
  if (!validated.valid) {
    return { success: false, error: validated.error };
  }
  let name = existing.name;
  if (nextRaw.name && formatName(nextRaw.name) !== existing.name) {
    const checked = checkName(nextRaw.name, current.items, { ignoreKey: key });
    if (!checked.valid) return { success: false, error: checked.error };
    name = checked.name;
  }

  const updated = {
    key: existing.key,
    name,
    type: LOCAL_TYPE,
    profileIndex: -1,
    data: validated.data,
    extra: cloneExtra({ ...existing.extra, ...(nextRaw.extra || {}), displayName: name })
  };

  const nextItems = current.items.slice();
  nextItems[idx] = updated;
  try {
    writeDeviceItems(filePath, deviceKey, nextItems);
  } catch (err) {
    return { success: false, error: err.message || String(err) };
  }
  return { success: true, item: updated, snapshot: snapshot(deviceKey, filePath) };
}

function deleteGif(key, options = {}, deviceKey, filePath = defaultLocalPath()) {
  const current = readDeviceItems(filePath, deviceKey);
  if (!current.ok) {
    return { success: false, error: current.error, unwritable: true };
  }
  const idx = current.items.findIndex((item) => item.key === key);
  if (idx === -1) {
    return { success: false, error: 'GIF library item not found' };
  }
  const removed = current.items[idx];
  const nextItems = current.items.filter((item) => item.key !== key);
  try {
    writeDeviceItems(filePath, deviceKey, nextItems);
  } catch (err) {
    return { success: false, error: err.message || String(err) };
  }

  const activeKey = options.activeKey || null;
  let replacement = null;
  if (activeKey === key) {
    if (nextItems.length > 0) {
      const neighborIdx = Math.min(idx, nextItems.length - 1);
      replacement = nextItems[neighborIdx];
    }
  }

  return {
    success: true,
    removed,
    replacement,
    snapshot: snapshot(deviceKey, filePath)
  };
}

function findReplacementItem(items, targetKey) {
  if (!Array.isArray(items) || items.length === 0) {
    return [GIF_TYPE, ''];
  }
  const idx = items.findIndex((i) => i.key === targetKey);
  if (idx === -1) return [GIF_TYPE, ''];
  if (idx + 1 < items.length) return [GIF_TYPE, items[idx + 1].name];
  if (idx - 1 >= 0) return [GIF_TYPE, items[idx - 1].name];
  return [GIF_TYPE, ''];
}

module.exports = {
  DATA_SCOPE,
  GIF_TYPE,
  LOCAL_TYPE,
  MODEL,
  SCHEMA_VERSION,
  MIN_NAME_LENGTH,
  MAX_NAME_LENGTH,
  MAX_GIF_ITEMS,
  MAX_LIGHT_KEY_COUNT,
  MAX_FRAMES,
  MAX_FRAME_DATA,
  MAX_LOCAL_FILE_BYTES,
  SELECTED_LIGHT_OFFSET,
  SELECTED_LIGHT_LENGTH,
  CUSTOM_PARAM_SIZE,
  KEY_PREFIX,
  G75_FRAME_ALIASES,
  FN_FRAME_ALIAS_CODE,
  emptyGifData,
  emptySnapshot,
  cloneGifData,
  cloneExtra,
  validateGifData,
  mapRgbaFrameToKeyColors,
  importGifBuffer,
  suggestImportedName,
  checkName,
  createKey,
  makeItem,
  defaultLocalPath,
  parseLocalDocument,
  readDeviceItems,
  writeDeviceItems,
  deviceStorageKey,
  snapshot,
  createGif,
  renameGif,
  updateGifData,
  deleteGif,
  findReplacementItem,
  xW,
  Yz,
  libraryFramesToPlayer
};
