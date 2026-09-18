/**
 * Portable GLW dataV2 key identities from G75 factory layer 0.
 * Helpers traced from chunk 2233 module 82668.F / 91951 tz,X,Bk,Yb,$p.
 * Space aliases 301/302 (Te g75V2) map to lighting-only slots 45/61.
 */

const fs = require('node:fs');
const path = require('node:path');
const { VALID_PHYSICAL_SLOTS } = require('./layout-g75v2.cjs');

const FACTORY_KEY_COUNT = 128;
const LAYER_COUNT = 4;
const FN_SLOT = 85;
const SPACE_ALIASES = [
  { alias: 'code:301', name: 'space2', slot: 45 },
  { alias: 'code:302', name: 'space3', slot: 61 }
];

let _factoryCache = null;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function packKey(type, code1, code2) {
  return ((type << 16) | (code1 << 8) | code2) & 0xffffff;
}

function packedHex(type, code1, code2) {
  const packed = packKey(type, code1, code2);
  if (!packed) return null;
  return `0x${packed.toString(16).toLowerCase()}`;
}

function isFnKey(tuple) {
  return Boolean(tuple) && tuple.type === 240 && tuple.code1 === 255;
}

function isSidePlaceholder(tuple) {
  if (!tuple) return false;
  const a = tuple.type;
  const b = tuple.code1;
  const c = tuple.code2;
  return a === b && b === c && a >= 240;
}

function isOrdinaryHid(tuple) {
  return Boolean(tuple) && tuple.type === 16 && tuple.code1 === 0 && tuple.code2 > 0;
}

function tupleFromBytes(bytes, index) {
  const off = index * 3;
  return {
    type: bytes[off],
    code1: bytes[off + 1],
    code2: bytes[off + 2]
  };
}

const FACTORY_DEFAULTS_ERROR = 'Packaged keyboard defaults are damaged; reinstall the app';

function loadFactoryLayers() {
  if (_factoryCache) return _factoryCache;
  const file = path.join(__dirname, 'data', 'default-layers.json');
  let json;
  try {
    json = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error(FACTORY_DEFAULTS_ERROR);
  }
  if (!isPlainObject(json) || json.model !== 'MCHOSE G75 V2' || json.usedBytes !== 384 || !isPlainObject(json.layers)) {
    throw new Error(FACTORY_DEFAULTS_ERROR);
  }
  const layers = [];
  for (let l = 0; l < LAYER_COUNT; l++) {
    const hex = json.layers[String(l)];
    // Buffer.from silently truncates short or odd-length hex instead of throwing
    if (typeof hex !== 'string' || hex.length !== 768) {
      throw new Error(FACTORY_DEFAULTS_ERROR);
    }
    const buf = Buffer.from(hex, 'hex');
    const tuples = [];
    for (let i = 0; i < FACTORY_KEY_COUNT; i++) tuples.push(tupleFromBytes(buf, i));
    layers.push(tuples);
  }
  _factoryCache = layers;
  return layers;
}

function factoryLayer(layer = 0) {
  return loadFactoryLayers()[layer] || loadFactoryLayers()[0];
}

function firstSidePlaceholderIndex(layer0) {
  for (let i = 0; i < layer0.length; i++) {
    if (isSidePlaceholder(layer0[i])) return i;
  }
  return -1;
}

function identityForFactoryTuple(tuple, index, layer0) {
  if (!tuple) return null;
  if (isFnKey(tuple)) return 'fn-key';
  if (isSidePlaceholder(tuple)) {
    const first = firstSidePlaceholderIndex(layer0);
    return `side-light-key:relative@${index - first}`;
  }
  if (isOrdinaryHid(tuple) || tuple.type) {
    return packedHex(tuple.type, tuple.code1, tuple.code2);
  }
  return null;
}

function buildLookup(layer = 0) {
  const layer0 = factoryLayer(0);
  const source = layer === 0 ? layer0 : factoryLayer(layer);
  const counts = Object.create(null);
  const bySlot = new Array(FACTORY_KEY_COUNT);
  for (let i = 0; i < FACTORY_KEY_COUNT; i++) {
    const id = identityForFactoryTuple(source[i], i, layer0);
    if (!id) {
      bySlot[i] = null;
      continue;
    }
    const occurrence = counts[id] || 0;
    counts[id] = occurrence + 1;
    bySlot[i] = { storageKeyByte: id, occurrence, slot: i };
  }
  for (const alias of SPACE_ALIASES) {
    if (!bySlot[alias.slot]) {
      const occurrence = counts[alias.alias] || 0;
      counts[alias.alias] = occurrence + 1;
      bySlot[alias.slot] = { storageKeyByte: alias.alias, occurrence, slot: alias.slot, alias: true };
    }
  }
  return { bySlot, counts };
}

function pickPortableValue(tuple) {
  if (Array.isArray(tuple) && tuple.length >= 3) {
    return { type: tuple[0], code1: tuple[1], code2: tuple[2] };
  }
  if (!isPlainObject(tuple)) return null;
  const out = {
    type: tuple.type,
    code1: tuple.code1,
    code2: tuple.code2
  };
  if (tuple.code3 !== undefined) out.code3 = tuple.code3;
  return out;
}

function tuplesEqual(a, b) {
  if (!a || !b) return false;
  return a.type === b.type && a.code1 === b.code1 && a.code2 === b.code2;
}

function normalizeFnCompare(tuple, factory) {
  if (isFnKey(tuple) && isFnKey(factory)) {
    return { ...tuple, code2: tuple.code2 % LAYER_COUNT };
  }
  return tuple;
}

function encodeLayerDiff(layerMap, layerIndex = 0) {
  const lookup = buildLookup(0);
  const factory = factoryLayer(layerIndex);
  const dataV2 = {};
  const src = layerMap && typeof layerMap === 'object' ? layerMap : {};
  for (let slot = 0; slot < FACTORY_KEY_COUNT; slot++) {
    const ident = lookup.bySlot[slot];
    if (!ident) continue;
    const raw = src[slot] !== undefined ? src[slot] : src[String(slot)];
    if (raw == null) continue;
    const value = pickPortableValue(raw);
    if (!value) continue;
    const compared = normalizeFnCompare(value, factory[slot]);
    if (tuplesEqual(compared, factory[slot])) continue;
    if (isFnKey(factory[slot]) && isFnKey(compared) && (compared.code2 % LAYER_COUNT) === (factory[slot].code2 % LAYER_COUNT)) {
      continue;
    }
    if (!dataV2[ident.storageKeyByte]) dataV2[ident.storageKeyByte] = [];
    dataV2[ident.storageKeyByte][ident.occurrence] = compared;
  }
  return { type: 'diff-keys', dataV2 };
}

function decodeLayerDiff(record, layerIndex = 0) {
  const factory = factoryLayer(layerIndex);
  const lookup = buildLookup(0);
  const out = {};
  for (const slot of VALID_PHYSICAL_SLOTS) {
    const f = factory[slot];
    out[String(slot)] = { type: f.type, code1: f.code1, code2: f.code2 };
  }
  if (!record) return out;
  if (Array.isArray(record)) {
    for (let i = 0; i < record.length && i < FACTORY_KEY_COUNT; i++) {
      const v = pickPortableValue(record[i]);
      if (v && VALID_PHYSICAL_SLOTS.has(i)) out[String(i)] = v;
    }
    return out;
  }
  if (!isPlainObject(record)) return out;
  const dataV2 = record.dataV2 || (record.type === 'diff-keys' ? record.dataV2 : null);
  const legacy = record.data;
  for (let slot = 0; slot < FACTORY_KEY_COUNT; slot++) {
    if (!VALID_PHYSICAL_SLOTS.has(slot)) continue;
    const ident = lookup.bySlot[slot];
    let value = null;
    if (dataV2 && ident) {
      const arr = dataV2[ident.storageKeyByte];
      if (Array.isArray(arr) && arr[ident.occurrence] != null) value = pickPortableValue(arr[ident.occurrence]);
    } else if (Array.isArray(legacy) && legacy[slot] != null) {
      value = pickPortableValue(legacy[slot]);
    }
    if (value) {
      if (isFnKey(value)) {
        value = { ...value, code2: value.code2 % LAYER_COUNT };
      }
      out[String(slot)] = value;
    }
  }
  for (const alias of SPACE_ALIASES) {
    if (!isPlainObject(dataV2)) continue;
    const arr = dataV2[alias.alias] || dataV2[alias.name];
    if (Array.isArray(arr) && arr[0] != null) {
      const value = pickPortableValue(arr[0]);
      if (value) out[String(alias.slot)] = value;
    }
  }
  return out;
}

function lookupSlotIdentity(slot) {
  return buildLookup(0).bySlot[slot] || null;
}

module.exports = {
  FACTORY_KEY_COUNT,
  LAYER_COUNT,
  FN_SLOT,
  SPACE_ALIASES,
  packKey,
  packedHex,
  isFnKey,
  isSidePlaceholder,
  isOrdinaryHid,
  loadFactoryLayers,
  factoryLayer,
  buildLookup,
  pickPortableValue,
  encodeLayerDiff,
  decodeLayerDiff,
  lookupSlotIdentity
};
