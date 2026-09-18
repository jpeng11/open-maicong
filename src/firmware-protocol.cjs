'use strict';

const crypto = require('node:crypto');

// G75 V2 firmware protocol evidence is recorded in docs/FIRMWARE_PROTOCOL.md.
// This module intentionally has no HID, filesystem, network, or Electron code.

const REPORT_ID = 0;
const REPORT_PAYLOAD_SIZE = 64;
const WRITE_BUFFER_SIZE = REPORT_PAYLOAD_SIZE + 1;
const FIRMWARE_CHUNK_SIZE = 32;
const VENDOR_ID = 0x3837;

const NORMAL_USAGE_PAGE = 0x0001;
const NORMAL_USAGE = 0x0000;
const CONTROL_INTERFACE = 1;
const BOOT_USAGE_PAGE = 0xFF00;
const BOOT_USAGE = 0x0001;

const NORMAL_PIDS = Object.freeze({
  WIRED_KEYBOARD: 0x2021,
  WIRELESS_RECEIVER: 0x3033
});

const BOOT_PIDS = Object.freeze({
  WIRED_KEYBOARD: 0x2022,
  WIRELESS_RECEIVER: 0x2010
});

const OPCODES = Object.freeze({
  ENTER_BOOT: 0x5F,
  ERASE: 0x81,
  WRITE: 0x80,
  CHECK: 0x82,
  END: 0x83,
  SUCCESS: 0x84
});

const ENTER_BOOT_PAYLOAD = Object.freeze([
  0x5F, 0x06, 0x00, 0x52, 0x01, 0x00, 0x00, 0x00, 0x51, 0x00, 0xAA, 0xBB
]);

const OFFICIAL_CATALOG = Object.freeze({
  keyboard: Object.freeze({
    key: 'keyboard',
    id: 'g75-v2-wired-keyboard',
    kind: 'keyboard',
    transport: 'wired-usb',
    normal: Object.freeze({
      vendorId: VENDOR_ID,
      productId: NORMAL_PIDS.WIRED_KEYBOARD,
      interface: CONTROL_INTERFACE,
      usagePage: NORMAL_USAGE_PAGE,
      usage: NORMAL_USAGE
    }),
    boot: Object.freeze({
      vendorId: VENDOR_ID,
      productId: BOOT_PIDS.WIRED_KEYBOARD,
      usagePage: BOOT_USAGE_PAGE,
      usage: BOOT_USAGE
    }),
    package: Object.freeze({
      fileName: 'update_G75V2.e824620b_dca8d0990778.bin',
      url: 'https://cdn.mchose.com.cn/configCenter/static/binaries/update_G75V2.e824620b_dca8d0990778.bin',
      size: 264408,
      sha256: 'b6b2a6abc0a682b3511049789d70c646268491c11aa65f0700120c42805b43f1',
      version: '1.14',
      versionNumber: 114,
      // Exact wire value the post-update version gate compares against:
      // versionNumber 114 means vendor fwVersion114 / wire 0x0114, never
      // decimal 114.
      versionRaw: 0x0114,
      versionSource: 'official-catalog',
      firmwareField: 'firmwareVersion'
    })
  }),
  receiver: Object.freeze({
    key: 'receiver',
    id: 'g75-v2-wireless-receiver',
    kind: 'receiver',
    transport: 'wireless-receiver-usb',
    normal: Object.freeze({
      vendorId: VENDOR_ID,
      productId: NORMAL_PIDS.WIRELESS_RECEIVER,
      interface: CONTROL_INTERFACE,
      usagePage: NORMAL_USAGE_PAGE,
      usage: NORMAL_USAGE
    }),
    boot: Object.freeze({
      vendorId: VENDOR_ID,
      productId: BOOT_PIDS.WIRELESS_RECEIVER,
      usagePage: BOOT_USAGE_PAGE,
      usage: BOOT_USAGE
    }),
    package: Object.freeze({
      fileName: 'update_G75V2_RF.e553557a_d8d9002e3131.bin',
      url: 'https://cdn.mchose.com.cn/configCenter/static/binaries/update_G75V2_RF.e553557a_d8d9002e3131.bin',
      size: 121032,
      sha256: '06fc8728f1b098e08386f18950ee4f8db8b4de0d3cd1adce285989c4d568e5fb',
      version: '1.30',
      versionNumber: 130,
      versionRaw: 0x0130,
      versionSource: 'official-catalog',
      firmwareField: 'rfFirmwareVersion'
    })
  })
});

function isByte(value) {
  return Number.isInteger(value) && value >= 0 && value <= 0xFF;
}

function toBuffer(value, name = 'bytes') {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (Array.isArray(value)) {
    if (!value.every(isByte)) throw new TypeError(`${name} must contain only uint8 values`);
    return Buffer.from(value);
  }
  throw new TypeError(`${name} must be a Buffer, Uint8Array, or byte array`);
}

function buildReport(payload) {
  const bytes = toBuffer(payload, 'report payload');
  if (bytes.length > REPORT_PAYLOAD_SIZE) {
    throw new RangeError(`Raw firmware report payload must be at most ${REPORT_PAYLOAD_SIZE} bytes`);
  }
  const report = Buffer.alloc(WRITE_BUFFER_SIZE, 0);
  report[0] = REPORT_ID;
  bytes.copy(report, 1);
  return report;
}

function buildEnterBootPacket() {
  return buildReport(ENTER_BOOT_PAYLOAD);
}

function normalizeEraseArgs(input, maybeProductId) {
  if (typeof input === 'number') {
    return { vendorId: input, productId: maybeProductId };
  }
  const spec = input && typeof input === 'object' ? input : {};
  const boot = spec.boot && typeof spec.boot === 'object' ? spec.boot : null;
  return {
    vendorId: spec.vendorId ?? spec.vid ?? (boot && (boot.vendorId ?? boot.vid)),
    productId: spec.productId ?? spec.pid ?? (boot && (boot.productId ?? boot.pid))
  };
}

function buildErasePacket(input, maybeProductId) {
  const { vendorId, productId } = normalizeEraseArgs(input, maybeProductId);
  if (vendorId !== VENDOR_ID) {
    throw new RangeError(`Unsupported boot vendor ID for G75 V2 erase: ${vendorId}`);
  }
  if (!Object.values(BOOT_PIDS).includes(productId)) {
    throw new RangeError(`Erase requires an exact G75 V2 boot product ID, got ${productId}`);
  }
  return buildReport([
    OPCODES.ERASE,
    0x07,
    vendorId & 0xFF,
    (vendorId >>> 8) & 0xFF,
    productId & 0xFF,
    (productId >>> 8) & 0xFF,
    0x00
  ]);
}

function buildChunkPacket(opcode, offset, chunk) {
  if (opcode !== OPCODES.WRITE && opcode !== OPCODES.CHECK) {
    throw new TypeError(`Firmware chunk opcode must be WRITE or CHECK, got ${opcode}`);
  }
  if (!Number.isInteger(offset) || offset < 0 || offset > 0xFFFFFFFF) {
    throw new RangeError(`Firmware offset must be an unsigned 32-bit integer, got ${offset}`);
  }
  const data = toBuffer(chunk, 'firmware chunk');
  if (data.length < 1 || data.length > FIRMWARE_CHUNK_SIZE) {
    throw new RangeError(`Firmware chunks must contain 1..${FIRMWARE_CHUNK_SIZE} bytes`);
  }
  if (offset + data.length > 0x100000000) {
    throw new RangeError('Firmware chunk offset plus length exceeds uint32 range');
  }
  return buildReport([
    opcode,
    data.length,
    offset & 0xFF,
    (offset >>> 8) & 0xFF,
    (offset >>> 16) & 0xFF,
    (offset >>> 24) & 0xFF,
    ...data
  ]);
}

function buildWriteChunkPacket(offset, chunk) {
  return buildChunkPacket(OPCODES.WRITE, offset, chunk);
}

function buildCheckChunkPacket(offset, chunk) {
  return buildChunkPacket(OPCODES.CHECK, offset, chunk);
}

function buildEndPacket() {
  return buildReport([OPCODES.END, 0x01, 0x00, 0x00, 0x00]);
}

function buildSuccessPacket() {
  return buildReport([OPCODES.SUCCESS, 0x01, 0x00, 0x00, 0x00]);
}

function responsePayload(raw) {
  const bytes = toBuffer(raw, 'firmware response');
  const offset = bytes.length === WRITE_BUFFER_SIZE && bytes[0] === REPORT_ID ? 1 : 0;
  return { bytes, offset, payload: bytes.subarray(offset) };
}

/**
 * Decode the vendor flag response. Boot responses do not echo an opcode or
 * offset. Only payload [0, 0] is success and [0, 1] is an explicit reject;
 * everything else is unrelated and must not satisfy a request.
 */
function decodeFlagResponse(raw) {
  const { bytes, offset, payload } = responsePayload(raw);
  if (payload.length < 2) {
    return { matched: false, reason: 'short-response', reportId: offset ? bytes[0] : null };
  }
  if (payload[0] !== 0x00) {
    return { matched: false, reason: 'nonzero-response-prefix', reportId: offset ? bytes[0] : null };
  }
  if (payload[1] === 0x00) {
    return {
      matched: true,
      success: true,
      rejected: false,
      receiveFlag: 0,
      reportId: offset ? bytes[0] : null
    };
  }
  if (payload[1] === 0x01) {
    return {
      matched: true,
      success: false,
      rejected: true,
      receiveFlag: 1,
      error: 'Bootloader rejected the firmware request',
      reportId: offset ? bytes[0] : null
    };
  }
  return {
    matched: false,
    reason: 'unsupported-receive-flag',
    receiveFlag: payload[1],
    reportId: offset ? bytes[0] : null
  };
}

// Test/mock-only response fixture. It is kept here so tests exercise the same
// report-shape decoder without needing a real bootloader response.
function buildFlagResponse(receiveFlag = 0, prefixed = false) {
  if (!Number.isInteger(receiveFlag) || receiveFlag < 0 || receiveFlag > 0xFF) {
    throw new RangeError(`receiveFlag must be a uint8, got ${receiveFlag}`);
  }
  const response = Buffer.alloc(prefixed ? WRITE_BUFFER_SIZE : REPORT_PAYLOAD_SIZE, 0);
  response[prefixed ? 1 : 0] = 0;
  response[prefixed ? 2 : 1] = receiveFlag;
  return response;
}

function catalogEntries(catalog = OFFICIAL_CATALOG) {
  if (Array.isArray(catalog)) return catalog.filter(Boolean);
  if (!catalog || typeof catalog !== 'object') return [];
  return Object.entries(catalog).map(([key, entry]) => {
    if (!entry || typeof entry !== 'object') return null;
    return entry.key ? entry : { ...entry, key };
  }).filter(Boolean);
}

function resolveTarget(targetRef, catalog = OFFICIAL_CATALOG) {
  const entries = catalogEntries(catalog);
  const refIds = targetRef && typeof targetRef === 'object'
    ? [targetRef.key, targetRef.id, targetRef.targetId, targetRef.kind]
    : typeof targetRef === 'string' ? [targetRef] : [];
  const usableRefs = new Set(refIds.filter(value => typeof value === 'string' && value.length > 0));
  if (usableRefs.size === 0) return null;

  // A manifest-shaped object is still only an untrusted reference. Resolve its
  // stable catalog key/id/kind and take the package manifest from `catalog`;
  // callers must not be able to make their own bytes/hash validation pass by
  // attaching a forged package object to the target reference.
  const matches = entries.filter(entry => [entry.key, entry.id, entry.targetId, entry.kind]
    .some(value => usableRefs.has(value)));
  return matches.length === 1 ? matches[0] : null;
}

function matchesNormalIdentity(identity, targetRef, catalog = OFFICIAL_CATALOG) {
  const target = resolveTarget(targetRef, catalog);
  if (!target || !identity || typeof identity !== 'object') return false;
  const expected = target.normal;
  const usage = identity.usage === undefined || identity.usage === null ? NORMAL_USAGE : identity.usage;
  return identity.vendorId === expected.vendorId
    && identity.productId === expected.productId
    && identity.interface === CONTROL_INTERFACE
    && identity.usagePage === expected.usagePage
    && usage === NORMAL_USAGE;
}

function matchesBootIdentity(identity, targetRef, catalog = OFFICIAL_CATALOG) {
  const target = resolveTarget(targetRef, catalog);
  if (!target || !identity || typeof identity !== 'object') return false;
  const expected = target.boot;
  return identity.vendorId === expected.vendorId
    && identity.productId === expected.productId
    && identity.usagePage === expected.usagePage
    && identity.usage === expected.usage;
}

function identifyNormalTarget(identity, catalog = OFFICIAL_CATALOG) {
  const matches = catalogEntries(catalog).filter(entry => matchesNormalIdentity(identity, entry, catalog));
  if (matches.length !== 1) {
    return {
      valid: false,
      ambiguous: matches.length > 1,
      error: matches.length === 0
        ? 'Normal HID identity is not an exact supported G75 V2 control interface'
        : 'Normal HID identity matches more than one firmware target'
    };
  }
  return { valid: true, target: matches[0] };
}

function normalizeString(value) {
  if (value === undefined || value === null) return null;
  const result = String(value).trim();
  return result ? result : null;
}

function normalizeTopologyNumber(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 && value <= 0xFFFFFFFF ? value : null;
  }
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text === '') return null;
  const isDecimal = /^[0-9]+$/.test(text);
  const isHex = /^0x[0-9a-f]+$/i.test(text);
  if (!isDecimal && !isHex) return null;
  let parsed;
  try {
    parsed = BigInt(text);
  } catch {
    return null;
  }
  return parsed >= 0n && parsed <= 0xFFFFFFFFn ? Number(parsed) : null;
}

// Exported as a named helper so topology adapters can apply the same strict
// parsing before using registry data. In particular, parseInt-style prefixes
// such as "123junk" are never accepted as topology evidence.
const parseTopologyNumber = normalizeTopologyNumber;

function stableUsbLocation(identity) {
  if (!identity || typeof identity !== 'object') return null;
  return normalizeTopologyNumber(
    identity.locationId ?? identity.locationID ?? identity.usbLocation ?? identity.usbLocationId
  );
}

function hasStableUsbLocation(identity) {
  return stableUsbLocation(identity) !== null;
}

/**
 * Same-device evidence for a bounded boot/normal transition. The USB
 * location is the stable topology anchor; a serial, when available on either
 * side, must also be present and equal. Registry entry IDs and enumeration
 * paths are intentionally not continuity evidence because they can change
 * when the device detaches and re-enumerates in another mode.
 */
function sameDeviceIdentity(left, right) {
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const serialLeft = normalizeString(left.serialNumber ?? left.serial);
  const serialRight = normalizeString(right.serialNumber ?? right.serial);
  if (serialLeft !== null || serialRight !== null) {
    if (serialLeft === null || serialRight === null || serialLeft !== serialRight) return false;
  }

  const locationLeft = stableUsbLocation(left);
  const locationRight = stableUsbLocation(right);
  if (locationLeft === null || locationRight === null) return false;
  return locationLeft === locationRight;
}

/**
 * Same-device evidence for a bounded normal<->boot transition. Bootloaders
 * commonly ship minimal descriptors without a serial string, so a serial
 * mismatch is only proven when BOTH sides expose one; otherwise the stable
 * USB location is the continuity anchor. The weaker binding is recorded
 * explicitly as serialEvidence so callers can surface it. Normal<->normal
 * comparisons that guard configuration writes keep using sameDeviceIdentity.
 */
function transitionIdentityEvidence(anchor, identity) {
  if (!anchor || !identity || typeof anchor !== 'object' || typeof identity !== 'object') {
    return { match: false, serialEvidence: 'none', reason: 'missing-identity' };
  }
  const locationAnchor = stableUsbLocation(anchor);
  const locationIdentity = stableUsbLocation(identity);
  if (locationAnchor === null || locationIdentity === null) {
    return { match: false, serialEvidence: 'none', reason: 'location-missing' };
  }
  if (locationAnchor !== locationIdentity) {
    return { match: false, serialEvidence: 'none', reason: 'location-mismatch' };
  }
  const serialAnchor = normalizeString(anchor.serialNumber ?? anchor.serial);
  const serialIdentity = normalizeString(identity.serialNumber ?? identity.serial);
  if (serialAnchor !== null && serialIdentity !== null) {
    return serialAnchor === serialIdentity
      ? { match: true, serialEvidence: 'both' }
      : { match: false, serialEvidence: 'both', reason: 'serial-mismatch' };
  }
  return { match: true, serialEvidence: 'location-only' };
}

function sameTransitionIdentity(anchor, identity) {
  return transitionIdentityEvidence(anchor, identity).match;
}

function sha256Hex(bytes) {
  return crypto.createHash('sha256').update(toBuffer(bytes, 'firmware package')).digest('hex');
}

function validateFirmwarePackage(bytes, targetRef, options = {}) {
  const catalog = options.catalog || OFFICIAL_CATALOG;
  const target = resolveTarget(targetRef, catalog);
  if (!target) {
    return { valid: false, error: 'Firmware target is not a known catalog identity' };
  }

  let data;
  try {
    data = toBuffer(bytes, 'firmware package');
  } catch (err) {
    return { valid: false, error: err.message };
  }

  const manifest = target.package;
  if (!manifest || !Number.isInteger(manifest.size) || typeof manifest.sha256 !== 'string') {
    return { valid: false, error: `Firmware target ${target.key || target.id} has no complete package manifest` };
  }
  if (data.length !== manifest.size) {
    return {
      valid: false,
      error: `Firmware package size mismatch: expected ${manifest.size} bytes, received ${data.length}`,
      expectedSize: manifest.size,
      receivedSize: data.length
    };
  }
  const digest = sha256Hex(data);
  if (digest !== manifest.sha256.toLowerCase()) {
    return {
      valid: false,
      error: `Firmware package SHA-256 mismatch: expected ${manifest.sha256}, received ${digest}`,
      expectedSha256: manifest.sha256,
      receivedSha256: digest
    };
  }

  return {
    valid: true,
    target,
    targetKey: target.key,
    targetId: target.id,
    targetKind: target.kind,
    transport: target.transport,
    version: manifest.version,
    versionNumber: manifest.versionNumber,
    versionRaw: Number.isInteger(manifest.versionRaw) ? manifest.versionRaw : null,
    versionSource: manifest.versionSource || 'catalog',
    fileName: manifest.fileName,
    size: data.length,
    sha256: digest,
    // The updater must transfer this exact buffer from offset zero. No header
    // stripping or version inference is performed here.
    fullFile: true,
    headerPreserved: true,
    bytes: data
  };
}

/**
 * The catalog pins the exact wire value as versionRaw (official catalog:
 * versionNumber 114 means vendor fwVersion114 / wire 0x0114, NOT decimal
 * 114). No decimal reinterpretation is permitted here: a device reporting
 * raw 0x0072 (displayed "0.72") must not satisfy a gate for catalog version
 * 1.14. A catalog without a pinned versionRaw falls back to treating
 * versionNumber itself as the wire value, which is what test fixtures do.
 */
function catalogVersionMatchesRaw(actualRaw, catalogPackage) {
  if (!Number.isInteger(actualRaw) || !catalogPackage || typeof catalogPackage !== 'object') return false;
  const expectedRaw = Number.isInteger(catalogPackage.versionRaw)
    ? catalogPackage.versionRaw
    : catalogPackage.versionNumber;
  return Number.isInteger(expectedRaw) && actualRaw === expectedRaw;
}

function packageReview(info) {
  if (!info || !info.valid) return null;
  return {
    targetKey: info.targetKey,
    targetId: info.targetId,
    targetKind: info.targetKind,
    transport: info.transport,
    version: info.version,
    versionNumber: info.versionNumber,
    versionRaw: Number.isInteger(info.versionRaw) ? info.versionRaw : null,
    versionSource: info.versionSource,
    fileName: info.fileName,
    size: info.size,
    sha256: info.sha256,
    fullFile: true,
    headerPreserved: true
  };
}

module.exports = {
  REPORT_ID,
  REPORT_PAYLOAD_SIZE,
  WRITE_BUFFER_SIZE,
  FIRMWARE_CHUNK_SIZE,
  VENDOR_ID,
  NORMAL_USAGE_PAGE,
  NORMAL_USAGE,
  CONTROL_INTERFACE,
  BOOT_USAGE_PAGE,
  BOOT_USAGE,
  NORMAL_PIDS,
  BOOT_PIDS,
  OPCODES,
  ENTER_BOOT_PAYLOAD,
  OFFICIAL_CATALOG,
  buildReport,
  buildEnterBootPacket,
  buildErasePacket,
  buildWriteChunkPacket,
  buildCheckChunkPacket,
  buildEndPacket,
  buildSuccessPacket,
  decodeFlagResponse,
  buildFlagResponse,
  catalogEntries,
  resolveTarget,
  matchesNormalIdentity,
  matchesBootIdentity,
  identifyNormalTarget,
  sameDeviceIdentity,
  transitionIdentityEvidence,
  sameTransitionIdentity,
  parseTopologyNumber,
  stableUsbLocation,
  hasStableUsbLocation,
  sha256Hex,
  validateFirmwarePackage,
  catalogVersionMatchesRaw,
  packageReview
};
