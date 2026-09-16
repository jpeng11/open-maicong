/**
 * G75 local still lighting library.
 * Shape and handlers from UI1833 eC/e8/eL/T and UI2233 module 1134 / 50746 / 69872 / 91972.
 * Selected-name region is GLW custom JSON offset 840 length 56 (CMD 241/242).
 * GIF lives in gif-library.cjs. Cloud/share/side libraries are not implemented here.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { G75_V2_LIGHTING_ENTRIES } = require('./layout-g75v2.cjs');
const lightingMemory = require('./lighting-memory.cjs');

const DATA_SCOPE = 'LightingEffectProfile';
const STILL_TYPE = 'still';
const LOCAL_TYPE = 'localstorage';
const MODEL = 'g75_v2';
const SCHEMA_VERSION = '1.0.0';
const MIN_NAME_LENGTH = 2;
const MAX_NAME_LENGTH = 15;
const MAX_STILL_ITEMS = 20;
const MAX_LIGHT_KEY_COUNT = 128;
const MAX_FRAMES = 8;
const MAX_FRAME_DATA = 128;
const MAX_LOCAL_FILE_BYTES = 256 * 1024;
const MAX_LOCAL_DEVICES = 32;
const STILL_EDIT_DELAY_MS = 300;
const SELECTED_LIGHT_OFFSET = 840;
const SELECTED_LIGHT_LENGTH = 56;
const CUSTOM_PARAM_SIZE = 1024;
const HEX_COLOR_REGEX = /^#[0-9A-Fa-f]{6}$/;
const KEY_PREFIX = 'LightingEffectProfile@still@';

// Te g75V2 spaceKeys + Fn alias code 1 (readable.js 38506–38674).
const G75_FRAME_ALIASES = [
  { name: 'space2', code: 301, index: 45 },
  { name: 'space3', code: 302, index: 61 }
];
const FN_FRAME_ALIAS_CODE = 1;
const FN_SLOT = 85;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function emptyStillData() {
  return {
    dataScope: DATA_SCOPE,
    type: STILL_TYPE,
    frames: [{ data: [] }],
    isPreset: false
  };
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

function lightingFrameKeys() {
  const keys = G75_V2_LIGHTING_ENTRIES.map((k) => ({
    name: k.name,
    code: k.code,
    index: k.slot
  }));
  for (const alias of G75_FRAME_ALIASES) {
    keys.push({ name: alias.name, code: alias.code, index: alias.index, alias: true });
  }
  const fn = keys.find((k) => k.index === FN_SLOT && k.code === 255);
  if (fn) {
    keys.push({
      name: fn.name,
      code: FN_FRAME_ALIAS_CODE,
      index: FN_SLOT,
      alias: true
    });
  }
  return keys;
}

function keysByCode(keys) {
  const map = new Map();
  for (const key of keys) map.set(key.code, key);
  return map;
}

function keysByIndex(keys) {
  const map = new Map();
  for (const key of keys) {
    const list = map.get(key.index) || [];
    list.push(key);
    map.set(key.index, list);
  }
  return map;
}

function preferredKeyAtIndex(list) {
  if (!list || list.length === 0) return null;
  return list.find((k) => k.code > 0) || list[0];
}

function findKeyByName(keys, name) {
  if (typeof name !== 'string' || !name) return null;
  const want = name.toUpperCase();
  return keys.find((k) => typeof k.name === 'string' && k.name.toUpperCase() === want) || null;
}

// xW / yK: {code,color} -> {code,selectColor} (UI2233 module 50746).
function xW(colors) {
  if (!Array.isArray(colors)) return [];
  return colors.map((entry) => ({
    code: entry.code,
    selectColor: entry.selectColor || entry.color
  }));
}

// Yz: player {dur,colors} -> library {duration,data} (UI2233 module 50746).
function Yz(playerFrames) {
  if (!Array.isArray(playerFrames)) return [];
  return playerFrames.map((frame) => ({
    duration: frame.dur,
    data: (frame.colors || []).map((c) => ({
      code: c.code,
      selectColor: c.color
    }))
  }));
}

// UC / x: library frames -> player (readable ~2709 / UI2233 function x).
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

function cloneStillData(src) {
  const raw = isPlainObject(src) && src.dataScope ? src : (isPlainObject(src) && isPlainObject(src.data) ? src.data : src);
  if (!isPlainObject(raw)) {
    return raw;
  }
  const out = {
    dataScope: raw.dataScope,
    type: raw.type,
    frames: Array.isArray(raw.frames) ? cloneJson(raw.frames) : raw.frames,
    isPreset: false
  };
  return out;
}

function cloneExtra(extra) {
  const src = isPlainObject(extra) ? extra : {};
  return {
    displayName: formatName(src.displayName || ''),
    lightScopeType: src.lightScopeType === 'side' || src.lightScopeType === 'side2' ? src.lightScopeType : 'main',
    confirmShareFailed: false
  };
}

function validateFrameEntry(entry, pathLabel) {
  if (typeof entry === 'string') {
    return { valid: false, error: `${pathLabel} string entries are not stored by the still library writer` };
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

function validateStillData(value) {
  if (!isPlainObject(value)) {
    return { valid: false, error: 'Still data must be a plain object' };
  }
  const allowed = new Set(['dataScope', 'type', 'frames', 'isPreset']);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      return { valid: false, error: `Unknown still data field "${key}"` };
    }
  }
  if (value.dataScope !== DATA_SCOPE) {
    return { valid: false, error: 'Still dataScope must be LightingEffectProfile' };
  }
  if (value.type !== STILL_TYPE) {
    return { valid: false, error: 'Still library rejects non-still types' };
  }
  if (value.isPreset !== undefined && value.isPreset !== false) {
    return { valid: false, error: 'Local still items must have isPreset false' };
  }
  if (!Array.isArray(value.frames) || value.frames.length === 0) {
    return { valid: false, error: 'Still frames must be a nonempty array' };
  }
  if (value.frames.length > MAX_FRAMES) {
    return { valid: false, error: `Still frames exceed ${MAX_FRAMES}` };
  }
  const frames = [];
  for (let i = 0; i < value.frames.length; i++) {
    const frame = value.frames[i];
    if (!isPlainObject(frame) || !Array.isArray(frame.data)) {
      return { valid: false, error: `Still frames[${i}].data must be an array` };
    }
    for (const frameKey of Object.keys(frame)) {
      if (frameKey !== 'data' && frameKey !== 'duration') {
        return { valid: false, error: `Still frames[${i}] unknown field "${frameKey}"` };
      }
    }
    if (frame.data.length > MAX_FRAME_DATA) {
      return { valid: false, error: `Still frames[${i}].data exceeds ${MAX_FRAME_DATA} entries` };
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
      if (!Number.isFinite(frame.duration)) {
        return { valid: false, error: `Still frames[${i}].duration must be numeric when present` };
      }
      out.duration = frame.duration;
    }
    frames.push(out);
  }
  return {
    valid: true,
    data: {
      dataScope: DATA_SCOPE,
      type: STILL_TYPE,
      frames,
      isPreset: false
    }
  };
}

function colorsToArray(colors) {
  const arr = new Array(MAX_LIGHT_KEY_COUNT).fill('#000000');
  if (Array.isArray(colors)) {
    for (let i = 0; i < Math.min(colors.length, MAX_LIGHT_KEY_COUNT); i++) {
      const hex = normalizeHex(typeof colors[i] === 'string' ? colors[i] : colors[i] && colors[i].hex);
      if (hex) arr[i] = hex;
    }
    return arr;
  }
  if (isPlainObject(colors)) {
    for (const [key, value] of Object.entries(colors)) {
      if (!/^\d+$/.test(key)) continue;
      const idx = Number(key);
      if (!Number.isInteger(idx) || idx < 0 || idx >= MAX_LIGHT_KEY_COUNT) continue;
      const hex = normalizeHex(typeof value === 'string' ? value : value && value.hex);
      if (hex) arr[idx] = hex;
    }
  }
  return arr;
}

function colors2KeyColorFrame(colors, options = {}) {
  const arr = colorsToArray(colors);
  const keys = lightingFrameKeys();
  const byIndex = keysByIndex(keys);
  const out = [];
  const seen = new Set();
  arr.forEach((hex, index) => {
    if (!hex || hex === '#000000') return;
    const preferred = preferredKeyAtIndex(byIndex.get(index));
    if (!preferred) return;
    if (seen.has(preferred.code)) return;
    seen.add(preferred.code);
    out.push({ code: preferred.code, name: preferred.name, selectColor: hex });
  });
  if (options.colorFromScope && options.colorFromScope !== 'main') {
    return [];
  }
  return out;
}

function keyColorFrame2Colors(frameData, options = {}) {
  const fallback = normalizeHex(options.fallbackColor) || '#000000';
  const maxCount = Number.isInteger(options.maxCount) ? options.maxCount : MAX_LIGHT_KEY_COUNT;
  const colors = new Array(maxCount).fill(fallback);
  const keys = lightingFrameKeys();
  const byCode = keysByCode(keys);
  const data = Array.isArray(frameData) ? frameData : [];
  data.forEach((entry, index) => {
    if (typeof entry === 'string') {
      const hex = normalizeHex(entry) || fallback;
      if (index >= 0 && index < colors.length) colors[index] = hex;
      return;
    }
    if (!isPlainObject(entry)) return;
    let matched = byCode.get(entry.code);
    if (!matched && entry.name) matched = findKeyByName(keys, entry.name);
    if (!matched || matched.index < 0 || matched.index >= colors.length) return;
    const hex = normalizeHex(
      Object.prototype.hasOwnProperty.call(entry, 'selectColor') ? entry.selectColor : entry.color
    );
    if (hex) colors[matched.index] = hex;
  });
  return colors;
}

function stillDataToColorMap(data) {
  const validated = validateStillData(data);
  if (!validated.valid) return {};
  const frame = validated.data.frames[0] || { data: [] };
  const colors = keyColorFrame2Colors(frame.data);
  const map = {};
  for (const key of G75_V2_LIGHTING_ENTRIES) {
    map[key.slot] = colors[key.slot] || '#000000';
  }
  return map;
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
  throw new Error('Could not allocate a still library key');
}

function makeItem(name, data, extra, key, items) {
  const checked = checkName(name, items);
  if (!checked.valid) return checked;
  const source = data === undefined || data === null ? emptyStillData() : data;
  const validated = validateStillData(source);
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

function findReplacementItem(items, deletedKey) {
  const list = Array.isArray(items) ? items : [];
  const idx = list.findIndex((item) => item.key === deletedKey);
  if (idx < 0) return { mode: 'missing' };
  for (let i = idx + 1; i < list.length; i++) {
    if (list[i].key !== deletedKey) return { mode: 'replace', item: list[i] };
  }
  for (let i = idx - 1; i >= 0; i--) {
    if (list[i].key !== deletedKey) return { mode: 'replace', item: list[i] };
  }
  return { mode: 'empty' };
}

function createStill(items, name, data, extra) {
  const list = Array.isArray(items) ? items.slice() : [];
  if (list.length >= MAX_STILL_ITEMS) {
    return { valid: false, error: 'Local still library is full (20)' };
  }
  const made = makeItem(name, data, extra, null, list);
  if (!made.valid) return made;
  list.unshift(made.item);
  return { valid: true, items: list, key: made.item.key, item: made.item };
}

function renameStill(items, key, name) {
  const list = Array.isArray(items) ? items.map((item) => ({ ...item, extra: { ...item.extra }, data: cloneStillData(item.data) })) : [];
  const idx = list.findIndex((item) => item.key === key);
  if (idx < 0) return { valid: false, error: 'Still was not found' };
  const previous = list[idx];
  const oldName = previous.name;
  const checked = checkName(name, list, { ignoreKey: key });
  if (!checked.valid) return checked;
  list[idx] = {
    ...previous,
    name: checked.name,
    extra: { ...cloneExtra(previous.extra), displayName: checked.name }
  };
  return {
    valid: true,
    items: list,
    item: list[idx],
    oldName,
    newName: checked.name
  };
}

function updateStillData(items, key, mutator) {
  const list = Array.isArray(items) ? items.map((item) => ({ ...item, extra: { ...item.extra }, data: cloneJson(item.data) })) : [];
  const idx = list.findIndex((item) => item.key === key);
  if (idx < 0) return { valid: false, error: 'Still was not found' };
  const current = list[idx];
  const patch = typeof mutator === 'function'
    ? mutator(cloneJson(current.data), cloneExtra(current.extra))
    : mutator;
  if (!patch || !isPlainObject(patch)) {
    return { valid: false, error: 'Still update did not return data' };
  }
  const nextData = patch.data || patch;
  const validated = validateStillData(nextData);
  if (!validated.valid) return validated;
  const nextExtra = cloneExtra(patch.extra || current.extra);
  list[idx] = { ...current, data: validated.data, extra: nextExtra };
  return { valid: true, items: list, item: list[idx] };
}

function deleteStill(items, key, options = {}) {
  const list = Array.isArray(items) ? items.slice() : [];
  const current = list.find((item) => item.key === key);
  if (!current) return { valid: false, error: 'Still was not found' };
  const active = Boolean(options.isActive);
  let replacement = { mode: 'preserve' };
  if (active) replacement = findReplacementItem(list, key);
  const next = list.filter((item) => item.key !== key);
  return {
    valid: true,
    items: next,
    deleted: current,
    replacement
  };
}

function selectedPairFromItem(item) {
  if (!item) return [STILL_TYPE, ''];
  return [STILL_TYPE, item.name || ''];
}

function pairsEqual(a, b) {
  const left = Array.isArray(a) ? a : [STILL_TYPE, ''];
  const right = Array.isArray(b) ? b : [STILL_TYPE, ''];
  return (left[0] || STILL_TYPE) === (right[0] || STILL_TYPE) && (left[1] || '') === (right[1] || '');
}

function encodeSelectedLightEffect(pair, length = SELECTED_LIGHT_LENGTH) {
  const type = pair && pair[0] === STILL_TYPE ? '' : ((pair && pair[0]) || '');
  const name = (pair && pair[1]) || '';
  const json = JSON.stringify([type, name]);
  const bytes = Buffer.from(json, 'utf8');
  if (bytes.length >= length) {
    return { valid: false, error: 'Selected lighting name does not fit the 56-byte region' };
  }
  const out = Buffer.alloc(length, 255);
  bytes.copy(out, 0);
  return { valid: true, buffer: out, pair: [pair && pair[0] === STILL_TYPE ? STILL_TYPE : type || STILL_TYPE, name] };
}

function decodeJSONBytes(buf, fallback) {
  if (!buf || buf.length === 0) return fallback;
  const bytes = Buffer.from(buf);
  let n = bytes.indexOf(255);
  while (n !== -1) {
    try {
      return JSON.parse(bytes.subarray(0, n).toString('utf8'));
    } catch {
      n = bytes.indexOf(255, n + 1);
    }
  }
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    return fallback;
  }
}

function decodeSelectedLightEffect(buf) {
  const parsed = decodeJSONBytes(buf, []);
  if (!Array.isArray(parsed)) {
    return { valid: true, pair: [STILL_TYPE, ''], recovered: true };
  }
  return {
    valid: true,
    pair: [parsed[0] || STILL_TYPE, parsed[1] || '']
  };
}

function selectedLightOffset(profileIndex) {
  return (profileIndex * CUSTOM_PARAM_SIZE) + SELECTED_LIGHT_OFFSET;
}

function emptyFile() {
  return { version: SCHEMA_VERSION, devices: {} };
}

function defaultLocalPath() {
  try {
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') {
      return path.join(app.getPath('userData'), 'still-library.json');
    }
  } catch {
    // node unit tests
  }
  return path.join(os.tmpdir(), 'maicong-still-library.json');
}

function parseLocalDocument(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return { ok: true, missing: true, data: emptyFile() };
    }
    const st = fs.statSync(filePath);
    if (!st.isFile() || st.size > MAX_LOCAL_FILE_BYTES) {
      return { ok: false, unwritable: true, recovered: true, error: 'Still library local file exceeds the bounded size' };
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    if (raw.length > MAX_LOCAL_FILE_BYTES) {
      return { ok: false, unwritable: true, recovered: true, error: 'Still library local file exceeds the bounded size' };
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return { ok: false, unwritable: true, recovered: true, error: err.message || 'Still library local file is not valid JSON' };
    }
    if (!isPlainObject(parsed) || !isPlainObject(parsed.devices)) {
      return { ok: false, unwritable: true, recovered: true, error: 'Still library local file is malformed' };
    }
    for (const key of Object.keys(parsed)) {
      if (key !== 'version' && key !== 'devices') {
        return { ok: false, unwritable: true, recovered: true, error: `Unknown still library file field "${key}"` };
      }
    }
    if (parsed.version !== undefined && parsed.version !== SCHEMA_VERSION) {
      return { ok: false, unwritable: true, recovered: true, error: `Unsupported still library file version: "${parsed.version}"` };
    }
    if (Object.keys(parsed.devices).length > MAX_LOCAL_DEVICES) {
      return { ok: false, unwritable: true, recovered: true, error: 'Still library local file has too many devices' };
    }
    return { ok: true, data: parsed };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: true, missing: true, data: emptyFile() };
    return { ok: false, unwritable: true, recovered: true, error: err.message || String(err) };
  }
}

function saveLocalFileAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.still-library-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}.tmp`);
  const text = JSON.stringify(data, null, 2);
  if (Buffer.byteLength(text, 'utf8') > MAX_LOCAL_FILE_BYTES) {
    throw new Error('Still library local file would exceed the bounded size');
  }
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      // ignore tmp cleanup
    }
    throw err;
  }
}

function validateStoredItem(raw, seenKeys) {
  if (!isPlainObject(raw)) {
    return { valid: false, error: 'Still library item must be a plain object' };
  }
  const allowed = new Set(['key', 'name', 'type', 'profileIndex', 'data', 'extra']);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      return { valid: false, error: `Unknown still library item field "${key}"` };
    }
  }
  if (typeof raw.key !== 'string' || !raw.key.startsWith(KEY_PREFIX)) {
    return { valid: false, error: 'Still library item key is missing or malformed' };
  }
  if (seenKeys.has(raw.key)) {
    return { valid: false, error: `Still library has a duplicate key "${raw.key}"` };
  }
  if (raw.type !== LOCAL_TYPE) {
    return { valid: false, error: 'Still library item type must be localstorage' };
  }
  if (raw.profileIndex !== -1) {
    return { valid: false, error: 'Still library item profileIndex must be -1' };
  }
  if (raw.extra !== undefined && !isPlainObject(raw.extra)) {
    return { valid: false, error: 'Still library item extra must be a plain object when present' };
  }
  if (isPlainObject(raw.extra)) {
    const extraAllowed = new Set(['displayName', 'lightScopeType', 'confirmShareFailed']);
    for (const key of Object.keys(raw.extra)) {
      if (!extraAllowed.has(key)) {
        return { valid: false, error: `Unknown still library extra field "${key}"` };
      }
    }
    if (raw.extra.lightScopeType !== undefined && raw.extra.lightScopeType !== 'main') {
      return { valid: false, error: 'Local still library extra.lightScopeType must be main' };
    }
    if (raw.extra.confirmShareFailed !== undefined && raw.extra.confirmShareFailed !== false && raw.extra.confirmShareFailed !== true) {
      return { valid: false, error: 'Still library extra.confirmShareFailed must be boolean' };
    }
  }
  const made = makeItem(raw.name, raw.data, raw.extra, raw.key, []);
  if (!made.valid) return made;
  seenKeys.add(raw.key);
  return { valid: true, item: made.item };
}

function validateItemsArray(rawItems) {
  if (rawItems === undefined) {
    return { valid: true, items: [] };
  }
  if (!Array.isArray(rawItems)) {
    return { valid: false, error: 'Still library items must be an array' };
  }
  if (rawItems.length > MAX_STILL_ITEMS) {
    return { valid: false, error: `Still library exceeds ${MAX_STILL_ITEMS} local items` };
  }
  const seenKeys = new Set();
  const items = [];
  for (let i = 0; i < rawItems.length; i++) {
    const checked = validateStoredItem(rawItems[i], seenKeys);
    if (!checked.valid) {
      return { valid: false, error: checked.error || `Still library item ${i} is invalid` };
    }
    const nameCheck = checkName(checked.item.name, items);
    if (!nameCheck.valid) {
      return { valid: false, error: nameCheck.error };
    }
    items.push(checked.item);
  }
  return { valid: true, items };
}

function validateDeviceRecord(device) {
  if (!isPlainObject(device)) {
    return { valid: false, error: 'Still library device record must be a plain object' };
  }
  const allowed = new Set(['model', 'items', 'identityKind']);
  for (const key of Object.keys(device)) {
    if (!allowed.has(key)) {
      return { valid: false, error: `Unknown still library device field "${key}"` };
    }
  }
  if (device.model !== MODEL) {
    return { valid: false, error: `Still library device model must be ${MODEL}` };
  }
  return validateItemsArray(device.items);
}

function readDeviceItems(filePath, deviceKey) {
  const doc = parseLocalDocument(filePath);
  if (!doc.ok) {
    return { ok: false, items: [], error: doc.error, unwritable: true, recovered: true };
  }
  const allowedDoc = new Set(['version', 'devices']);
  for (const key of Object.keys(doc.data)) {
    if (!allowedDoc.has(key)) {
      return {
        ok: false,
        items: [],
        error: `Unknown still library file field "${key}"`,
        unwritable: true,
        recovered: true
      };
    }
  }
  const device = doc.data.devices && doc.data.devices[deviceKey];
  if (!device) return { ok: true, items: [] };
  const checked = validateDeviceRecord(device);
  if (!checked.valid) {
    return {
      ok: false,
      items: [],
      error: checked.error || 'Still library device record is malformed',
      unwritable: true,
      recovered: true
    };
  }
  return { ok: true, items: checked.items };
}

function writeDeviceItems(filePath, deviceKey, items, identity = {}) {
  const incoming = validateItemsArray(items);
  if (!incoming.valid) {
    throw new Error(incoming.error || 'Still library contains an item that failed validation');
  }
  const doc = parseLocalDocument(filePath);
  if (!doc.ok) {
    throw new Error(`${doc.error || 'Local still library file is unreadable'}; existing file was left unchanged`);
  }
  const file = doc.data;
  if (!file.devices) file.devices = {};
  if (file.devices[deviceKey]) {
    const existing = validateDeviceRecord(file.devices[deviceKey]);
    if (!existing.valid) {
      throw new Error(`${existing.error || 'Local still library file is malformed'}; existing file was left unchanged`);
    }
  } else if (Object.keys(file.devices).length >= MAX_LOCAL_DEVICES) {
    throw new Error('Still library local store is at the device limit');
  }
  if (!isPlainObject(file.devices[deviceKey])) file.devices[deviceKey] = { model: MODEL, items: [] };
  file.devices[deviceKey].model = MODEL;
  file.devices[deviceKey].items = incoming.items;
  if (identity.kind) file.devices[deviceKey].identityKind = identity.kind;
  file.version = SCHEMA_VERSION;
  saveLocalFileAtomic(filePath, file);
  return incoming.items;
}

function snapshot(items, selectedPair, extras = {}) {
  const list = Array.isArray(items) ? items : [];
  const pair = Array.isArray(selectedPair) ? selectedPair : [STILL_TYPE, ''];
  const selectedName = pair[1] || '';
  const selected = list.find((item) => item.name === selectedName && (pair[0] || STILL_TYPE) === STILL_TYPE) || null;
  return {
    items: list.map((item) => ({
      key: item.key,
      name: item.name,
      type: item.type,
      profileIndex: item.profileIndex,
      data: cloneStillData(item.data),
      extra: cloneExtra(item.extra)
    })),
    count: list.length,
    max: MAX_STILL_ITEMS,
    remaining: Math.max(0, MAX_STILL_ITEMS - list.length),
    selectedKey: selected ? selected.key : null,
    selectedPair: [pair[0] || STILL_TYPE, selectedName],
    selectedOnDevice: Boolean(extras.selectedOnDevice),
    error: extras.error || null,
    unwritable: Boolean(extras.unwritable),
    gifSupported: false,
    cloudSupported: false,
    sideLibrarySupported: false,
    ...extras
  };
}

function deviceStorageKey(device) {
  return lightingMemory.deviceStorageKey(device);
}

function deviceIdentity(device) {
  return lightingMemory.deviceIdentity(device);
}

module.exports = {
  DATA_SCOPE,
  STILL_TYPE,
  LOCAL_TYPE,
  MODEL,
  SCHEMA_VERSION,
  MIN_NAME_LENGTH,
  MAX_NAME_LENGTH,
  MAX_STILL_ITEMS,
  MAX_LIGHT_KEY_COUNT,
  MAX_FRAMES,
  MAX_FRAME_DATA,
  MAX_LOCAL_FILE_BYTES,
  STILL_EDIT_DELAY_MS,
  SELECTED_LIGHT_OFFSET,
  SELECTED_LIGHT_LENGTH,
  CUSTOM_PARAM_SIZE,
  KEY_PREFIX,
  G75_FRAME_ALIASES,
  FN_FRAME_ALIAS_CODE,
  emptyStillData,
  formatName,
  translateName,
  cloneStillData,
  cloneExtra,
  validateStillData,
  checkName,
  createKey,
  createStill,
  renameStill,
  updateStillData,
  deleteStill,
  findReplacementItem,
  selectedPairFromItem,
  pairsEqual,
  encodeSelectedLightEffect,
  decodeSelectedLightEffect,
  decodeJSONBytes,
  selectedLightOffset,
  colors2KeyColorFrame,
  keyColorFrame2Colors,
  stillDataToColorMap,
  lightingFrameKeys,
  xW,
  Yz,
  libraryFramesToPlayer,
  defaultLocalPath,
  parseLocalDocument,
  readDeviceItems,
  writeDeviceItems,
  snapshot,
  deviceStorageKey,
  deviceIdentity,
  validateItemsArray,
  validateDeviceRecord
};
