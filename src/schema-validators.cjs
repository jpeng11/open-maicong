/**
 * Shared Schema Validators for Maicong Studio
 * Enforces strict input validation before ANY hardware write.
 * Shared between backend IPC handlers, transport mutators, and profile import.
 */

const {
  VALID_PHYSICAL_SLOTS,
  VALID_LIGHTING_SLOTS,
  ELIGIBLE_ADVANCED_SLOTS,
  getDefaultTuple,
  getComplementPriority
} = require('./layout-g75v2.cjs');
const { calculateMacroBankBytes } = require('./macro-draft.js');
const lightingMemory = require('./lighting-memory.cjs');

// Valid GLW Key Types (Verified Hardware)
const VALID_KEY_TYPES = new Set([
  0,   // EMPTY
  16,  // STANDARD [16, modifierMask, HIDusage]
  32,  // MOUSE_BUTTON [32, buttonMask, 0]
  33,  // MOUSE_WHEEL [33, 0, scrollDirection] (1: Up, 255: Down)
  48,  // MEDIA_MOUSE [48, 226, 0]
  64,  // SYSTEM [64, usage, 0] (Power, Sleep, Wake)
  112, // MACRO [112, slot, playbackType]
  145, // TGL [145, tableIndex, 0]
  146, // MT [146, tableIndex, delayMs / 10]
  148, // SOCD [148, tableIndex, partnerPhysicalSlot]
  240  // FN_LAYER [240, 255, 1]
]);

// Valid Macro Playback Types: 0 = repeat while held, 1 = play once, 255 = toggle repeat
const VALID_PLAYBACK_TYPES = new Set([0, 1, 255]);

// Valid Macro Action Kinds
const VALID_ACTION_NAMES = new Set(['keydown', 'keyup', 'mousedown', 'mouseup']);

const HEX_COLOR_REGEX = /^#[0-9A-Fa-f]{6}$/;
const CANONICAL_INT_REGEX = /^(0|[1-9]\d*)$/;

function isPlainObject(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const proto = Object.getPrototypeOf(obj);
  return proto === Object.prototype || proto === null;
}

function isInteger(val) {
  return typeof val === 'number' && Number.isInteger(val) && !Number.isNaN(val);
}

function isUint8(val) {
  return isInteger(val) && val >= 0 && val <= 255;
}

// Ordinary tuples allowed as MT tap/hold and TGL targets (not macros, not recursive advanced).
const ORDINARY_TABLE_KEY_TYPES = new Set([0, 16, 32, 33, 48, 64, 240]);

const ADVANCED_BINDING_KINDS = new Set(['mt', 'tgl', 'socd', 'cb', 'remove']);

function tuplesEqual(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === 3 && b.length === 3 &&
    a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

/**
 * Exact 3-byte tuple: integer index-aligned [type, code1, code2], no missing bytes, no NaN.
 */
function validateExactTuple3(tuple, desc) {
  if (Array.isArray(tuple)) {
    if (tuple.length !== 3) {
      return { valid: false, error: `${desc} must be an exact 3-byte array [type, code1, code2]` };
    }
    for (let i = 0; i < 3; i++) {
      if (!isUint8(tuple[i])) {
        return { valid: false, error: `Invalid byte ${i} in ${desc}: ${tuple[i]}. Must be integer 0..255` };
      }
    }
    return { valid: true, tuple: [tuple[0], tuple[1], tuple[2]] };
  }
  if (isPlainObject(tuple)) {
    const allowed = new Set(['type', 'code1', 'code2']);
    for (const k of Object.keys(tuple)) {
      if (!allowed.has(k)) {
        return { valid: false, error: `Unknown key "${k}" in ${desc}` };
      }
    }
    if (!isUint8(tuple.type) || !isUint8(tuple.code1) || !isUint8(tuple.code2)) {
      return { valid: false, error: `Invalid or missing type/code1/code2 in ${desc}. All must be integers 0..255` };
    }
    return { valid: true, tuple: [tuple.type, tuple.code1, tuple.code2] };
  }
  return { valid: false, error: `${desc} must be a 3-byte array or plain object with type, code1, code2` };
}

function validateOrdinaryTableTuple(tuple, desc) {
  const checked = validateExactTuple3(tuple, desc);
  if (!checked.valid) return checked;
  const type = checked.tuple[0];
  if (type >= 145 && type <= 149) {
    return { valid: false, error: `Recursive advanced tuple type ${type} not allowed in ${desc}` };
  }
  if (!ORDINARY_TABLE_KEY_TYPES.has(type)) {
    return { valid: false, error: `${desc} type ${type} is not an ordinary keyboard, chord, consumer, or system tuple` };
  }
  if (type === 32) {
    if (checked.tuple[1] <= 0 || (checked.tuple[1] & ~31) !== 0 || checked.tuple[2] !== 0) {
      return { valid: false, error: `Invalid mouse button tuple in ${desc}: [${checked.tuple.join(', ')}]` };
    }
  } else if (type === 33) {
    if (checked.tuple[1] !== 0 || (checked.tuple[2] !== 1 && checked.tuple[2] !== 255)) {
      return { valid: false, error: `Invalid mouse wheel tuple in ${desc}: [${checked.tuple.join(', ')}]` };
    }
  }
  return checked;
}

function pickNamedTuple(item, primaryKey, altKey, desc) {
  const hasPrimary = item[primaryKey] !== undefined;
  const hasAlt = item[altKey] !== undefined;
  if (!hasPrimary && !hasAlt) {
    return { valid: false, error: `Missing tuple for ${desc}` };
  }
  if (hasPrimary && hasAlt) {
    const a = validateExactTuple3(item[primaryKey], `${desc} ${primaryKey}`);
    if (!a.valid) return a;
    const b = validateExactTuple3(item[altKey], `${desc} ${altKey}`);
    if (!b.valid) return b;
    if (!tuplesEqual(a.tuple, b.tuple)) {
      return { valid: false, error: `${desc} ${primaryKey} and ${altKey} disagree` };
    }
    return a;
  }
  return validateExactTuple3(hasPrimary ? item[primaryKey] : item[altKey], desc);
}

function iterateProfileLayerSlots(rawLayers, callback) {
  if (!rawLayers || typeof rawLayers !== 'object') return;
  for (let l = 0; l < 4; l++) {
    const layerObj = Array.isArray(rawLayers) ? rawLayers[l] : rawLayers[String(l)];
    if (!layerObj) continue;
    if (Array.isArray(layerObj)) {
      for (const item of layerObj) {
        if (!item || typeof item !== 'object') continue;
        const slot = item.slot !== undefined ? item.slot : item.index;
        callback(l, slot, item);
      }
    } else if (typeof layerObj === 'object') {
      for (const [sStr, def] of Object.entries(layerObj)) {
        callback(l, Number(sStr), def);
      }
    }
  }
}

function layersContainAdvancedBindings(rawLayers) {
  let found = false;
  iterateProfileLayerSlots(rawLayers, (_l, _slot, def) => {
    if (!def) return;
    if (def.type === 145 || def.type === 146 || def.type === 148) found = true;
  });
  return found;
}

/**
 * Validates lighting parameters object.
 * Rejects unknown keys, unsupported effects, non-integers, invalid hex.
 * Allows optional calibrationRgb: { r, g, b }.
 *
 * @param {Object} params
 * @returns {{ valid: boolean, error?: string }}
 */
function validateLightingParams(params) {
  if (!isPlainObject(params)) {
    return { valid: false, error: 'Lighting parameters must be a plain non-null object' };
  }

  const allowedKeys = new Set([
    'effect', 'brightness', 'speed', 'direction', 'customColorDisabled', 'hexColor',
    'sideEffect', 'sideBrightness', 'sideSpeed', 'sideCustomColorDisabled', 'sideHexColor',
    'calibrationRgb'
  ]);

  for (const key of Object.keys(params)) {
    if (!allowedKeys.has(key)) {
      return { valid: false, error: `Unknown lighting parameter key: "${key}"` };
    }
  }

  // Main effect: 0..22 (23 official effects)
  if (params.effect !== undefined) {
    if (!isInteger(params.effect) || params.effect < 0 || params.effect > 22) {
      return { valid: false, error: `Invalid lighting effect: ${params.effect}. Must be integer 0..22` };
    }
  }

  // Brightness: 0..100
  if (params.brightness !== undefined) {
    if (!isInteger(params.brightness) || params.brightness < 0 || params.brightness > 100) {
      return { valid: false, error: `Invalid brightness: ${params.brightness}. Must be integer 0..100` };
    }
  }

  // Speed: 0..4 (verified hardware range)
  if (params.speed !== undefined) {
    if (!isInteger(params.speed) || params.speed < 0 || params.speed > 4) {
      return { valid: false, error: `Invalid speed: ${params.speed}. Must be integer 0..4` };
    }
  }

  // Direction: 0 or 1
  if (params.direction !== undefined) {
    if (typeof params.direction === 'boolean') {
      // boolean is acceptable
    } else if (!isInteger(params.direction) || (params.direction !== 0 && params.direction !== 1)) {
      return { valid: false, error: `Invalid direction: ${params.direction}. Must be 0 or 1` };
    }
  }

  // customColorDisabled: boolean or 0/1
  if (params.customColorDisabled !== undefined) {
    if (typeof params.customColorDisabled !== 'boolean' && params.customColorDisabled !== 0 && params.customColorDisabled !== 1) {
      return { valid: false, error: 'customColorDisabled must be boolean or 0/1' };
    }
  }

  // hexColor: valid 7-char hex
  if (params.hexColor !== undefined) {
    if (typeof params.hexColor !== 'string' || !HEX_COLOR_REGEX.test(params.hexColor)) {
      return { valid: false, error: `Invalid hexColor: "${params.hexColor}". Must be #RRGGBB format` };
    }
  }

  // Side Effect: 1..4 (1: Neon, 2: Constant On, 3: Breathing, 4: Off)
  if (params.sideEffect !== undefined) {
    if (!isInteger(params.sideEffect) || params.sideEffect < 1 || params.sideEffect > 4) {
      return { valid: false, error: `Invalid sideEffect: ${params.sideEffect}. Must be integer 1..4` };
    }
  }

  // Side Brightness: 0..100
  if (params.sideBrightness !== undefined) {
    if (!isInteger(params.sideBrightness) || params.sideBrightness < 0 || params.sideBrightness > 100) {
      return { valid: false, error: `Invalid sideBrightness: ${params.sideBrightness}. Must be integer 0..100` };
    }
  }

  // Side Speed: 0..4
  if (params.sideSpeed !== undefined) {
    if (!isInteger(params.sideSpeed) || params.sideSpeed < 0 || params.sideSpeed > 4) {
      return { valid: false, error: `Invalid sideSpeed: ${params.sideSpeed}. Must be integer 0..4` };
    }
  }

  // sideCustomColorDisabled: boolean or 0/1
  if (params.sideCustomColorDisabled !== undefined) {
    if (typeof params.sideCustomColorDisabled !== 'boolean' && params.sideCustomColorDisabled !== 0 && params.sideCustomColorDisabled !== 1) {
      return { valid: false, error: 'sideCustomColorDisabled must be boolean or 0/1' };
    }
  }

  // sideHexColor: valid 7-char hex
  if (params.sideHexColor !== undefined) {
    if (typeof params.sideHexColor !== 'string' || !HEX_COLOR_REGEX.test(params.sideHexColor)) {
      return { valid: false, error: `Invalid sideHexColor: "${params.sideHexColor}". Must be #RRGGBB format` };
    }
  }

  // calibrationRgb: { r: 0..255, g: 0..255, b: 0..255 }
  if (params.calibrationRgb !== undefined) {
    if (!isPlainObject(params.calibrationRgb)) {
      return { valid: false, error: 'calibrationRgb must be a plain object with integer r, g, b (0..255)' };
    }
    const { r, g, b } = params.calibrationRgb;
    if (!isUint8(r) || !isUint8(g) || !isUint8(b)) {
      return { valid: false, error: 'calibrationRgb r, g, b components must be uint8 integers 0..255' };
    }
  }

  return { valid: true };
}

/**
 * Validates performance settings object.
 * Rejects unknown keys, non-integers, invalid values.
 * Strictly checks only editable implemented fields that mutateSettings applies.
 *
 * @param {Object} settings
 * @returns {{ valid: boolean, error?: string }}
 */
function validateSettingsParams(settings) {
  if (!isPlainObject(settings)) {
    return { valid: false, error: 'Settings parameters must be a plain non-null object' };
  }

  const allowedKeys = new Set([
    'sleepTime', 'sleepMode', 'debounceLevel', 'macMode',
    'reporteRate', 'lockWin', 'rollerType'
  ]);

  for (const key of Object.keys(settings)) {
    if (!allowedKeys.has(key)) {
      return { valid: false, error: `Unknown settings parameter key: "${key}"` };
    }
  }

  if (settings.sleepTime !== undefined) {
    if (!isUint8(settings.sleepTime)) {
      return { valid: false, error: `Invalid sleepTime: ${settings.sleepTime}. Must be integer 0..255 (units of 30s)` };
    }
  }

  if (settings.sleepMode !== undefined) {
    if (typeof settings.sleepMode !== 'boolean' && settings.sleepMode !== 0 && settings.sleepMode !== 1) {
      return { valid: false, error: 'sleepMode must be boolean or 0/1 (1 = never sleep)' };
    }
  }

  if (settings.debounceLevel !== undefined) {
    if (!isInteger(settings.debounceLevel) || settings.debounceLevel < 0 || settings.debounceLevel > 7) {
      return { valid: false, error: `Invalid debounceLevel: ${settings.debounceLevel}. Must be integer 0..7` };
    }
  }

  if (settings.macMode !== undefined) {
    if (!isInteger(settings.macMode) || settings.macMode < 0 || settings.macMode > 15) {
      return { valid: false, error: `Invalid macMode: ${settings.macMode}. Must be integer 0..15` };
    }
  }

  if (settings.reporteRate !== undefined) {
    // 4=1kHz, 3=2kHz, 2=4kHz, 1=8kHz
    if (!isInteger(settings.reporteRate) || settings.reporteRate < 1 || settings.reporteRate > 4) {
      return { valid: false, error: `Invalid reporteRate: ${settings.reporteRate}. Must be integer 1..4 (1=8k, 2=4k, 3=2k, 4=1k)` };
    }
  }

  if (settings.lockWin !== undefined) {
    if (typeof settings.lockWin !== 'boolean' && settings.lockWin !== 0 && settings.lockWin !== 1) {
      return { valid: false, error: 'lockWin must be boolean or 0/1' };
    }
  }

  if (settings.rollerType !== undefined) {
    if (!isUint8(settings.rollerType)) {
      return { valid: false, error: `Invalid rollerType: ${settings.rollerType}. Must be uint8 integer 0..255` };
    }
  }

  return { valid: true };
}

/**
 * Validates keymap updates array.
 * Restricts slots strictly to physical slots (82 keys).
 * Requires code1 and code2 (no default zero permitted).
 * Rejects duplicates and unknown keys.
 *
 * @param {Array<Object>} keyUpdates
 * @returns {{ valid: boolean, error?: string }}
 */
function validateKeymapUpdates(keyUpdates) {
  if (!Array.isArray(keyUpdates)) {
    return { valid: false, error: 'Key updates must be an array' };
  }

  const seenSlots = new Set();
  const allowedKeys = new Set(['slot', 'index', 'type', 'code1', 'code2']);

  for (let i = 0; i < keyUpdates.length; i++) {
    const u = keyUpdates[i];
    if (!isPlainObject(u)) {
      return { valid: false, error: `Key update at index ${i} must be a plain object` };
    }

    for (const k of Object.keys(u)) {
      if (!allowedKeys.has(k)) {
        return { valid: false, error: `Unknown key "${k}" in key update at index ${i}` };
      }
    }

    const slot = u.slot !== undefined ? u.slot : u.index;
    if (!isInteger(slot) || !VALID_PHYSICAL_SLOTS.has(slot)) {
      return { valid: false, error: `Invalid key slot ${slot} at index ${i}. Cannot write to non-physical slot: ${slot}` };
    }

    if (seenSlots.has(slot)) {
      return { valid: false, error: `Duplicate key update for slot ${slot} at index ${i}` };
    }
    seenSlots.add(slot);

    if (!isInteger(u.type) || !VALID_KEY_TYPES.has(u.type)) {
      return { valid: false, error: `Invalid key tuple type ${u.type} at slot ${slot}. Must be one of: [${Array.from(VALID_KEY_TYPES).join(', ')}]` };
    }

    // code1 and code2 are REQUIRED. Missing code1/code2 must fail, no default zero.
    if (u.code1 === undefined || !isUint8(u.code1)) {
      return { valid: false, error: `Missing or invalid code1 for slot ${slot}. Must be uint8 integer 0..255` };
    }

    if (u.code2 === undefined || !isUint8(u.code2)) {
      return { valid: false, error: `Missing or invalid code2 for slot ${slot}. Must be uint8 integer 0..255` };
    }

    // Empty/Disabled key validation: type 0 requires code1=0 and code2=0
    if (u.type === 0) {
      if (u.code1 !== 0 || u.code2 !== 0) {
        return { valid: false, error: `Disabled key at slot ${slot} must have code1=0 and code2=0, got [0, ${u.code1}, ${u.code2}]` };
      }
    }

    // Mouse button validation: type 32
    if (u.type === 32) {
      if (u.code1 <= 0 || (u.code1 & ~31) !== 0) {
        return { valid: false, error: `Mouse button binding at slot ${slot} specifies invalid button mask ${u.code1}. Allowed button bits: 1, 2, 4, 8, 16` };
      }
      if (u.code2 !== 0) {
        return { valid: false, error: `Mouse button binding at slot ${slot} must have code2=0, got ${u.code2}` };
      }
    }

    // Mouse wheel validation: type 33
    if (u.type === 33) {
      if (u.code1 !== 0) {
        return { valid: false, error: `Mouse wheel binding at slot ${slot} must have code1=0, got ${u.code1}` };
      }
      if (u.code2 !== 1 && u.code2 !== 255) {
        return { valid: false, error: `Mouse wheel binding at slot ${slot} specifies invalid direction ${u.code2}. Must be 1 (Up) or 255 (Down)` };
      }
    }

    // System control validation: type 64
    if (u.type === 64) {
      if (u.code2 !== 0) {
        return { valid: false, error: `System control binding at slot ${slot} must have code2=0, got ${u.code2}` };
      }
    }

    // Macro binding validation: type 112
    if (u.type === 112) {
      const macroSlot = u.code1;
      if (!isInteger(macroSlot) || macroSlot < 0 || macroSlot > 15) {
        return { valid: false, error: `Macro key binding at slot ${slot} specifies invalid macro slot ${macroSlot}. Must be 0..15` };
      }
      const playbackType = u.code2;
      if (!VALID_PLAYBACK_TYPES.has(playbackType)) {
        return { valid: false, error: `Macro key binding at slot ${slot} specifies invalid playback type ${playbackType}. Must be 0, 1, or 255` };
      }
    }

    // Advanced Key bindings (TGL: 145, MT: 146, SOCD: 148)
    if (u.type === 145 || u.type === 146 || u.type === 148) {
      if (slot === 37 || slot === 85) {
        return { valid: false, error: `Slot ${slot} (${slot === 37 ? 'Knob' : 'Fn'}) cannot be assigned advanced keys` };
      }

      if (u.type === 145) {
        if (!isInteger(u.code1) || u.code1 < 0 || u.code1 >= 32) {
          return { valid: false, error: `TGL key binding at slot ${slot} specifies invalid table index ${u.code1}. Must be 0..31` };
        }
      } else if (u.type === 146) {
        if (!isInteger(u.code1) || u.code1 < 0 || u.code1 >= 32) {
          return { valid: false, error: `MT key binding at slot ${slot} specifies invalid table index ${u.code1}. Must be 0..31` };
        }
        if (!isInteger(u.code2) || u.code2 < 0 || u.code2 > 100) {
          return { valid: false, error: `MT key binding at slot ${slot} specifies invalid delay steps ${u.code2}. Must be 0..100 (0..1000ms)` };
        }
      } else if (u.type === 148) {
        if (!isInteger(u.code1) || u.code1 < 0 || u.code1 >= 32) {
          return { valid: false, error: `SOCD key binding at slot ${slot} specifies invalid table index ${u.code1}. Must be 0..31` };
        }
        const partnerSlot = u.code2;
        if (!isInteger(partnerSlot) || !VALID_PHYSICAL_SLOTS.has(partnerSlot) || partnerSlot === slot || partnerSlot === 37 || partnerSlot === 85) {
          return { valid: false, error: `SOCD key binding at slot ${slot} specifies invalid partner slot ${partnerSlot}` };
        }
      }
    }
  }

  return { valid: true };
}

/**
 * Validates per-key RGB colors.
 * Restricts slots strictly to valid physical LED slots (83 slots: knob 37 has no LED; split space 45, 53, 61).
 * Rejects non-physical or reserved LED slots.
 * Rejects non-canonical numeric string keys (no parseInt trailing junk acceptance).
 *
 * @param {Array<Object>|Object} colors
 * @returns {{ valid: boolean, error?: string }}
 */
function validateKeyColors(colors) {
  if (!colors || typeof colors !== 'object') {
    return { valid: false, error: 'Key colors must be a plain object or array' };
  }

  if (Array.isArray(colors)) {
    const seenSlots = new Set();
    const allowedKeys = new Set(['slot', 'index', 'hex', 'r', 'g', 'b']);
    for (let i = 0; i < colors.length; i++) {
      const c = colors[i];
      if (!isPlainObject(c)) {
        return { valid: false, error: `Key color entry at index ${i} must be a plain object` };
      }
      for (const k of Object.keys(c)) {
        if (!allowedKeys.has(k)) {
          return { valid: false, error: `Unknown key "${k}" in color entry at index ${i}` };
        }
      }
      const slot = c.slot !== undefined ? c.slot : c.index;
      if (!isInteger(slot) || !VALID_LIGHTING_SLOTS.has(slot)) {
        return { valid: false, error: `Invalid LED slot ${slot} at index ${i}. Per-key RGB colors are restricted to the 83 valid physical lighting zones.` };
      }
      if (seenSlots.has(slot)) {
        return { valid: false, error: `Duplicate key color for slot ${slot} at index ${i}` };
      }
      seenSlots.add(slot);

      const hex = c.hex || rgbToHex(c.r, c.g, c.b);
      if (typeof hex !== 'string' || !HEX_COLOR_REGEX.test(hex)) {
        return { valid: false, error: `Invalid color value for slot ${slot}: "${hex}". Must be #RRGGBB format` };
      }
    }
    return { valid: true };
  }

  if (!isPlainObject(colors)) {
    return { valid: false, error: 'Key colors must be a plain object or array' };
  }

  for (const [k, v] of Object.entries(colors)) {
    if (!CANONICAL_INT_REGEX.test(k)) {
      return { valid: false, error: `Invalid LED slot key "${k}". Must be exact canonical integer` };
    }
    const slot = Number(k);
    if (!VALID_LIGHTING_SLOTS.has(slot)) {
      return { valid: false, error: `Invalid LED slot ${slot}. Per-key RGB colors are restricted to the 83 valid physical lighting zones.` };
    }
    let hex = null;
    if (typeof v === 'string') {
      hex = v;
    } else if (isPlainObject(v)) {
      hex = rgbToHex(v.r, v.g, v.b);
    }
    if (typeof hex !== 'string' || !HEX_COLOR_REGEX.test(hex)) {
      return { valid: false, error: `Invalid color value for slot ${slot}: "${v}". Must be #RRGGBB format` };
    }
  }

  return { valid: true };
}

function rgbToHex(r, g, b) {
  if (!isUint8(r) || !isUint8(g) || !isUint8(b)) return null;
  return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('').toUpperCase();
}

/**
 * Validates macro slots array.
 * Validates slots, types, actions, action kinds, codes, delays, and 8192-byte capacity.
 * Requires code and delay for every action.
 * Rejects unknown keys recursively.
 *
 * @param {Array<Object>} slots
 * @returns {{ valid: boolean, error?: string }}
 */
function validateMacroSlots(slots) {
  if (!Array.isArray(slots)) {
    return { valid: false, error: 'Macro slots must be an array' };
  }

  if (slots.length > 16) {
    return { valid: false, error: `Too many macro slots: ${slots.length}. Maximum is 16 slots` };
  }

  const seenIds = new Set();
  const allowedSlotKeys = new Set(['id', 'name', 'type', 'actions', 'offset']);
  const allowedActionKeys = new Set(['action', 'code', 'delay']);

  let totalActions = 0;

  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    if (!isPlainObject(s)) {
      return { valid: false, error: `Macro slot at index ${i} must be a plain object` };
    }

    for (const k of Object.keys(s)) {
      if (!allowedSlotKeys.has(k)) {
        return { valid: false, error: `Unknown key "${k}" in macro slot at index ${i}` };
      }
    }

    const slotId = s.id !== undefined ? s.id : i;
    if (!isInteger(slotId) || slotId < 0 || slotId > 15) {
      return { valid: false, error: `Invalid macro slot id ${slotId} at index ${i}. Must be integer 0..15` };
    }

    if (seenIds.has(slotId)) {
      return { valid: false, error: `Duplicate macro slot id ${slotId} at index ${i}` };
    }
    seenIds.add(slotId);

    if (s.name !== undefined && typeof s.name !== 'string') {
      return { valid: false, error: `Invalid macro name in slot ${slotId}. Must be string` };
    }

    if (s.type !== undefined) {
      if (!VALID_PLAYBACK_TYPES.has(s.type)) {
        return { valid: false, error: `Invalid macro playback type ${s.type} in slot ${slotId}. Must be 0, 1, or 255` };
      }
    }

    if (s.actions !== undefined) {
      if (!Array.isArray(s.actions)) {
        return { valid: false, error: `Macro actions in slot ${slotId} must be an array` };
      }

      totalActions += s.actions.length;

      for (let a = 0; a < s.actions.length; a++) {
        const act = s.actions[a];
        if (!isPlainObject(act)) {
          return { valid: false, error: `Action ${a} in slot ${slotId} must be a plain object` };
        }

        for (const ak of Object.keys(act)) {
          if (!allowedActionKeys.has(ak)) {
            return { valid: false, error: `Unknown key "${ak}" in action ${a} of slot ${slotId}` };
          }
        }

        if (!VALID_ACTION_NAMES.has(act.action)) {
          return { valid: false, error: `Invalid macro action "${act.action}" in slot ${slotId}. Must be keydown, keyup, mousedown, or mouseup` };
        }

        if (act.code === undefined || !isUint8(act.code)) {
          return { valid: false, error: `Missing or invalid key code in action ${a} of slot ${slotId}. Must be uint8 integer 0..255` };
        }

        if (act.delay === undefined || !isInteger(act.delay) || act.delay < 0 || act.delay > 65535) {
          return { valid: false, error: `Missing or invalid delay in action ${a} of slot ${slotId}. Must be integer 0..65535` };
        }
      }
    }
  }

  // Preflight 8192-byte capacity with vendor-identical action-body deduplication
  const totalBytes = calculateMacroBankBytes(slots);
  if (totalBytes > 8192) {
    return { valid: false, error: `Total macro storage capacity exceeded: requires ${totalBytes} bytes, max 8192 bytes` };
  }

  return { valid: true };
}

/**
 * Local extended-storage metadata (names + standard delay). Not CMD 12/13 actions.
 * Optional on profile export. Rejects array shapes, id fields, action arrays, and unknown keys.
 * Canonical format: { version: 1, slots: [ up to 16 entries ] }
 */
function validateMacroMetadata(meta) {
  if (Array.isArray(meta)) {
    return { valid: false, error: 'macroMetadata must be a canonical object { version: 1, slots: [...] }, arrays are not accepted' };
  }
  if (!isPlainObject(meta)) {
    return { valid: false, error: 'macroMetadata must be a plain object' };
  }
  const allowed = new Set(['version', 'slots']);
  for (const k of Object.keys(meta)) {
    if (!allowed.has(k)) {
      return { valid: false, error: `Unknown key "${k}" in macroMetadata` };
    }
  }
  if (meta.version !== 1) {
    return { valid: false, error: `macroMetadata.version must be 1, got ${meta.version}` };
  }
  if (!Array.isArray(meta.slots) || meta.slots.length > 16) {
    return { valid: false, error: 'macroMetadata.slots must be an array of at most 16 entries' };
  }
  for (let i = 0; i < meta.slots.length; i++) {
    const row = validateMacroMetadataSlot(meta.slots[i], i);
    if (!row.valid) return row;
  }
  return { valid: true };
}

function validateMacroMetadataSlot(slot, index) {
  if (!isPlainObject(slot)) {
    return { valid: false, error: `macroMetadata slot ${index} must be a plain object` };
  }
  const allowed = new Set(['name', 'defaultDelay', 'enableDefaultDelay']);
  for (const k of Object.keys(slot)) {
    if (!allowed.has(k)) {
      return { valid: false, error: `Unknown key "${k}" in macroMetadata slot ${index}` };
    }
  }
  if (Object.prototype.hasOwnProperty.call(slot, 'id')) {
    return { valid: false, error: `macroMetadata slot ${index} must not include id field; slot positions are ordered` };
  }
  if (Object.prototype.hasOwnProperty.call(slot, 'actions')) {
    return { valid: false, error: `macroMetadata slot ${index} must not include actions` };
  }
  if (slot.name !== undefined && typeof slot.name !== 'string') {
    return { valid: false, error: `macroMetadata slot ${index} name must be a string` };
  }
  if (slot.name !== undefined && slot.name.length > 64) {
    return { valid: false, error: `macroMetadata slot ${index} name exceeds 64 characters` };
  }
  if (slot.defaultDelay !== undefined) {
    if (!isInteger(slot.defaultDelay) || slot.defaultDelay < 5 || slot.defaultDelay > 65535) {
      return { valid: false, error: `macroMetadata slot ${index} defaultDelay must be integer 5..65535` };
    }
  }
  if (slot.enableDefaultDelay !== undefined && typeof slot.enableDefaultDelay !== 'boolean') {
    return { valid: false, error: `macroMetadata slot ${index} enableDefaultDelay must be boolean` };
  }
  return { valid: true };
}

/**
 * Validates advanced profile section and ensures semantic consistency between tables and layers.
 * Rejects arrays, unknown keys, and wrong mt/tgl/extras types before any write.
 * Validates every supplied entry, including unreferenced indices.
 *
 * @param {Object} advanced - Advanced section { mt, tgl, keyExtras }
 * @param {Array|Object} [rawLayers] - 4 keymap layers
 * @returns {{ valid: boolean, error?: string }}
 */
function validateAdvancedProfile(advanced, rawLayers = null) {
  if (!isPlainObject(advanced)) {
    return { valid: false, error: 'Advanced section must be a plain object' };
  }

  const allowedSectionKeys = new Set(['mt', 'tgl', 'keyExtras']);
  for (const k of Object.keys(advanced)) {
    if (!allowedSectionKeys.has(k)) {
      return { valid: false, error: `Unknown key "${k}" in advanced section` };
    }
  }

  const mtByIndex = new Map();
  const tglByIndex = new Map();
  const extrasBySlot = new Map();

  if (advanced.mt !== undefined) {
    if (typeof advanced.mt === 'string') {
      if (!/^[0-9a-fA-F]{512}$/.test(advanced.mt)) {
        return { valid: false, error: 'Advanced MT hex string must be exactly 512 hex characters (256 bytes)' };
      }
      const protocol = require('./protocol.cjs');
      const parsed = protocol.parseMtTable(Buffer.from(advanced.mt, 'hex'));
      for (let i = 0; i < parsed.length; i++) {
        const e = parsed[i];
        if ((e.rawTap && e.rawTap[0] >= 145 && e.rawTap[0] <= 149) ||
            (e.rawHold && e.rawHold[0] >= 145 && e.rawHold[0] <= 149)) {
          return { valid: false, error: `MT table entry ${i} contains recursive advanced tuple` };
        }
        mtByIndex.set(e.index, { index: e.index, rawTap: e.rawTap, rawHold: e.rawHold });
      }
    } else if (Array.isArray(advanced.mt)) {
      if (advanced.mt.length > 32) {
        return { valid: false, error: 'MT table entries exceed capacity of 32' };
      }
      const seenIndices = new Set();
      const allowedMtKeys = new Set(['index', 'id', 'tapKey', 'holdKey', 'rawTap', 'rawHold']);
      for (let i = 0; i < advanced.mt.length; i++) {
        const item = advanced.mt[i];
        if (!isPlainObject(item)) {
          return { valid: false, error: `MT entry at index ${i} must be a plain object` };
        }
        for (const k of Object.keys(item)) {
          if (!allowedMtKeys.has(k)) {
            return { valid: false, error: `Unknown key "${k}" in MT entry at index ${i}` };
          }
        }
        const idx = item.index !== undefined ? item.index : (item.id !== undefined ? item.id : i);
        if (!isInteger(idx) || idx < 0 || idx >= 32) {
          return { valid: false, error: `Invalid MT entry index ${idx} at index ${i}. Must be integer 0..31` };
        }
        if (seenIndices.has(idx)) {
          return { valid: false, error: `Duplicate MT entry index ${idx} at index ${i}` };
        }
        seenIndices.add(idx);

        const tapVal = pickNamedTuple(item, 'tapKey', 'rawTap', `MT entry ${idx} tapKey`);
        if (!tapVal.valid) return tapVal;
        const holdVal = pickNamedTuple(item, 'holdKey', 'rawHold', `MT entry ${idx} holdKey`);
        if (!holdVal.valid) return holdVal;

        const tapOrd = validateOrdinaryTableTuple(tapVal.tuple, `MT entry ${idx} tapKey`);
        if (!tapOrd.valid) return tapOrd;
        const holdOrd = validateOrdinaryTableTuple(holdVal.tuple, `MT entry ${idx} holdKey`);
        if (!holdOrd.valid) return holdOrd;

        mtByIndex.set(idx, { index: idx, rawTap: tapOrd.tuple, rawHold: holdOrd.tuple });
      }
    } else {
      return { valid: false, error: 'Advanced MT table must be a 512-hex string or array of MT entries' };
    }
  }

  if (advanced.tgl !== undefined) {
    if (typeof advanced.tgl === 'string') {
      if (!/^[0-9a-fA-F]{256}$/.test(advanced.tgl)) {
        return { valid: false, error: 'Advanced TGL hex string must be exactly 256 hex characters (128 bytes)' };
      }
      const protocol = require('./protocol.cjs');
      const parsed = protocol.parseTglTable(Buffer.from(advanced.tgl, 'hex'));
      for (let i = 0; i < parsed.length; i++) {
        const e = parsed[i];
        if (e.rawTarget && e.rawTarget[0] >= 145 && e.rawTarget[0] <= 149) {
          return { valid: false, error: `TGL table entry ${i} contains recursive advanced tuple` };
        }
        tglByIndex.set(e.index, { index: e.index, rawTarget: e.rawTarget });
      }
    } else if (Array.isArray(advanced.tgl)) {
      if (advanced.tgl.length > 32) {
        return { valid: false, error: 'TGL table entries exceed capacity of 32' };
      }
      const seenIndices = new Set();
      const allowedTglKeys = new Set(['index', 'id', 'targetKey', 'rawTarget']);
      for (let i = 0; i < advanced.tgl.length; i++) {
        const item = advanced.tgl[i];
        if (!isPlainObject(item)) {
          return { valid: false, error: `TGL entry at index ${i} must be a plain object` };
        }
        for (const k of Object.keys(item)) {
          if (!allowedTglKeys.has(k)) {
            return { valid: false, error: `Unknown key "${k}" in TGL entry at index ${i}` };
          }
        }
        const idx = item.index !== undefined ? item.index : (item.id !== undefined ? item.id : i);
        if (!isInteger(idx) || idx < 0 || idx >= 32) {
          return { valid: false, error: `Invalid TGL entry index ${idx} at index ${i}. Must be integer 0..31` };
        }
        if (seenIndices.has(idx)) {
          return { valid: false, error: `Duplicate TGL entry index ${idx} at index ${i}` };
        }
        seenIndices.add(idx);

        const targetVal = pickNamedTuple(item, 'targetKey', 'rawTarget', `TGL entry ${idx} targetKey`);
        if (!targetVal.valid) return targetVal;
        const targetOrd = validateOrdinaryTableTuple(targetVal.tuple, `TGL entry ${idx} targetKey`);
        if (!targetOrd.valid) return targetOrd;

        tglByIndex.set(idx, { index: idx, rawTarget: targetOrd.tuple });
      }
    } else {
      return { valid: false, error: 'Advanced TGL table must be a 256-hex string or array of TGL entries' };
    }
  }

  if (advanced.keyExtras !== undefined) {
    if (typeof advanced.keyExtras === 'string') {
      if (!/^[0-9a-fA-F]{2048}$/.test(advanced.keyExtras)) {
        return { valid: false, error: 'Key Extras hex string must be exactly 2048 hex characters (1024 bytes)' };
      }
      const protocol = require('./protocol.cjs');
      const parsed = protocol.parseKeyExtras(Buffer.from(advanced.keyExtras, 'hex'));
      for (const e of parsed) extrasBySlot.set(e.slot, e);
    } else if (Array.isArray(advanced.keyExtras)) {
      if (advanced.keyExtras.length > 128) {
        return { valid: false, error: 'Key Extras entries exceed capacity of 128' };
      }
      const seenSlots = new Set();
      const allowedExtrasKeys = new Set(['slot', 'index', 'priority', 'switchType', 'keyMode', 'raw']);
      for (let i = 0; i < advanced.keyExtras.length; i++) {
        const item = advanced.keyExtras[i];
        if (!isPlainObject(item)) {
          return { valid: false, error: `Key Extras entry at index ${i} must be a plain object` };
        }
        for (const k of Object.keys(item)) {
          if (!allowedExtrasKeys.has(k)) {
            return { valid: false, error: `Unknown key "${k}" in Key Extras entry at index ${i}` };
          }
        }
        const slot = item.slot !== undefined ? item.slot : (item.index !== undefined ? item.index : i);
        if (!isInteger(slot) || slot < 0 || slot >= 128) {
          return { valid: false, error: `Invalid Key Extras slot ${slot} at index ${i}. Must be integer 0..127` };
        }
        if (seenSlots.has(slot)) {
          return { valid: false, error: `Duplicate Key Extras slot ${slot} at index ${i}` };
        }
        seenSlots.add(slot);

        if (item.priority !== undefined) {
          if (!isInteger(item.priority) || item.priority < 0 || item.priority > 3) {
            return { valid: false, error: `Invalid SOCD priority ${item.priority} for slot ${slot}. Must be integer 0..3` };
          }
        }
        if (item.switchType !== undefined && !isUint8(item.switchType)) {
          return { valid: false, error: `Invalid switchType ${item.switchType} for slot ${slot}. Must be integer 0..255` };
        }
        if (item.keyMode !== undefined && !isUint8(item.keyMode)) {
          return { valid: false, error: `Invalid keyMode ${item.keyMode} for slot ${slot}. Must be integer 0..255` };
        }

        extrasBySlot.set(slot, item);
      }
    } else {
      return { valid: false, error: 'Key Extras must be a 2048-hex string or array of key extras entries' };
    }
  }

  if (rawLayers) {
    const referencedMt = new Set();
    const referencedTgl = new Set();
    let hasSocd = false;

    for (let l = 0; l < 4; l++) {
      const layerObj = Array.isArray(rawLayers) ? rawLayers[l] : rawLayers[String(l)];
      if (!layerObj) continue;

      const layerKeysMap = new Map();
      if (Array.isArray(layerObj)) {
        for (const item of layerObj) {
          const slot = item.slot !== undefined ? item.slot : item.index;
          layerKeysMap.set(slot, item);
        }
      } else if (typeof layerObj === 'object') {
        for (const [sStr, def] of Object.entries(layerObj)) {
          layerKeysMap.set(Number(sStr), def);
        }
      }

      for (const [slot, def] of layerKeysMap.entries()) {
        const type = def.type;
        if (type === 145) {
          const tableIndex = def.code1;
          if (!isInteger(tableIndex) || tableIndex < 0 || tableIndex >= 32) {
            return { valid: false, error: `Layer ${l} slot ${slot} specifies invalid TGL table index ${tableIndex}` };
          }
          if (!ELIGIBLE_ADVANCED_SLOTS.has(slot)) {
            return { valid: false, error: `Layer ${l} slot ${slot} cannot hold a TGL binding` };
          }
          referencedTgl.add(tableIndex);
          if (!tglByIndex.has(tableIndex)) {
            return { valid: false, error: `Layer ${l} slot ${slot}: TGL table index ${tableIndex} is not present in the supplied TGL table` };
          }
        } else if (type === 146) {
          const tableIndex = def.code1;
          if (!isInteger(tableIndex) || tableIndex < 0 || tableIndex >= 32) {
            return { valid: false, error: `Layer ${l} slot ${slot} specifies invalid MT table index ${tableIndex}` };
          }
          if (!ELIGIBLE_ADVANCED_SLOTS.has(slot)) {
            return { valid: false, error: `Layer ${l} slot ${slot} cannot hold an MT binding` };
          }
          referencedMt.add(tableIndex);
          if (!mtByIndex.has(tableIndex)) {
            return { valid: false, error: `Layer ${l} slot ${slot}: MT table index ${tableIndex} is not present in the supplied MT table` };
          }
        } else if (type === 148) {
          hasSocd = true;
          const tableIndex = def.code1;
          const partnerSlot = def.code2;
          if (!isInteger(tableIndex) || tableIndex < 0 || tableIndex >= 32) {
            return { valid: false, error: `Layer ${l} slot ${slot} specifies invalid SOCD MT table index ${tableIndex}` };
          }
          if (!ELIGIBLE_ADVANCED_SLOTS.has(slot) || !ELIGIBLE_ADVANCED_SLOTS.has(partnerSlot)) {
            return { valid: false, error: `Layer ${l} slot ${slot}: Knob (37) and Fn (85) cannot be SOCD keys` };
          }
          if (!VALID_PHYSICAL_SLOTS.has(partnerSlot) || partnerSlot === slot) {
            return { valid: false, error: `Layer ${l} slot ${slot}: Invalid partner slot ${partnerSlot}` };
          }

          const partnerDef = layerKeysMap.get(partnerSlot);
          if (!partnerDef || partnerDef.type !== 148) {
            return { valid: false, error: `Layer ${l} slot ${slot}: Missing reciprocal SOCD binding on partner slot ${partnerSlot}` };
          }
          if (partnerDef.code2 !== slot) {
            return { valid: false, error: `Layer ${l} slot ${slot}: Partner slot ${partnerSlot} points to ${partnerDef.code2} instead of ${slot}` };
          }
          const partnerTableIndex = partnerDef.code1;
          if (partnerTableIndex === tableIndex) {
            return { valid: false, error: `Layer ${l} slot ${slot}: Both SOCD keys reference the same table index ${tableIndex}` };
          }

          referencedMt.add(tableIndex);
          referencedMt.add(partnerTableIndex);

          const entry1 = mtByIndex.get(tableIndex);
          const entry2 = mtByIndex.get(partnerTableIndex);
          if (!entry1 || !entry2) {
            return { valid: false, error: `Layer ${l} slot ${slot}: SOCD MT table entries ${tableIndex}/${partnerTableIndex} are not present in the supplied MT table` };
          }

          const defA = getDefaultTuple(l, slot);
          const defB = getDefaultTuple(l, partnerSlot);
          const t1 = entry1.rawTap;
          const h1 = entry1.rawHold;
          const t2 = entry2.rawTap;
          const h2 = entry2.rawHold;
          if (!tuplesEqual(t1, defA) || !tuplesEqual(h1, defB)) {
            return { valid: false, error: `Layer ${l} slot ${slot}: MT table entry ${tableIndex} does not match default pair for slots ${slot}, ${partnerSlot}` };
          }
          if (!tuplesEqual(t2, defB) || !tuplesEqual(h2, defA)) {
            return { valid: false, error: `Layer ${l} partner slot ${partnerSlot}: MT table entry ${partnerTableIndex} does not match reversed default pair` };
          }

          const extra1 = extrasBySlot.get(slot);
          const extra2 = extrasBySlot.get(partnerSlot);
          if (!extra1 || extra1.priority === undefined || !extra2 || extra2.priority === undefined) {
            return { valid: false, error: `Layer ${l} slot ${slot}: SOCD extras priority missing for slots ${slot}/${partnerSlot}` };
          }
          if (!isInteger(extra1.priority) || extra1.priority < 0 || extra1.priority > 3 ||
              !isInteger(extra2.priority) || extra2.priority < 0 || extra2.priority > 3) {
            return { valid: false, error: `Layer ${l} slot ${slot}: SOCD extras priority must be integer 0..3` };
          }
          const expectedComplement = getComplementPriority(extra1.priority);
          if (extra2.priority !== expectedComplement) {
            return { valid: false, error: `Layer ${l}: SOCD slot ${slot} priority ${extra1.priority} is not complementary to partner slot ${partnerSlot} priority ${extra2.priority}` };
          }
        }
      }
    }

    if (referencedTgl.size > 0 && tglByIndex.size === 0) {
      return { valid: false, error: 'Layers reference TGL bindings but the advanced TGL table is missing' };
    }
    if (referencedMt.size > 0 && mtByIndex.size === 0) {
      return { valid: false, error: 'Layers reference MT/SOCD bindings but the advanced MT table is missing' };
    }
    if (hasSocd && extrasBySlot.size === 0) {
      return { valid: false, error: 'Layers reference SOCD bindings but the advanced keyExtras section is missing' };
    }
  }

  return { valid: true };
}

/**
 * Validates a complete profile object for import or staging before any mutation.
 * Enforces strict schema discriminator, required sections, and exact canonical layers/slots.
 * Rejects unknown keys recursively.
 *
 * @param {Object} profileData
 * @returns {{ valid: boolean, error?: string }}
 */
function validateProfileSchema(profileData) {
  if (!isPlainObject(profileData)) {
    return { valid: false, error: 'Profile data must be a plain non-null JSON object' };
  }

  const allowedRootKeys = new Set([
    'app', 'model', 'protocol', 'version', 'profileIndex', 'exportedAt',
    'lighting', 'settings', 'layers', 'keymaps', 'perKeyRgb', 'macros',
    'advanced', 'macroMetadata', 'lightingMemory'
  ]);

  for (const key of Object.keys(profileData)) {
    if (!allowedRootKeys.has(key)) {
      return { valid: false, error: `Unknown root property in profile schema: "${key}"` };
    }
  }

  // Schema discriminator & required fields for a full profile
  if (typeof profileData.model !== 'string' || !profileData.model.includes('MCHOSE G75 V2')) {
    return { valid: false, error: `Invalid or missing model discriminator: expected "MCHOSE G75 V2", got "${profileData.model}"` };
  }

  if (profileData.protocol !== 'GLW') {
    return { valid: false, error: `Invalid or missing protocol discriminator: expected "GLW", got "${profileData.protocol}"` };
  }

  if (typeof profileData.version !== 'string' || !profileData.version) {
    return { valid: false, error: 'Missing or invalid profile schema version string' };
  }

  if (profileData.profileIndex !== undefined) {
    if (!isInteger(profileData.profileIndex) || profileData.profileIndex < 0 || profileData.profileIndex > 3) {
      return { valid: false, error: `Invalid profileIndex: ${profileData.profileIndex}. Must be integer 0..3` };
    }
  }

  // Required sections: lighting, settings, layers/keymaps, perKeyRgb, macros
  if (!profileData.lighting) {
    return { valid: false, error: 'Missing required "lighting" section in profile backup' };
  }
  const lVal = validateLightingParams(profileData.lighting);
  if (!lVal.valid) return { valid: false, error: `Lighting validation failed: ${lVal.error}` };

  if (!profileData.settings) {
    return { valid: false, error: 'Missing required "settings" section in profile backup' };
  }
  const sVal = validateSettingsParams(profileData.settings);
  if (!sVal.valid) return { valid: false, error: `Settings validation failed: ${sVal.error}` };

  const rawLayers = profileData.layers !== undefined ? profileData.layers : profileData.keymaps;
  if (!rawLayers || typeof rawLayers !== 'object') {
    return { valid: false, error: 'Missing required "layers" section in profile backup' };
  }

  if (Array.isArray(rawLayers)) {
    if (rawLayers.length !== 4) {
      return { valid: false, error: `Layers array must have exact length 4 (layers 0..3), got ${rawLayers.length}` };
    }
    for (let l = 0; l < 4; l++) {
      const layerKeys = rawLayers[l];
      if (!Array.isArray(layerKeys)) {
        return { valid: false, error: `Layer ${l} must be an array of key updates` };
      }
      const kVal = validateKeymapUpdates(layerKeys);
      if (!kVal.valid) return { valid: false, error: `Layer ${l} validation failed: ${kVal.error}` };
    }
  } else if (isPlainObject(rawLayers)) {
    const layerEntries = Object.entries(rawLayers);
    if (layerEntries.length !== 4) {
      return { valid: false, error: `Layers object must have exactly 4 layers (0..3), got ${layerEntries.length}` };
    }
    for (let l = 0; l < 4; l++) {
      const lStr = String(l);
      if (!(lStr in rawLayers)) {
        return { valid: false, error: `Missing required layer "${lStr}" in layers object` };
      }
      const layerKeys = rawLayers[lStr];
      if (layerKeys === null || typeof layerKeys !== 'object') {
        return { valid: false, error: `Layer "${lStr}" must be a non-null object or array` };
      }
      if (Array.isArray(layerKeys)) {
        const kVal = validateKeymapUpdates(layerKeys);
        if (!kVal.valid) return { valid: false, error: `Layer ${l} validation failed: ${kVal.error}` };
      } else if (isPlainObject(layerKeys)) {
        const updates = [];
        for (const [slotStr, def] of Object.entries(layerKeys)) {
          if (!CANONICAL_INT_REGEX.test(slotStr)) {
            return { valid: false, error: `Invalid slot key "${slotStr}" in layer ${l}` };
          }
          if (!isPlainObject(def)) {
            return { valid: false, error: `Key definition for slot ${slotStr} in layer ${l} must be a plain object` };
          }
          updates.push({
            slot: Number(slotStr),
            type: def.type,
            code1: def.code1,
            code2: def.code2
          });
        }
        const kVal = validateKeymapUpdates(updates);
        if (!kVal.valid) return { valid: false, error: `Layer ${l} validation failed: ${kVal.error}` };
      } else {
        return { valid: false, error: `Layer "${lStr}" must be a plain object or array` };
      }
    }
  } else {
    return { valid: false, error: 'Layers must be a plain object or array of 4 layers' };
  }

  if (profileData.perKeyRgb === undefined || profileData.perKeyRgb === null) {
    return { valid: false, error: 'Missing required "perKeyRgb" section in profile backup' };
  }
  const rgbVal = validateKeyColors(profileData.perKeyRgb);
  if (!rgbVal.valid) return { valid: false, error: `Per-key RGB validation failed: ${rgbVal.error}` };

  if (!Array.isArray(profileData.macros)) {
    return { valid: false, error: 'Missing required "macros" section in profile backup' };
  }
  const mVal = validateMacroSlots(profileData.macros);
  if (!mVal.valid) return { valid: false, error: `Macros validation failed: ${mVal.error}` };

  if (profileData.macroMetadata !== undefined) {
    const mmVal = validateMacroMetadata(profileData.macroMetadata);
    if (!mmVal.valid) return { valid: false, error: `Macro metadata validation failed: ${mmVal.error}` };
  }

  if (profileData.lightingMemory !== undefined) {
    const lmVal = lightingMemory.validateImportedLightingMemory(profileData.lightingMemory);
    if (!lmVal.valid) return { valid: false, error: `Lighting memory validation failed: ${lmVal.error}` };
  }

  if (layersContainAdvancedBindings(rawLayers) && profileData.advanced === undefined) {
    return { valid: false, error: 'Layers contain MT/TGL/SOCD bindings but the required "advanced" section is missing' };
  }

  if (profileData.advanced !== undefined) {
    const advVal = validateAdvancedProfile(profileData.advanced, rawLayers);
    if (!advVal.valid) {
      return { valid: false, error: `Advanced validation failed: ${advVal.error}` };
    }
  }

  return { valid: true };
}

/**
 * Validates an explicit advanced apply/remove request captured at click time.
 */
function validateAdvancedBinding(spec) {
  if (!isPlainObject(spec)) {
    return { valid: false, error: 'Advanced binding spec must be a plain object' };
  }

  const allowed = new Set([
    'profileIndex', 'layer', 'slot', 'kind',
    'tapKey', 'holdKey', 'delayMs',
    'targetKey',
    'partnerSlot', 'priority',
    'modifierKey', 'regularKey'
  ]);
  for (const k of Object.keys(spec)) {
    if (!allowed.has(k)) {
      return { valid: false, error: `Unknown key "${k}" in advanced binding spec` };
    }
  }

  if (!isInteger(spec.profileIndex) || spec.profileIndex < 0 || spec.profileIndex > 3) {
    return { valid: false, error: 'Advanced binding profileIndex must be integer 0..3' };
  }
  if (!isInteger(spec.layer) || spec.layer < 0 || spec.layer > 3) {
    return { valid: false, error: 'Advanced binding layer must be integer 0..3' };
  }
  if (!isInteger(spec.slot) || !ELIGIBLE_ADVANCED_SLOTS.has(spec.slot)) {
    return { valid: false, error: `Advanced binding slot ${spec.slot} is not eligible (Fn 85 and knob 37 are excluded)` };
  }
  if (typeof spec.kind !== 'string' || !ADVANCED_BINDING_KINDS.has(spec.kind)) {
    return { valid: false, error: 'Advanced binding kind must be mt, tgl, socd, cb, or remove' };
  }

  if (spec.kind === 'remove') {
    return { valid: true };
  }

  if (spec.kind === 'mt') {
    const tap = validateOrdinaryTableTuple(spec.tapKey, 'MT tapKey');
    if (!tap.valid) return tap;
    const hold = validateOrdinaryTableTuple(spec.holdKey, 'MT holdKey');
    if (!hold.valid) return hold;
    if (spec.delayMs !== undefined) {
      if (!isInteger(spec.delayMs) || spec.delayMs < 0 || spec.delayMs > 1000) {
        return { valid: false, error: `MT delayMs must be integer 0..1000, got ${spec.delayMs}` };
      }
    }
    return { valid: true, tapKey: tap.tuple, holdKey: hold.tuple };
  }

  if (spec.kind === 'tgl') {
    const target = validateOrdinaryTableTuple(spec.targetKey, 'TGL targetKey');
    if (!target.valid) return target;
    const [t, c1] = target.tuple;
    if (t === 48 || (t === 240 && (c1 === 250 || c1 === 255))) {
      return { valid: false, error: `Key [${target.tuple.join(', ')}] cannot be assigned to TGL` };
    }
    return { valid: true, targetKey: target.tuple };
  }

  if (spec.kind === 'socd') {
    if (!isInteger(spec.partnerSlot) || !ELIGIBLE_ADVANCED_SLOTS.has(spec.partnerSlot) || spec.partnerSlot === spec.slot) {
      return { valid: false, error: `SOCD partnerSlot ${spec.partnerSlot} is invalid` };
    }
    if (spec.priority === undefined || !isInteger(spec.priority) || spec.priority < 0 || spec.priority > 3) {
      return { valid: false, error: `SOCD priority must be integer 0..3, got ${spec.priority}` };
    }
    return { valid: true };
  }

  if (spec.kind === 'cb') {
    const { isHotKeyTuple, isNormalKeyTuple, mergeCBKey } = require('./protocol.cjs');
    if (!isHotKeyTuple(spec.modifierKey)) {
      return { valid: false, error: 'CB modifierKey must be a modifier-only tuple [16, mask, 0] (Ctrl/Shift/Alt/Win)' };
    }
    if (!isNormalKeyTuple(spec.regularKey)) {
      return { valid: false, error: 'CB regularKey must be a regular type-16 tuple [16, 0, hidUsage]' };
    }
    let tuple;
    try {
      tuple = mergeCBKey(spec.modifierKey, spec.regularKey);
    } catch (err) {
      return { valid: false, error: err.message };
    }
    return { valid: true, tuple };
  }

  return { valid: false, error: `Unsupported advanced binding kind: ${spec.kind}` };
}

/**
 * Validates an Advanced-tab clear-all request (not factory CMD 238).
 */
function validateClearAllAdvanced(spec) {
  if (!isPlainObject(spec)) {
    return { valid: false, error: 'Clear-all advanced spec must be a plain object' };
  }
  const allowed = new Set(['profileIndex']);
  for (const k of Object.keys(spec)) {
    if (!allowed.has(k)) {
      return { valid: false, error: `Unknown key "${k}" in clear-all advanced spec` };
    }
  }
  if (!isInteger(spec.profileIndex) || spec.profileIndex < 0 || spec.profileIndex > 3) {
    return { valid: false, error: 'Clear-all advanced profileIndex must be integer 0..3' };
  }
  return { valid: true };
}

module.exports = {
  VALID_KEY_TYPES,
  VALID_PLAYBACK_TYPES,
  VALID_ACTION_NAMES,
  ORDINARY_TABLE_KEY_TYPES,
  HEX_COLOR_REGEX,
  isPlainObject,
  isInteger,
  isUint8,
  validateLightingParams,
  validateSettingsParams,
  validateKeymapUpdates,
  validateKeyColors,
  validateMacroSlots,
  validateMacroMetadata,
  validateProfileSchema,
  validateAdvancedProfile,
  validateAdvancedBinding,
  validateClearAllAdvanced,
  validateOrdinaryTableTuple,
  layersContainAdvancedBindings
};
