/**
 * GLW Keyboard Protocol Encoder & Decoder
 * Verified on physical hardware (MCHOSE G75 V2 2.4G Receiver VID 0x3837 PID 0x3033).
 * Reverse-engineered from official Cizhou / MCHOSE shared vendor bundles.
 */

const { getNormalizedBodyKey, calculateMacroBankBytes } = require('./macro-draft.js');

// GLW Constants
const REPORT_ID = 0; // Unnumbered report, 0-prefixed in node-hid write
const REPORT_PAYLOAD_SIZE = 64;
const WRITE_BUFFER_SIZE = 65; // Leading 0 + 64 bytes
const CHUNK_SIZE = 56; // Maximum segment size for GLW protocol transfer
const MAX_KEYBOARD_PROFILES = 4;
const TOTAL_KEY_AREA_SIZE = 512;
const USED_KEY_AREA_SIZE = 384; // 128 keys * 3 bytes
const MAX_LAYERS = 4; // 0: Win, 1: Win Fn, 2: Mac, 3: Mac Fn
const MAX_MACRO_SLOTS = 16;
const SHARED_MACRO_SIZE = 8192; // Type 133 (G75 V2) shared macro buffer
const MIN_MACRO_DELAY = 5;

// Special key codes
const KNOB_CODE = 3809;
const FN_CODE = 255;

// GLW Command Opcodes
const COMMANDS = {
  GET_INFO: 3,                 // 0x03 - Firmware version, RF version, dongle identity
  GET_BASE: 4,                 // 0x04 - Active profile, profile count, profile order
  GET_FUNC_CONFIG: 5,          // 0x05 - RGB lighting, battery, sleep, debounce, reporting
  SET_FUNC_CONFIG: 6,          // 0x06 - Write RGB lighting, performance settings
  GET_DEFAULT_KEY_MATRIX: 7,   // 0x07 - Default key layout matrix
  GET_USER_KEY_MATRIX: 8,      // 0x08 - Remapped user key matrix
  SET_USER_KEY_MATRIX: 9,      // 0x09 - Write single key or matrix slot
  GET_KEY_COLOR: 10,           // 0x0A - Read per-key RGB colors
  SET_KEY_COLOR: 11,           // 0x0B - Write per-key RGB colors
  GET_MACROS: 12,              // 0x0C - Read macro definitions
  SET_MACROS: 13,              // 0x0D - Write macro definitions
  SET_BASE: 14,                // 0x0E - Set active profile and profile order
  GET_KEY_EXTRAS: 160,         // 0xA0 - Read key extras / trigger configuration (1024 bytes per profile)
  SET_KEY_EXTRAS: 161,         // 0xA1 - Write key extras / trigger configuration (1024 bytes per profile)
  GET_MT_KEYS: 164,            // 0xA4 - Read MT (Mod-Tap) entries (256 bytes per profile)
  SET_MT_KEYS: 165,            // 0xA5 - Write MT (Mod-Tap) entries (256 bytes per profile)
  GET_TGL_KEYS: 166,           // 0xA6 - Read TGL (Toggle) entries (128 bytes per profile)
  SET_TGL_KEYS: 167,           // 0xA7 - Write TGL (Toggle) entries (128 bytes per profile)
  FACTORY_RESET: 238,          // 0xEE - Factory reset / restore defaults (data [profileIndex] or [255])
  GET_CUSTOM_PARAM: 241,       // 0xF1 - Read profile custom region (profile*1024 + offset)
  SET_CUSTOM_PARAM: 242,       // 0xF2 - Write profile custom region
  STREAM_SIDE2: 220,           // 0xDC - Stream RGB key colors to second side lighting
  STREAM_MAIN: 221,            // 0xDD - Stream RGB key colors to main lighting (Music / GIF)
  STREAM_SIDE: 223             // 0xDF - Stream RGB key colors to side lighting
};

const RESET_SCOPE_ALL = 255;
const RESET_NOTIFICATION_TIMEOUT_MS = 8000;

// Protocol Magic Flags
const FLAG_REQUEST = 0x55; // 85
const FLAG_RESPONSE = 0xAA; // 170

// Key types in GLW 3-byte tuple [type, code1, code2]
// Verified format: [16, modifierMask, HIDusage]
const KEY_TYPES = {
  EMPTY: 0,
  STANDARD: 16,     // 0x10 - [16, modifierMask, HIDusage]
  MOUSE_BUTTON: 32, // 0x20 - [32, buttonMask, 0] (KC_MOUSE_BUTTON_0 = 2097408 -> [32, 1, 0])
  MOUSE_WHEEL: 33,  // 0x21 - [33, 0, direction] (1: Up, 255: Down)
  MEDIA_MOUSE: 48,  // 0x30 - Media or knob actions, e.g. knob [48, 226, 0]
  SYSTEM: 64,       // 0x40 - System controls [64, usage, 0] (Power: 1, Sleep: 2, Wake: 4)
  MACRO: 112,       // 0x70 - Macro slot trigger [112, slot, playbackType]
  TGL: 145,         // 0x91 - Toggle key [145, tableIndex, 0]
  MT: 146,          // 0x92 - Mod-Tap / Tap-Hold [146, tableIndex, delayMs/10]
  SOCD: 148,        // 0x94 - SOCD pair [148, tableIndex, partnerPhysicalSlot]
  FN_LAYER: 240     // 0xF0 - Layer switch / Fn trigger, e.g. Fn [240, 255, 1], lighting & extra keys
};

const MOUSE_BUTTON_LABELS = {
  1: 'Left Mouse Button',
  2: 'Right Mouse Button',
  4: 'Middle Mouse Button',
  8: 'Mouse Backward',
  16: 'Mouse Forward'
};

// Modifier bitmask to HID usage mapping (224..231)
const MODIFIER_MASKS = {
  1: 224,   // Left Control
  2: 225,   // Left Shift
  4: 226,   // Left Alt
  8: 227,   // Left GUI / Win
  16: 228,  // Right Control
  32: 229,  // Right Shift
  64: 230,  // Right Alt
  128: 231  // Right GUI / Win
};

// HID usage to modifier bitmask
const USAGE_TO_MODIFIER_MASK = {
  224: 1,
  225: 2,
  226: 4,
  227: 8,
  228: 16,
  229: 32,
  230: 64,
  231: 128
};

/**
 * Calculates GLW protocol checksum:
 * 8-bit sum of packet descriptor and payload.
 *
 * @param {Array<number>|Uint8Array|Buffer} bytes
 * @returns {number} 8-bit sum
 */
function calculateChecksum(bytes) {
  let sum = 0;
  for (let i = 0; i < bytes.length; i++) {
    sum = (sum + bytes[i]) & 0xFF;
  }
  return sum;
}

/**
 * Builds a 65-byte Buffer ready for node-hid write (reportId 0 + 64 bytes).
 * Framing: [0, 0x55, command, 0, checksum, size, offsetLo, offsetHi, 0, ...data]
 *
 * Rejects invalid command/offset/size/out-of-range/non-integer/oversized payload.
 *
 * @param {Object} options
 * @param {number} options.command - GLW command opcode (0..255)
 * @param {number} [options.offset=0] - Byte offset in memory region (0..65535)
 * @param {number} [options.size] - Requested read size or data length (0..56)
 * @param {Array<number>|Buffer} [options.data=[]] - Payload data for write commands
 * @returns {Buffer} 65-byte buffer
 */
function encodePacket({ command, offset = 0, size, data = [] }) {
  if (!Number.isInteger(command) || command < 0 || command > 255) {
    throw new TypeError(`Invalid command opcode: ${command}. Must be integer 0..255`);
  }
  if (!Number.isInteger(offset) || offset < 0 || offset > 65535) {
    throw new RangeError(`Invalid memory offset: ${offset}. Must be integer 0..65535`);
  }

  const payloadData = Array.isArray(data) ? data : Array.from(data);
  const dataLen = payloadData.length;
  const reqSize = size !== undefined ? size : dataLen;

  if (!Number.isInteger(reqSize) || reqSize < 0 || reqSize > CHUNK_SIZE) {
    throw new RangeError(`Invalid packet size: ${reqSize}. Must be integer 0..${CHUNK_SIZE}`);
  }

  if (dataLen > reqSize) {
    throw new RangeError(`Payload data length (${dataLen}) exceeds requested packet size (${reqSize})`);
  }

  for (let i = 0; i < dataLen; i++) {
    const b = payloadData[i];
    if (!Number.isInteger(b) || b < 0 || b > 255) {
      throw new TypeError(`Invalid payload byte at index ${i}: ${b}. Must be uint8 integer 0..255`);
    }
  }

  const offsetLo = offset & 0xFF;
  const offsetHi = (offset >> 8) & 0xFF;

  // Header descriptor bytes that participate in checksum: [size, offsetLo, offsetHi, 0]
  const descriptor = [reqSize, offsetLo, offsetHi, 0];
  const checksumParticipants = dataLen > 0 ? [...descriptor, ...payloadData] : descriptor;
  const checksum = calculateChecksum(checksumParticipants);

  const buffer = Buffer.alloc(WRITE_BUFFER_SIZE, 0);
  buffer[0] = REPORT_ID;       // Report ID 0
  buffer[1] = FLAG_REQUEST;    // 0x55
  buffer[2] = command;         // Command opcode
  buffer[3] = 0;               // Subcommand / Reserved
  buffer[4] = checksum;        // 8-bit checksum
  buffer[5] = reqSize;         // Length of requested or written data
  buffer[6] = offsetLo;        // Low byte of offset
  buffer[7] = offsetHi;        // High byte of offset
  buffer[8] = 0;               // Reserved 0

  for (let i = 0; i < dataLen; i++) {
    buffer[9 + i] = payloadData[i];
  }

  return buffer;
}

/**
 * Splits streaming RGB bytes into 54-byte chunk packets according to the vendor GLW transport.
 * For range length > 54, chunks are 54 bytes with the final packet overlapping the preceding
 * segment by taking the last 54 bytes at offset (rangeLength - 54).
 *
 * @param {Buffer|Uint8Array|Array<number>} rawBytes - Raw RGB bytes (e.g. 384 bytes for 128 keys)
 * @param {Object} [options={}]
 * @param {number} [options.command=221] - GLW streaming command opcode (221 main, 223 side, 220 side2)
 * @param {number} [options.profileIndex=0] - Profile argument (0 for G75 host streaming)
 * @param {number} [options.rangeStart=0] - Starting byte offset of range in profile lighting memory
 * @returns {Array<Buffer>} 65-byte HID write packet buffers
 */
function buildStreamingPackets(rawBytes, options = {}) {
  const command = Number.isInteger(options.command) ? options.command : COMMANDS.STREAM_MAIN;
  const profileIndex = Number.isInteger(options.profileIndex) ? options.profileIndex : 0;
  const rangeStart = Number.isInteger(options.rangeStart) ? options.rangeStart : 0;
  const totalLightAreaSize = TOTAL_KEY_AREA_SIZE; // 512
  const chunkSize = 3;
  const packetCapacity = Math.min(CHUNK_SIZE, Math.floor(CHUNK_SIZE / chunkSize) * chunkSize); // 54

  const bytes = Buffer.isBuffer(rawBytes) ? rawBytes : Buffer.from(rawBytes || []);
  if (bytes.length === 0) return [];

  const packets = [];
  for (let p = 0; p < bytes.length; p += packetCapacity) {
    let chunk = bytes.subarray(p, p + packetCapacity);
    let offsetInBytes = p;
    if (chunk.length < packetCapacity && p > 0) {
      offsetInBytes = bytes.length - packetCapacity;
      chunk = bytes.subarray(offsetInBytes, offsetInBytes + packetCapacity);
    }
    const targetOffset = (profileIndex * totalLightAreaSize) + rangeStart + offsetInBytes;
    packets.push(encodePacket({
      command,
      offset: targetOffset,
      size: chunk.length,
      data: chunk
    }));
  }
  return packets;
}


/**
 * Decodes an incoming 64-byte HID report from node-hid.
 * Reply Framing: [0xAA, command, status, checksum, size, offsetLo, offsetHi, 0, ...data]
 *
 * Strict validation:
 * - Must start with 0xAA (at byte 0 or byte 1 if leading 0 report ID)
 * - Size must not exceed 56
 * - Reserved byte (offset + 7) must be 0
 * - Available payload length must be at least header.size
 * - Validates checksum
 *
 * @param {Buffer|Uint8Array|Array<number>} raw
 * @param {Object} [expectedRequest=null] - Optional expected request descriptor
 * @returns {Object|null} Decoded packet or null if invalid framing
 */
function decodePacket(raw, expectedRequest = null) {
  if (!raw || raw.length < 8) return null;

  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  let offset = 0;
  if (bytes.length === 65 && bytes[0] === 0) {
    offset = 1;
  }

  if (bytes[offset] !== FLAG_RESPONSE) {
    return null; // Not a valid GLW reply flag
  }

  const command = bytes[offset + 1];
  const status = bytes[offset + 2];
  const replyChecksum = bytes[offset + 3];
  const size = bytes[offset + 4];
  const offsetLo = bytes[offset + 5];
  const offsetHi = bytes[offset + 6];
  const reservedByte = bytes[offset + 7];
  const memoryOffset = offsetLo | (offsetHi << 8);

  // Reject oversized replies (GLW chunk size maximum is 56)
  if (size > CHUNK_SIZE) {
    return null;
  }

  // Reject nonzero reserved byte per GLW protocol spec
  const reservedValid = (reservedByte === 0);

  const payloadStart = offset + 8;
  const availableBytes = bytes.length - payloadStart;
  if (availableBytes < size) {
    return null; // Truncated packet
  }

  const payload = Buffer.from(bytes.subarray(payloadStart, payloadStart + size));

  // Verify checksum over [size, offsetLo, offsetHi, 0, ...payload]
  const checksumParticipants = [size, offsetLo, offsetHi, 0, ...payload];
  const calculatedChecksum = calculateChecksum(checksumParticipants);
  let checksumValid = (replyChecksum === calculatedChecksum);

  // Request-matched GET_INFO CMD 3 offset 0 exception:
  // When expectedRequest descriptor is provided, accept echoed checksum if and only if
  // it strictly matches the expected request descriptor checksum.
  // Firmware quirk: the device sometimes echoes the request descriptor
  // checksum instead of computing the reply checksum. Admission through this
  // exception proves the request was heard, not that the payload is intact,
  // so version/identity gates must treat a checksumEchoed reply as untrusted.
  // Remove the exception once the affected firmware revision is obsolete.
  let checksumEchoed = false;
  if (!checksumValid && expectedRequest && command === COMMANDS.GET_INFO && memoryOffset === 0 && size === 38) {
    const requestIsGetInfo = expectedRequest.command === undefined || expectedRequest.command === COMMANDS.GET_INFO;
    const requestOffsetOk = expectedRequest.offset === undefined || expectedRequest.offset === 0;
    if (requestIsGetInfo && requestOffsetOk
      && expectedRequest.expectedChecksum !== undefined
      && replyChecksum === expectedRequest.expectedChecksum) {
      checksumValid = true;
      checksumEchoed = true;
    }
  }

  return {
    command,
    status,
    success: status === 0 && checksumValid && reservedValid,
    checksumValid,
    checksumEchoed,
    reservedValid,
    replyChecksum,
    calculatedChecksum,
    offset: memoryOffset,
    size,
    data: payload
  };
}

/**
 * Unsolicited factory-reset completion reports are not 0x55/0xAA framed.
 * GLW emits reset for input starting 0xA2, or 0xFA 0xFB 0xFF.
 * Ordinary AA command acknowledgments are not reset completion.
 */
function decodeResetNotification(raw) {
  if (!raw || raw.length < 1) return null;
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  let i = 0;
  if (bytes.length === 65 && bytes[0] === 0) i = 1;
  if (bytes.length - i < 1) return null;
  if (bytes[i] === FLAG_RESPONSE) return null;
  if (bytes[i] === 0xA2) {
    return { type: 'reset', kind: 'a2', bytes };
  }
  if (bytes.length - i >= 3 && bytes[i] === 0xFA && bytes[i + 1] === 0xFB && bytes[i + 2] === 0xFF) {
    return { type: 'reset', kind: 'fafbff', bytes };
  }
  return null;
}

/**
 * @param {'active'|'all'} scope
 * @param {number} activeProfileIndex
 * @returns {number} wire data byte
 */
function resolveFactoryResetScopeByte(scope, activeProfileIndex) {
  if (scope === 'all') return RESET_SCOPE_ALL;
  if (scope === 'active') {
    if (!Number.isInteger(activeProfileIndex) || activeProfileIndex < 0 || activeProfileIndex > 3) {
      throw new RangeError('active profile index must be integer 0..3');
    }
    return activeProfileIndex;
  }
  throw new TypeError('scope must be "active" or "all"');
}

/**
 * Parses response from CMD 3 (GET_INFO)
 * Payload layout:
 * - bytes 0..1: FW version uint16le (e.g. 0x0114 -> "1.14" / "114")
 * - bytes 2..3: RF FW version uint16le (e.g. 0x0130 -> "1.30" / "130")
 * - bytes 6..: Dongle build string (starts at byte 6 with comma, e.g. ",Jan 12 2026, 20:41:47 2.4G Dongle")
 */
function parseInfo(data) {
  if (!data || data.length < 4) return null;

  const fwRaw = data[0] | (data[1] << 8);
  const rfFwRaw = data[2] | (data[3] << 8);

  const formatVersion = (raw) => {
    if (raw === 0xFFFF || raw === 0) return 'Unknown';
    const hex = raw.toString(16);
    if (hex.length >= 3) {
      return `${hex.slice(0, hex.length - 2)}.${hex.slice(hex.length - 2)}`;
    }
    return hex;
  };

  let buildDate = null;
  let dongleInfo = null;
  if (data.length > 6) {
    const chars = [];
    for (let i = 6; i < data.length; i++) {
      if (data[i] === 0) break;
      if (data[i] >= 32 && data[i] <= 126) {
        chars.push(String.fromCharCode(data[i]));
      }
    }
    const fullStr = chars.join('').replace(/^[\s,]+/, '').trim();
    if (fullStr) {
      const dongleMatch = fullStr.match(/(.+?)(2\.4G\s+Dongle.*)$/i);
      if (dongleMatch) {
        buildDate = dongleMatch[1].trim() || null;
        dongleInfo = dongleMatch[2].trim() || null;
      } else {
        buildDate = fullStr;
        dongleInfo = null;
      }
    }
  }

  return {
    firmwareVersion: formatVersion(fwRaw),
    rawFirmwareVersion: fwRaw,
    rfFirmwareVersion: formatVersion(rfFwRaw),
    rawRfFirmwareVersion: rfFwRaw,
    buildDate,
    dongleInfo
  };
}

/**
 * Parses response from CMD 4 (GET_BASE)
 * Payload layout:
 * - byte 0: active profile slot (0..3)
 * - byte 1: profile count enabled (1..4)
 * - bytes 2..5: profile order (e.g. [0, 1, 2, 3])
 * - bytes 6..55: system / marker bytes (must be preserved)
 *
 * Strict validation: rejects invalid count, order, or active slot.
 * Does not clamp-repair.
 */
function parseBase(data) {
  if (!data || data.length < 56) return null;

  const activeSlot = data[0];
  const profileCount = data[1];
  const profileOrder = [data[2], data[3], data[4], data[5]];

  // Validate profile count
  if (profileCount < 1 || profileCount > MAX_KEYBOARD_PROFILES) {
    return null;
  }

  // Validate active slot
  if (activeSlot < 0 || activeSlot >= profileCount) {
    return null;
  }

  // Validate profile order (must contain unique profile indices in 0..3)
  const seen = new Set();
  for (let i = 0; i < MAX_KEYBOARD_PROFILES; i++) {
    const p = profileOrder[i];
    if (p < 0 || p >= MAX_KEYBOARD_PROFILES || seen.has(p)) {
      return null;
    }
    seen.add(p);
  }

  const activeProfile = profileOrder[activeSlot];

  return {
    activeSlot,
    activeProfile,
    profileCount,
    profileOrder,
    rawBytes: Buffer.from(data)
  };
}

/**
 * Encodes mutated base buffer to switch active profile.
 * Preserves all other 56 bytes.
 *
 * Strict requirements:
 * - Requires complete 56-byte existing buffer
 * - Rejects unknown or disabled profiles
 * - Does not silently rewrite profile order
 *
 * @param {Buffer} originalBuffer - Complete 56-byte prior buffer
 * @param {number} newActiveProfile - Profile index (0..3)
 * @returns {Buffer} Mutated 56-byte buffer
 */
function mutateBase(originalBuffer, newActiveProfile) {
  if (!originalBuffer || originalBuffer.length < 56) {
    throw new Error('mutateBase requires complete 56-byte prior buffer; no zero fallback permitted');
  }

  const parsed = parseBase(originalBuffer);
  if (!parsed) {
    throw new Error('mutateBase rejected malformed base buffer');
  }

  const enabledProfiles = parsed.profileOrder.slice(0, parsed.profileCount);
  const slot = enabledProfiles.indexOf(newActiveProfile);
  if (slot === -1) {
    throw new Error(`Profile ${newActiveProfile} is not enabled or present in active profile order [${enabledProfiles.join(', ')}]`);
  }

  const buf = Buffer.from(originalBuffer);
  buf[0] = slot;
  return buf;
}

/**
 * Converts RGB components to hex string '#RRGGBB'
 */
function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(x => (x & 0xFF).toString(16).padStart(2, '0')).join('').toUpperCase();
}

/**
 * Parses hex color '#RRGGBB' into { r, g, b }
 */
function hexToRgb(hex) {
  if (!hex || typeof hex !== 'string') return { r: 0, g: 229, b: 255 };
  const clean = hex.replace('#', '');
  return {
    r: parseInt(clean.substring(0, 2), 16) || 0,
    g: parseInt(clean.substring(2, 4), 16) || 0,
    b: parseInt(clean.substring(4, 6), 16) || 0
  };
}

/**
 * Parses response from CMD 5 (GET_FUNC_CONFIG)
 * 64-byte payload covering lighting, battery, and performance settings.
 *
 * Verified speed range is 0..4 (raw10 = 4 - speed).
 */
function parseFuncConfig(data) {
  if (!data || data.length < 64) return null;

  // Main Lighting
  const effect = data[8];
  const brightness = Math.min(100, Math.max(0, data[9]));
  const speed = Math.max(0, Math.min(4, 4 - data[10])); // Verified 0..4 range
  const direction = data[11] & 1;
  const customColorDisabled = Boolean(data[12]);
  const colorIndex = data[13];
  const hexColor = rgbToHex(data[14], data[15], data[16]);

  // Side Lighting
  const sideEffect = data[24];
  const sideBrightness = Math.min(100, Math.max(0, data[25]));
  const sideSpeed = Math.max(0, Math.min(4, 4 - data[26])); // Verified 0..4 range
  const sideCustomColorDisabled = Boolean(data[27]);
  const sideHexColor = rgbToHex(data[29], data[30], data[31]);

  // Calibration RGB
  const calibrationRgb = { r: data[40], g: data[41], b: data[42] };

  // Performance / Status
  const macMode = data[1] & 0x0F;
  const reporteRate = data[4] & 0x0F;
  const tickRate = (data[4] >> 4) & 0x0F;
  const deadZone = data[5];
  const lockWin = Boolean(data[6] & 1);
  const lockAltTab = Boolean((data[6] >> 1) & 1);
  const lockAltF4 = Boolean((data[6] >> 2) & 1);
  const debounceLevel = (data[7] >> 5) & 7;
  const batteryLevel = Math.min(100, Math.max(0, data[32] & 127));
  const isCharging = Boolean((data[32] >> 7) & 1);
  const rollerType = data[33];
  const workMode = data[34];
  const sleepTime = data[35]; // Verified: units of 30 seconds
  const sleepMode = data[36]; // 1 = never sleep, 0 = sleep enabled
  const rfChannel = data[37];
  const reportRate24G = data[38];

  return {
    lighting: {
      effect,
      brightness,
      speed,
      direction,
      customColorDisabled,
      colorIndex,
      hexColor,
      sideEffect,
      sideBrightness,
      sideSpeed,
      sideCustomColorDisabled,
      sideHexColor,
      calibrationRgb
    },
    performance: {
      batteryLevel,
      isCharging,
      macMode,
      reporteRate,
      tickRate,
      deadZone,
      lockWin,
      lockAltTab,
      lockAltF4,
      debounceLevel,
      rollerType,
      workMode,
      sleepTime,
      sleepMode,
      rfChannel,
      reportRate24G
    },
    rawBytes: Buffer.from(data)
  };
}

/**
 * Updates lighting fields inside an existing 64-byte funcConfig buffer.
 * Preserves all reserved and non-lighting parameters.
 * Requires complete 64-byte prior buffer.
 */
function mutateLighting(funcBuffer, lighting) {
  if (!funcBuffer || funcBuffer.length < 64) {
    throw new Error('mutateLighting requires complete 64-byte prior buffer; no zero fallback permitted');
  }

  const buf = Buffer.from(funcBuffer);

  if (lighting.effect !== undefined) buf[8] = lighting.effect & 0xFF;
  if (lighting.brightness !== undefined) buf[9] = Math.min(100, Math.max(0, lighting.brightness));
  if (lighting.speed !== undefined) {
    const s = Math.max(0, Math.min(4, lighting.speed));
    buf[10] = 4 - s;
  }
  if (lighting.direction !== undefined) buf[11] = lighting.direction ? 1 : 0;
  if (lighting.customColorDisabled !== undefined) buf[12] = lighting.customColorDisabled ? 1 : 0;

  if (lighting.hexColor) {
    const rgb = hexToRgb(lighting.hexColor);
    buf[14] = rgb.r;
    buf[15] = rgb.g;
    buf[16] = rgb.b;
  }

  if (lighting.sideEffect !== undefined) buf[24] = lighting.sideEffect & 0xFF;
  if (lighting.sideBrightness !== undefined) buf[25] = Math.min(100, Math.max(0, lighting.sideBrightness));
  if (lighting.sideSpeed !== undefined) {
    const ss = Math.max(0, Math.min(4, lighting.sideSpeed));
    buf[26] = 4 - ss;
  }
  if (lighting.sideCustomColorDisabled !== undefined) buf[27] = lighting.sideCustomColorDisabled ? 1 : 0;

  if (lighting.sideHexColor) {
    const sideRgb = hexToRgb(lighting.sideHexColor);
    buf[29] = sideRgb.r;
    buf[30] = sideRgb.g;
    buf[31] = sideRgb.b;
  }

  // LED White Balance Calibration RGB (bytes 40, 41, 42)
  if (lighting.calibrationRgb) {
    const { r, g, b } = lighting.calibrationRgb;
    if (Number.isInteger(r) && r >= 0 && r <= 255) buf[40] = r;
    if (Number.isInteger(g) && g >= 0 && g <= 255) buf[41] = g;
    if (Number.isInteger(b) && b >= 0 && b <= 255) buf[42] = b;
  }

  return buf;
}

/**
 * Updates settings fields inside an existing 64-byte funcConfig buffer.
 * Preserves all reserved and lighting parameters.
 * Requires complete 64-byte prior buffer.
 */
function mutateSettings(funcBuffer, settings, profileIndex = null) {
  if (!funcBuffer || funcBuffer.length < 64) {
    throw new Error('mutateSettings requires complete 64-byte prior buffer; no zero fallback permitted');
  }

  const buf = Buffer.from(funcBuffer);

  if (settings.macMode !== undefined) {
    if (profileIndex !== null && Number.isInteger(profileIndex)) {
      const isMac = (settings.macMode & 2) !== 0 || settings.macMode === 'mac';
      buf[1] = (buf[1] & 0xF0) | ((profileIndex * 4 + (isMac ? 2 : 0)) & 0x0F);
    } else {
      buf[1] = (buf[1] & 0xF0) | (settings.macMode & 0x0F);
    }
  }
  if (settings.reporteRate !== undefined) {
    // Byte 4 low nibble is reporteRate; preserve tickRate in high nibble
    buf[4] = (buf[4] & 0xF0) | (settings.reporteRate & 0x0F);
  }
  if (settings.sleepTime !== undefined) {
    buf[35] = Math.min(255, Math.max(0, settings.sleepTime));
  }
  if (settings.sleepMode !== undefined) {
    buf[36] = settings.sleepMode ? 1 : 0;
  }
  if (settings.debounceLevel !== undefined) {
    buf[7] = (buf[7] & 0x1F) | ((settings.debounceLevel & 7) << 5);
  }
  if (settings.lockWin !== undefined) {
    buf[6] = (buf[6] & 0xFE) | (settings.lockWin ? 1 : 0);
  }
  if (settings.rollerType !== undefined) {
    buf[33] = settings.rollerType & 0xFF;
  }

  return buf;
}

const CONSUMER_KEY_LABELS = {
  233: 'Volume Up',
  234: 'Volume Down',
  226: 'Mute',
  205: 'Play / Pause',
  183: 'Stop',
  181: 'Next Track',
  182: 'Prev Track',
  111: 'Brightness Up',
  112: 'Brightness Down',
  35: 'Homepage',
  39: 'Web Refresh',
  38: 'Web Stop',
  37: 'Web Forward',
  36: 'Web Backward',
  42: 'Web Favorites',
  33: 'Web Search',
  146: 'Calculator',
  148: 'My Computer',
  138: 'Mail',
  207: 'Siri',
  160: 'Launchpad',
  188: 'Rewind',
  187: 'Fast Forward',
  176: 'Eject'
};

const KB_CONTROL_LABELS = {
  2: 'Win Lock',
  4: 'Win OS Switch',
  5: 'Mac OS Switch',
  6: 'Win / Mac Toggle',
  8: 'Factory Reset (Hold 3s)',
  11: 'Show Battery',
  21: 'Side Light Bright +',
  22: 'Side Light Bright -',
  23: 'Side Light Speed -',
  24: 'Side Light Speed +',
  25: 'Side Light Speed Loop',
  26: 'Side Light Color',
  28: 'Side Light On/Off',
  30: 'Back / Home',
  46: 'Backlight Mode -',
  47: 'Backlight Mode +',
  48: 'RGB Mode',
  50: 'Backlight Bright +',
  51: 'Backlight Bright -',
  53: 'Backlight Toggle',
  54: 'Backlight Speed +',
  55: 'Backlight Speed -',
  60: 'Backlight Color -',
  61: 'Backlight Color +',
  69: 'Show Desktop',
  70: 'File Explorer',
  71: 'Switch Window',
  73: 'Toggle Charging',
  81: 'Mac Search',
  83: 'Mac Screenshot',
  86: 'Open M Hub',
  160: 'Side Light Mode',
  250: 'Switch Onboard Profile'
};

const SYSTEM_CONTROL_LABELS = {
  1: 'System Power',
  2: 'System Sleep',
  4: 'System Wake'
};

const SHORTCUT_CHORD_LABELS = {
  '1,45': 'Zoom out',
  '1,46': 'Zoom in',
  '1,39': 'Reset',
  '1,28': 'Restore',
  '1,29': 'Undo',
  '1,4': 'Select all',
  '1,17': 'Create',
  '1,6': 'Copy',
  '1,27': 'Cut',
  '1,25': 'Paste',
  '1,22': 'Save',
  '1,18': 'Open',
  '1,23': 'New Item',
  '1,26': 'Close item',
  '4,80': 'Back (keyboard)',
  '4,79': 'Forward (keyboard)',
  '8,43': 'switch window',
  '8,7': 'Show desktop',
  '9,88': 'Open navigation',
  '8,23': 'Cycle taskbar Apps',
  '8,4': 'Action center',
  '8,8': 'File Explorer',
  '8,12': 'Windows settings center',
  '8,15': 'Lock computer',
  '8,14': 'Cast screen to other devices',
  '8,5': 'Jump to tray',
  '8,10': 'Start Xbox game bar',
  '8,21': 'Run',
  '8,22': 'Search',
  '8,24': 'Display settings',
  '8,27': 'Simple menu',
  '8,55': 'Emoji box',
  '1,41': 'Start menu',
  '4,43': 'Taskbar',
  '4,61': 'Close window',
  '4,41': 'Switch to next App',
  '5,76': 'Windows security screen',
  '3,41': 'Task Manager',
  '8,45': 'Zoom out',
  '8,46': 'Zoom in',
  '8,39': 'Actual Size',
  '10,29': 'Redo',
  '8,29': 'Undo',
  '8,17': 'New file/window',
  '8,6': 'Copy',
  '8,25': 'Paste',
  '8,18': 'Open file',
  '8,26': 'Close current tab/window',
  '8,47': 'Go back/up one level',
  '8,48': 'Go to next page',
  '12,7': 'Show/hide Dock',
  '8,62': 'VoiceOver',
  '12,44': 'Open Finder',
  '9,20': 'Lock screen',
  '9,44': 'Emoji & Symbols',
  '1,82': 'Mission Control',
  '10,11': 'Browser homepage',
  '10,6': 'Go to home directory',
  '12,5': 'Show bookmarks (Safari)',
  '12,41': 'Force Quit',
  '8,9': 'Find/Address Bar'
};

const CONSUMER_TUPLE_LABELS = {
  // Standard Media (code2 = 0)
  '233,0': 'Volume Up',
  '234,0': 'Volume Down',
  '226,0': 'Mute',
  '205,0': 'Play / Pause',
  '183,0': 'Stop',
  '181,0': 'Next Track',
  '182,0': 'Prev Track',
  '111,0': 'Brightness Up',
  '112,0': 'Brightness Down',
  '188,0': 'Rewind',
  '187,0': 'Fast Forward',
  '176,0': 'Eject',
  '207,0': 'Siri',
  '160,0': 'Launchpad',
  // Application Launch (code2 = 1)
  '146,1': 'Calculator',
  '148,1': 'My computer',
  '138,1': 'Mail',
  // Web Navigation / Browser (code2 = 2)
  '35,2': 'Browser homepage',
  '39,2': 'Refresh (web page)',
  '38,2': 'Web Stop',
  '37,2': 'Web Forward',
  '36,2': 'Web Backward',
  '42,2': 'Favorites',
  '33,2': 'Search (Web)'
};

const LIGHTING_CONTROL_LABELS = {
  47: 'Backlight Mode Switch→',
  46: 'Backlight Mode Switch←',
  50: 'Backlight brightness +',
  51: 'Backlight brightness -',
  54: 'Backlight speed +',
  55: 'Backlight speed -',
  61: 'Switch backlight color→',
  60: 'Switch backlight color←',
  53: 'Toggle keyboard backlight',
  160: 'Switch indicator mode',
  21: 'Indicator brightness +',
  22: 'Indicator brightness -',
  24: 'Indicator speed +',
  23: 'Indicator speed -',
  26: 'Indicator Speed Switch',
  27: 'Switch indicator color',
  29: 'Indicator On/Off'
};

/**
 * Decodes a 3-byte key tuple [type, code1, code2] into logical key representation.
 *
 * Protocol verified tuple order:
 * - Standard normal key: [16, modifierMask, HIDusage] -> Esc is [16, 0, 41]
 * - Modifier-only key:   [16, 1 << (usage - 224), 0]   -> LeftCtrl is [16, 1, 0]
 * - Rotary knob:         [48, 226, 0]
 * - Media consumer keys: [48, consumerUsage, 0]
 * - Fn layer key:        [240, 255, 1] (Win) or [240, 255, 3] (Mac)
 * - TGL toggle key:      [145, tableIndex, 0]
 * - MT mod-tap key:      [146, tableIndex, delayMs / 10]
 * - SOCD opposing key:   [148, tableIndex, partnerPhysicalSlot]
 * - Clear / Disabled:    [0, 0, 0]
 *
 * @param {Array<number>|Buffer|Uint8Array} tuple - 3 bytes [type, code1, code2]
 * @returns {Object} Decoded key object
 */
function decodeKeyTuple(tuple) {
  const type = tuple[0] || 0;
  const code1 = tuple[1] || 0;
  const code2 = tuple[2] || 0;

  if (type === KEY_TYPES.EMPTY) {
    return {
      type: 0,
      code1: 0,
      code2: 0,
      code: 0,
      label: 'Disabled',
      modifierMask: 0,
      isModifier: false
    };
  }

  if (type === KEY_TYPES.STANDARD) {
    if (code1 === 0 && code2 === 0) {
      return {
        type: 16,
        code1: 0,
        code2: 0,
        code: 0,
        label: 'Clear',
        modifierMask: 0,
        isModifier: false,
        isClear: true
      };
    }
    if (code1 > 0 && code2 > 0) {
      const chordLabel = SHORTCUT_CHORD_LABELS[`${code1},${code2}`] || `Chord [16, ${code1}, ${code2}]`;
      return {
        type,
        code1,
        code2,
        code: code2,
        label: chordLabel,
        modifierMask: code1,
        isModifier: false,
        isChord: true
      };
    }
    if (code2 > 0) {
      // Standard key with HID usage in code2
      return {
        type,
        code1,
        code2,
        code: code2,
        modifierMask: code1,
        isModifier: false
      };
    } else if (code1 > 0) {
      // Modifier-only key
      const modifierUsage = MODIFIER_MASKS[code1] || (224 + Math.round(Math.log2(code1)));
      return {
        type,
        code1,
        code2,
        code: modifierUsage,
        modifierMask: code1,
        isModifier: true
      };
    }
    return { type, code1, code2, code: 0, modifierMask: 0, isModifier: false };
  }

  if (type === KEY_TYPES.MOUSE_BUTTON) {
    const label = MOUSE_BUTTON_LABELS[code1] || (code1 > 0 ? `Mouse Button ${code1}` : 'Mouse Button');
    return {
      type,
      code1,
      code2,
      code: code1,
      label,
      modifierMask: 0,
      isModifier: false,
      isMouse: true
    };
  }

  if (type === KEY_TYPES.MOUSE_WHEEL) {
    const label = code2 === 255 ? 'Wheel Down' : (code2 === 1 ? 'Wheel Up' : `Wheel ${code2}`);
    return {
      type,
      code1,
      code2,
      code: code2,
      label,
      modifierMask: 0,
      isModifier: false,
      isMouse: true
    };
  }

  if (type === KEY_TYPES.FN_LAYER) {
    const isFnKey = code1 === 255;
    let label;
    if (isFnKey) {
      label = 'FN Layer';
    } else if (code1 === 250) {
      label = 'Switch Profile';
    } else if (code1 === 81) {
      label = 'Search';
    } else if (LIGHTING_CONTROL_LABELS[code1]) {
      label = LIGHTING_CONTROL_LABELS[code1];
    } else if (code1 === 31) {
      label = code2 === 0 ? '2.4G Pairing (Hold 3s)' : `Bluetooth ${code2}`;
    } else {
      label = KB_CONTROL_LABELS[code1] || `System ${code1}`;
    }
    return {
      type,
      code1,
      code2,
      code: isFnKey ? FN_CODE : (code1 === 250 ? 250 : code1),
      label,
      modifierMask: 0,
      isModifier: false
    };
  }

  if (type === KEY_TYPES.MEDIA_MOUSE) {
    const tupleKey = `${code1},${code2}`;
    const label = CONSUMER_TUPLE_LABELS[tupleKey] ||
      (code1 === 226 && code2 === 0 ? 'Mute' : (code1 > 0 || code2 > 0 ? (code2 > 0 ? `Media [48, ${code1}, ${code2}]` : `Media ${code1}`) : 'Media'));
    return {
      type,
      code1,
      code2,
      code: code1 === 226 && code2 === 0 ? KNOB_CODE : code1,
      label,
      modifierMask: 0,
      isModifier: false,
      isMedia: true
    };
  }

  if (type === KEY_TYPES.SYSTEM) {
    const label = SYSTEM_CONTROL_LABELS[code1] || `System ${code1}`;
    return {
      type: 64,
      code1,
      code2,
      code: code1,
      label,
      modifierMask: 0,
      isModifier: false
    };
  }

  if (type === KEY_TYPES.MACRO) {
    // Verified GLW Macro format: [112, slot, playbackType]
    // UI1833 function tC: 0 = repeat while held, 1 = play once, 255 = toggle repeat
    return {
      type,
      code1,
      code2,
      code: code1,
      slot: code1,
      playbackType: code2,
      label: `M${code1 + 1}`,
      isModifier: false,
      isMacro: true
    };
  }

  if (type === KEY_TYPES.TGL) {
    return {
      type: 145,
      code1,
      code2,
      tableIndex: code1,
      label: `TGL #${code1 + 1}`,
      isAdvanced: true,
      advancedType: 'tgl',
      modifierMask: 0,
      isModifier: false
    };
  }

  if (type === KEY_TYPES.MT) {
    const delayMs = code2 * 10;
    return {
      type: 146,
      code1,
      code2,
      tableIndex: code1,
      delayMs,
      label: `MT #${code1 + 1} (${delayMs}ms)`,
      isAdvanced: true,
      advancedType: 'mt',
      modifierMask: 0,
      isModifier: false
    };
  }

  if (type === KEY_TYPES.SOCD) {
    return {
      type: 148,
      code1,
      code2,
      tableIndex: code1,
      partnerSlot: code2,
      label: `SOCD #${code1 + 1} (slot ${code2})`,
      isAdvanced: true,
      advancedType: 'socd',
      modifierMask: 0,
      isModifier: false
    };
  }

  return {
    type,
    code1,
    code2,
    code: code2 || code1,
    label: `Type ${type}`,
    modifierMask: 0,
    isModifier: false
  };
}

/**
 * Encodes a key into a 3-byte tuple [type, code1, code2].
 *
 * @param {Object} options
 * @param {number} [options.code] - HID usage (or KNOB_CODE, FN_CODE)
 * @param {number} [options.modifierMask=0] - Modifier bitmask for combinations
 * @param {number} [options.type] - Key type override
 * @param {number} [options.slot] - Macro slot index
 * @param {number} [options.playbackType=1] - Macro playback type
 * @param {number} [options.tableIndex] - Advanced MT / TGL table index
 * @param {number} [options.partnerSlot] - SOCD partner slot
 * @param {number} [options.delayMs] - MT delay in ms
 * @param {number} [options.code1]
 * @param {number} [options.code2]
 * @returns {Array<number>} 3-byte tuple [type, code1, code2]
 */
function encodeKeyTuple({ code, modifierMask = 0, type, slot, playbackType, tableIndex, partnerSlot, delayMs, code1, code2 }) {
  if (type !== undefined) {
    if (type === KEY_TYPES.MACRO) {
      const macroSlot = slot !== undefined ? slot : (code1 !== undefined ? code1 : code);
      const pType = playbackType !== undefined ? playbackType : (code2 !== undefined ? code2 : 1);
      return [KEY_TYPES.MACRO, macroSlot & 0xFF, pType & 0xFF];
    }
    if (type === KEY_TYPES.EMPTY) {
      return [0, 0, 0];
    }
    if (type === KEY_TYPES.MOUSE_BUTTON) {
      const c1 = code1 !== undefined ? code1 : (code !== undefined ? code : 1);
      const c2 = code2 !== undefined ? code2 : 0;
      return [KEY_TYPES.MOUSE_BUTTON, c1 & 0xFF, c2 & 0xFF];
    }
    if (type === KEY_TYPES.MOUSE_WHEEL) {
      const c1 = code1 !== undefined ? code1 : 0;
      const c2 = code2 !== undefined ? code2 : (code !== undefined ? code : 1);
      return [KEY_TYPES.MOUSE_WHEEL, c1 & 0xFF, c2 & 0xFF];
    }
    if (type === KEY_TYPES.MEDIA_MOUSE) {
      const c1 = code1 !== undefined ? code1 : (code === KNOB_CODE ? 226 : code);
      const c2 = code2 !== undefined ? code2 : 0;
      return [KEY_TYPES.MEDIA_MOUSE, c1 & 0xFF, c2 & 0xFF];
    }
    if (type === KEY_TYPES.SYSTEM) {
      const c1 = code1 !== undefined ? code1 : (code || 1);
      return [KEY_TYPES.SYSTEM, c1 & 0xFF, 0];
    }
    if (type === KEY_TYPES.FN_LAYER) {
      const c1 = code1 !== undefined ? code1 : 255;
      const c2 = code2 !== undefined ? code2 : 1;
      return [KEY_TYPES.FN_LAYER, c1 & 0xFF, c2 & 0xFF];
    }
    if (type === KEY_TYPES.TGL) {
      const idx = tableIndex !== undefined ? tableIndex : (code1 !== undefined ? code1 : 0);
      return [KEY_TYPES.TGL, idx & 0xFF, 0];
    }
    if (type === KEY_TYPES.MT) {
      const idx = tableIndex !== undefined ? tableIndex : (code1 !== undefined ? code1 : 0);
      const delay = delayMs !== undefined ? Math.floor(delayMs / 10) : (code2 !== undefined ? code2 : 15);
      return [KEY_TYPES.MT, idx & 0xFF, delay & 0xFF];
    }
    if (type === KEY_TYPES.SOCD) {
      const idx = tableIndex !== undefined ? tableIndex : (code1 !== undefined ? code1 : 0);
      const pSlot = partnerSlot !== undefined ? partnerSlot : (code2 !== undefined ? code2 : 0);
      return [KEY_TYPES.SOCD, idx & 0xFF, pSlot & 0xFF];
    }
    if (type === KEY_TYPES.STANDARD) {
      const c1 = code1 !== undefined ? code1 : modifierMask;
      const c2 = code2 !== undefined ? code2 : code;
      return [KEY_TYPES.STANDARD, c1 & 0xFF, c2 & 0xFF];
    }
    return [type & 0xFF, (code1 || 0) & 0xFF, (code2 || 0) & 0xFF];
  }

  if (code === KNOB_CODE) {
    return [KEY_TYPES.MEDIA_MOUSE, 226, 0];
  }
  if (code === FN_CODE) {
    return [KEY_TYPES.FN_LAYER, 255, 1];
  }
  if (code >= 224 && code <= 231) {
    // Modifier-only key: [16, 1 << (code - 224), 0]
    const mask = USAGE_TO_MODIFIER_MASK[code] || (1 << (code - 224));
    return [KEY_TYPES.STANDARD, mask, 0];
  }
  if (code > 0) {
    // Standard key: [16, modifierMask, HIDusage]
    return [KEY_TYPES.STANDARD, modifierMask & 0xFF, code & 0xFF];
  }
  return [KEY_TYPES.EMPTY, 0, 0];
}

function isExactUint8Triple(tuple) {
  return Array.isArray(tuple) && tuple.length === 3 &&
    Number.isInteger(tuple[0]) && tuple[0] >= 0 && tuple[0] <= 255 &&
    Number.isInteger(tuple[1]) && tuple[1] >= 0 && tuple[1] <= 255 &&
    Number.isInteger(tuple[2]) && tuple[2] >= 0 && tuple[2] <= 255;
}

/** Hub isHotKey: exact [16, modifierMask, 0]. Extra array elements are rejected. */
function isHotKeyTuple(tuple) {
  return isExactUint8Triple(tuple) &&
    tuple[0] === KEY_TYPES.STANDARD &&
    tuple[1] > 0 &&
    tuple[2] === 0;
}

/** Hub isNormalKey: exact [16, 0, hidUsage]. Extra array elements are rejected. */
function isNormalKeyTuple(tuple) {
  return isExactUint8Triple(tuple) &&
    tuple[0] === KEY_TYPES.STANDARD &&
    tuple[1] === 0 &&
    tuple[2] > 0;
}

/** Hub isCBKey / mergeCBKey: exact [16, modifierMask, hidUsage]. Extra elements rejected. */
function isCBKeyTuple(tuple) {
  return isExactUint8Triple(tuple) &&
    tuple[0] === KEY_TYPES.STANDARD &&
    tuple[1] > 0 &&
    tuple[2] > 0;
}

/**
 * Official mergeCBKey(hot, normal) → { type: 16, code1: hot.code1, code2: normal.code2 }.
 * @returns {[number, number, number]}
 */
function mergeCBKey(hotKey, normalKey) {
  if (!isHotKeyTuple(hotKey) || !isNormalKeyTuple(normalKey)) {
    throw new Error('CB merge requires a modifier-only key and a regular type-16 key');
  }
  return [KEY_TYPES.STANDARD, hotKey[1], normalKey[2]];
}

/**
 * Parses key matrix raw bytes into an array of key tuples { type, code1, code2, index, layer, code }
 * Each key entry is 3 bytes.
 */
function parseKeyMatrix(data, layer = 0) {
  if (!data || data.length === 0) return [];
  const count = Math.floor(data.length / 3);
  const keys = [];

  for (let i = 0; i < count; i++) {
    const offset = i * 3;
    const tuple = [data[offset], data[offset + 1], data[offset + 2]];
    const decoded = decodeKeyTuple(tuple);
    keys.push({
      index: i,
      layer,
      ...decoded
    });
  }

  return keys;
}

/**
 * Parses per-key RGB colors (CMD 10)
 * 384 bytes = 128 keys * 3 bytes (R, G, B)
 *
 * @param {Buffer|Uint8Array} data
 * @returns {Array<Object>} 128 key color objects
 */
function parseKeyColors(data) {
  if (!data || data.length < USED_KEY_AREA_SIZE) return [];
  const colors = [];
  const count = Math.floor(USED_KEY_AREA_SIZE / 3); // 128

  for (let i = 0; i < count; i++) {
    const offset = i * 3;
    const r = data[offset];
    const g = data[offset + 1];
    const b = data[offset + 2];
    colors.push({
      index: i,
      r,
      g,
      b,
      hex: rgbToHex(r, g, b)
    });
  }

  return colors;
}

/**
 * Serializes per-key RGB colors (CMD 11)
 *
 * @param {Array<Object>|Object} colors - Array of { index, r, g, b, hex } or map { [index]: hex }
 * @param {Buffer} [existingBuffer] - 384-byte existing buffer to preserve uncolored keys
 * @returns {Buffer} 384-byte buffer
 */
function serializeKeyColors(colors, existingBuffer = null) {
  const buffer = Buffer.alloc(USED_KEY_AREA_SIZE, 0);
  if (existingBuffer && existingBuffer.length >= USED_KEY_AREA_SIZE) {
    existingBuffer.copy(buffer, 0, 0, USED_KEY_AREA_SIZE);
  }

  if (Array.isArray(colors)) {
    for (const item of colors) {
      if (item) {
        const idx = item.slot !== undefined ? item.slot : item.index;
        if (Number.isInteger(idx) && idx >= 0 && idx < 128) {
          const offset = idx * 3;
          if (item.hex) {
            const rgb = hexToRgb(item.hex);
            if (rgb) {
              buffer[offset] = rgb.r;
              buffer[offset + 1] = rgb.g;
              buffer[offset + 2] = rgb.b;
            }
          } else {
            buffer[offset] = item.r || 0;
            buffer[offset + 1] = item.g || 0;
            buffer[offset + 2] = item.b || 0;
          }
        }
      }
    }
  } else if (colors && typeof colors === 'object') {
    for (const [keyIdx, val] of Object.entries(colors)) {
      const idx = parseInt(keyIdx, 10);
      if (Number.isInteger(idx) && idx >= 0 && idx < 128) {
        const offset = idx * 3;
        const rgb = typeof val === 'string' ? hexToRgb(val) : val;
        if (rgb) {
          buffer[offset] = rgb.r || 0;
          buffer[offset + 1] = rgb.g || 0;
          buffer[offset + 2] = rgb.b || 0;
        }
      }
    }
  }

  return buffer;
}

/**
 * Decodes 4-byte macro action block
 * [delayLo, delayHi, flags, keyCode]
 *
 * Supported flags:
 * - low 6 bits (flags & 63): action kind (1: modifier bitmask, 2: HID keycode, 3: mouse)
 * - bit 6 (flags & 64): keydown / mousedown
 * - bit 7 (flags & 128): terminator / end-of-macro
 */
function decodeMacroAction(bytes) {
  const delay = bytes[0] | (bytes[1] << 8);
  const flags = bytes[2];
  const codeByte = bytes[3];

  const isEnd = Boolean(flags & 128);
  const isDown = Boolean(flags & 64);
  const kind = flags & 63;

  if (kind !== 1 && kind !== 2 && kind !== 3) {
    throw new Error(`Unsupported macro action kind: ${kind}`);
  }

  let action = isDown ? 'keydown' : 'keyup';
  let code = codeByte;

  if (kind === 1) {
    // Modifier bitmask
    const modifierCodes = {
      1: 224, 2: 225, 4: 226, 8: 227,
      16: 228, 32: 229, 64: 230, 128: 231
    };
    if (!modifierCodes[codeByte]) {
      throw new Error(`Invalid modifier mask in macro action: ${codeByte}`);
    }
    code = modifierCodes[codeByte];
  } else if (kind === 3) {
    // Mouse button
    action = isDown ? 'mousedown' : 'mouseup';
  }

  return {
    type: 'action',
    action,
    code,
    delay: Math.max(0, delay),
    isEnd,
    kind
  };
}

/**
 * Encodes a macro action into 4 bytes
 */
function encodeMacroAction(act, isEnd = false) {
  const delay = Math.max(MIN_MACRO_DELAY - 1, act.delay || 0);
  const delayLo = delay & 0xFF;
  const delayHi = (delay >> 8) & 0xFF;

  let kind = 2; // Default: Standard HID
  let codeByte = act.code || 0;

  if (act.code >= 224 && act.code <= 231) {
    kind = 1; // Modifier
    codeByte = 1 << (act.code & 15);
  } else if (act.action === 'mousedown' || act.action === 'mouseup') {
    kind = 3; // Mouse
  }

  const isDown = act.action === 'keydown' || act.action === 'mousedown';
  const flags = (kind & 63) | (isDown ? 64 : 0) | (isEnd ? 128 : 0);

  return [delayLo, delayHi, flags, codeByte];
}

/**
 * Deserializes full 8192-byte macro region into an array of macro slots (16 slots).
 * Validates magic metadata, offset alignment and bounds. Fail-closed on corruption.
 */
function parseMacroRegion(data) {
  if (!data || data.length < SHARED_MACRO_SIZE) {
    throw new Error(`parseMacroRegion requires full ${SHARED_MACRO_SIZE}-byte macro region`);
  }

  // Validate magic header at byte 32..33
  if (data[32] !== 129 || data[33] !== 126) {
    throw new Error(`Invalid macro metadata magic: [${data[32]}, ${data[33]}]. Expected [129, 126] (0x81, 0x7E)`);
  }

  const offsets = [];
  for (let i = 0; i < MAX_MACRO_SLOTS; i++) {
    const off = data[i * 2] | (data[i * 2 + 1] << 8);
    // Validate offset bounds and 4-byte alignment
    if (off < 64 || off > SHARED_MACRO_SIZE - 4 || (off % 4 !== 0)) {
      throw new Error(`Invalid macro offset at slot ${i}: ${off}. Must be 4-byte aligned and between 64 and ${SHARED_MACRO_SIZE - 4}`);
    }
    offsets.push(off);
  }

  const slotTypes = [];
  for (let i = 0; i < MAX_MACRO_SLOTS; i++) {
    slotTypes.push(data[34 + i]);
  }

  const slots = [];
  for (let i = 0; i < MAX_MACRO_SLOTS; i++) {
    const slotOffset = offsets[i];
    const type = slotTypes[i] || 0;
    const actions = [];

    let cur = slotOffset;
    let terminated = false;
    while (cur + 4 <= SHARED_MACRO_SIZE) {
      const chunk = data.subarray(cur, cur + 4);
      // Check for empty marker block [0, 0, 128, 0]
      if (chunk[0] === 0 && chunk[1] === 0 && chunk[2] === 128 && chunk[3] === 0) {
        terminated = true;
        break;
      }
      const decoded = decodeMacroAction(chunk);
      actions.push({
        action: decoded.action,
        code: decoded.code,
        delay: decoded.delay
      });
      if (decoded.isEnd) {
        terminated = true;
        break;
      }
      cur += 4;
    }

    if (!terminated) {
      throw new Error(`Macro slot ${i} is unterminated: reached boundary without explicit end-of-macro action or empty marker`);
    }

    slots.push({
      id: i,
      name: `Macro ${i + 1}`,
      type,
      offset: slotOffset,
      actions
    });
  }

  return slots;
}

/**
 * Serializes 16 macro slots into the 8192-byte shared memory buffer.
 * Preflights capacity before building buffer; throws RangeError on overflow.
 * Preserves unmodified slots from fresh 8192-byte read and metadata.
 * Validates all actions and types.
 */
function serializeMacroRegion(slots, existingBuffer = null) {
  if (!existingBuffer || existingBuffer.length < SHARED_MACRO_SIZE) {
    throw new Error(`serializeMacroRegion requires valid ${SHARED_MACRO_SIZE}-byte prior buffer`);
  }

  // Parse existing slots to preserve unedited slots
  const existingSlots = parseMacroRegion(existingBuffer);

  // Determine updated slots map
  const updatesMap = new Map();
  if (Array.isArray(slots)) {
    for (let idx = 0; idx < slots.length; idx++) {
      const s = slots[idx];
      if (s && typeof s === 'object') {
        const slotId = s.id !== undefined ? s.id : idx;
        updatesMap.set(slotId, s);
      }
    }
  } else if (slots && typeof slots === 'object') {
    for (const [k, v] of Object.entries(slots)) {
      updatesMap.set(parseInt(k, 10), v);
    }
  }

  // Construct merged effective slots (16 slots)
  const effectiveSlots = [];
  let totalActions = 0;

  for (let i = 0; i < MAX_MACRO_SLOTS; i++) {
    const update = updatesMap.get(i);
    const existing = existingSlots[i];

    const slotType = (update && update.type !== undefined)
      ? update.type
      : (existing ? existing.type : 0);
    if (!Number.isInteger(slotType) || slotType < 0 || slotType > 255) {
      throw new TypeError(`Invalid macro playback type ${slotType} in slot ${i}. Must be uint8 integer 0..255`);
    }

    // Missing actions on a metadata-only update preserve the existing slot body.
    // An explicit empty array still clears the slot.
    const actions = (update && Array.isArray(update.actions))
      ? update.actions
      : (existing && Array.isArray(existing.actions) ? existing.actions : []);
    for (let a = 0; a < actions.length; a++) {
      const act = actions[a];
      if (!act || typeof act !== 'object') {
        throw new TypeError(`Invalid macro action at slot ${i}, action ${a}`);
      }
      if (act.action !== 'keydown' && act.action !== 'keyup' && act.action !== 'mousedown' && act.action !== 'mouseup') {
        throw new TypeError(`Invalid action kind "${act.action}" at slot ${i}, action ${a}`);
      }
      if (act.code !== undefined && (!Number.isInteger(act.code) || act.code < 0 || act.code > 255)) {
        throw new TypeError(`Invalid action key code ${act.code} at slot ${i}, action ${a}`);
      }
      if (act.delay !== undefined && (!Number.isInteger(act.delay) || act.delay < 0 || act.delay > 65535)) {
        throw new RangeError(`Invalid action delay ${act.delay} at slot ${i}, action ${a}`);
      }
    }

    effectiveSlots.push({
      id: i,
      type: slotType,
      actions
    });
  }

  // Deduplication & offset assignment:
  // Offset 64 is the 4-byte empty marker block [0, 0, 128, 0].
  // Action bodies start at offset 68.
  // Reusable body offsets map: bodyKey -> assignedOffset
  const bodyOffsets = new Map();
  bodyOffsets.set('', 64);

  const bodiesToWrite = [];
  let currentActionOffset = 68;
  const slotAssignedOffsets = new Array(MAX_MACRO_SLOTS);

  for (let i = 0; i < MAX_MACRO_SLOTS; i++) {
    const actions = effectiveSlots[i].actions;
    if (actions.length === 0) {
      slotAssignedOffsets[i] = 64;
    } else {
      const bodyKey = getNormalizedBodyKey(actions);
      if (bodyOffsets.has(bodyKey)) {
        slotAssignedOffsets[i] = bodyOffsets.get(bodyKey);
      } else {
        const off = currentActionOffset;
        bodyOffsets.set(bodyKey, off);
        slotAssignedOffsets[i] = off;
        bodiesToWrite.push({ offset: off, actions });
        currentActionOffset += actions.length * 4;
      }
    }
  }

  if (currentActionOffset > SHARED_MACRO_SIZE) {
    throw new RangeError(`Macro storage capacity exceeded: requires ${currentActionOffset} bytes, max ${SHARED_MACRO_SIZE}`);
  }

  const buffer = Buffer.alloc(SHARED_MACRO_SIZE, 0);
  existingBuffer.copy(buffer);

  // Metadata magic
  buffer[32] = 129; // 0x81
  buffer[33] = 126; // 0x7E

  // Empty marker block at offset 64
  buffer[64] = 0;
  buffer[65] = 0;
  buffer[66] = 128;
  buffer[67] = 0;

  // Write slot offsets (0..31) and slot playback types (34..49)
  // Reserved bytes 50..63 are preserved from existingBuffer
  for (let i = 0; i < MAX_MACRO_SLOTS; i++) {
    const off = slotAssignedOffsets[i];
    buffer[i * 2] = off & 0xFF;
    buffer[i * 2 + 1] = (off >> 8) & 0xFF;
    buffer[34 + i] = effectiveSlots[i].type & 0xFF;
  }

  // Write unique action bodies
  for (const item of bodiesToWrite) {
    let off = item.offset;
    for (let a = 0; a < item.actions.length; a++) {
      const isLast = (a === item.actions.length - 1);
      const encoded = encodeMacroAction(item.actions[a], isLast);
      buffer[off] = encoded[0];
      buffer[off + 1] = encoded[1];
      buffer[off + 2] = encoded[2];
      buffer[off + 3] = encoded[3];
      off += 4;
    }
  }

  return buffer;
}

// MT (Mod-Tap) Table Constants
const MT_TABLE_SIZE = 256;
const MT_ENTRIES_COUNT = 32;
const MT_ENTRY_SIZE = 6;
const MT_RESERVED_OFFSET = 192;
const MT_RESERVED_SIZE = 64;

/**
 * Parses MT (Mod-Tap) table (CMD 164)
 * 256-byte payload containing 32 entries (each 6 bytes: 3B tap tuple + 3B hold tuple).
 * Remaining 64 bytes (192..255) are reserved.
 *
 * @param {Buffer|Uint8Array} data
 * @returns {Array<Object>} 32 MT entries
 */
function parseMtTable(data) {
  if (!data || data.length < MT_TABLE_SIZE) {
    throw new Error(`parseMtTable requires complete ${MT_TABLE_SIZE}-byte buffer`);
  }
  const entries = [];
  for (let i = 0; i < MT_ENTRIES_COUNT; i++) {
    const off = i * MT_ENTRY_SIZE;
    const tapTuple = [data[off], data[off + 1], data[off + 2]];
    const holdTuple = [data[off + 3], data[off + 4], data[off + 5]];
    entries.push({
      index: i,
      tapKey: decodeKeyTuple(tapTuple),
      holdKey: decodeKeyTuple(holdTuple),
      rawTap: tapTuple,
      rawHold: holdTuple
    });
  }
  return entries;
}

/**
 * Serializes MT entries into 256-byte buffer (CMD 165).
 * Preserves 64 reserved bytes (192..255) from existing buffer.
 * Rejects recursive advanced tuples.
 *
 * @param {Array<Object>|Object} entries
 * @param {Buffer} [existingBuffer]
 * @returns {Buffer} 256-byte buffer
 */
function requireExactTuple3(value, label) {
  let bytes;
  if (Array.isArray(value)) {
    if (value.length !== 3) {
      throw new TypeError(`${label} must be an exact 3-byte tuple`);
    }
    bytes = [value[0], value[1], value[2]];
  } else if (value && typeof value === 'object') {
    bytes = [value.type, value.code1, value.code2];
  } else {
    throw new TypeError(`${label} must be an exact 3-byte tuple`);
  }
  for (let i = 0; i < 3; i++) {
    if (!Number.isInteger(bytes[i]) || bytes[i] < 0 || bytes[i] > 255) {
      throw new TypeError(`Invalid ${label} byte ${i}: ${bytes[i]}. Must be integer 0..255 (no masking)`);
    }
  }
  if (bytes[0] >= 145 && bytes[0] <= 149) {
    throw new TypeError(`Recursive advanced tuple ${bytes[0]} not allowed in ${label}`);
  }
  return bytes;
}

function serializeMtTable(entries, existingBuffer = null) {
  const buffer = Buffer.alloc(MT_TABLE_SIZE, 0);
  if (existingBuffer && existingBuffer.length >= MT_TABLE_SIZE) {
    existingBuffer.copy(buffer, 0, 0, MT_TABLE_SIZE);
  }

  const entriesList = Array.isArray(entries) ? entries : Object.values(entries || {});
  for (const entry of entriesList) {
    if (!entry) continue;
    const idx = entry.index !== undefined ? entry.index : entry.id;
    if (!Number.isInteger(idx) || idx < 0 || idx >= MT_ENTRIES_COUNT) {
      throw new RangeError(`Invalid MT table index: ${idx}. Must be integer 0..${MT_ENTRIES_COUNT - 1}`);
    }

    const tapSource = entry.rawTap !== undefined ? entry.rawTap : entry.tapKey;
    const holdSource = entry.rawHold !== undefined ? entry.rawHold : entry.holdKey;
    const tapTuple = requireExactTuple3(tapSource, `MT entry ${idx} tapKey`);
    const holdTuple = requireExactTuple3(holdSource, `MT entry ${idx} holdKey`);

    const off = idx * MT_ENTRY_SIZE;
    buffer[off] = tapTuple[0];
    buffer[off + 1] = tapTuple[1];
    buffer[off + 2] = tapTuple[2];
    buffer[off + 3] = holdTuple[0];
    buffer[off + 4] = holdTuple[1];
    buffer[off + 5] = holdTuple[2];
  }

  return buffer;
}

// TGL (Toggle) Table Constants
const TGL_TABLE_SIZE = 128;
const TGL_ENTRIES_COUNT = 32;
const TGL_ENTRY_SIZE = 3;
const TGL_RESERVED_OFFSET = 96;
const TGL_RESERVED_SIZE = 32;

/**
 * Parses TGL (Toggle) table (CMD 166)
 * 128-byte payload containing 32 entries (each 3 bytes: 3B target key tuple).
 * Remaining 32 bytes (96..127) are reserved.
 *
 * @param {Buffer|Uint8Array} data
 * @returns {Array<Object>} 32 TGL entries
 */
function parseTglTable(data) {
  if (!data || data.length < TGL_TABLE_SIZE) {
    throw new Error(`parseTglTable requires complete ${TGL_TABLE_SIZE}-byte buffer`);
  }
  const entries = [];
  for (let i = 0; i < TGL_ENTRIES_COUNT; i++) {
    const off = i * TGL_ENTRY_SIZE;
    const targetTuple = [data[off], data[off + 1], data[off + 2]];
    entries.push({
      index: i,
      targetKey: decodeKeyTuple(targetTuple),
      rawTarget: targetTuple
    });
  }
  return entries;
}

/**
 * Serializes TGL entries into 128-byte buffer (CMD 167).
 * Preserves 32 reserved bytes (96..127) from existing buffer.
 * Rejects recursive advanced tuples.
 *
 * @param {Array<Object>|Object} entries
 * @param {Buffer} [existingBuffer]
 * @returns {Buffer} 128-byte buffer
 */
function serializeTglTable(entries, existingBuffer = null) {
  const buffer = Buffer.alloc(TGL_TABLE_SIZE, 0);
  if (existingBuffer && existingBuffer.length >= TGL_TABLE_SIZE) {
    existingBuffer.copy(buffer, 0, 0, TGL_TABLE_SIZE);
  }

  const entriesList = Array.isArray(entries) ? entries : Object.values(entries || {});
  for (const entry of entriesList) {
    if (!entry) continue;
    const idx = entry.index !== undefined ? entry.index : entry.id;
    if (!Number.isInteger(idx) || idx < 0 || idx >= TGL_ENTRIES_COUNT) {
      throw new RangeError(`Invalid TGL table index: ${idx}. Must be integer 0..${TGL_ENTRIES_COUNT - 1}`);
    }

    const targetSource = entry.rawTarget !== undefined ? entry.rawTarget : entry.targetKey;
    const targetTuple = requireExactTuple3(targetSource, `TGL entry ${idx} targetKey`);

    const off = idx * TGL_ENTRY_SIZE;
    buffer[off] = targetTuple[0];
    buffer[off + 1] = targetTuple[1];
    buffer[off + 2] = targetTuple[2];
  }

  return buffer;
}

// Key Extras (Trigger / SOCD) Constants
const KEY_EXTRAS_SIZE = 1024;
const KEY_EXTRAS_ENTRIES_COUNT = 128;
const KEY_EXTRAS_ENTRY_SIZE = 8;

/**
 * Parses Key Extras region (CMD 160)
 * 1024-byte payload containing 128 entries (8 bytes each).
 * High nibble of byte 1 is SOCD priority (0..3).
 *
 * @param {Buffer|Uint8Array} data
 * @returns {Array<Object>} 128 key extras entries
 */
function parseKeyExtras(data) {
  if (!data || data.length < KEY_EXTRAS_SIZE) {
    throw new Error(`parseKeyExtras requires complete ${KEY_EXTRAS_SIZE}-byte buffer`);
  }
  const entries = [];
  for (let i = 0; i < KEY_EXTRAS_ENTRIES_COUNT; i++) {
    const off = i * KEY_EXTRAS_ENTRY_SIZE;
    const switchType = data[off];
    const byte1 = data[off + 1];
    const priority = (byte1 >> 4) & 0x0F;
    const keyMode = byte1 & 0x0F;
    entries.push({
      slot: i,
      switchType,
      priority,
      keyMode,
      raw: Buffer.from(data.subarray(off, off + KEY_EXTRAS_ENTRY_SIZE))
    });
  }
  return entries;
}

/**
 * Mutates SOCD priority for a key slot in a 1024-byte Key Extras buffer.
 * Preserves low nibble of byte 1 and ALL other 7 bytes strictly.
 *
 * @param {Buffer} existingBuffer - Complete 1024-byte prior buffer
 * @param {number} slot - Matrix slot (0..127)
 * @param {number} priority - SOCD priority (0..3)
 * @returns {Buffer} Mutated 1024-byte buffer
 */
function mutateKeyExtrasPriority(existingBuffer, slot, priority) {
  if (!existingBuffer || existingBuffer.length < KEY_EXTRAS_SIZE) {
    throw new Error(`mutateKeyExtrasPriority requires complete ${KEY_EXTRAS_SIZE}-byte prior buffer`);
  }
  if (!Number.isInteger(slot) || slot < 0 || slot >= KEY_EXTRAS_ENTRIES_COUNT) {
    throw new RangeError(`Invalid slot ${slot} for key extras. Must be 0..${KEY_EXTRAS_ENTRIES_COUNT - 1}`);
  }
  if (!Number.isInteger(priority) || priority < 0 || priority > 3) {
    throw new RangeError(`Invalid SOCD priority ${priority}. Must be integer 0..3`);
  }

  const buffer = Buffer.alloc(KEY_EXTRAS_SIZE);
  existingBuffer.copy(buffer);

  const off = slot * KEY_EXTRAS_ENTRY_SIZE + 1;
  const existingByte1 = buffer[off];
  buffer[off] = ((priority & 0x0F) << 4) | (existingByte1 & 0x0F);

  return buffer;
}

const CUSTOM_PARAM_SIZE = 1024;
const CB_CUSTOM_PARAM_OFFSET = 280;
const CB_CUSTOM_PARAM_LENGTH = 56;
const CB_CUSTOM_PARAM_LAYER_LEN_MAX = 40;

function cbCustomParamOffset(profileIndex) {
  if (!Number.isInteger(profileIndex) || profileIndex < 0 || profileIndex > 3) {
    throw new RangeError(`Invalid profile index ${profileIndex} for customParam`);
  }
  return profileIndex * CUSTOM_PARAM_SIZE + CB_CUSTOM_PARAM_OFFSET;
}

function emptyCbKeyIndexList() {
  return [[], [], [], []];
}

function parseCbCustomParam(data) {
  if (!data || data.length < CB_CUSTOM_PARAM_LENGTH) {
    return {
      ok: false,
      error: `parseCbCustomParam requires complete ${CB_CUSTOM_PARAM_LENGTH}-byte buffer`,
      cbKeyIndexList: emptyCbKeyIndexList()
    };
  }
  const raw = Buffer.from(data.subarray(0, CB_CUSTOM_PARAM_LENGTH));
  const lists = emptyCbKeyIndexList();
  const takeStrict = (offset) => {
    if (offset >= CB_CUSTOM_PARAM_LENGTH) {
      return { ok: false, error: 'cbKeyIndexList is truncated' };
    }
    const len = raw[offset];
    if (len >= CB_CUSTOM_PARAM_LAYER_LEN_MAX) {
      return { ok: false, error: `cbKeyIndexList length ${len} must be < ${CB_CUSTOM_PARAM_LAYER_LEN_MAX}` };
    }
    if (offset + 1 + len > CB_CUSTOM_PARAM_LENGTH) {
      return { ok: false, error: 'cbKeyIndexList row extends past the 56-byte region' };
    }
    return {
      ok: true,
      row: Array.from(raw.subarray(offset + 1, offset + 1 + len)),
      next: offset + 1 + len
    };
  };

  let encodedEnd = 4;
  let encoding = 'marked';
  if (raw[3] === 255) {
    let cursor = 4;
    for (let layer = 0; layer < 4; layer++) {
      const got = takeStrict(cursor);
      if (!got.ok) {
        return {
          ok: false,
          error: got.error,
          cbKeyIndexList: emptyCbKeyIndexList(),
          raw,
          rtPressPrecisionMode: raw[0],
          rtReleasePrecisionMode: raw[1],
          rtSmartCacheValue: raw[2]
        };
      }
      lists[layer] = got.row;
      cursor = got.next;
    }
    encodedEnd = cursor;
  } else {
    encoding = 'legacy';
    const got = takeStrict(3);
    if (!got.ok) {
      return {
        ok: false,
        error: got.error,
        cbKeyIndexList: emptyCbKeyIndexList(),
        raw,
        rtPressPrecisionMode: raw[0],
        rtReleasePrecisionMode: raw[1],
        rtSmartCacheValue: raw[2]
      };
    }
    lists[0] = got.row;
    encodedEnd = got.next;
  }

  return {
    ok: true,
    encoding,
    rtPressPrecisionMode: raw[0],
    rtReleasePrecisionMode: raw[1],
    rtSmartCacheValue: raw[2],
    cbKeyIndexList: lists,
    encodedEnd,
    raw
  };
}

function serializeCbCustomParam(param, existingBuffer) {
  if (!param || typeof param !== 'object') {
    throw new Error('serializeCbCustomParam requires a customParam object');
  }
  if (param.ok === false) {
    throw new Error(param.error || 'Refusing to serialize malformed customParam');
  }
  const existing = existingBuffer && existingBuffer.length >= CB_CUSTOM_PARAM_LENGTH
    ? Buffer.from(existingBuffer.subarray(0, CB_CUSTOM_PARAM_LENGTH))
    : (param.raw && param.raw.length >= CB_CUSTOM_PARAM_LENGTH
      ? Buffer.from(param.raw.subarray(0, CB_CUSTOM_PARAM_LENGTH))
      : Buffer.alloc(CB_CUSTOM_PARAM_LENGTH, 0));
  const nested = Array.isArray(param.cbKeyIndexList) && Array.isArray(param.cbKeyIndexList[0]);
  const lists = nested
    ? param.cbKeyIndexList
    : emptyCbKeyIndexList().map((row, layer) => (layer === 0 && Array.isArray(param.cbKeyIndexList) ? param.cbKeyIndexList : row));
  const parts = [
    existing[0],
    existing[1],
    existing[2],
    255
  ];
  for (let layer = 0; layer < 4; layer++) {
    const row = Array.isArray(lists[layer])
      ? lists[layer].filter((slot) => Number.isInteger(slot) && slot >= 0 && slot <= 255)
      : [];
    if (row.length >= CB_CUSTOM_PARAM_LAYER_LEN_MAX) {
      throw new Error(`cbKeyIndexList layer ${layer} length ${row.length} must be < ${CB_CUSTOM_PARAM_LAYER_LEN_MAX}`);
    }
    parts.push(row.length, ...row);
  }
  if (parts.length > CB_CUSTOM_PARAM_LENGTH) {
    throw new Error(`cbKeyIndexList does not fit the ${CB_CUSTOM_PARAM_LENGTH}-byte customParam region`);
  }
  const buf = Buffer.from(existing);
  for (let i = 0; i < parts.length; i++) buf[i] = parts[i];
  return buf;
}

function buffersEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Mutates Base buffer to enable up to 4 onboard profiles.
 * Preserves active profile, profile order, and all marker bytes 6..55.
 *
 * @param {Buffer} originalBuffer - Complete 56-byte prior buffer
 * @param {number} [newCount=4] - Number of enabled profiles (1..4)
 * @returns {Buffer} Mutated 56-byte buffer
 */
function enableProfileCount(originalBuffer, newCount = 4) {
  if (!originalBuffer || originalBuffer.length < 56) {
    throw new Error('enableProfileCount requires complete 56-byte prior buffer');
  }
  const parsed = parseBase(originalBuffer);
  if (!parsed) {
    throw new Error('enableProfileCount rejected malformed base buffer');
  }
  if (!Number.isInteger(newCount) || newCount < 1 || newCount > MAX_KEYBOARD_PROFILES) {
    throw new RangeError(`Invalid profile count: ${newCount}. Must be 1..${MAX_KEYBOARD_PROFILES}`);
  }
  if (newCount < parsed.profileCount) {
    const stillEnabled = parsed.profileOrder.slice(0, newCount);
    if (!stillEnabled.includes(parsed.activeProfile)) {
      throw new Error(`Cannot reduce profile count to ${newCount}: active profile ${parsed.activeProfile} would be disabled`);
    }
  }
  const buf = Buffer.from(originalBuffer);
  buf[1] = newCount;
  buf[0] = parsed.profileOrder.indexOf(parsed.activeProfile);
  return buf;
}

/**
 * Mutates base length, order, and active profile. Preserves marker bytes 6..55.
 * Used slots occupy order[0..length). Unused slots follow. Does not claim
 * that earlier hardware profile writes roll back if this packet fails.
 */
function mutateBaseConfig(originalBuffer, spec = {}) {
  if (!originalBuffer || originalBuffer.length < 56) {
    throw new Error('mutateBaseConfig requires complete 56-byte prior buffer');
  }
  const parsed = parseBase(originalBuffer);
  if (!parsed) {
    throw new Error('mutateBaseConfig rejected malformed base buffer');
  }
  const order = Array.isArray(spec.profileOrder) ? spec.profileOrder.slice() : parsed.profileOrder.slice();
  if (order.length !== MAX_KEYBOARD_PROFILES) {
    throw new Error('profileOrder must contain 4 unique physical indexes');
  }
  const seen = new Set();
  for (const p of order) {
    if (!Number.isInteger(p) || p < 0 || p >= MAX_KEYBOARD_PROFILES || seen.has(p)) {
      throw new Error(`Invalid profile order: [${order.join(', ')}]`);
    }
    seen.add(p);
  }
  const newCount = spec.profileCount !== undefined ? spec.profileCount : parsed.profileCount;
  if (!Number.isInteger(newCount) || newCount < 1 || newCount > MAX_KEYBOARD_PROFILES) {
    throw new RangeError(`Invalid profile count: ${newCount}`);
  }
  const activeProfile = spec.activeProfile !== undefined ? spec.activeProfile : parsed.activeProfile;
  const slot = order.slice(0, newCount).indexOf(activeProfile);
  if (slot === -1) {
    throw new Error(`Active profile ${activeProfile} is not in the enabled order prefix`);
  }
  const buf = Buffer.from(originalBuffer);
  buf[0] = slot;
  buf[1] = newCount;
  buf[2] = order[0];
  buf[3] = order[1];
  buf[4] = order[2];
  buf[5] = order[3];
  return buf;
}

function userLayerOffset(profileIndex, layer) {
  return (profileIndex * MAX_LAYERS + layer) * TOTAL_KEY_AREA_SIZE;
}

function readSlotTuple(layerBuffer, slot) {
  const off = slot * 3;
  if (!layerBuffer || off + 2 >= layerBuffer.length) {
    return null;
  }
  return [layerBuffer[off], layerBuffer[off + 1], layerBuffer[off + 2]];
}

function bumpCount(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

function addOwner(map, key, owner) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(owner);
}

/**
 * Scan 4 layer buffers (384 bytes each) for advanced table references.
 * Types 145 occupy the TGL table; 146/148 occupy the MT table; unknown 147/149 occupy both.
 * Counts/owners let callers reuse an index only when no remaining binding still points at it.
 */
function collectAdvancedReferences(layerBuffers) {
  const mt = new Set();
  const tgl = new Set();
  const mtCounts = new Map();
  const tglCounts = new Map();
  const mtOwners = new Map();
  const tglOwners = new Map();
  const socdByLayer = [];
  const list = Array.isArray(layerBuffers) ? layerBuffers : [];
  for (let l = 0; l < 4; l++) {
    const data = list[l];
    const socd = [];
    if (data && data.length >= 3) {
      const count = Math.floor(data.length / 3);
      for (let slot = 0; slot < count; slot++) {
        const off = slot * 3;
        const type = data[off];
        const code1 = data[off + 1];
        const code2 = data[off + 2];
        const owner = { layer: l, slot, type, code1, code2 };
        if (type === KEY_TYPES.TGL) {
          tgl.add(code1);
          bumpCount(tglCounts, code1);
          addOwner(tglOwners, code1, owner);
        } else if (type === KEY_TYPES.MT) {
          mt.add(code1);
          bumpCount(mtCounts, code1);
          addOwner(mtOwners, code1, owner);
        } else if (type === KEY_TYPES.SOCD) {
          mt.add(code1);
          bumpCount(mtCounts, code1);
          addOwner(mtOwners, code1, owner);
          socd.push({ slot, tableIndex: code1, partnerSlot: code2 });
        } else if (type === 147 || type === 149) {
          mt.add(code1);
          tgl.add(code1);
          bumpCount(mtCounts, code1);
          bumpCount(tglCounts, code1);
          addOwner(mtOwners, code1, owner);
          addOwner(tglOwners, code1, owner);
        }
      }
    }
    socdByLayer.push(socd);
  }
  return { mt, tgl, mtCounts, tglCounts, mtOwners, tglOwners, socdByLayer };
}

function copyLayerBuffers(layerBuffers) {
  return (Array.isArray(layerBuffers) ? layerBuffers : []).map((b) => (b ? Buffer.from(b) : Buffer.alloc(0)));
}

function clearBindingsOnCopies(layerBuffers, clears) {
  const copies = copyLayerBuffers(layerBuffers);
  for (const item of clears || []) {
    const lyr = item.layer;
    const sl = item.slot;
    if (!copies[lyr] || !Number.isInteger(sl)) continue;
    const off = sl * 3;
    if (off + 2 >= copies[lyr].length) continue;
    copies[lyr][off] = 0;
    copies[lyr][off + 1] = 0;
    copies[lyr][off + 2] = 0;
  }
  return copies;
}

function referencesAfterClearing(layerBuffers, clears) {
  return collectAdvancedReferences(clearBindingsOnCopies(layerBuffers, clears));
}

function isReciprocalSocd(layerBuffer, slot) {
  const t = readSlotTuple(layerBuffer, slot);
  if (!t || t[0] !== KEY_TYPES.SOCD) return false;
  const partner = t[2];
  if (!Number.isInteger(partner) || partner < 0 || partner === slot || partner * 3 + 2 >= layerBuffer.length) {
    return false;
  }
  const p = readSlotTuple(layerBuffer, partner);
  return Boolean(p && p[0] === KEY_TYPES.SOCD && p[2] === slot);
}

function preserveReservedTail(prepared, existing, reservedOffset) {
  const out = Buffer.from(prepared);
  if (existing && existing.length > reservedOffset && out.length > reservedOffset) {
    existing.copy(out, reservedOffset, reservedOffset);
  }
  return out;
}

function tableSliceEqual(a, b, offset, length) {
  if (!a || !b || a.length < offset + length || b.length < offset + length) return false;
  for (let i = 0; i < length; i++) {
    if (a[offset + i] !== b[offset + i]) return false;
  }
  return true;
}

function allocateFreeIndices(usedSet, count, capacity = 32) {
  const free = [];
  for (let i = 0; i < capacity && free.length < count; i++) {
    if (!usedSet.has(i)) free.push(i);
  }
  if (free.length < count) return null;
  return free;
}

const WRITE_TO_READ_COMMAND = {
  [COMMANDS.SET_FUNC_CONFIG]: COMMANDS.GET_FUNC_CONFIG,
  [COMMANDS.SET_USER_KEY_MATRIX]: COMMANDS.GET_USER_KEY_MATRIX,
  [COMMANDS.SET_KEY_COLOR]: COMMANDS.GET_KEY_COLOR,
  [COMMANDS.SET_MACROS]: COMMANDS.GET_MACROS,
  [COMMANDS.SET_BASE]: COMMANDS.GET_BASE,
  [COMMANDS.SET_KEY_EXTRAS]: COMMANDS.GET_KEY_EXTRAS,
  [COMMANDS.SET_MT_KEYS]: COMMANDS.GET_MT_KEYS,
  [COMMANDS.SET_TGL_KEYS]: COMMANDS.GET_TGL_KEYS,
  [COMMANDS.SET_CUSTOM_PARAM]: COMMANDS.GET_CUSTOM_PARAM
};

module.exports = {
  REPORT_ID,
  REPORT_PAYLOAD_SIZE,
  WRITE_BUFFER_SIZE,
  CHUNK_SIZE,
  MAX_KEYBOARD_PROFILES,
  TOTAL_KEY_AREA_SIZE,
  USED_KEY_AREA_SIZE,
  MAX_LAYERS,
  MAX_MACRO_SLOTS,
  SHARED_MACRO_SIZE,
  MIN_MACRO_DELAY,
  KNOB_CODE,
  FN_CODE,
  COMMANDS,
  GET_CUSTOM_PARAM: COMMANDS.GET_CUSTOM_PARAM,
  SET_CUSTOM_PARAM: COMMANDS.SET_CUSTOM_PARAM,
  RESET_SCOPE_ALL,
  RESET_NOTIFICATION_TIMEOUT_MS,
  FLAG_REQUEST,
  FLAG_RESPONSE,
  KEY_TYPES,
  MODIFIER_MASKS,
  USAGE_TO_MODIFIER_MASK,
  CONSUMER_KEY_LABELS,
  KB_CONTROL_LABELS,
  MOUSE_BUTTON_LABELS,
  SYSTEM_CONTROL_LABELS,
  calculateChecksum,
  encodePacket,
  decodePacket,
  decodeResetNotification,
  resolveFactoryResetScopeByte,
  parseInfo,
  parseDeviceInfo: parseInfo,
  parseBase,
  mutateBase,
  enableProfileCount,
  mutateBaseConfig,
  rgbToHex,
  hexToRgb,
  parseFuncConfig,
  mutateLighting,
  mutateSettings,
  decodeKeyTuple,
  encodeKeyTuple,
  isHotKeyTuple,
  isNormalKeyTuple,
  isCBKeyTuple,
  mergeCBKey,
  parseKeyMatrix,
  parseKeyColors,
  serializeKeyColors,
  decodeMacroAction,
  encodeMacroAction,
  parseMacroRegion,
  serializeMacroRegion,
  getNormalizedBodyKey,
  calculateMacroBankBytes,
  // Advanced MT / TGL / Extras
  MT_TABLE_SIZE,
  MT_ENTRIES_COUNT,
  MT_ENTRY_SIZE,
  MT_RESERVED_OFFSET,
  MT_RESERVED_SIZE,
  parseMtTable,
  serializeMtTable,
  TGL_TABLE_SIZE,
  TGL_ENTRIES_COUNT,
  TGL_ENTRY_SIZE,
  TGL_RESERVED_OFFSET,
  TGL_RESERVED_SIZE,
  parseTglTable,
  serializeTglTable,
  KEY_EXTRAS_SIZE,
  KEY_EXTRAS_ENTRIES_COUNT,
  KEY_EXTRAS_ENTRY_SIZE,
  parseKeyExtras,
  mutateKeyExtrasPriority,
  CUSTOM_PARAM_SIZE,
  CB_CUSTOM_PARAM_OFFSET,
  CB_CUSTOM_PARAM_LENGTH,
  CB_CUSTOM_PARAM_LAYER_LEN_MAX,
  cbCustomParamOffset,
  emptyCbKeyIndexList,
  parseCbCustomParam,
  serializeCbCustomParam,
  buffersEqual,
  requireExactTuple3,
  userLayerOffset,
  readSlotTuple,
  collectAdvancedReferences,
  copyLayerBuffers,
  clearBindingsOnCopies,
  referencesAfterClearing,
  isReciprocalSocd,
  preserveReservedTail,
  tableSliceEqual,
  allocateFreeIndices,
  WRITE_TO_READ_COMMAND,
  SHORTCUT_CHORD_LABELS,
  CONSUMER_TUPLE_LABELS,
  LIGHTING_CONTROL_LABELS,
  buildStreamingPackets,
  validators: require('./schema-validators.cjs')
};
