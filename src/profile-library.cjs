/**
 * Hub-style driver-local G75 profile library.
 * Ordinary capacity is maxProfileLength 20 minus ordinary onboard minus local
 * items (module 78072 tX). Persistence is per verified device identity.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const lightingMemory = require('./lighting-memory.cjs');
const { VALID_PHYSICAL_SLOTS } = require('./layout-g75v2.cjs');
const names = require('./profile-names.cjs');
const keys = require('./profile-keys.cjs');
const validators = require('./schema-validators.cjs');

const MODEL = 'g75_v2';
const SCHEMA_VERSION = '1.0.0';
const LOCAL_TYPE = 'localstorage';
const KEYBOARD_TYPE = 'keyboard';
const KEY_PREFIX = 'KeyboardProfile@localstorage@';
const MAX_PROFILE_LENGTH = 20;
const MAX_KEYBOARD_PROFILES = 4;
const MAX_LOCAL_FILE_BYTES = 2 * 1024 * 1024;
const MAX_LOCAL_DEVICES = 32;
const MAX_RECOVERY = 8;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function emptyFile() {
  return { version: SCHEMA_VERSION, devices: {} };
}

function defaultLocalPath() {
  try {
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') {
      return path.join(app.getPath('userData'), 'profile-library.json');
    }
  } catch {
    // node unit tests
  }
  return path.join(os.tmpdir(), 'maicong-profile-library.json');
}

function createKey() {
  return KEY_PREFIX + crypto.randomBytes(8).toString('hex');
}

function onboardKey(profileIndex) {
  return `KeyboardProfile@keyboard@${profileIndex}`;
}

function defaultLighting() {
  return {
    effect: 0,
    brightness: 100,
    speed: 4,
    direction: 0,
    customColorDisabled: false,
    hexColor: '#000000',
    sideEffect: 1,
    sideBrightness: 80,
    sideSpeed: 4,
    sideCustomColorDisabled: false,
    sideHexColor: '#000000',
    calibrationRgb: { r: 255, g: 255, b: 255 }
  };
}

function defaultSettings() {
  return {
    sleepTime: 6,
    sleepMode: 0,
    debounceLevel: 0,
    macMode: 0,
    reporteRate: 4,
    lockWin: false,
    rollerType: 0
  };
}

function defaultLayers() {
  const layers = {};
  for (let l = 0; l < 4; l++) {
    const factory = keys.factoryLayer(l);
    const map = {};
    for (const slot of VALID_PHYSICAL_SLOTS) {
      const t = factory[slot];
      map[String(slot)] = { type: t.type, code1: t.code1, code2: t.code2 };
    }
    layers[String(l)] = map;
  }
  return layers;
}

function defaultNativeSnapshot() {
  return {
    app: 'Maicong Studio',
    model: 'MCHOSE G75 V2',
    protocol: 'GLW',
    version: '2.0.0',
    lighting: defaultLighting(),
    settings: defaultSettings(),
    layers: defaultLayers(),
    perKeyRgb: {},
    macros: [],
    selectedLightEffect: ['still', '']
  };
}

const ALLOWED_SNAPSHOT_KEYS = new Set([
  'app', 'model', 'protocol', 'version', 'profileIndex', 'exportedAt',
  'lighting', 'settings', 'layers', 'keymaps', 'perKeyRgb', 'macros',
  'advanced', 'macroMetadata', 'lightingMemory',
  'selectedLightEffect', 'customParam', 'triggerTravel'
]);

function validateStoredLayers(layers) {
  if (!isPlainObject(layers) && !Array.isArray(layers)) {
    return { valid: false, error: 'Profile layers must be an object' };
  }
  for (let l = 0; l < 4; l++) {
    const layer = Array.isArray(layers) ? layers[l] : layers[String(l)];
    if (layer == null) return { valid: false, error: `Profile layer ${l} is missing` };
    if (Array.isArray(layer)) {
      for (let i = 0; i < layer.length; i++) {
        const def = layer[i];
        if (!isPlainObject(def) || !Number.isInteger(def.type) || !Number.isInteger(def.code1) || !Number.isInteger(def.code2)) {
          return { valid: false, error: `Profile layer ${l} entry ${i} is malformed` };
        }
      }
      continue;
    }
    if (!isPlainObject(layer)) return { valid: false, error: `Profile layer ${l} must be an object` };
    for (const [slot, def] of Object.entries(layer)) {
      if (!isPlainObject(def) || !Number.isInteger(def.type) || !Number.isInteger(def.code1) || !Number.isInteger(def.code2)) {
        return { valid: false, error: `Profile layer ${l} slot ${slot} is malformed` };
      }
    }
  }
  return { valid: true };
}

function validateNativeSnapshot(data) {
  if (data == null) return { valid: false, error: 'Profile data is missing or malformed' };
  if (!isPlainObject(data)) return { valid: false, error: 'Profile data must be a plain object' };
  for (const key of Object.keys(data)) {
    if (!ALLOWED_SNAPSHOT_KEYS.has(key)) {
      return { valid: false, error: `Unknown profile data field "${key}"` };
    }
  }
  if (typeof data.model !== 'string' || !data.model.includes('MCHOSE G75 V2')) {
    return { valid: false, error: `Unsupported profile model: ${data.model}` };
  }
  if (data.protocol !== undefined && data.protocol !== 'GLW') {
    return { valid: false, error: `Unsupported profile protocol: ${data.protocol}` };
  }
  if (!isPlainObject(data.lighting)) {
    return { valid: false, error: 'Profile lighting must be an object' };
  }
  if (!Number.isInteger(data.lighting.effect) || !Number.isInteger(data.lighting.brightness)) {
    return { valid: false, error: 'Profile lighting is missing effect or brightness' };
  }
  if (!isPlainObject(data.settings)) {
    return { valid: false, error: 'Profile settings must be an object' };
  }
  if (!Number.isInteger(data.settings.sleepTime) || !Number.isInteger(data.settings.reporteRate)) {
    return { valid: false, error: 'Profile settings are missing sleepTime or reporteRate' };
  }
  const rawLayers = data.layers !== undefined ? data.layers : data.keymaps;
  const layers = validateStoredLayers(rawLayers);
  if (!layers.valid) return layers;
  if (data.perKeyRgb !== undefined && (data.perKeyRgb === null || typeof data.perKeyRgb !== 'object' || Array.isArray(data.perKeyRgb))) {
    return { valid: false, error: 'Profile perKeyRgb must be an object' };
  }
  if (data.macros !== undefined) {
    const macros = validators.validateMacroSlots(data.macros);
    if (!macros.valid) return { valid: false, error: macros.error };
  }
  if (data.macroMetadata !== undefined) {
    const meta = validators.validateMacroMetadata(data.macroMetadata);
    if (!meta.valid) return { valid: false, error: meta.error };
  }
  if (data.advanced !== undefined) {
    const adv = validators.validateAdvancedProfile(data.advanced, null);
    if (!adv.valid) return { valid: false, error: adv.error };
  }
  if (data.lightingMemory !== undefined) {
    const mem = lightingMemory.validateImportedLightingMemory(data.lightingMemory);
    if (!mem.valid) return { valid: false, error: mem.error };
  }
  if (data.customParam !== undefined && !isPlainObject(data.customParam)) {
    return { valid: false, error: 'Profile customParam must be an object' };
  }
  if (data.triggerTravel !== undefined && !isPlainObject(data.triggerTravel)) {
    return { valid: false, error: 'Profile triggerTravel must be an object' };
  }
  if (data.selectedLightEffect !== undefined && !Array.isArray(data.selectedLightEffect)) {
    return { valid: false, error: 'Profile selectedLightEffect must be an array' };
  }
  return { valid: true, data };
}

function cloneExtra(extra) {
  if (extra === undefined) return undefined;
  if (!isPlainObject(extra)) return {};
  return cloneJson(extra);
}

function makeItem(name, data, extra, key) {
  const checked = names.validateProfileName(name);
  if (!checked.valid) return checked;
  const snap = validateNativeSnapshot(data);
  if (!snap.valid) return snap;
  const item = {
    key: key || createKey(),
    name: checked.name,
    type: LOCAL_TYPE,
    profileIndex: -1,
    data: cloneJson(snap.data),
    extra: extra === undefined ? { confirmShareFailed: false } : cloneExtra(extra)
  };
  if (!item.extra) item.extra = { confirmShareFailed: false };
  if (item.extra.confirmShareFailed === undefined) item.extra.confirmShareFailed = false;
  return { valid: true, item };
}

function ordinaryRemaining(onboardOrdinaryCount, localOrdinaryCount) {
  return MAX_PROFILE_LENGTH - onboardOrdinaryCount - localOrdinaryCount;
}

function checkCapacity(onboardOrdinaryCount, localOrdinaryCount, extra = 1) {
  const remaining = ordinaryRemaining(onboardOrdinaryCount, localOrdinaryCount);
  if (remaining < extra) {
    return { valid: false, error: 'The number of configurations has reached the limit', remaining };
  }
  return { valid: true, remaining };
}

function validateStoredItem(raw, seenKeys) {
  if (!isPlainObject(raw)) return { valid: false, error: 'Profile library item must be a plain object' };
  const allowed = new Set(['key', 'name', 'type', 'profileIndex', 'data', 'extra']);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) return { valid: false, error: `Unknown profile library item field "${key}"` };
  }
  if (typeof raw.key !== 'string' || !raw.key.startsWith(KEY_PREFIX)) {
    return { valid: false, error: 'Profile library item key is missing or malformed' };
  }
  if (seenKeys.has(raw.key)) {
    return { valid: false, error: `Profile library has a duplicate key "${raw.key}"` };
  }
  if (raw.type !== LOCAL_TYPE) {
    return { valid: false, error: 'Profile library item type must be localstorage' };
  }
  if (raw.profileIndex !== -1) {
    return { valid: false, error: 'Profile library item profileIndex must be -1' };
  }
  if (raw.extra !== undefined && !isPlainObject(raw.extra)) {
    return { valid: false, error: 'Profile library item extra must be a plain object when present' };
  }
  const made = makeItem(raw.name, raw.data, raw.extra, raw.key);
  if (!made.valid) return made;
  seenKeys.add(raw.key);
  return { valid: true, item: made.item };
}

function validateItemsArray(rawItems) {
  if (rawItems === undefined) return { valid: true, items: [] };
  if (!Array.isArray(rawItems)) return { valid: false, error: 'Profile library items must be an array' };
  if (rawItems.length > MAX_PROFILE_LENGTH) {
    return { valid: false, error: `Profile library exceeds ${MAX_PROFILE_LENGTH} ordinary entries` };
  }
  const seenKeys = new Set();
  const items = [];
  for (let i = 0; i < rawItems.length; i++) {
    const checked = validateStoredItem(rawItems[i], seenKeys);
    if (!checked.valid) return { valid: false, error: checked.error || `Profile library item ${i} is invalid` };
    const nameCheck = names.validateProfileName(checked.item.name, { existing: items });
    if (!nameCheck.valid) return { valid: false, error: nameCheck.error };
    items.push(checked.item);
  }
  return { valid: true, items };
}

function validateRecoveryArray(raw) {
  if (raw === undefined) return { valid: true, recovery: [] };
  if (!Array.isArray(raw)) return { valid: false, error: 'Profile library recovery must be an array' };
  if (raw.length > MAX_RECOVERY) return { valid: false, error: 'Profile library recovery exceeds the bound' };
  const recovery = [];
  for (const row of raw) {
    if (!isPlainObject(row) || typeof row.key !== 'string' || !isPlainObject(row.item)) {
      return { valid: false, error: 'Profile library recovery entry is malformed' };
    }
    recovery.push(cloneJson(row));
  }
  return { valid: true, recovery };
}

function validateDeviceRecord(device) {
  if (!isPlainObject(device)) return { valid: false, error: 'Profile library device record must be a plain object' };
  const allowed = new Set(['model', 'items', 'identityKind', 'recovery']);
  for (const key of Object.keys(device)) {
    if (!allowed.has(key)) return { valid: false, error: `Unknown profile library device field "${key}"` };
  }
  if (device.model !== MODEL) {
    return { valid: false, error: `Profile library device model must be ${MODEL}` };
  }
  const items = validateItemsArray(device.items);
  if (!items.valid) return items;
  const recovery = validateRecoveryArray(device.recovery);
  if (!recovery.valid) return recovery;
  return { valid: true, items: items.items, recovery: recovery.recovery };
}

function parseLocalDocument(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return { ok: true, missing: true, data: emptyFile() };
    }
    const st = fs.statSync(filePath);
    if (!st.isFile() || st.size > MAX_LOCAL_FILE_BYTES) {
      return { ok: false, unwritable: true, recovered: true, error: 'Profile library local file exceeds the bounded size' };
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    if (Buffer.byteLength(raw, 'utf8') > MAX_LOCAL_FILE_BYTES) {
      return { ok: false, unwritable: true, recovered: true, error: 'Profile library local file exceeds the bounded size' };
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return { ok: false, unwritable: true, recovered: true, error: err.message || 'Profile library local file is not valid JSON' };
    }
    if (!isPlainObject(parsed) || !isPlainObject(parsed.devices)) {
      return { ok: false, unwritable: true, recovered: true, error: 'Profile library local file is malformed' };
    }
    for (const key of Object.keys(parsed)) {
      if (key !== 'version' && key !== 'devices') {
        return { ok: false, unwritable: true, recovered: true, error: `Unknown profile library file field "${key}"` };
      }
    }
    if (parsed.version !== undefined && parsed.version !== SCHEMA_VERSION) {
      return { ok: false, unwritable: true, recovered: true, error: `Unsupported profile library file version: "${parsed.version}"` };
    }
    if (Object.keys(parsed.devices).length > MAX_LOCAL_DEVICES) {
      return { ok: false, unwritable: true, recovered: true, error: 'Profile library local file has too many devices' };
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
  const tmp = path.join(dir, `.profile-library-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}.tmp`);
  const text = JSON.stringify(data, null, 2);
  if (Buffer.byteLength(text, 'utf8') > MAX_LOCAL_FILE_BYTES) {
    throw new Error('Profile library local file would exceed the bounded size');
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

function readDevice(filePath, deviceKey) {
  const doc = parseLocalDocument(filePath);
  if (!doc.ok) {
    return { ok: false, items: [], recovery: [], error: doc.error, unwritable: true, recovered: true };
  }
  const device = doc.data.devices && doc.data.devices[deviceKey];
  if (!device) return { ok: true, items: [], recovery: [] };
  const checked = validateDeviceRecord(device);
  if (!checked.valid) {
    return {
      ok: false,
      items: [],
      recovery: [],
      error: checked.error || 'Profile library device record is malformed',
      unwritable: true,
      recovered: true
    };
  }
  return { ok: true, items: checked.items, recovery: checked.recovery };
}

function writeDevice(filePath, deviceKey, items, options = {}) {
  const incoming = validateItemsArray(items);
  if (!incoming.valid) {
    throw new Error(incoming.error || 'Profile library contains an item that failed validation');
  }
  const doc = parseLocalDocument(filePath);
  if (!doc.ok) {
    throw new Error(`${doc.error || 'Local profile library file is unreadable'}; existing file was left unchanged`);
  }
  const file = doc.data;
  if (!file.devices) file.devices = {};
  if (file.devices[deviceKey]) {
    const existing = validateDeviceRecord(file.devices[deviceKey]);
    if (!existing.valid) {
      throw new Error(`${existing.error || 'Local profile library file is malformed'}; existing file was left unchanged`);
    }
  } else if (Object.keys(file.devices).length >= MAX_LOCAL_DEVICES) {
    throw new Error('Profile library local store is at the device limit');
  }
  if (!isPlainObject(file.devices[deviceKey])) {
    file.devices[deviceKey] = { model: MODEL, items: [], recovery: [] };
  }
  file.devices[deviceKey].model = MODEL;
  file.devices[deviceKey].items = incoming.items;
  if (options.identityKind) file.devices[deviceKey].identityKind = options.identityKind;
  if (options.recovery) {
    const rec = validateRecoveryArray(options.recovery);
    if (!rec.valid) throw new Error(rec.error);
    file.devices[deviceKey].recovery = rec.recovery.slice(0, MAX_RECOVERY);
  }
  file.version = SCHEMA_VERSION;
  saveLocalFileAtomic(filePath, file);
  return incoming.items;
}

function prependRecovery(recovery, item, reason) {
  const next = Array.isArray(recovery) ? recovery.slice() : [];
  next.unshift({
    key: item && item.key,
    reason: reason || 'outgoing',
    savedAt: Date.now(),
    item: cloneJson(item)
  });
  return next.slice(0, MAX_RECOVERY);
}

function createFromDefaults(items, name, onboardOrdinaryCount, existingNames = []) {
  const cap = checkCapacity(onboardOrdinaryCount, items.length, 1);
  if (!cap.valid) return cap;
  const chosen = names.uniqueLocalName(name || 'New configuration 1', items.concat(existingNames));
  if (!chosen) return { valid: false, error: 'Could not allocate a unique configuration name' };
  const made = makeItem(chosen, defaultNativeSnapshot());
  if (!made.valid) return made;
  return { valid: true, item: made.item, items: [made.item, ...items] };
}

function copyOnboardToLocal(items, name, snapshot, extra, onboardOrdinaryCount, existingNames = []) {
  const cap = checkCapacity(onboardOrdinaryCount, items.length, 1);
  if (!cap.valid) return cap;
  const allocated = names.allocateLocalName(name, items.concat(existingNames));
  if (!allocated.valid) return allocated;
  const made = makeItem(allocated.name, snapshot, names.extraWithPreservedOriginal(extra, allocated));
  if (!made.valid) return made;
  return { valid: true, item: made.item, items: [made.item, ...items] };
}

function renameItem(items, key, name, onboardNames) {
  const index = items.findIndex((item) => item.key === key);
  if (index < 0) return { valid: false, error: 'Profile was not found' };
  const existing = items.map((item, i) => (i === index ? null : { name: item.name, key: item.key })).filter(Boolean);
  for (const n of onboardNames || []) existing.push({ name: n, key: `onboard:${n}` });
  const checked = names.validateProfileName(name, { existing, ignoreKey: key });
  if (!checked.valid) return checked;
  const next = items.slice();
  next[index] = { ...next[index], name: checked.name };
  return { valid: true, item: next[index], items: next };
}

function deleteItem(items, key) {
  const current = items.find((item) => item.key === key);
  if (!current) return { valid: false, error: 'Profile was not found' };
  return { valid: true, deleted: current, items: items.filter((item) => item.key !== key) };
}

function reorderItems(items, orderedKeys) {
  const list = items.slice();
  const rank = new Map((orderedKeys || []).map((k, i) => [k, i]));
  list.sort((a, b) => {
    const ia = rank.has(a.key) ? rank.get(a.key) : 9999;
    const ib = rank.has(b.key) ? rank.get(b.key) : 9999;
    return ia - ib;
  });
  return { valid: true, items: list };
}

function updateItemData(items, key, data) {
  const index = items.findIndex((item) => item.key === key);
  if (index < 0) return { valid: false, error: 'Profile was not found' };
  const snap = validateNativeSnapshot(data);
  if (!snap.valid) return snap;
  const next = items.slice();
  next[index] = { ...next[index], data: cloneJson(snap.data) };
  return { valid: true, item: next[index], items: next };
}

function snapshot(onboard, localItems, extras = {}) {
  const local = Array.isArray(localItems) ? localItems : [];
  const board = Array.isArray(onboard) ? onboard : [];
  const ordinaryOnboard = board.filter((p) => p && p.type === KEYBOARD_TYPE).length;
  const remaining = Math.max(0, ordinaryRemaining(ordinaryOnboard, local.length));
  return {
    onboard: board,
    local: local.map((item) => ({
      key: item.key,
      name: item.name,
      type: item.type,
      profileIndex: item.profileIndex,
      extra: cloneExtra(item.extra)
    })),
    items: local,
    count: ordinaryOnboard + local.length,
    max: MAX_PROFILE_LENGTH,
    remaining,
    onboardCount: ordinaryOnboard,
    localCount: local.length,
    error: extras.error || null,
    unwritable: Boolean(extras.unwritable),
    recovered: Boolean(extras.recovered),
    recoveryCount: extras.recoveryCount || 0,
    names: extras.names || [],
    namesSource: extras.namesSource || 'default',
    progress: extras.progress || null,
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
  MODEL,
  SCHEMA_VERSION,
  LOCAL_TYPE,
  KEYBOARD_TYPE,
  KEY_PREFIX,
  MAX_PROFILE_LENGTH,
  MAX_KEYBOARD_PROFILES,
  MAX_LOCAL_FILE_BYTES,
  createKey,
  onboardKey,
  defaultNativeSnapshot,
  defaultLighting,
  defaultSettings,
  defaultLayers,
  validateNativeSnapshot,
  makeItem,
  ordinaryRemaining,
  checkCapacity,
  parseLocalDocument,
  readDevice,
  writeDevice,
  prependRecovery,
  createFromDefaults,
  copyOnboardToLocal,
  renameItem,
  deleteItem,
  reorderItems,
  updateItemData,
  snapshot,
  defaultLocalPath,
  deviceStorageKey,
  deviceIdentity,
  cloneJson
};
