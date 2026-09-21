'use strict';

/**
 * Complete G75 V2 configuration backup/restore.
 *
 * This module deliberately owns no HID handle.  It consumes the existing
 * DeviceTransport readRange/writeRange transaction contract so a future
 * updater can suspend the normal transport before handing it this work.
 * Every region is read completely before a backup is accepted, and restore
 * prepares every write from complete post-firmware reads before dispatching
 * the first mutation.
 */

const fs = require('node:fs');
const path = require('node:path');
const { writeFileAtomicDurable } = require('./store-file.cjs');

const protocol = require('./protocol.cjs');
const firmwareIdentity = require('./firmware-protocol.cjs');
const profileNames = require('./profile-names.cjs');
const {
  G75_V2_KEYS,
  VALID_PHYSICAL_SLOTS,
  VALID_LIGHTING_SLOTS,
  ELIGIBLE_ADVANCED_SLOTS
} = require('./layout-g75v2.cjs');

const BACKUP_SCHEMA = 'maicong.g75v2.firmware-backup';
const BACKUP_SCHEMA_VERSION = 1;
const BACKUP_DATA_FORMAT = 'native-raw-v1';
const MAX_BACKUP_BYTES = 16 * 1024 * 1024;
const NORMAL_VENDOR_ID = firmwareIdentity.VENDOR_ID;
const NORMAL_PRODUCT_IDS = new Set(Object.values(firmwareIdentity.NORMAL_PIDS));
const IDENTITY_FIELDS = ['vendorId', 'productId', 'interface', 'usagePage', 'usage'];
const LIVE_FUNC_OFFSETS = new Set([32, 34]);

class FirmwareBackupError extends Error {
  constructor(message, section = null, extra = {}) {
    super(message);
    this.name = 'FirmwareBackupError';
    this.section = section;
    Object.assign(this, extra);
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toHex(buffer) {
  return Buffer.from(buffer).toString('hex');
}

function exactBuffer(value, length, label) {
  if (typeof value !== 'string' || value.length !== length * 2 || !/^[0-9a-f]+$/i.test(value)) {
    throw new FirmwareBackupError(`${label} must be an exact ${length}-byte hexadecimal buffer`, label);
  }
  return Buffer.from(value, 'hex');
}

function exactTuple(value, label) {
  if (!Array.isArray(value) || value.length !== 3 || value.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    throw new FirmwareBackupError(`${label} must be an exact 3-byte tuple`, label);
  }
  return value.slice();
}

function finiteTimestamp(value, label) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new FirmwareBackupError(`${label} must be a positive finite timestamp`, label);
  }
  return value;
}

function currentDeviceIdentity(transport, override = null) {
  const stateDevice = (transport && transport.lastState && transport.lastState.device) || {};
  const descriptor = (transport && transport.deviceInfo) || {};
  const topology = override
    || (transport && (transport.firmwareTopologyIdentity || transport.topologyIdentity))
    || {};
  // node-hid's public state omits some macOS topology fields. The open handle
  // descriptor remains authoritative for VID/PID/interface/path/serial; a
  // reviewed topology candidate contributes only LocationID/registry proof
  // after it agrees with that live descriptor. Never let cached topology
  // fields mask a changed current handle.
  const d = { ...stateDevice, ...descriptor };
  const serial = d.serialNumber != null ? d.serialNumber : d.serial;
  const liveIdentity = {
    vendorId: d.vendorId,
    productId: d.productId,
    interface: d.interface,
    usagePage: d.usagePage,
    usage: d.usage,
    serialNumber: serial == null || serial === '' ? null : String(serial),
    path: d.path == null || d.path === '' ? null : String(d.path),
    locationId: d.locationId == null || d.locationId === '' ? null : d.locationId,
    registryEntryId: d.registryEntryId == null ? null : d.registryEntryId,
    registryPath: d.registryPath == null || d.registryPath === '' ? null : String(d.registryPath)
  };
  let topologyConflict = false;
  const comparableFields = ['vendorId', 'productId', 'interface', 'usagePage', 'usage'];
  for (const field of comparableFields) {
    if (topology[field] !== undefined && topology[field] !== null
      && liveIdentity[field] !== undefined && liveIdentity[field] !== null) {
      const topologyValue = field === 'usage' && (topology[field] === undefined || topology[field] === null)
        ? firmwareIdentity.NORMAL_USAGE : topology[field];
      const liveValue = field === 'usage' && (liveIdentity[field] === undefined || liveIdentity[field] === null)
        ? firmwareIdentity.NORMAL_USAGE : liveIdentity[field];
      if (topologyValue !== liveValue) topologyConflict = true;
    }
  }
  const topologySerial = topology.serialNumber != null
    ? String(topology.serialNumber)
    : (topology.serial != null ? String(topology.serial) : null);
  if (liveIdentity.serialNumber && topologySerial && liveIdentity.serialNumber !== topologySerial) topologyConflict = true;
  const topologyPath = topology.path || topology.registryPath || null;
  if (liveIdentity.path && topologyPath && liveIdentity.path !== String(topologyPath)) topologyConflict = true;
  if (liveIdentity.registryPath && topology.registryPath && liveIdentity.registryPath !== String(topology.registryPath)) topologyConflict = true;

  const liveLocation = firmwareIdentity.stableUsbLocation(liveIdentity);
  const topologyLocation = firmwareIdentity.stableUsbLocation(topology);
  if (liveLocation !== null && topologyLocation !== null && liveLocation !== topologyLocation) topologyConflict = true;

  const result = {
    ...liveIdentity,
    // A registry-correlated serial may fill a descriptor omission, but it can
    // never replace a serial actually reported by the current handle.
    serialNumber: liveIdentity.serialNumber || topologySerial,
    locationId: liveLocation !== null ? liveIdentity.locationId : (topologyLocation !== null ? topologyLocation : liveIdentity.locationId),
    registryEntryId: liveIdentity.registryEntryId !== null ? liveIdentity.registryEntryId : (topology.registryEntryId ?? null),
    registryPath: liveIdentity.registryPath || (topology.registryPath == null ? null : String(topology.registryPath))
  };
  if (topologyConflict) result._topologyConflict = true;
  return result;
}

function validateNormalIdentity(identity, catalog = firmwareIdentity.OFFICIAL_CATALOG) {
  if (!isPlainObject(identity)) return { valid: false, error: 'Device identity is missing' };
  if (identity._topologyConflict) return { valid: false, error: 'Reviewed topology does not match the current HID handle identity' };
  const target = firmwareIdentity.identifyNormalTarget(identity, catalog);
  if (!target.valid) return { valid: false, error: target.error || 'Device identity is not an exact normal G75 V2 control interface' };
  if (!firmwareIdentity.hasStableUsbLocation(identity)) {
    return { valid: false, error: 'Device identity has no stable USB LocationID topology evidence' };
  }
  if (identity.serialNumber != null && typeof identity.serialNumber !== 'string') {
    return { valid: false, error: 'Device serial number is malformed' };
  }
  if (identity.path != null && typeof identity.path !== 'string') {
    return { valid: false, error: 'Device HID path is malformed' };
  }
  if (identity.locationId != null && firmwareIdentity.parseTopologyNumber(identity.locationId) === null) {
    return { valid: false, error: 'Device USB location is malformed' };
  }
  return { valid: true };
}

/**
 * Compare the stable part of the normal-device identity. A HID path and
 * registry entry can be recreated by macOS, so neither is continuity proof;
 * the reviewed LocationID is mandatory and the existing helper also checks
 * serial equality whenever either side exposes one.
 */
function identitiesMatch(expected, current) {
  const a = validateNormalIdentity(expected);
  const b = validateNormalIdentity(current);
  if (!a.valid || !b.valid) return false;
  for (const field of IDENTITY_FIELDS) {
    if (field === 'usage') {
      const expectedUsage = expected.usage === undefined || expected.usage === null
        ? firmwareIdentity.NORMAL_USAGE : expected.usage;
      const currentUsage = current.usage === undefined || current.usage === null
        ? firmwareIdentity.NORMAL_USAGE : current.usage;
      if (expectedUsage !== currentUsage) return false;
    } else if (expected[field] !== current[field]) {
      return false;
    }
  }
  // This is the reviewed normal/normal continuity helper used by the native
  // topology resolver. It intentionally ignores changing HID paths and
  // registry entry IDs, but requires the stable LocationID and any available
  // serial evidence on both sides.
  return firmwareIdentity.sameDeviceIdentity(expected, current);
}

function identityForStorage(identity) {
  return {
    vendorId: identity.vendorId,
    productId: identity.productId,
    interface: identity.interface,
    usagePage: identity.usagePage,
    usage: identity.usage,
    serialNumber: identity.serialNumber || null,
    path: identity.path || null,
    // LocationID 0 is a valid stable topology anchor; only absence is null.
    locationId: identity.locationId != null ? identity.locationId : null,
    registryEntryId: identity.registryEntryId || null,
    registryPath: identity.registryPath || null
  };
}

function safeProgress(options, update) {
  if (!options || typeof options.onProgress !== 'function') return;
  try {
    options.onProgress(Object.freeze({ ...update }));
  } catch {
    // Progress reporting cannot turn a completed device operation into an
    // unknown operation.
  }
}

function readTimeout(options, kind = 'read') {
  const value = options && (kind === 'write' ? options.writeTimeoutMs : options.readTimeoutMs);
  return Number.isInteger(value) && value > 0 ? value : (kind === 'write' ? 1500 : 1000);
}

function transportIsCurrent(transport, startGen, startEpoch, identity, topologyIdentity = null) {
  if (!transport || !transport.device || transport.generation !== startGen) return false;
  if (transport.resetEpoch !== startEpoch || transport.needsReconnect) return false;
  if (typeof transport._profileStillCurrent === 'function' && !transport._profileStillCurrent(startGen, startEpoch)) return false;
  return identitiesMatch(identity, currentDeviceIdentity(transport, topologyIdentity));
}

async function readRegion(transport, command, offset, length, guard, section, options) {
  if (!guard()) throw new FirmwareBackupError(`${section} read was invalidated before dispatch`, section);
  const result = await transport.readRange(
    command,
    offset,
    length,
    readTimeout(options),
    guard.startGen,
    options && options.ownerToken
  );
  if (!guard()) throw new FirmwareBackupError(`${section} read was invalidated by a device identity change`, section, { uncertain: false });
  if (!result || !result.success || !result.data || result.data.length !== length) {
    throw new FirmwareBackupError(`${section} read was incomplete: ${(result && result.error) || 'missing bytes'}`, section, { uncertain: false });
  }
  return Buffer.from(result.data);
}

function pickSettings(performance) {
  return {
    macMode: performance.macMode,
    reporteRate: performance.reporteRate,
    tickRate: performance.tickRate,
    deadZone: performance.deadZone,
    lockWin: performance.lockWin,
    lockAltTab: performance.lockAltTab,
    lockAltF4: performance.lockAltF4,
    debounceLevel: performance.debounceLevel,
    rollerType: performance.rollerType,
    sleepTime: performance.sleepTime,
    sleepMode: performance.sleepMode,
    rfChannel: performance.rfChannel,
    reportRate24G: performance.reportRate24G
  };
}

function makeFuncSemantic(raw, profileIndex) {
  const parsed = protocol.parseFuncConfig(raw);
  if (!parsed) throw new FirmwareBackupError(`Profile ${profileIndex} funcConfig is malformed`, `profile-${profileIndex}.funcConfig`);
  return {
    lighting: parsed.lighting,
    settings: pickSettings(parsed.performance),
    // This is evidence only; restore deliberately does not replay live bytes.
    capturedLive: {
      batteryLevel: parsed.performance.batteryLevel,
      isCharging: parsed.performance.isCharging,
      workMode: parsed.performance.workMode
    }
  };
}

function globalSlotCandidates() {
  // The vendor predicate is layout metadata `isGlobalKey === true`.  The
  // native G75 catalog currently declares no such slots; keeping the
  // predicate explicit makes the absence an auditable no-op rather than a
  // guessed list of key indexes.
  return G75_V2_KEYS
    .filter((entry) => entry && entry.isGlobalKey === true)
    .map((entry) => entry.slot)
    .filter((slot, index, all) => Number.isInteger(slot) && all.indexOf(slot) === index)
    .sort((a, b) => a - b);
}

function buildGlobals(profile, slots) {
  const keys = [];
  for (const index of slots) {
    const layers = profile.layers.map((layer) => {
      const offset = index * 3;
      return Array.from(layer.subarray(offset, offset + 3));
    });
    keys.push({ index, layers });
  }
  return {
    predicate: 'layout.isGlobalKey === true',
    evidence: 'g75-v2-layout-catalog',
    eligibleSlots: slots.slice(),
    keys
  };
}

async function captureInTransaction(transport, startGen, options) {
  const startEpoch = transport.resetEpoch;
  const identity = currentDeviceIdentity(transport, options.identity || options.topologyIdentity || null);
  const identityCheck = validateNormalIdentity(identity, options.catalog || firmwareIdentity.OFFICIAL_CATALOG);
  if (!identityCheck.valid) return { success: false, error: identityCheck.error, failedSection: 'identity' };
  const guard = () => transportIsCurrent(transport, startGen, startEpoch, identity, options.identity || options.topologyIdentity || null);
  guard.startGen = startGen;

  const completedSections = [];
  const read = async (command, offset, length, section) => {
    safeProgress(options, { phase: 'reading', section, completedSections: completedSections.slice() });
    const data = await readRegion(transport, command, offset, length, guard, section, options);
    completedSections.push(section);
    return data;
  };

  try {
    const infoRaw = await read(protocol.COMMANDS.GET_INFO, 0, 56, 'device-info');
    const info = protocol.parseInfo(infoRaw);
    if (!info) throw new FirmwareBackupError('Device-info payload could not be parsed', 'device-info');

    const baseRaw = await read(protocol.COMMANDS.GET_BASE, 0, 56, 'base');
    const base = protocol.parseBase(baseRaw);
    if (!base) throw new FirmwareBackupError('Base profile list is malformed', 'base');

    const defaults = [];
    for (let layer = 0; layer < protocol.MAX_LAYERS; layer++) {
      defaults.push(await read(
        protocol.COMMANDS.GET_DEFAULT_KEY_MATRIX,
        layer * protocol.TOTAL_KEY_AREA_SIZE,
        protocol.TOTAL_KEY_AREA_SIZE,
        `defaults.layer-${layer}`
      ));
    }

    const nameRegions = [];
    const featureRegions = [];
    for (let slot = 0; slot < protocol.MAX_KEYBOARD_PROFILES; slot++) {
      const namesRaw = await read(
        protocol.COMMANDS.GET_CUSTOM_PARAM,
        profileNames.namesOffset(slot),
        profileNames.PROFILE_NAMES_LENGTH,
        `profile-${slot}.names`
      );
      const decodedNames = profileNames.decodeProfileNames(namesRaw);
      if (!decodedNames.valid) throw new FirmwareBackupError(`Profile ${slot} names are malformed`, `profile-${slot}.names`);
      nameRegions.push({ slot, rawHex: toHex(namesRaw), stored: decodedNames.stored });

      const featureRaw = await read(
        protocol.COMMANDS.GET_CUSTOM_PARAM,
        profileNames.featureSupportOffset(slot),
        profileNames.FEATURE_SUPPORT_LENGTH,
        `profile-${slot}.feature-support`
      );
      const decodedFeature = profileNames.decodeFeatureSupport(featureRaw);
      if (!decodedFeature.valid) throw new FirmwareBackupError(`Profile ${slot} feature-support metadata is malformed`, `profile-${slot}.feature-support`);
      featureRegions.push({ slot, rawHex: toHex(featureRaw), support: decodedFeature.support });
    }

    const macrosRaw = await read(protocol.COMMANDS.GET_MACROS, 0, protocol.MACRO_READ_WINDOW_SIZE, 'shared-macros');
    let macros;
    try {
      macros = protocol.parseMacroRegion(macrosRaw);
    } catch (err) {
      throw new FirmwareBackupError(`Shared macro bank is malformed: ${err.message}`, 'shared-macros');
    }

    const profiles = [];
    for (let orderIndex = 0; orderIndex < base.profileCount; orderIndex++) {
      const profileIndex = base.profileOrder[orderIndex];
      const funcRaw = await read(
        protocol.COMMANDS.GET_FUNC_CONFIG,
        profileIndex * 64,
        64,
        `profile-${profileIndex}.funcConfig`
      );
      const semanticFunc = makeFuncSemantic(funcRaw, profileIndex);

      const layers = [];
      for (let layer = 0; layer < protocol.MAX_LAYERS; layer++) {
        layers.push(await read(
          protocol.COMMANDS.GET_USER_KEY_MATRIX,
          protocol.userLayerOffset(profileIndex, layer),
          protocol.TOTAL_KEY_AREA_SIZE,
          `profile-${profileIndex}.layer-${layer}`
        ));
      }

      const colorsRaw = await read(
        protocol.COMMANDS.GET_KEY_COLOR,
        profileIndex * protocol.TOTAL_KEY_AREA_SIZE,
        protocol.USED_KEY_AREA_SIZE,
        `profile-${profileIndex}.colors`
      );
      if (protocol.parseKeyColors(colorsRaw).length !== 128) {
        throw new FirmwareBackupError(`Profile ${profileIndex} color table is malformed`, `profile-${profileIndex}.colors`);
      }

      const mtRaw = await read(protocol.COMMANDS.GET_MT_KEYS, profileIndex * protocol.MT_TABLE_SIZE, protocol.MT_TABLE_SIZE, `profile-${profileIndex}.advanced.mt`);
      const tglRaw = await read(protocol.COMMANDS.GET_TGL_KEYS, profileIndex * protocol.TGL_TABLE_SIZE, protocol.TGL_TABLE_SIZE, `profile-${profileIndex}.advanced.tgl`);
      const extrasRaw = await read(protocol.COMMANDS.GET_KEY_EXTRAS, profileIndex * protocol.KEY_EXTRAS_SIZE, protocol.KEY_EXTRAS_SIZE, `profile-${profileIndex}.advanced.key-extras`);
      const customRaw = await read(protocol.COMMANDS.GET_CUSTOM_PARAM, protocol.cbCustomParamOffset(profileIndex), protocol.CB_CUSTOM_PARAM_LENGTH, `profile-${profileIndex}.advanced.custom-param`);

      let customParam;
      try {
        customParam = protocol.parseCbCustomParam(customRaw);
        if (!customParam.ok) throw new Error(customParam.error);
        protocol.parseMtTable(mtRaw);
        protocol.parseTglTable(tglRaw);
        protocol.parseKeyExtras(extrasRaw);
      } catch (err) {
        throw new FirmwareBackupError(`Profile ${profileIndex} advanced metadata is malformed: ${err.message}`, `profile-${profileIndex}.advanced`);
      }

      profiles.push({
        profileIndex,
        orderIndex,
        name: nameRegions[0].stored[profileIndex] || '',
        funcConfig: {
          rawHex: toHex(funcRaw),
          lighting: semanticFunc.lighting,
          settings: semanticFunc.settings,
          capturedLive: semanticFunc.capturedLive
        },
        layers: layers.map(toHex),
        colorsHex: toHex(colorsRaw),
        advanced: {
          mtHex: toHex(mtRaw),
          tglHex: toHex(tglRaw),
          keyExtrasHex: toHex(extrasRaw),
          customParamHex: toHex(customRaw),
          customParam: {
            rtPressPrecisionMode: customParam.rtPressPrecisionMode,
            rtReleasePrecisionMode: customParam.rtReleasePrecisionMode,
            rtSmartCacheValue: customParam.rtSmartCacheValue,
            cbKeyIndexList: customParam.cbKeyIndexList,
            encoding: customParam.encoding
          }
        }
      });
    }

    const activeProfile = profiles.find((profile) => profile.profileIndex === base.activeProfile);
    if (!activeProfile) throw new FirmwareBackupError('Active profile is absent from the enabled profile set', 'base');

    const backup = {
      schema: BACKUP_SCHEMA,
      schemaVersion: BACKUP_SCHEMA_VERSION,
      dataFormat: BACKUP_DATA_FORMAT,
      complete: true,
      savedAt: Date.now(),
      identity: identityForStorage(identity),
      deviceInfo: {
        rawHex: toHex(infoRaw),
        firmwareVersion: info.firmwareVersion,
        rawFirmwareVersion: info.rawFirmwareVersion,
        rfFirmwareVersion: info.rfFirmwareVersion,
        rawRfFirmwareVersion: info.rawRfFirmwareVersion,
        buildDate: info.buildDate,
        dongleInfo: info.dongleInfo
      },
      base: {
        rawHex: toHex(baseRaw),
        activeSlot: base.activeSlot,
        activeProfile: base.activeProfile,
        profileLength: base.profileCount,
        profileOrder: base.profileOrder.slice()
      },
      defaults: {
        layers: defaults.map(toHex)
      },
      names: {
        stored: nameRegions[0].stored.slice(),
        regions: nameRegions
      },
      featureSupport: featureRegions,
      macros: {
        rawHex: toHex(macrosRaw),
        slots: macros
      },
      globals: buildGlobals(activeProfile, globalSlotCandidates()),
      profiles,
      restoration: {
        status: 'captured',
        verifiedAt: null
      }
    };

    const validated = validateFirmwareBackup(backup);
    if (!validated.valid) throw new FirmwareBackupError(validated.error, 'backup');
    return { success: true, backup, completedSections };
  } catch (err) {
    return {
      success: false,
      error: err.message || String(err),
      failedSection: err.section || null,
      completedSections,
      uncertain: Boolean(err.uncertain),
      partial: {
        schema: BACKUP_SCHEMA,
        schemaVersion: BACKUP_SCHEMA_VERSION,
        dataFormat: BACKUP_DATA_FORMAT,
        complete: false,
        savedAt: Date.now(),
        identity: identityForStorage(identity),
        completedSections: completedSections.slice(),
        failedSection: err.section || null
      }
    };
  }
}

function preparePerformance(func, settings, profileIndex) {
  const out = protocol.mutateSettings(protocol.mutateLighting(func, settings.lighting || {}), settings.performance || {}, profileIndex);
  const p = settings.performance || {};
  if (settings.lighting && settings.lighting.colorIndex !== undefined) out[13] = settings.lighting.colorIndex & 0xFF;
  if (p.tickRate !== undefined) out[4] = (out[4] & 0x0F) | ((p.tickRate & 0x0F) << 4);
  if (p.deadZone !== undefined) out[5] = p.deadZone & 0xFF;
  if (p.lockAltTab !== undefined) out[6] = (out[6] & 0xFD) | (p.lockAltTab ? 0x02 : 0);
  if (p.lockAltF4 !== undefined) out[6] = (out[6] & 0xFB) | (p.lockAltF4 ? 0x04 : 0);
  if (p.rfChannel !== undefined) out[37] = p.rfChannel & 0xFF;
  if (p.reportRate24G !== undefined) out[38] = p.reportRate24G & 0xFF;
  return out;
}

function migrateLayer(captured, current, oldDefault, newDefault) {
  if (captured.length !== protocol.TOTAL_KEY_AREA_SIZE
    || current.length !== protocol.TOTAL_KEY_AREA_SIZE
    || oldDefault.length !== protocol.TOTAL_KEY_AREA_SIZE
    || newDefault.length !== protocol.TOTAL_KEY_AREA_SIZE) {
    throw new FirmwareBackupError('Layer migration requires complete 512-byte user/default buffers', 'layer');
  }
  const out = Buffer.from(current);
  // The first 384 bytes contain 128 tuple positions, but only the immutable
  // G75 physical-slot catalog is user configuration. Lighting-only, Fn/knob,
  // and otherwise untagged positions remain the post-firmware values.
  for (const slot of VALID_PHYSICAL_SLOTS) {
    const offset = slot * 3;
    const wasDefault = captured[offset] === oldDefault[offset]
      && captured[offset + 1] === oldDefault[offset + 1]
      && captured[offset + 2] === oldDefault[offset + 2];
    const source = wasDefault ? newDefault : captured;
    source.copy(out, offset, offset, offset + 3);
  }
  return out;
}

function migrateColors(captured, current) {
  if (captured.length !== protocol.USED_KEY_AREA_SIZE || current.length !== protocol.USED_KEY_AREA_SIZE) {
    throw new FirmwareBackupError('Color migration requires complete 384-byte buffers', 'colors');
  }
  const out = Buffer.from(current);
  for (const slot of VALID_LIGHTING_SLOTS) {
    const offset = slot * 3;
    captured.copy(out, offset, offset, offset + 3);
  }
  return out;
}

function migrateKeyExtras(captured, current) {
  if (captured.length !== protocol.KEY_EXTRAS_SIZE || current.length !== protocol.KEY_EXTRAS_SIZE) {
    throw new FirmwareBackupError('Key-extras migration requires complete 1024-byte buffers', 'key-extras');
  }
  const out = Buffer.from(current);
  for (const slot of ELIGIBLE_ADVANCED_SLOTS) {
    const offset = slot * protocol.KEY_EXTRAS_ENTRY_SIZE;
    captured.copy(out, offset, offset, offset + protocol.KEY_EXTRAS_ENTRY_SIZE);
  }
  return out;
}

function migrateAdvancedTable(captured, current, references, entrySize, reservedOffset, tableSize) {
  if (!Number.isInteger(entrySize) || entrySize <= 0
    || !Number.isInteger(reservedOffset) || reservedOffset <= 0 || reservedOffset % entrySize !== 0
    || !Number.isInteger(tableSize) || tableSize < reservedOffset) {
    throw new FirmwareBackupError('Advanced table geometry is malformed', 'advanced');
  }
  if (captured.length !== tableSize || current.length !== tableSize) {
    throw new FirmwareBackupError(`Advanced table migration requires complete ${tableSize}-byte buffers`, 'advanced');
  }
  const entryCount = reservedOffset / entrySize;
  const out = Buffer.from(current);
  for (const index of references) {
    // A referenced entry beyond the table must fail loudly: Buffer.copy would
    // otherwise clamp into a silent no-op and drop a binding a key still uses.
    if (!Number.isInteger(index) || index < 0 || index >= entryCount) {
      throw new FirmwareBackupError(`Advanced table reference ${index} exceeds the ${entryCount}-entry table`, 'advanced');
    }
    const offset = index * entrySize;
    captured.copy(out, offset, offset, offset + entrySize);
  }
  return protocol.preserveReservedTail(out, current, reservedOffset);
}

function applyGlobals(layerBuffers, globals) {
  const byIndex = new Map();
  for (const item of (globals && globals.keys) || []) byIndex.set(item.index, item.layers);
  for (const [index, layers] of byIndex) {
    for (let layer = 0; layer < protocol.MAX_LAYERS; layer++) {
      const tuple = layers[layer];
      const offset = index * 3;
      tuple.copy ? tuple.copy(layerBuffers[layer], offset) : Buffer.from(tuple).copy(layerBuffers[layer], offset);
    }
  }
}

function makeCurrentMetadata(raw, slot, kind) {
  if (kind === 'names') {
    const decoded = profileNames.decodeProfileNames(raw);
    if (!decoded.valid) throw new FirmwareBackupError(`Profile ${slot} names are malformed after firmware update`, `profile-${slot}.names`);
    return decoded;
  }
  const decoded = profileNames.decodeFeatureSupport(raw);
  if (!decoded.valid) throw new FirmwareBackupError(`Profile ${slot} feature-support metadata is malformed after firmware update`, `profile-${slot}.feature-support`);
  return decoded;
}

function prepareRestorePlans(backup, current, defaults, profileData) {
  const oldDefaults = backup.defaults.layers.map((hex, layer) => exactBuffer(hex, protocol.TOTAL_KEY_AREA_SIZE, `defaults.layer-${layer}`));
  const globalBuffers = {
    predicate: backup.globals.predicate,
    keys: backup.globals.keys.map((item) => ({ index: item.index, layers: item.layers.map((tuple) => Buffer.from(exactTuple(tuple, `global ${item.index}`))) }))
  };
  const plans = [];
  for (const captured of backup.profiles) {
    const p = captured.profileIndex;
    const now = profileData.get(p);
    if (!now) throw new FirmwareBackupError(`Missing current post-firmware reads for profile ${p}`, `profile-${p}`);

    // Start with the complete post-firmware read, then apply semantic fields;
    // this intentionally preserves live/reserved bytes and current firmware
    // fields that are not configuration.
    const semanticFunc = preparePerformance(now.func, {
      lighting: captured.funcConfig.lighting,
      performance: captured.funcConfig.settings
    }, p);

    const layers = [];
    for (let layer = 0; layer < protocol.MAX_LAYERS; layer++) {
      const capturedLayer = exactBuffer(captured.layers[layer], protocol.TOTAL_KEY_AREA_SIZE, `profile-${p}.layer-${layer}`);
      layers.push(migrateLayer(capturedLayer, now.layers[layer], oldDefaults[layer], defaults[layer]));
    }
    applyGlobals(layers, globalBuffers);

    const capturedMt = exactBuffer(captured.advanced.mtHex, protocol.MT_TABLE_SIZE, `profile-${p}.advanced.mt`);
    const capturedTgl = exactBuffer(captured.advanced.tglHex, protocol.TGL_TABLE_SIZE, `profile-${p}.advanced.tgl`);
    const capturedExtras = exactBuffer(captured.advanced.keyExtrasHex, protocol.KEY_EXTRAS_SIZE, `profile-${p}.advanced.key-extras`);
    const targetUsedLayers = layers.map((layer) => layer.subarray(0, protocol.USED_KEY_AREA_SIZE));
    const references = protocol.collectAdvancedReferences(targetUsedLayers);
    const mt = migrateAdvancedTable(capturedMt, now.mt, references.mt, protocol.MT_ENTRY_SIZE, protocol.MT_RESERVED_OFFSET, protocol.MT_TABLE_SIZE);
    const tgl = migrateAdvancedTable(capturedTgl, now.tgl, references.tgl, protocol.TGL_ENTRY_SIZE, protocol.TGL_RESERVED_OFFSET, protocol.TGL_TABLE_SIZE);
    const extras = migrateKeyExtras(capturedExtras, now.extras);
    const customExisting = now.custom;
    const capturedCustomRaw = exactBuffer(captured.advanced.customParamHex, protocol.CB_CUSTOM_PARAM_LENGTH, `profile-${p}.advanced.custom-param`);
    const customParsed = protocol.parseCbCustomParam(capturedCustomRaw);
    if (!customParsed.ok) throw new FirmwareBackupError(customParsed.error, `profile-${p}.advanced.custom-param`);
    const custom = protocol.serializeCbCustomParam(customParsed, customExisting);
    // serializeCbCustomParam intentionally keeps the three precision bytes
    // from its existing buffer for ordinary profile imports. A firmware
    // backup is different: these are captured advanced configuration, so
    // restore them from the validated source while retaining all later
    // post-firmware reserved bytes.
    custom[0] = capturedCustomRaw[0];
    custom[1] = capturedCustomRaw[1];
    custom[2] = capturedCustomRaw[2];

    plans.push({
      profileIndex: p,
      func: { offset: p * 64, data: semanticFunc },
      layers: layers.map((data, layer) => ({ offset: protocol.userLayerOffset(p, layer), data })),
      colors: {
        offset: p * protocol.TOTAL_KEY_AREA_SIZE,
        data: migrateColors(exactBuffer(captured.colorsHex, protocol.USED_KEY_AREA_SIZE, `profile-${p}.colors`), now.colors)
      },
      advanced: {
        mt: { offset: p * protocol.MT_TABLE_SIZE, data: mt },
        tgl: { offset: p * protocol.TGL_TABLE_SIZE, data: tgl },
        keyExtras: { offset: p * protocol.KEY_EXTRAS_SIZE, data: extras },
        custom: { offset: protocol.cbCustomParamOffset(p), data: custom }
      }
    });
  }
  return { plans, base: current.base, macros: current.macros };
}

async function restoreInTransaction(transport, startGen, backup, options) {
  const startEpoch = transport.resetEpoch;
  const identity = currentDeviceIdentity(transport, options.identity || options.topologyIdentity || null);
  if (!identitiesMatch(backup.identity, identity)) {
    return { success: false, error: 'Backup identity does not match the currently connected normal device', failedSection: 'identity', uncertain: false, writesStarted: false };
  }
  const guard = () => transportIsCurrent(transport, startGen, startEpoch, identity, options.identity || options.topologyIdentity || null);
  guard.startGen = startGen;
  const completedSections = [];
  const read = async (command, offset, length, section) => {
    const data = await readRegion(transport, command, offset, length, guard, section, options);
    completedSections.push(`read:${section}`);
    return data;
  };
  let writesStarted = false;
  try {
    // Strict preflight: no write is dispatched until every current region and
    // every semantic conversion below has succeeded.
    const currentBaseRaw = await read(protocol.COMMANDS.GET_BASE, 0, 56, 'current-base');
    const currentBase = protocol.parseBase(currentBaseRaw);
    if (!currentBase) throw new FirmwareBackupError('Current post-firmware base is malformed', 'current-base');
    const currentMacrosRaw = await read(protocol.COMMANDS.GET_MACROS, 0, protocol.MACRO_READ_WINDOW_SIZE, 'current-macros');
    let currentMacroSlots;
    try { currentMacroSlots = protocol.parseMacroRegion(currentMacrosRaw); } catch (err) {
      throw new FirmwareBackupError(`Current post-firmware macro bank is malformed: ${err.message}`, 'current-macros');
    }

    const names = [];
    const feature = [];
    for (let slot = 0; slot < protocol.MAX_KEYBOARD_PROFILES; slot++) {
      names.push(await read(protocol.COMMANDS.GET_CUSTOM_PARAM, profileNames.namesOffset(slot), profileNames.PROFILE_NAMES_LENGTH, `current-profile-${slot}.names`));
      makeCurrentMetadata(names[slot], slot, 'names');
      feature.push(await read(protocol.COMMANDS.GET_CUSTOM_PARAM, profileNames.featureSupportOffset(slot), profileNames.FEATURE_SUPPORT_LENGTH, `current-profile-${slot}.feature-support`));
      makeCurrentMetadata(feature[slot], slot, 'feature');
    }

    const defaults = [];
    for (let layer = 0; layer < protocol.MAX_LAYERS; layer++) {
      defaults.push(await read(protocol.COMMANDS.GET_DEFAULT_KEY_MATRIX, layer * protocol.TOTAL_KEY_AREA_SIZE, protocol.TOTAL_KEY_AREA_SIZE, `current-defaults.layer-${layer}`));
    }

    const profileData = new Map();
    for (const captured of backup.profiles) {
      const p = captured.profileIndex;
      const func = await read(protocol.COMMANDS.GET_FUNC_CONFIG, p * 64, 64, `current-profile-${p}.funcConfig`);
      if (!protocol.parseFuncConfig(func)) throw new FirmwareBackupError(`Current profile ${p} funcConfig is malformed`, `current-profile-${p}.funcConfig`);
      const layers = [];
      for (let layer = 0; layer < protocol.MAX_LAYERS; layer++) {
        layers.push(await read(protocol.COMMANDS.GET_USER_KEY_MATRIX, protocol.userLayerOffset(p, layer), protocol.TOTAL_KEY_AREA_SIZE, `current-profile-${p}.layer-${layer}`));
      }
      const colors = await read(protocol.COMMANDS.GET_KEY_COLOR, p * protocol.TOTAL_KEY_AREA_SIZE, protocol.USED_KEY_AREA_SIZE, `current-profile-${p}.colors`);
      if (protocol.parseKeyColors(colors).length !== 128) throw new FirmwareBackupError(`Current profile ${p} colors are malformed`, `current-profile-${p}.colors`);
      const mt = await read(protocol.COMMANDS.GET_MT_KEYS, p * protocol.MT_TABLE_SIZE, protocol.MT_TABLE_SIZE, `current-profile-${p}.advanced.mt`);
      const tgl = await read(protocol.COMMANDS.GET_TGL_KEYS, p * protocol.TGL_TABLE_SIZE, protocol.TGL_TABLE_SIZE, `current-profile-${p}.advanced.tgl`);
      const extras = await read(protocol.COMMANDS.GET_KEY_EXTRAS, p * protocol.KEY_EXTRAS_SIZE, protocol.KEY_EXTRAS_SIZE, `current-profile-${p}.advanced.key-extras`);
      const custom = await read(protocol.COMMANDS.GET_CUSTOM_PARAM, protocol.cbCustomParamOffset(p), protocol.CB_CUSTOM_PARAM_LENGTH, `current-profile-${p}.advanced.custom-param`);
      try {
        protocol.parseMtTable(mt);
        protocol.parseTglTable(tgl);
        protocol.parseKeyExtras(extras);
        const parsedCustom = protocol.parseCbCustomParam(custom);
        if (!parsedCustom.ok) throw new Error(parsedCustom.error);
      } catch (err) {
        throw new FirmwareBackupError(`Current profile ${p} advanced metadata is malformed: ${err.message}`, `current-profile-${p}.advanced`);
      }
      profileData.set(p, { func, layers, colors, mt, tgl, extras, custom });
    }

    const desiredBase = protocol.mutateBaseConfig(currentBaseRaw, {
      activeProfile: backup.base.activeProfile,
      profileCount: backup.base.profileLength,
      profileOrder: backup.base.profileOrder
    });
    const desiredMacros = protocol.serializeMacroRegion(backup.macros.slots, currentMacrosRaw);
    const plan = prepareRestorePlans(backup, { base: desiredBase, macros: desiredMacros }, defaults, profileData);
    const enabledSlots = new Set(backup.base.profileOrder.slice(0, backup.base.profileLength));
    const namesStored = backup.names.stored.slice();
    for (let slot = 0; slot < protocol.MAX_KEYBOARD_PROFILES; slot++) {
      if (!enabledSlots.has(slot)) namesStored[slot] = '';
    }
    const encodedNames = profileNames.encodeProfileNames(namesStored);
    if (!encodedNames.valid) throw new FirmwareBackupError(encodedNames.error, 'profile-names');
    const featureBySlot = new Map(backup.featureSupport.map((entry) => [entry.slot, exactBuffer(entry.rawHex, profileNames.FEATURE_SUPPORT_LENGTH, `feature-support-${entry.slot}`)]));

    const writes = [];
    // Vendor ordering: shared macros first, then base/profile list, names, and
    // per-profile data. All are already prepared from complete reads.
    writes.push({ command: protocol.COMMANDS.SET_MACROS, offset: 0, data: desiredMacros, section: 'shared-macros' });
    writes.push({ command: protocol.COMMANDS.SET_BASE, offset: 0, data: desiredBase, section: 'base' });
    for (let slot = 0; slot < protocol.MAX_KEYBOARD_PROFILES; slot++) {
      writes.push({ command: protocol.COMMANDS.SET_CUSTOM_PARAM, offset: profileNames.namesOffset(slot), data: encodedNames.buffer, section: `profile-${slot}.names` });
      if (enabledSlots.has(slot)) {
        writes.push({ command: protocol.COMMANDS.SET_CUSTOM_PARAM, offset: profileNames.featureSupportOffset(slot), data: featureBySlot.get(slot), section: `profile-${slot}.feature-support` });
      }
    }
    for (const item of plan.plans) {
      writes.push({ command: protocol.COMMANDS.SET_FUNC_CONFIG, offset: item.func.offset, data: item.func.data, section: `profile-${item.profileIndex}.funcConfig`, ignoreBytes: LIVE_FUNC_OFFSETS });
      writes.push({ command: protocol.COMMANDS.SET_MT_KEYS, offset: item.advanced.mt.offset, data: item.advanced.mt.data, section: `profile-${item.profileIndex}.advanced.mt` });
      writes.push({ command: protocol.COMMANDS.SET_TGL_KEYS, offset: item.advanced.tgl.offset, data: item.advanced.tgl.data, section: `profile-${item.profileIndex}.advanced.tgl` });
      writes.push({ command: protocol.COMMANDS.SET_KEY_EXTRAS, offset: item.advanced.keyExtras.offset, data: item.advanced.keyExtras.data, section: `profile-${item.profileIndex}.advanced.key-extras` });
      writes.push({ command: protocol.COMMANDS.SET_CUSTOM_PARAM, offset: item.advanced.custom.offset, data: item.advanced.custom.data, section: `profile-${item.profileIndex}.advanced.custom-param` });
      for (const layer of item.layers) writes.push({ command: protocol.COMMANDS.SET_USER_KEY_MATRIX, offset: layer.offset, data: layer.data, section: `profile-${item.profileIndex}.layer-${layer.offset / protocol.TOTAL_KEY_AREA_SIZE % protocol.MAX_LAYERS}` });
      writes.push({ command: protocol.COMMANDS.SET_KEY_COLOR, offset: item.colors.offset, data: item.colors.data, section: `profile-${item.profileIndex}.colors` });
    }

    const write = async (item) => {
      if (!guard()) throw new FirmwareBackupError('Device identity changed before the next restore write', item.section, { uncertain: writesStarted });
      safeProgress(options, { phase: 'writing', section: item.section, completedSections: completedSections.slice() });
      let result;
      try {
        result = await transport._writeVerify(item.command, item.offset, item.data, startGen, {
          section: item.section,
          completedSections: completedSections.slice(),
          ignoreBytes: item.ignoreBytes,
          timeoutMs: readTimeout(options, 'write'),
          ownerToken: options && options.ownerToken
        });
      } catch (err) {
        // The transport contract should return a structured result, but a
        // thrown native/mock submission leaves its dispatch state unknown.
        writesStarted = true;
        throw new FirmwareBackupError(err.message || String(err), item.section, { uncertain: true, writesStarted: true });
      }
      if (result && (result.success || result.dispatched || result.uncertain)) writesStarted = true;
      if (!guard()) throw new FirmwareBackupError('Device identity changed during restore write/readback', item.section, { uncertain: true });
      if (!result || !result.success) {
        throw new FirmwareBackupError((result && result.error) || `${item.section} write failed`, item.section, {
          uncertain: Boolean(result && result.uncertain),
          writesStarted,
          completedSections: completedSections.slice()
        });
      }
      completedSections.push(item.section);
    };

    for (const item of writes) await write(item);

    // A final read-only identity/base/macro confirmation keeps the verified
    // status behind a second complete read boundary, not merely write ACKs.
    const finalBase = await read(protocol.COMMANDS.GET_BASE, 0, 56, 'final-base');
    const finalParsed = protocol.parseBase(finalBase);
    if (!finalParsed || finalParsed.activeProfile !== backup.base.activeProfile || finalParsed.profileCount !== backup.base.profileLength || finalParsed.profileOrder.some((value, i) => value !== backup.base.profileOrder[i])) {
      throw new FirmwareBackupError('Final base readback does not match the restored profile topology', 'final-base', { uncertain: true });
    }
    const finalMacros = await read(protocol.COMMANDS.GET_MACROS, 0, protocol.MACRO_READ_WINDOW_SIZE, 'final-macros');
    try { protocol.parseMacroRegion(finalMacros); } catch (err) {
      throw new FirmwareBackupError(`Final macro readback is malformed: ${err.message}`, 'final-macros', { uncertain: true });
    }
    return { success: true, completedSections, writesStarted: true, restorationVerified: true };
  } catch (err) {
    return {
      success: false,
      error: err.message || String(err),
      failedSection: err.section || null,
      completedSections,
      uncertain: Boolean(err.uncertain),
      writesStarted,
      partial: writesStarted
    };
  }
}

function validateFirmwareBackup(backup) {
  try {
    if (!isPlainObject(backup)) throw new FirmwareBackupError('Backup must be an object', 'backup');
    if (backup.schema !== BACKUP_SCHEMA || backup.schemaVersion !== BACKUP_SCHEMA_VERSION || backup.dataFormat !== BACKUP_DATA_FORMAT) {
      throw new FirmwareBackupError('Unsupported firmware backup schema or data format', 'backup');
    }
    if (backup.complete !== true) throw new FirmwareBackupError('Backup is partial and cannot be restored', 'backup');
    finiteTimestamp(backup.savedAt, 'savedAt');
    const identity = validateNormalIdentity(backup.identity);
    if (!identity.valid) throw new FirmwareBackupError(identity.error, 'identity');

    const baseRaw = exactBuffer(backup.base && backup.base.rawHex, 56, 'base');
    const parsedBase = protocol.parseBase(baseRaw);
    if (!parsedBase) throw new FirmwareBackupError('Backup base profile list is malformed', 'base');
    if (backup.base.activeProfile !== parsedBase.activeProfile
      || backup.base.activeSlot !== parsedBase.activeSlot
      || backup.base.profileLength !== parsedBase.profileCount
      || !Array.isArray(backup.base.profileOrder)
      || backup.base.profileOrder.length !== protocol.MAX_KEYBOARD_PROFILES
      || backup.base.profileOrder.some((p, i) => p !== parsedBase.profileOrder[i])) {
      throw new FirmwareBackupError('Backup base metadata does not match its raw bytes', 'base');
    }

    if (!backup.defaults || !Array.isArray(backup.defaults.layers) || backup.defaults.layers.length !== protocol.MAX_LAYERS) throw new FirmwareBackupError('Backup is missing all four immutable default layers', 'defaults');
    backup.defaults.layers.forEach((hex, layer) => exactBuffer(hex, protocol.TOTAL_KEY_AREA_SIZE, `defaults.layer-${layer}`));

    if (!backup.names || !Array.isArray(backup.names.stored) || backup.names.stored.length !== protocol.MAX_KEYBOARD_PROFILES || backup.names.stored.some((name) => typeof name !== 'string')) throw new FirmwareBackupError('Backup profile names are incomplete', 'profile-names');
    if (!Array.isArray(backup.names.regions) || backup.names.regions.length !== protocol.MAX_KEYBOARD_PROFILES) throw new FirmwareBackupError('Backup profile-name regions are incomplete', 'profile-names');
    const nameSlots = new Set();
    for (const region of backup.names.regions) {
      if (!Number.isInteger(region.slot) || region.slot < 0 || region.slot >= protocol.MAX_KEYBOARD_PROFILES || nameSlots.has(region.slot)) throw new FirmwareBackupError('Backup profile-name slots are invalid or duplicated', 'profile-names');
      nameSlots.add(region.slot);
      if (!Array.isArray(region.stored) || region.stored.length !== protocol.MAX_KEYBOARD_PROFILES || region.stored.some((name) => typeof name !== 'string')) throw new FirmwareBackupError(`Backup profile-${region.slot} names are incomplete`, `profile-${region.slot}.names`);
      const raw = exactBuffer(region.rawHex, profileNames.PROFILE_NAMES_LENGTH, `profile-${region.slot}.names`);
      const decoded = profileNames.decodeProfileNames(raw);
      if (!decoded.valid || decoded.stored.some((name, i) => name !== region.stored[i])) throw new FirmwareBackupError(`Backup profile-${region.slot} names do not match their raw bytes`, `profile-${region.slot}.names`);
      if (region.stored.some((name, i) => name !== backup.names.stored[i])) throw new FirmwareBackupError('Backup profile-name regions disagree; refusing to choose one silently', 'profile-names');
    }
    if (nameSlots.size !== protocol.MAX_KEYBOARD_PROFILES) throw new FirmwareBackupError('Backup profile-name slots are incomplete', 'profile-names');

    if (!Array.isArray(backup.featureSupport) || backup.featureSupport.length !== protocol.MAX_KEYBOARD_PROFILES) throw new FirmwareBackupError('Backup feature-support metadata is incomplete', 'feature-support');
    const featureSlots = new Set();
    for (const entry of backup.featureSupport) {
      if (!Number.isInteger(entry.slot) || entry.slot < 0 || entry.slot >= protocol.MAX_KEYBOARD_PROFILES || featureSlots.has(entry.slot)) throw new FirmwareBackupError('Backup feature-support slots are invalid or duplicated', 'feature-support');
      featureSlots.add(entry.slot);
      if (!isPlainObject(entry.support)) throw new FirmwareBackupError(`Backup feature-support metadata is missing for slot ${entry.slot}`, `feature-support-${entry.slot}`);
      const raw = exactBuffer(entry.rawHex, profileNames.FEATURE_SUPPORT_LENGTH, `feature-support-${entry.slot}`);
      const decoded = profileNames.decodeFeatureSupport(raw);
      if (!decoded.valid || JSON.stringify(decoded.support) !== JSON.stringify(entry.support)) throw new FirmwareBackupError(`Backup feature-support metadata is malformed for slot ${entry.slot}`, `feature-support-${entry.slot}`);
    }
    if (featureSlots.size !== protocol.MAX_KEYBOARD_PROFILES) throw new FirmwareBackupError('Backup feature-support slots are incomplete', 'feature-support');

    const macrosRaw = exactBuffer(backup.macros && backup.macros.rawHex, protocol.MACRO_READ_WINDOW_SIZE, 'shared-macros');
    const parsedMacros = protocol.parseMacroRegion(macrosRaw);
    if (!Array.isArray(backup.macros.slots) || backup.macros.slots.length !== parsedMacros.length) throw new FirmwareBackupError('Backup macro slot list is incomplete', 'shared-macros');
    if (JSON.stringify(backup.macros.slots) !== JSON.stringify(parsedMacros)) throw new FirmwareBackupError('Backup macro slot metadata does not match its raw bytes', 'shared-macros');

    if (!backup.globals || backup.globals.predicate !== 'layout.isGlobalKey === true' || backup.globals.evidence !== 'g75-v2-layout-catalog' || !Array.isArray(backup.globals.eligibleSlots) || !Array.isArray(backup.globals.keys)) throw new FirmwareBackupError('Backup global-key metadata is missing its eligibility proof', 'globals');
    const expectedGlobalSlots = globalSlotCandidates();
    if (backup.globals.eligibleSlots.length !== expectedGlobalSlots.length || backup.globals.eligibleSlots.some((slot, i) => slot !== expectedGlobalSlots[i])) {
      throw new FirmwareBackupError('Backup global-key set does not match the reviewed G75 V2 layout catalog', 'globals');
    }
    const globalSeen = new Set();
    for (const item of backup.globals.keys) {
      if (!Number.isInteger(item.index) || !expectedGlobalSlots.includes(item.index) || globalSeen.has(item.index)) throw new FirmwareBackupError('Backup global-key index is invalid, ineligible, or duplicated', 'globals');
      globalSeen.add(item.index);
      if (!Array.isArray(item.layers) || item.layers.length !== protocol.MAX_LAYERS) throw new FirmwareBackupError(`Backup global key ${item.index} is missing layer values`, 'globals');
      item.layers.forEach((tuple, layer) => exactTuple(tuple, `global-${item.index}.layer-${layer}`));
    }

    if (!Array.isArray(backup.profiles) || backup.profiles.length !== parsedBase.profileCount) throw new FirmwareBackupError('Backup does not contain exactly the enabled profiles', 'profiles');
    const enabled = parsedBase.profileOrder.slice(0, parsedBase.profileCount);
    const profileSet = new Set();
    const profilesByIndex = new Map();
    for (const profile of backup.profiles) {
      if (!Number.isInteger(profile.profileIndex) || !enabled.includes(profile.profileIndex) || profileSet.has(profile.profileIndex)) throw new FirmwareBackupError('Backup profile set is not the enabled base-order prefix', 'profiles');
      profileSet.add(profile.profileIndex);
      profilesByIndex.set(profile.profileIndex, profile);
      if (profile.orderIndex !== enabled.indexOf(profile.profileIndex)) throw new FirmwareBackupError(`Backup profile ${profile.profileIndex} has an incorrect enabled-order index`, `profile-${profile.profileIndex}`);
      if (profile.name !== backup.names.stored[profile.profileIndex]) throw new FirmwareBackupError(`Backup profile ${profile.profileIndex} name does not match the name table`, `profile-${profile.profileIndex}`);
      exactBuffer(profile.funcConfig && profile.funcConfig.rawHex, 64, `profile-${profile.profileIndex}.funcConfig`);
      if (!profile.funcConfig.lighting || !profile.funcConfig.settings) throw new FirmwareBackupError(`Profile ${profile.profileIndex} lacks semantic funcConfig fields`, `profile-${profile.profileIndex}.funcConfig`);
      const semantic = makeFuncSemantic(Buffer.from(profile.funcConfig.rawHex, 'hex'), profile.profileIndex);
      if (JSON.stringify(semantic.lighting) !== JSON.stringify(profile.funcConfig.lighting)
        || JSON.stringify(semantic.settings) !== JSON.stringify(profile.funcConfig.settings)
        || JSON.stringify(semantic.capturedLive) !== JSON.stringify(profile.funcConfig.capturedLive)) {
        throw new FirmwareBackupError(`Profile ${profile.profileIndex} semantic funcConfig fields do not match raw bytes`, `profile-${profile.profileIndex}.funcConfig`);
      }
      if (!Array.isArray(profile.layers) || profile.layers.length !== protocol.MAX_LAYERS) throw new FirmwareBackupError(`Profile ${profile.profileIndex} does not contain four layers`, `profile-${profile.profileIndex}`);
      profile.layers.forEach((hex, layer) => exactBuffer(hex, protocol.TOTAL_KEY_AREA_SIZE, `profile-${profile.profileIndex}.layer-${layer}`));
      exactBuffer(profile.colorsHex, protocol.USED_KEY_AREA_SIZE, `profile-${profile.profileIndex}.colors`);
      if (!profile.advanced) throw new FirmwareBackupError(`Profile ${profile.profileIndex} lacks advanced metadata`, `profile-${profile.profileIndex}.advanced`);
      exactBuffer(profile.advanced.mtHex, protocol.MT_TABLE_SIZE, `profile-${profile.profileIndex}.advanced.mt`);
      exactBuffer(profile.advanced.tglHex, protocol.TGL_TABLE_SIZE, `profile-${profile.profileIndex}.advanced.tgl`);
      exactBuffer(profile.advanced.keyExtrasHex, protocol.KEY_EXTRAS_SIZE, `profile-${profile.profileIndex}.advanced.key-extras`);
      exactBuffer(profile.advanced.customParamHex, protocol.CB_CUSTOM_PARAM_LENGTH, `profile-${profile.profileIndex}.advanced.custom-param`);
      protocol.parseMtTable(Buffer.from(profile.advanced.mtHex, 'hex'));
      protocol.parseTglTable(Buffer.from(profile.advanced.tglHex, 'hex'));
      protocol.parseKeyExtras(Buffer.from(profile.advanced.keyExtrasHex, 'hex'));
      const custom = protocol.parseCbCustomParam(Buffer.from(profile.advanced.customParamHex, 'hex'));
      if (!custom.ok) throw new FirmwareBackupError(`Profile ${profile.profileIndex} custom parameter is malformed`, `profile-${profile.profileIndex}.advanced.custom-param`);
      if (profile.advanced.customParam) {
        const canonicalCustom = {
          rtPressPrecisionMode: custom.rtPressPrecisionMode,
          rtReleasePrecisionMode: custom.rtReleasePrecisionMode,
          rtSmartCacheValue: custom.rtSmartCacheValue,
          cbKeyIndexList: custom.cbKeyIndexList,
          encoding: custom.encoding
        };
        if (JSON.stringify(canonicalCustom) !== JSON.stringify(profile.advanced.customParam)) throw new FirmwareBackupError(`Profile ${profile.profileIndex} custom metadata does not match raw bytes`, `profile-${profile.profileIndex}.advanced.custom-param`);
      }
    }
    if (profileSet.size !== enabled.length) throw new FirmwareBackupError('Backup profile set is incomplete', 'profiles');
    const activeProfile = profilesByIndex.get(parsedBase.activeProfile);
    for (const item of backup.globals.keys) {
      for (let layer = 0; layer < protocol.MAX_LAYERS; layer++) {
        const raw = Buffer.from(activeProfile.layers[layer], 'hex');
        const offset = item.index * 3;
        const tuple = Array.from(raw.subarray(offset, offset + 3));
        if (tuple.some((value, i) => value !== item.layers[layer][i])) throw new FirmwareBackupError(`Backup global key ${item.index} does not match the captured active profile`, 'globals');
      }
    }
    if (backup.restoration !== undefined) {
      if (!isPlainObject(backup.restoration) || !['captured', 'verified'].includes(backup.restoration.status)) {
        throw new FirmwareBackupError('Backup restoration status is invalid', 'restoration');
      }
      if (backup.restoration.status === 'captured' && backup.restoration.verifiedAt !== null) {
        throw new FirmwareBackupError('Captured backup cannot contain a verification timestamp', 'restoration');
      }
      if (backup.restoration.status === 'verified') {
        finiteTimestamp(backup.restoration.verifiedAt, 'restoration.verifiedAt');
        if (backup.restoration.verifiedBy !== 'native-transport-readback') throw new FirmwareBackupError('Backup verification marker is not native readback proof', 'restoration');
      }
    }
    return { valid: true, value: backup };
  } catch (err) {
    return { valid: false, error: err.message || String(err), section: err.section || null };
  }
}

function backupJsonBytes(backup) {
  const text = `${JSON.stringify(backup, null, 2)}\n`;
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length > MAX_BACKUP_BYTES) throw new FirmwareBackupError(`Backup exceeds the ${MAX_BACKUP_BYTES}-byte safety limit`, 'backup');
  return bytes;
}

function isPackageSha256(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function writeFirmwareBackupAtomic(filePath, backup) {
  if (typeof filePath !== 'string' || !filePath) return { success: false, error: 'A backup file path is required' };
  const validated = validateFirmwareBackup(backup);
  if (!validated.valid) return { success: false, error: validated.error, persisted: false };
  try {
    writeFileAtomicDurable(filePath, backupJsonBytes(backup));
    return { success: true, persisted: true, filePath };
  } catch (err) {
    return { success: false, error: err.message || String(err), persisted: false };
  }
}

function readFirmwareBackup(filePath) {
  if (typeof filePath !== 'string' || !filePath) return { success: false, error: 'A backup file path is required' };
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_BACKUP_BYTES) return { success: false, error: 'Backup file is missing, not a regular file, or exceeds the safety limit' };
    const raw = fs.readFileSync(filePath);
    const value = JSON.parse(raw.toString('utf8'));
    const validated = validateFirmwareBackup(value);
    if (!validated.valid) return { success: false, error: validated.error, retained: true };
    return { success: true, backup: value, filePath };
  } catch (err) {
    return { success: false, error: err.message || String(err), retained: true };
  }
}

function existingBackupRetained(filePath) {
  if (typeof filePath !== 'string' || !filePath) return false;
  try { return fs.statSync(filePath).isFile(); } catch { return false; }
}

/**
 * Boot recovery anchor. Persisted immediately before enter-boot is
 * dispatched so an interrupted update (app crash, power loss, cable pull
 * while the device sits in bootloader mode) can be resumed after a relaunch.
 * The anchor is the pre-flight identity proof: target key, stable USB
 * location, serial (when the normal descriptor exposed one), and the package
 * SHA-256 it was written for. It lives next to the backup file and uses the
 * same durable-write discipline because it gates destructive boot commands.
 */
const BOOT_ANCHOR_SCHEMA = 'g75v2-boot-anchor';
const BOOT_ANCHOR_SCHEMA_VERSION = 1;
const MAX_BOOT_ANCHOR_BYTES = 16 * 1024;

function bootAnchorPath(dir) {
  if (typeof dir !== 'string' || !dir) return null;
  return path.join(dir, 'firmware-boot-anchor.json');
}

function validateBootAnchor(anchor) {
  try {
    if (!isPlainObject(anchor)) throw new FirmwareBackupError('Boot anchor must be a plain object', 'anchor');
    if (anchor.schema !== BOOT_ANCHOR_SCHEMA) throw new FirmwareBackupError('Boot anchor schema is not recognized', 'anchor');
    if (anchor.version !== BOOT_ANCHOR_SCHEMA_VERSION) throw new FirmwareBackupError('Boot anchor schema version is not supported', 'anchor');
    if (typeof anchor.targetKey !== 'string' || !anchor.targetKey) throw new FirmwareBackupError('Boot anchor target key is missing', 'anchor');
    if (!Number.isInteger(anchor.locationId) || anchor.locationId < 0) throw new FirmwareBackupError('Boot anchor lacks a stable USB location', 'anchor');
    if (anchor.serialNumber !== null && typeof anchor.serialNumber !== 'string') throw new FirmwareBackupError('Boot anchor serial is malformed', 'anchor');
    if (!isPackageSha256(anchor.packageSha256)) {
      throw new FirmwareBackupError('Boot anchor package SHA-256 is missing or malformed', 'anchor');
    }
    if (anchor.backupPath !== null && typeof anchor.backupPath !== 'string') throw new FirmwareBackupError('Boot anchor backup path is malformed', 'anchor');
    if (anchor.firmwareField !== null && typeof anchor.firmwareField !== 'string') throw new FirmwareBackupError('Boot anchor firmware field is malformed', 'anchor');
    if (anchor.beforeVersionRaw !== null && (!Number.isInteger(anchor.beforeVersionRaw) || anchor.beforeVersionRaw < 0)) {
      throw new FirmwareBackupError('Boot anchor pre-update version is malformed', 'anchor');
    }
    finiteTimestamp(anchor.enteredAt, 'anchor.enteredAt');
    return { valid: true, value: anchor };
  } catch (err) {
    return { valid: false, error: err.message || String(err), section: err.section || null };
  }
}

function writeBootAnchor(filePath, anchor) {
  if (typeof filePath !== 'string' || !filePath) return { success: false, error: 'A boot anchor file path is required' };
  const validated = validateBootAnchor(anchor);
  if (!validated.valid) return { success: false, error: validated.error, persisted: false };
  try {
    const bytes = Buffer.from(`${JSON.stringify(anchor, null, 2)}\n`, 'utf8');
    if (bytes.length > MAX_BOOT_ANCHOR_BYTES) throw new FirmwareBackupError('Boot anchor exceeds the safety size limit', 'anchor');
    writeFileAtomicDurable(filePath, bytes);
    return { success: true, persisted: true, filePath };
  } catch (err) {
    return { success: false, error: err.message || String(err), persisted: false };
  }
}

function readBootAnchor(filePath) {
  if (typeof filePath !== 'string' || !filePath) return { success: false, error: 'A boot anchor file path is required' };
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_BOOT_ANCHOR_BYTES) return { success: false, error: 'Boot anchor file is not a regular file or exceeds the safety limit' };
    const value = JSON.parse(fs.readFileSync(filePath).toString('utf8'));
    const validated = validateBootAnchor(value);
    if (!validated.valid) return { success: false, error: validated.error, retained: true };
    return { success: true, anchor: value, filePath };
  } catch (err) {
    return { success: false, error: err.message || String(err), missing: Boolean(err && err.code === 'ENOENT') };
  }
}

function clearBootAnchor(filePath) {
  if (typeof filePath !== 'string' || !filePath) return { success: false, error: 'A boot anchor file path is required' };
  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    if (err && err.code === 'ENOENT') return { success: true, cleared: false, filePath };
    return { success: false, error: err.message || String(err) };
  }
  // The removal's directory entry needs the same durable commit as the rename.
  try {
    const dirFd = fs.openSync(path.dirname(filePath), 'r');
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  } catch (err) {
    return { success: false, error: err.message || String(err) };
  }
  return { success: true, cleared: true, filePath };
}

async function captureFirmwareBackup(transport, options = {}) {
  if (!transport || typeof transport.runTransaction !== 'function' || typeof transport.readRange !== 'function') {
    return { success: false, error: 'Firmware backup requires the serialized DeviceTransport read contract', readyForUpdate: false };
  }
  const filePath = options.filePath || options.backupPath || null;
  safeProgress(options, { phase: 'preflight', section: 'identity', completedSections: [] });
  let result;
  try {
    result = await transport.runTransaction(
      (startGen) => captureInTransaction(transport, startGen, options),
      { ownerToken: options.ownerToken }
    );
  } catch (err) {
    result = { success: false, error: err.message || String(err), failedSection: 'transaction', uncertain: false, completedSections: [] };
  }
  if (!result || !result.success) {
    return {
      ...result,
      success: false,
      readyForUpdate: false,
      persisted: false,
      backupRetained: existingBackupRetained(filePath),
      recoverable: existingBackupRetained(filePath)
    };
  }
  if (!filePath) {
    return {
      success: true,
      backup: result.backup,
      persisted: false,
      readyForUpdate: false,
      backupRetained: false,
      recoverable: true,
      error: 'Backup was captured in memory but no atomic file path was supplied; update authorization remains false'
    };
  }
  safeProgress(options, { phase: 'persisting', section: 'backup-file', completedSections: result.completedSections || [] });
  const persisted = writeFirmwareBackupAtomic(filePath, result.backup);
  if (!persisted.success) {
    return {
      success: false,
      error: persisted.error,
      backup: result.backup,
      persisted: false,
      readyForUpdate: false,
      backupRetained: existingBackupRetained(filePath),
      recoverable: existingBackupRetained(filePath)
    };
  }
  safeProgress(options, { phase: 'complete', section: 'backup-file', completedSections: result.completedSections || [] });
  return {
    success: true,
    backup: result.backup,
    filePath,
    persisted: true,
    readyForUpdate: true,
    backupRetained: true,
    recoverable: true
  };
}

async function restoreFirmwareBackup(transport, source, options = {}) {
  if (!transport || typeof transport.runTransaction !== 'function' || typeof transport.readRange !== 'function' || typeof transport._writeVerify !== 'function') {
    return { success: false, error: 'Firmware restore requires the serialized DeviceTransport read/write verification contract' };
  }
  const filePath = typeof source === 'string' ? source : (options.filePath || options.backupPath || null);
  let backup = source;
  if (typeof source === 'string') {
    const loaded = readFirmwareBackup(source);
    if (!loaded.success) return { success: false, error: loaded.error, backupRetained: existingBackupRetained(source), restorationVerified: false };
    backup = loaded.backup;
  }
  const validated = validateFirmwareBackup(backup);
  if (!validated.valid) return { success: false, error: validated.error, backupRetained: Boolean(filePath) || false, restorationVerified: false };

  let result;
  try {
    result = await transport.runTransaction(
      (startGen) => restoreInTransaction(transport, startGen, backup, options),
      { ownerToken: options.ownerToken }
    );
  } catch (err) {
    result = { success: false, error: err.message || String(err), failedSection: 'transaction', uncertain: false, writesStarted: false };
  }
  if (!result || !result.success) {
    return {
      ...result,
      success: false,
      restorationVerified: false,
      backupRetained: Boolean(filePath) ? existingBackupRetained(filePath) : true,
      recoverable: true
    };
  }

  let marked = backup;
  if (filePath) {
    marked = {
      ...backup,
      restoration: {
        status: 'verified',
        verifiedAt: Date.now(),
        verifiedBy: 'native-transport-readback'
      }
    };
    const persisted = writeFirmwareBackupAtomic(filePath, marked);
    if (!persisted.success) {
      return {
        success: false,
        error: `Hardware restoration was verified, but the backup status could not be persisted: ${persisted.error}`,
        completedSections: result.completedSections,
        uncertain: false,
        restorationVerified: true,
        backupRetained: existingBackupRetained(filePath),
        recoverable: true
      };
    }
  }
  return {
    ...result,
    success: true,
    backup: marked,
    filePath,
    restorationVerified: true,
    backupRetained: Boolean(filePath),
    recoverable: true
  };
}

module.exports = {
  BACKUP_SCHEMA,
  BACKUP_SCHEMA_VERSION,
  BACKUP_DATA_FORMAT,
  MAX_BACKUP_BYTES,
  BOOT_ANCHOR_SCHEMA,
  BOOT_ANCHOR_SCHEMA_VERSION,
  NORMAL_VENDOR_ID,
  NORMAL_PRODUCT_IDS,
  currentDeviceIdentity,
  validateNormalIdentity,
  identitiesMatch,
  validateFirmwareBackup,
  writeFirmwareBackupAtomic,
  readFirmwareBackup,
  bootAnchorPath,
  validateBootAnchor,
  isPackageSha256,
  writeBootAnchor,
  readBootAnchor,
  clearBootAnchor,
  captureFirmwareBackup,
  restoreFirmwareBackup,
  FirmwareBackupError
};
