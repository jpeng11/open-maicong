/**
 * Official version-3 KeyboardProfile JSON (hub tw/tx/tC).
 * Import creates a local item and writes no hardware.
 */

const names = require('./profile-names.cjs');
const keys = require('./profile-keys.cjs');
const library = require('./profile-library.cjs');
const lightingMemory = require('./lighting-memory.cjs');
const protocol = require('./protocol.cjs');
const validators = require('./schema-validators.cjs');
const { VALID_LIGHTING_SLOTS } = require('./layout-g75v2.cjs');
const draft = require('./macro-draft.js');

const G75_VID = 14391;
const G75_WIRED_PID = 8225;
const G75_RECEIVER_PID = 12339;
const G75_MODEL_TYPE = 133;
const G75_WIRED_NAME = 'MCHOSE G75 V2';
const G75_RECEIVER_NAME = 'MCHOSE G75 V2 2.4G';
const DATA_SCOPE = 'KeyboardProfile';
const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;
const MACRO_ACTIONS = new Set(['keydown', 'keyup', 'mousedown', 'mouseup']);
// GLW hub tC / en 821, 823, 825 store hardware types 0, 1, 255 (bytes 34+i).
// QHW UI_MACRO_TYPE_DICT maps UI OneTime=2 onto GLW hardware 1; type 2 is not a GLW official mode.
const VALID_PLAYBACK = new Set([0, 1, 255]);
const NESTED_OFFICIAL_OBJECTS = ['performance', 'light', 'customParam', 'triggerTravel', 'advancedKeys'];

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asInt(value) {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  return null;
}

function isUint8(value) {
  return Number.isInteger(value) && value >= 0 && value <= 255;
}

function parseIdentityNumber(value, label) {
  if (typeof value === 'number' && Number.isInteger(value)) return { ok: true, value };
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^0x[0-9a-fA-F]+$/.test(trimmed)) {
      return { ok: true, value: parseInt(trimmed, 16) };
    }
    if (/^[0-9]+$/.test(trimmed)) {
      return { ok: true, value: parseInt(trimmed, 10) };
    }
  }
  return { ok: false, error: `Invalid ${label}` };
}

function resolveG75Model(vendorId, productId, productName) {
  const vid = parseIdentityNumber(vendorId, 'vendorId');
  const pid = parseIdentityNumber(productId, 'productId');
  if (!vid.ok) return { ok: false, error: vid.error };
  if (!pid.ok) return { ok: false, error: pid.error };
  if (vid.value !== G75_VID) {
    return { ok: false, error: 'Profile is not a G75 V2 identity' };
  }
  const name = productName == null ? '' : String(productName);
  if (pid.value === G75_WIRED_PID) {
    return { ok: true, modelType: G75_MODEL_TYPE, kind: 'wired', vendorId: vid.value, productId: pid.value, productName: name || G75_WIRED_NAME };
  }
  if (pid.value === G75_RECEIVER_PID) {
    if (!/G75\s*V2/i.test(name) || !/2\.4G/i.test(name)) {
      return { ok: false, error: 'Ambiguous receiver PID 0x3033 was not identified as G75 V2' };
    }
    return { ok: true, modelType: G75_MODEL_TYPE, kind: 'receiver', vendorId: vid.value, productId: pid.value, productName: name };
  }
  return { ok: false, error: 'Profile product id is not a G75 V2 wired or receiver identity' };
}

function nativeActionsToOfficial(actions) {
  if (!Array.isArray(actions)) return [];
  const out = [];
  for (const act of actions) {
    if (!act || typeof act !== 'object') continue;
    const code = Number.isInteger(act.code) ? act.code : 0;
    const delay = Number.isInteger(act.delay) ? act.delay : 0;
    if (!code) {
      if (delay >= 5) out.push({ type: 'time', delay });
      continue;
    }
    out.push({ type: 'action', action: act.action, code });
    if (delay >= 5) out.push({ type: 'time', delay });
  }
  return out;
}

function officialActionsToNative(records) {
  if (records === undefined) return { valid: true, actions: [] };
  if (!Array.isArray(records)) return { valid: false, error: 'macroActions must be an array' };
  const actions = [];
  let pending = null;
  const flushPending = () => {
    if (pending) {
      actions.push(pending);
      pending = null;
    }
  };
  for (let i = 0; i < records.length; i++) {
    const row = records[i];
    if (!isPlainObject(row) || typeof row.type !== 'string') {
      return { valid: false, error: `Malformed macro record at index ${i}` };
    }
    if (row.type === 'time') {
      if (!Number.isInteger(row.delay) || row.delay < 0) {
        return { valid: false, error: `Malformed macro time delay at index ${i}` };
      }
      if (pending) {
        pending.delay = row.delay;
        flushPending();
      } else {
        actions.push({ action: 'keyup', code: 0, delay: row.delay });
      }
      continue;
    }
    if (row.type === 'action') {
      if (!MACRO_ACTIONS.has(row.action) || !Number.isInteger(row.code)) {
        return { valid: false, error: `Malformed macro action at index ${i}` };
      }
      flushPending();
      pending = { action: row.action, code: row.code, delay: 0 };
      continue;
    }
    return { valid: false, error: `Unsupported macro record type "${row.type}"` };
  }
  flushPending();
  return { valid: true, actions };
}

function emptyMetadataSlots() {
  const slots = [];
  for (let i = 0; i < 16; i++) slots.push({});
  return slots;
}

function officialMacrosToNative(macros) {
  if (macros === undefined) return { valid: true, macros: [], macroMetadata: { version: 1, slots: emptyMetadataSlots() } };
  if (!Array.isArray(macros)) return { valid: false, error: 'Official macros must be an array' };
  const out = [];
  const metaSlots = emptyMetadataSlots();
  const seen = new Set();
  for (let i = 0; i < macros.length; i++) {
    const slot = macros[i];
    if (!isPlainObject(slot)) return { valid: false, error: `Official macro slot ${i} is malformed` };
    if (!Number.isInteger(slot.macroIndex) || slot.macroIndex < 0 || slot.macroIndex > 15) {
      return { valid: false, error: `Official macroIndex at slot ${i} is missing or out of range` };
    }
    if (seen.has(slot.macroIndex)) {
      return { valid: false, error: `Duplicate official macroIndex ${slot.macroIndex}` };
    }
    seen.add(slot.macroIndex);
    if (slot.type !== undefined && !VALID_PLAYBACK.has(slot.type)) {
      return { valid: false, error: `Official macro playback type ${slot.type} at index ${slot.macroIndex} is not 0, 1, or 255` };
    }
    const converted = officialActionsToNative(slot.macroActions);
    if (!converted.valid) return converted;
    const name = typeof slot.name === 'string' ? slot.name : `Macro ${slot.macroIndex + 1}`;
    if (slot.defaultDelay !== undefined && (!Number.isInteger(slot.defaultDelay) || slot.defaultDelay < 5 || slot.defaultDelay > 65535)) {
      return { valid: false, error: `Official macro defaultDelay at index ${slot.macroIndex} is malformed` };
    }
    if (slot.enableDefaultDelay !== undefined && typeof slot.enableDefaultDelay !== 'boolean') {
      return { valid: false, error: `Official macro enableDefaultDelay at index ${slot.macroIndex} is malformed` };
    }
    out.push({
      id: slot.macroIndex,
      name,
      type: Number.isInteger(slot.type) ? slot.type : 0,
      actions: converted.actions
    });
    const meta = { name };
    if (Number.isInteger(slot.defaultDelay)) meta.defaultDelay = slot.defaultDelay;
    if (slot.enableDefaultDelay !== undefined) meta.enableDefaultDelay = Boolean(slot.enableDefaultDelay);
    metaSlots[slot.macroIndex] = meta;
  }
  return { valid: true, macros: out, macroMetadata: { version: 1, slots: metaSlots } };
}

function nativeMacrosToOfficial(macros, metadata) {
  if (!Array.isArray(macros)) return [];
  const metaSlots = metadata && Array.isArray(metadata.slots) ? metadata.slots : [];
  return macros.map((slot, i) => {
    const id = slot && Number.isInteger(slot.id) ? slot.id : i;
    const meta = isPlainObject(metaSlots[id]) ? metaSlots[id] : {};
    const name = (slot && typeof slot.name === 'string' && slot.name)
      ? slot.name
      : (typeof meta.name === 'string' ? meta.name : '');
    const defaultDelay = Number.isInteger(meta.defaultDelay)
      ? meta.defaultDelay
      : (slot && Number.isInteger(slot.defaultDelay) ? slot.defaultDelay : 50);
    const enableDefaultDelay = meta.enableDefaultDelay !== undefined
      ? Boolean(meta.enableDefaultDelay)
      : (slot && slot.enableDefaultDelay !== undefined ? Boolean(slot.enableDefaultDelay) : true);
    return {
      macroIndex: id,
      macroActions: nativeActionsToOfficial(slot && slot.actions),
      name,
      type: slot && Number.isInteger(slot.type) ? slot.type : 0,
      defaultDelay,
      enableDefaultDelay
    };
  });
}

function optionalInt(value, label) {
  if (value === undefined) return { valid: true, present: false };
  if (!Number.isInteger(value)) return { valid: false, error: `Official ${label} must be an integer` };
  return { valid: true, present: true, value };
}

function lightToNative(light) {
  if (!isPlainObject(light)) return { valid: false, error: 'Official light must be an object' };
  const c = light.config !== undefined ? light.config : light;
  if (!isPlainObject(c)) return { valid: false, error: 'Official light.config must be an object' };
  if (light.colors !== undefined && !Array.isArray(light.colors)) {
    return { valid: false, error: 'Official light.colors must be an array when present' };
  }
  const lighting = {};
  const effect = optionalInt(c.effect, 'light effect');
  if (!effect.valid) return effect;
  if (!effect.present) return { valid: false, error: 'Official light is missing effect' };
  lighting.effect = effect.value;

  const brightness = optionalInt(c.brightness, 'light brightness');
  if (!brightness.valid) return brightness;
  if (!brightness.present) return { valid: false, error: 'Official light is missing brightness' };
  lighting.brightness = brightness.value;

  const speed = optionalInt(c.speed, 'light speed');
  if (!speed.valid) return speed;
  if (speed.present) lighting.speed = speed.value;

  const direct = optionalInt(c.direct !== undefined ? c.direct : c.direction, 'light direction');
  if (!direct.valid) return direct;
  if (direct.present) lighting.direction = direct.value;

  if (c.customColorDisabled !== undefined) {
    if (typeof c.customColorDisabled !== 'boolean' && c.customColorDisabled !== 0 && c.customColorDisabled !== 1) {
      return { valid: false, error: 'Official light customColorDisabled is malformed' };
    }
    lighting.customColorDisabled = Boolean(c.customColorDisabled);
  }
  if (c.hexColor !== undefined) {
    if (typeof c.hexColor !== 'string' || !HEX_COLOR.test(c.hexColor)) {
      return { valid: false, error: 'Official light hexColor is malformed' };
    }
    lighting.hexColor = c.hexColor;
  }

  const sideEffect = optionalInt(c.side_effect, 'side light effect');
  if (!sideEffect.valid) return sideEffect;
  if (sideEffect.present) lighting.sideEffect = sideEffect.value;
  const sideBrightness = optionalInt(c.side_brightness, 'side light brightness');
  if (!sideBrightness.valid) return sideBrightness;
  if (sideBrightness.present) lighting.sideBrightness = sideBrightness.value;
  const sideSpeed = optionalInt(c.side_speed, 'side light speed');
  if (!sideSpeed.valid) return sideSpeed;
  if (sideSpeed.present) lighting.sideSpeed = sideSpeed.value;
  if (c.sideCustomColorDisabled !== undefined) {
    if (typeof c.sideCustomColorDisabled !== 'boolean' && c.sideCustomColorDisabled !== 0 && c.sideCustomColorDisabled !== 1) {
      return { valid: false, error: 'Official light sideCustomColorDisabled is malformed' };
    }
    lighting.sideCustomColorDisabled = Boolean(c.sideCustomColorDisabled);
  }
  if (c.side_hexColor !== undefined) {
    if (typeof c.side_hexColor !== 'string' || !HEX_COLOR.test(c.side_hexColor)) {
      return { valid: false, error: 'Official light side_hexColor is malformed' };
    }
    lighting.sideHexColor = c.side_hexColor;
  }

  const lit = validators.validateLightingParams(lighting);
  if (!lit.valid) return { valid: false, error: lit.error };

  const colors = Array.isArray(light.colors) ? light.colors : [];
  const perKeyRgb = {};
  for (let i = 0; i < colors.length; i++) {
    if (typeof colors[i] === 'string' && colors[i] && VALID_LIGHTING_SLOTS.has(i)) {
      if (!HEX_COLOR.test(colors[i])) {
        return { valid: false, error: `Official light color at index ${i} is malformed` };
      }
      perKeyRgb[String(i)] = colors[i];
    }
  }
  return { valid: true, lighting, perKeyRgb };
}

function nativeToLight(snapshot) {
  const l = snapshot.lighting || {};
  const colors = new Array(128).fill('');
  const rgb = snapshot.perKeyRgb && typeof snapshot.perKeyRgb === 'object' ? snapshot.perKeyRgb : {};
  for (const [slot, hex] of Object.entries(rgb)) {
    const i = parseInt(slot, 10);
    if (Number.isInteger(i) && i >= 0 && i < 128 && typeof hex === 'string') colors[i] = hex;
  }
  return {
    config: {
      effect: l.effect,
      brightness: l.brightness,
      speed: l.speed,
      direct: l.direction,
      customColorDisabled: l.customColorDisabled ? 1 : 0,
      hexColor: l.hexColor,
      side_effect: l.sideEffect,
      side_brightness: l.sideBrightness,
      side_speed: l.sideSpeed,
      sideCustomColorDisabled: l.sideCustomColorDisabled ? 1 : 0,
      side_hexColor: l.sideHexColor
    },
    colors
  };
}

function performanceToNative(perf) {
  if (!isPlainObject(perf)) return { valid: false, error: 'Official performance must be an object' };
  const settings = {};
  const ints = ['sleepTime', 'sleepMode', 'debounceLevel', 'macMode', 'rollerType', 'reporteRate'];
  for (const field of ints) {
    if (perf[field] === undefined) continue;
    if (!Number.isInteger(perf[field])) {
      return { valid: false, error: `Official performance.${field} must be an integer` };
    }
    if (field === 'macMode') settings.macMode = perf.macMode % 4;
    else settings[field] = perf[field];
  }
  if (settings.sleepTime === undefined) {
    return { valid: false, error: 'Official performance is missing sleepTime' };
  }
  if (settings.reporteRate === undefined) {
    return { valid: false, error: 'Official performance is missing reporteRate' };
  }
  if (perf.lockWin !== undefined) {
    if (typeof perf.lockWin !== 'boolean') {
      return { valid: false, error: 'Official performance.lockWin must be a boolean' };
    }
    settings.lockWin = perf.lockWin;
  }
  const checked = validators.validateSettingsParams(settings);
  if (!checked.valid) return { valid: false, error: checked.error };
  return { valid: true, settings };
}

function isSupportedOfficialReportRate(rate) {
  return rate === 1 || rate === 2 || rate === 3 || rate === 4;
}

function nativeToPerformance(snapshot) {
  const s = snapshot.settings || {};
  const macMode = Number.isInteger(s.macMode) ? s.macMode % 4 : 0;
  return {
    macMode: macMode - (macMode % 2),
    debugMode: 0,
    rf_battery: 0,
    isCharging: 0,
    work_mode: 0,
    reporteRate: s.reporteRate,
    report_rate_2_4G: 0,
    tickRate: 0,
    sleepTime: s.sleepTime,
    sleepMode: s.sleepMode,
    debounceLevel: s.debounceLevel,
    lockWin: Boolean(s.lockWin),
    rollerType: s.rollerType
  };
}

function userKeysToNative(userKeys) {
  if (!Array.isArray(userKeys) || userKeys.length !== 4) {
    return { valid: false, error: 'Official userKeys must be an array of 4 layers' };
  }
  const layers = {};
  for (let l = 0; l < 4; l++) {
    if (!isPlainObject(userKeys[l])) {
      return { valid: false, error: `Official userKeys layer ${l} must be an object` };
    }
    try {
      layers[String(l)] = keys.decodeLayerDiff(userKeys[l], l);
    } catch (err) {
      return { valid: false, error: err.message || 'Official userKeys could not be decoded' };
    }
    const layer = layers[String(l)];
    for (const [slot, def] of Object.entries(layer)) {
      if (!isPlainObject(def) || !isUint8(def.type) || !isUint8(def.code1) || !isUint8(def.code2)) {
        return { valid: false, error: `Official userKeys layer ${l} slot ${slot} is malformed` };
      }
    }
  }
  return { valid: true, layers };
}

function nativeToUserKeys(snapshot) {
  const layers = snapshot.layers || snapshot.keymaps || {};
  const out = [];
  for (let l = 0; l < 4; l++) {
    const layer = Array.isArray(layers) ? layers[l] : layers[String(l)];
    out.push(keys.encodeLayerDiff(layer || {}, l));
  }
  return out;
}

function isKeyTuple(value) {
  return isPlainObject(value) && isUint8(value.type) && isUint8(value.code1) && isUint8(value.code2);
}

function tupleZero(value) {
  return value.type === 0 && value.code1 === 0 && value.code2 === 0;
}

function pickTuple(value) {
  return { type: value.type, code1: value.code1, code2: value.code2 };
}

function dksEntryPopulated(entry) {
  if (!isPlainObject(entry)) return true;
  const actions = [entry.action0, entry.action1, entry.action2, entry.action3];
  for (const action of actions) {
    if (action && isPlainObject(action) && (action.type || action.code1 || action.code2)) return true;
  }
  if (Array.isArray(entry.point) && entry.point.some((b) => b)) return true;
  return false;
}

function referencedAdvancedIndices(layers) {
  const mt = new Set();
  const tgl = new Set();
  const src = layers || {};
  for (let l = 0; l < 4; l++) {
    const layer = Array.isArray(src) ? src[l] : src[String(l)];
    if (!layer) continue;
    const entries = Array.isArray(layer)
      ? layer
      : Object.entries(layer).map(([slot, def]) => ({ slot: Number(slot), ...def }));
    for (const item of entries) {
      const def = item.def || item;
      const type = Array.isArray(def) ? def[0] : def.type;
      const code1 = Array.isArray(def) ? def[1] : def.code1;
      if (type === 146 && Number.isInteger(code1)) mt.add(code1);
      if (type === 145 && Number.isInteger(code1)) tgl.add(code1);
    }
  }
  return { mt, tgl };
}

function officialAdvancedToNative(advancedKeys, layers) {
  if (!isPlainObject(advancedKeys)) {
    return { valid: false, error: 'Official advancedKeys must be an object' };
  }
  if (advancedKeys.dks !== undefined) {
    if (!Array.isArray(advancedKeys.dks)) {
      return { valid: false, error: 'Official advancedKeys.dks must be an array' };
    }
    if (advancedKeys.dks.some(dksEntryPopulated)) {
      return { valid: false, error: 'Magnetic DKS advanced keys are not supported on G75 V2 mechanical' };
    }
  }
  if (advancedKeys.mt !== undefined && !Array.isArray(advancedKeys.mt)) {
    return { valid: false, error: 'Official advancedKeys.mt must be an array' };
  }
  if (advancedKeys.tgl !== undefined && !Array.isArray(advancedKeys.tgl)) {
    return { valid: false, error: 'Official advancedKeys.tgl must be an array' };
  }
  const mtSrc = Array.isArray(advancedKeys.mt) ? advancedKeys.mt : [];
  const tglSrc = Array.isArray(advancedKeys.tgl) ? advancedKeys.tgl : [];
  if (mtSrc.length > 32) return { valid: false, error: 'Official MT table exceeds 32 entries' };
  if (tglSrc.length > 32) return { valid: false, error: 'Official TGL table exceeds 32 entries' };

  const mtEntries = [];
  for (let i = 0; i < mtSrc.length; i++) {
    const row = mtSrc[i];
    if (row == null) return { valid: false, error: `Official MT entry at index ${i} is missing` };
    if (!isPlainObject(row) || !isKeyTuple(row.clickKey) || !isKeyTuple(row.downKey)) {
      return { valid: false, error: `Malformed official MT entry at index ${i}` };
    }
    for (const key of Object.keys(row)) {
      if (key !== 'clickKey' && key !== 'downKey') {
        return { valid: false, error: `Unknown field "${key}" in official MT entry ${i}` };
      }
    }
    mtEntries.push({
      index: i,
      tapKey: pickTuple(row.clickKey),
      holdKey: pickTuple(row.downKey),
      empty: tupleZero(row.clickKey) && tupleZero(row.downKey)
    });
  }

  const tglEntries = [];
  for (let i = 0; i < tglSrc.length; i++) {
    const row = tglSrc[i];
    if (row == null) return { valid: false, error: `Official TGL entry at index ${i} is missing` };
    if (!isKeyTuple(row)) {
      return { valid: false, error: `Malformed official TGL entry at index ${i}` };
    }
    tglEntries.push({
      index: i,
      targetKey: pickTuple(row),
      empty: tupleZero(row)
    });
  }

  const refs = referencedAdvancedIndices(layers);
  for (const idx of refs.mt) {
    if (idx < 0 || idx >= 32) {
      return { valid: false, error: `Imported MT table index ${idx} is out of range` };
    }
    const row = mtEntries[idx];
    if (!row || row.empty) {
      return { valid: false, error: `Imported keymap references MT table index ${idx} which is empty or missing` };
    }
  }
  for (const idx of refs.tgl) {
    if (idx < 0 || idx >= 32) {
      return { valid: false, error: `Imported TGL table index ${idx} is out of range` };
    }
    const row = tglEntries[idx];
    if (!row || row.empty) {
      return { valid: false, error: `Imported keymap references TGL table index ${idx} which is empty or missing` };
    }
  }

  const mtForWire = mtEntries.filter((e) => !e.empty).map((e) => ({
    index: e.index,
    tapKey: e.tapKey,
    holdKey: e.holdKey
  }));
  const tglForWire = tglEntries.filter((e) => !e.empty).map((e) => ({
    index: e.index,
    targetKey: e.targetKey
  }));

  let mtHex;
  let tglHex;
  try {
    mtHex = protocol.serializeMtTable(mtForWire).toString('hex');
    tglHex = protocol.serializeTglTable(tglForWire).toString('hex');
  } catch (err) {
    return { valid: false, error: err.message || 'Official advanced tables could not be converted' };
  }

  if (!mtForWire.length && !tglForWire.length) {
    return { valid: true, advanced: undefined };
  }

  const advanced = { mt: mtHex, tgl: tglHex };
  const checked = validators.validateAdvancedProfile(advanced, layers);
  if (!checked.valid) return { valid: false, error: checked.error };
  return { valid: true, advanced };
}

function nativeAdvancedToOfficial(advanced) {
  if (advanced === undefined || advanced === null) {
    return { valid: true, advancedKeys: { dks: [], mt: [], tgl: [] } };
  }
  if (!isPlainObject(advanced)) {
    return { valid: false, error: 'Native advanced section must be an object' };
  }
  let mtBuf;
  let tglBuf;
  try {
    if (advanced.mt === undefined) {
      mtBuf = Buffer.alloc(protocol.MT_TABLE_SIZE);
    } else if (typeof advanced.mt === 'string') {
      if (!/^[0-9a-fA-F]{512}$/.test(advanced.mt)) {
        return { valid: false, error: 'Native MT hex is malformed' };
      }
      mtBuf = Buffer.from(advanced.mt, 'hex');
    } else if (Array.isArray(advanced.mt)) {
      mtBuf = protocol.serializeMtTable(advanced.mt);
    } else {
      return { valid: false, error: 'Native MT table is malformed' };
    }
    if (advanced.tgl === undefined) {
      tglBuf = Buffer.alloc(protocol.TGL_TABLE_SIZE);
    } else if (typeof advanced.tgl === 'string') {
      if (!/^[0-9a-fA-F]{256}$/.test(advanced.tgl)) {
        return { valid: false, error: 'Native TGL hex is malformed' };
      }
      tglBuf = Buffer.from(advanced.tgl, 'hex');
    } else if (Array.isArray(advanced.tgl)) {
      tglBuf = protocol.serializeTglTable(advanced.tgl);
    } else {
      return { valid: false, error: 'Native TGL table is malformed' };
    }
  } catch (err) {
    return { valid: false, error: err.message || 'Native advanced tables could not be serialized' };
  }

  const mtParsed = protocol.parseMtTable(mtBuf);
  const tglParsed = protocol.parseTglTable(tglBuf);
  return {
    valid: true,
    advancedKeys: {
      dks: [],
      mt: mtParsed.map((e) => ({
        clickKey: { type: e.rawTap[0], code1: e.rawTap[1], code2: e.rawTap[2] },
        downKey: { type: e.rawHold[0], code1: e.rawHold[1], code2: e.rawHold[2] }
      })),
      tgl: tglParsed.map((e) => ({
        type: e.rawTarget[0],
        code1: e.rawTarget[1],
        code2: e.rawTarget[2]
      }))
    }
  };
}

function lightValueStoreToNative(store) {
  if (store === undefined) return { valid: true, lightingMemory: undefined };
  if (!isPlainObject(store)) return { valid: false, error: 'Official lightValueStore must be an object' };
  for (const field of ['light', 'sideLight', 'sideLight2']) {
    if (store[field] !== undefined && !Array.isArray(store[field])) {
      return { valid: false, error: `Official lightValueStore ${field} must be an array when present` };
    }
  }
  const main = store.light === undefined ? [] : store.light;
  const side = store.sideLight === undefined ? [] : store.sideLight;
  const side2 = store.sideLight2 === undefined ? [] : store.sideLight2;
  if (!main.length && !side.length && !side2.length) return { valid: true, lightingMemory: undefined };
  const checked = lightingMemory.validateImportedLightingMemory({ main, side, side2 });
  if (!checked.valid) return { valid: false, error: checked.error || 'Official lightValueStore is malformed' };
  return { valid: true, lightingMemory: { main, side, side2 } };
}

function inspectOfficialEnvelope(obj) {
  if (!isPlainObject(obj)) return { valid: false, error: 'Official profile must be a JSON object' };
  if (obj.dataScope && obj.dataScope !== DATA_SCOPE) {
    return { valid: false, error: `Unsupported dataScope "${obj.dataScope}"` };
  }
  if (obj.version === undefined || obj.data === undefined) {
    return { valid: false, error: 'Unsupported profile schema: official KeyboardProfile requires version and data' };
  }
  const version = obj.version;
  // Version 2 was never traced from a real vendor file; the vendor's broad
  // version>=2 branch is dispatch evidence, not a schema we can validate.
  if (version === 2) {
    return { valid: false, error: 'Unsupported legacy official profile version: 2' };
  }
  if (version !== 3) {
    return { valid: false, error: `Unsupported official profile version: ${version}` };
  }
  const identity = resolveG75Model(
    obj.vendorId != null ? obj.vendorId : (obj.identity && obj.identity.vendorId),
    obj.productId != null ? obj.productId : (obj.identity && obj.identity.productId),
    obj.productName != null ? obj.productName : (obj.identity && obj.identity.productName)
  );
  if (!identity.ok) return { valid: false, error: identity.error };
  const data = obj.data;
  if (!isPlainObject(data)) return { valid: false, error: 'Official profile data must be an object' };
  for (const field of NESTED_OFFICIAL_OBJECTS) {
    if (!isPlainObject(data[field])) {
      return { valid: false, error: `Official profile ${field} must be an object` };
    }
  }
  if (!Array.isArray(data.userKeys) || data.userKeys.length !== 4) {
    return { valid: false, error: 'Official userKeys must be an array of 4 layers' };
  }
  for (let i = 0; i < 4; i++) {
    if (!isPlainObject(data.userKeys[i])) {
      return { valid: false, error: `Official userKeys layer ${i} must be an object` };
    }
  }
  if (data.lightValueStore !== undefined && !isPlainObject(data.lightValueStore)) {
    return { valid: false, error: 'Official lightValueStore must be an object' };
  }
  if (data.selectedLightEffect !== undefined && !Array.isArray(data.selectedLightEffect)) {
    return { valid: false, error: 'Official selectedLightEffect must be an array when present' };
  }

  const macros = officialMacrosToNative(obj.macros);
  if (!macros.valid) return macros;
  const lighting = lightToNative(data.light);
  if (!lighting.valid) return lighting;
  const settings = performanceToNative(data.performance);
  if (!settings.valid) return settings;
  const layers = userKeysToNative(data.userKeys);
  if (!layers.valid) return layers;
  const adv = officialAdvancedToNative(data.advancedKeys, layers.layers);
  if (!adv.valid) return adv;
  const mem = lightValueStoreToNative(data.lightValueStore);
  if (!mem.valid) return mem;
  const displayName = names.translateI18nDisplay(names.formatName(data.name || (obj.data && obj.data.name)));
  const native = {
    app: 'Maicong Studio',
    model: 'MCHOSE G75 V2',
    protocol: 'GLW',
    version: '2.0.0',
    lighting: lighting.lighting,
    settings: settings.settings,
    layers: layers.layers,
    perKeyRgb: lighting.perKeyRgb,
    macros: macros.macros,
    macroMetadata: macros.macroMetadata,
    selectedLightEffect: Array.isArray(data.selectedLightEffect) ? data.selectedLightEffect : ['still', ''],
    customParam: data.customParam,
    triggerTravel: data.triggerTravel
  };
  if (mem.lightingMemory) native.lightingMemory = mem.lightingMemory;
  if (adv.advanced) native.advanced = adv.advanced;
  return {
    valid: true,
    identity,
    name: displayName || 'Imported',
    native,
    extra: isPlainObject(data.extra) ? data.extra : {},
    version
  };
}

function exportOfficialEnvelope(item, options = {}) {
  const src = item && item.data ? item.data : item;
  if (!isPlainObject(src)) return { valid: false, error: 'Nothing to export' };
  const name = names.translateI18nDisplay(names.formatName((item && item.name) || src.name || 'Profile'));
  const identity = options.identity || {
    vendorId: G75_VID,
    productId: options.receiver ? G75_RECEIVER_PID : G75_WIRED_PID,
    productName: options.receiver ? G75_RECEIVER_NAME : G75_WIRED_NAME
  };
  const advanced = nativeAdvancedToOfficial(src.advanced);
  if (!advanced.valid) return advanced;
  let userKeys;
  try {
    userKeys = nativeToUserKeys(src);
  } catch (err) {
    return { valid: false, error: err.message || 'Profile layers could not be encoded' };
  }
  const performance = nativeToPerformance(src);
  if (!isSupportedOfficialReportRate(performance.reporteRate)) {
    return {
      valid: false,
      error: `Invalid reporteRate: ${performance.reporteRate}. Must be integer 1..4 (1=8k, 2=4k, 3=2k, 4=1k)`
    };
  }
  const data = {
    name,
    performance,
    light: nativeToLight(src),
    userKeys,
    triggerTravel: src.triggerTravel || { travelKeys: [] },
    customParam: src.customParam || {},
    lightValueStore: src.lightingMemory
      ? {
        light: src.lightingMemory.main || [],
        sideLight: src.lightingMemory.side || [],
        sideLight2: src.lightingMemory.side2 || []
      }
      : { light: [], sideLight: [], sideLight2: [] },
    selectedLightEffect: src.selectedLightEffect || ['still', ''],
    advancedKeys: advanced.advancedKeys
  };
  const extra = {
    ...(item && item.extra ? item.extra : {}),
    fw_ver: options.fw_ver || 0,
    rffw_ver: options.rffw_ver || '0',
    identity
  };
  return {
    valid: true,
    envelope: {
      dataScope: DATA_SCOPE,
      type: (item && item.type) || library.LOCAL_TYPE,
      version: 3,
      vendorId: identity.vendorId,
      productId: identity.productId,
      productName: identity.productName,
      identity,
      exportedAt: Date.now(),
      data: { ...data, extra },
      macros: nativeMacrosToOfficial(src.macros, src.macroMetadata)
    }
  };
}

function referencedMacroSlots(layers) {
  const used = new Set();
  const src = layers || {};
  for (let l = 0; l < 4; l++) {
    const layer = Array.isArray(src) ? src[l] : src[String(l)];
    if (!layer) continue;
    const entries = Array.isArray(layer) ? layer : Object.entries(layer).map(([slot, def]) => ({ slot: Number(slot), ...def }));
    for (const item of entries) {
      const def = item.def || item;
      const type = Array.isArray(def) ? def[0] : def.type;
      const code1 = Array.isArray(def) ? def[1] : def.code1;
      if (type === 112 && Number.isInteger(code1)) used.add(code1);
    }
  }
  return used;
}

function collectLayerMacroSlots(layersByProfile) {
  const used = new Set();
  for (const layers of layersByProfile || []) {
    for (const slot of referencedMacroSlots(layers)) used.add(slot);
  }
  return used;
}

function emptyMacroSlot(id) {
  return { id, name: `Macro ${id + 1}`, type: 0, actions: [] };
}

function playbackType(slot) {
  return slot && Number.isInteger(slot.type) ? slot.type : 0;
}

function planMacroRemap(importedSlots, currentSlots, reservedByOthers) {
  const current = Array.isArray(currentSlots) ? currentSlots.slice() : [];
  while (current.length < 16) current.push(emptyMacroSlot(current.length));
  const reserved = reservedByOthers instanceof Set ? reservedByOthers : new Set();
  const imported = Array.isArray(importedSlots) ? importedSlots : [];
  const remap = new Map();
  const next = current.map((s) => ({ ...s, actions: Array.isArray(s.actions) ? s.actions.slice() : [] }));
  const bodyOf = (slot) => draft.getNormalizedBodyKey(slot && slot.actions);

  const usedIds = new Set();
  const seenImported = new Set();
  for (const slot of imported) {
    if (!slot || !Array.isArray(slot.actions) || slot.actions.length === 0) continue;
    if (!Number.isInteger(slot.id) || slot.id < 0 || slot.id > 15) {
      return { valid: false, error: `Imported macro slot id ${slot && slot.id} is out of range` };
    }
    if (seenImported.has(slot.id)) {
      return { valid: false, error: `Duplicate imported macro slot id ${slot.id}` };
    }
    seenImported.add(slot.id);
    const importedType = playbackType(slot);
    const key = bodyOf(slot);
    const dup = next.find((s) => bodyOf(s) && bodyOf(s) === key && playbackType(s) === importedType);
    if (dup) {
      remap.set(slot.id, dup.id);
      usedIds.add(dup.id);
      continue;
    }
    let dest = null;
    if (!reserved.has(slot.id) && !usedIds.has(slot.id) && (!next[slot.id] || !bodyOf(next[slot.id]))) {
      dest = slot.id;
    } else {
      for (let i = 0; i < 16; i++) {
        if (reserved.has(i) || usedIds.has(i)) continue;
        if (!bodyOf(next[i])) {
          dest = i;
          break;
        }
      }
    }
    if (dest == null) {
      return { valid: false, error: 'Shared macro bank has no free slot for imported macros without replacing unrelated references' };
    }
    const merged = {
      ...next[dest],
      id: dest,
      actions: slot.actions.slice(),
      type: importedType,
      name: typeof slot.name === 'string' ? slot.name : next[dest].name
    };
    if (!draft.canMutateSlot(next, dest, merged.actions)) {
      return { valid: false, error: 'Imported macros exceed the shared macro bank capacity' };
    }
    next[dest] = merged;
    remap.set(slot.id, dest);
    usedIds.add(dest);
  }

  return { valid: true, remap, slots: next };
}

function remapMacroMetadata(meta, remap) {
  if (!isPlainObject(meta) || !Array.isArray(meta.slots)) return meta;
  const relocated = emptyMetadataSlots();
  for (const [from, to] of remap.entries()) {
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from > 15 || to < 0 || to > 15) continue;
    const src = isPlainObject(meta.slots[from]) ? meta.slots[from] : {};
    relocated[to] = { ...src };
  }
  return { version: 1, slots: relocated };
}

function rewriteMacroBindings(layers, remap, slots) {
  const typeById = new Map();
  if (Array.isArray(slots)) {
    for (const s of slots) {
      if (s && Number.isInteger(s.id)) typeById.set(s.id, playbackType(s));
    }
  }
  const rewriteDef = (def) => {
    if (!def) return def;
    const type = Array.isArray(def) ? def[0] : def.type;
    const code1 = Array.isArray(def) ? def[1] : def.code1;
    if (type === 112 && remap.has(code1)) {
      const dest = remap.get(code1);
      const destType = typeById.has(dest)
        ? typeById.get(dest)
        : (Array.isArray(def) ? def[2] : def.code2);
      if (Array.isArray(def)) return [112, dest, destType];
      return { ...def, code1: dest, code2: destType };
    }
    return def;
  };
  const out = {};
  const src = layers || {};
  for (let l = 0; l < 4; l++) {
    const layer = Array.isArray(src) ? src[l] : src[String(l)];
    if (Array.isArray(layer)) {
      out[String(l)] = layer.map(rewriteDef);
      continue;
    }
    const map = {};
    if (layer && typeof layer === 'object') {
      for (const [slot, def] of Object.entries(layer)) {
        map[slot] = rewriteDef(def);
      }
    }
    out[String(l)] = map;
  }
  return out;
}

module.exports = {
  G75_VID,
  G75_WIRED_PID,
  G75_RECEIVER_PID,
  G75_MODEL_TYPE,
  G75_WIRED_NAME,
  G75_RECEIVER_NAME,
  DATA_SCOPE,
  resolveG75Model,
  nativeActionsToOfficial,
  officialActionsToNative,
  inspectOfficialEnvelope,
  exportOfficialEnvelope,
  referencedMacroSlots,
  collectLayerMacroSlots,
  planMacroRemap,
  remapMacroMetadata,
  rewriteMacroBindings,
  officialAdvancedToNative,
  nativeAdvancedToOfficial,
  asInt
};
