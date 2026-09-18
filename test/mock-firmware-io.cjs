'use strict';

/**
 * Injectable firmware doubles for unit tests and unpackaged --mock-ui-test.
 * Never opens a real HID handle or talks to a bootloader.
 */

const crypto = require('node:crypto');
const firmware = require('../src/firmware-protocol.cjs');

const KEYBOARD_BYTES = Buffer.from([
  0x37, 0x38, 0x21, 0x20, 0x14, 0x01, 0xAA, 0xBB,
  0x00, 0x00, 0x00, 0x00, 0x10, 0x11, 0x12, 0x13,
  0x20, 0x21, 0x22, 0x23, 0x30, 0x31, 0x32, 0x33,
  0x40, 0x41, 0x42, 0x43, 0x50, 0x51, 0x52, 0x53,
  0x60, 0x61, 0x62
]);

const RECEIVER_BYTES = Buffer.from([
  0x37, 0x38, 0x33, 0x30, 0x18, 0x01, 0xAA, 0xBB,
  0x00, 0x00, 0x00, 0x00, 0x90, 0x91, 0x92, 0x93,
  0xA0, 0xA1, 0xA2, 0xA3, 0xB0, 0xB1, 0xB2, 0xB3,
  0xC0, 0xC1, 0xC2, 0xC3, 0xD0, 0xD1, 0xD2, 0xD3,
  0xE0, 0xE1, 0xE2
]);

const MISMATCH_BYTES = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]);

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createMockUiCatalog() {
  return {
    keyboard: {
      ...firmware.OFFICIAL_CATALOG.keyboard,
      package: {
        fileName: 'mock-ui-firmware-keyboard.bin',
        size: KEYBOARD_BYTES.length,
        sha256: sha256(KEYBOARD_BYTES),
        version: '1.14',
        versionNumber: 114,
        versionRaw: 0x0114,
        versionSource: 'mock-ui-catalog',
        firmwareField: 'firmwareVersion'
      }
    },
    receiver: {
      ...firmware.OFFICIAL_CATALOG.receiver,
      package: {
        fileName: 'mock-ui-firmware-receiver.bin',
        size: RECEIVER_BYTES.length,
        sha256: sha256(RECEIVER_BYTES),
        version: '1.30',
        versionNumber: 130,
        versionRaw: 0x0130,
        versionSource: 'mock-ui-catalog',
        firmwareField: 'rfFirmwareVersion'
      }
    }
  };
}

function nodeHidReceiverHandle(overrides = {}) {
  return {
    vendorId: firmware.VENDOR_ID,
    productId: firmware.NORMAL_PIDS.WIRELESS_RECEIVER,
    interface: firmware.CONTROL_INTERFACE,
    usagePage: firmware.NORMAL_USAGE_PAGE,
    usage: firmware.NORMAL_USAGE,
    serialNumber: 'MOCK-FW-SERIAL',
    path: 'DevSrvsID:4295538287',
    ...overrides
  };
}

function receiverIdentity(overrides = {}) {
  return {
    ...nodeHidReceiverHandle(),
    locationId: 0x02400000,
    registryEntryId: 4295538287,
    registryPath: 'DevSrvsID:4295538287',
    path: 'mock://g75v2',
    ...overrides
  };
}

function keyboardIdentity(overrides = {}) {
  return {
    vendorId: firmware.VENDOR_ID,
    productId: firmware.NORMAL_PIDS.WIRED_KEYBOARD,
    interface: firmware.CONTROL_INTERFACE,
    usagePage: firmware.NORMAL_USAGE_PAGE,
    usage: firmware.NORMAL_USAGE,
    serialNumber: 'MOCK-FW-WIRED',
    locationId: 0x02400000,
    registryEntryId: 1001,
    registryPath: 'mock://g75v2-wired',
    path: 'mock://g75v2-wired',
    ...overrides
  };
}

function bootIdentityFromNormal(identity, targetKey) {
  const target = firmware.resolveTarget(targetKey, firmware.OFFICIAL_CATALOG);
  return {
    ...target.boot,
    serialNumber: identity.serialNumber,
    locationId: identity.locationId,
    registryEntryId: (identity.registryEntryId || 0) + 1,
    registryPath: `${identity.registryPath || identity.path}-boot`,
    path: `${identity.path}-boot`
  };
}

const RECEIVER_INFO_BEFORE = {
  firmwareVersion: '1.14',
  rawFirmwareVersion: 0x0114,
  rfFirmwareVersion: '1.29',
  rawRfFirmwareVersion: 0x0129,
  buildDate: 'mock-before',
  dongleInfo: '2.4G Dongle'
};

const RECEIVER_INFO_AFTER = {
  firmwareVersion: '1.14',
  rawFirmwareVersion: 0x0114,
  rfFirmwareVersion: '1.30',
  rawRfFirmwareVersion: 0x0130,
  buildDate: 'mock-after',
  dongleInfo: '2.4G Dongle'
};

const KEYBOARD_INFO_BEFORE = {
  firmwareVersion: '1.13',
  rawFirmwareVersion: 0x0113,
  rfFirmwareVersion: '1.30',
  rawRfFirmwareVersion: 0x0130,
  buildDate: 'mock-kb-before',
  dongleInfo: null
};

const KEYBOARD_INFO_AFTER = {
  firmwareVersion: '1.14',
  rawFirmwareVersion: 0x0114,
  rfFirmwareVersion: '1.30',
  rawRfFirmwareVersion: 0x0130,
  buildDate: 'mock-kb-after',
  dongleInfo: null
};

class MockNativeFirmwareIo {
  constructor(options = {}) {
    this.options = options;
    this.connected = false;
    this.identity = null;
    this.writes = [];
    this.dataListeners = new Set();
    this.disconnectListeners = new Set();
    this.closed = false;
    this.entered = null;
    this.normalIdentity = options.normalIdentity || receiverIdentity();
    this.bootIdentity = options.bootIdentity || bootIdentityFromNormal(this.normalIdentity, 'receiver');
    this.returnedNormalIdentity = options.returnedNormalIdentity || this.normalIdentity;
  }

  isConnected() {
    return this.connected && !this.closed;
  }

  onData(listener) {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  onDisconnect(listener) {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  _emitData(data) {
    for (const listener of this.dataListeners) listener(data);
  }

  _detach() {
    this.connected = false;
    for (const listener of this.disconnectListeners) listener({ kind: 'disconnected' });
  }

  _attach(identity) {
    this.identity = { ...identity };
    this.connected = true;
  }

  async openNormal({ reviewedIdentity }) {
    this._attach(reviewedIdentity || this.normalIdentity);
    return this.getIdentity();
  }

  getIdentity() {
    return this.identity ? { ...this.identity } : null;
  }

  async waitForIdentity(request) {
    if (typeof this.options.identityPlan === 'function') {
      return this.options.identityPlan(request, this);
    }
    if (request.phase === 'boot-confirmation') {
      const count = this.options.bootCandidates;
      if (count === 0) return [];
      if (Number.isInteger(count) && count > 1) {
        const candidates = [];
        for (let i = 0; i < count; i += 1) {
          candidates.push({ ...this.bootIdentity, path: `${this.bootIdentity.path}-${i}` });
        }
        return candidates;
      }
      this._attach(this.bootIdentity);
      return this.getIdentity();
    }
    if (request.phase === 'normal-reconnect') {
      this._attach(this.returnedNormalIdentity);
      return this.getIdentity();
    }
    throw new Error(`unexpected identity phase ${request.phase}`);
  }

  async write(packet, meta) {
    if (!this.isConnected()) throw new Error('mock native handle is disconnected');
    this.writes.push({ packet: Buffer.from(packet), meta: { ...meta } });
    if (meta.phase === 'enter-boot') {
      if (typeof this.options.onEnter === 'function') this.options.onEnter(this);
      this._detach();
      return { dispatched: true };
    }
    if (this.options.holdPhase === meta.phase) {
      if (!this.entered) this.entered = new Promise((resolve) => { this.releaseHeld = resolve; });
      await this.entered;
    }
    if (this.options.rejectPhase === meta.phase) {
      setImmediate(() => this._emitData(firmware.buildFlagResponse(1)));
      return { dispatched: true };
    }
    setImmediate(() => {
      this._emitData(firmware.buildFlagResponse(0));
      if (meta.phase === 'success') {
        if (typeof this.options.onFlashed === 'function') this.options.onFlashed(this);
        this._detach();
      }
    });
    return { dispatched: true };
  }

  releaseHeldWrite() {
    if (this.releaseHeld) {
      const release = this.releaseHeld;
      this.releaseHeld = null;
      release();
    }
  }

  cancel() {
    this._detach();
    return true;
  }

  async close() {
    this.closed = true;
    this.connected = false;
    this.dataListeners.clear();
    this.disconnectListeners.clear();
  }
}

class MockSessionTransport {
  constructor(options = {}) {
    this.options = options;
    const identity = options.identity || receiverIdentity();
    this.device = {};
    this.deviceInfo = { ...identity };
    this.lastState = {
      connected: true,
      device: { ...identity },
      info: clone(options.info || RECEIVER_INFO_BEFORE)
    };
    this.firmwareTopologyIdentity = options.omitTopology ? undefined : { ...identity };
    this.generation = 7;
    this.resetEpoch = 3;
    this.needsReconnect = false;
    this.calls = [];
    this.owner = null;
    this.reconnected = false;
    this._afterInfo = options.afterInfo || RECEIVER_INFO_AFTER;
    this._returnedIdentity = options.returnedIdentity || identity;
  }

  async readFirmwareInfo(options = {}) {
    this.calls.push({ kind: 'read-version', owner: Boolean(options.ownerToken) });
    const identity = this.reconnected
      ? this._returnedIdentity
      : (this.firmwareTopologyIdentity || this.lastState.device);
    const info = this.reconnected ? clone(this._afterInfo) : clone(this.lastState.info);
    this.lastState.info = info;
    return {
      success: true,
      identity: { ...identity },
      info
    };
  }

  async acquireFirmwareOwnership(expected) {
    this.calls.push({ kind: 'acquire' });
    if (this.owner) return { success: false, error: 'already owned', reason: 'busy' };
    this.owner = { owner: 'session' };
    return {
      success: true,
      token: this.owner,
      identity: { ...this.firmwareTopologyIdentity },
      generation: this.generation,
      resetEpoch: this.resetEpoch
    };
  }

  async backupFirmwareConfiguration(options = {}) {
    this.calls.push({ kind: 'backup', path: options.filePath, owner: options.ownerToken === this.owner });
    if (this.options.backupFailure) return { success: false, error: 'mock backup failed', backupRetained: true };
    return {
      success: true,
      persisted: true,
      readyForUpdate: true,
      filePath: options.filePath,
      backupRetained: true,
      backup: { schema: 'fixture-backup' }
    };
  }

  async closeFirmwareNormalHandle(ownerToken) {
    this.calls.push({ kind: 'close-normal', owner: ownerToken === this.owner });
    if (ownerToken !== this.owner) return { success: false, error: 'owner mismatch' };
    this.device = null;
    return { success: true, disconnected: true };
  }

  connect(targetPath = null, options = {}) {
    const ownerToken = options && options.firmwareOwner ? options.firmwareOwner : null;
    this.calls.push({ kind: 'connect', path: targetPath, owner: ownerToken === this.owner });
    if (this.owner && ownerToken !== this.owner) {
      return { success: false, error: 'Firmware updater owns the device transport', updaterOwned: true };
    }
    this.reconnected = true;
    this.device = {};
    this.deviceInfo = { ...this._returnedIdentity };
    this.lastState.device = { ...this._returnedIdentity };
    this.lastState.connected = true;
    return { success: true, device: { ...this._returnedIdentity } };
  }

  async connectFirmwareNormal(identity, ownerToken) {
    this.calls.push({ kind: 'connect-normal', path: identity && identity.path, owner: ownerToken === this.owner });
    if (ownerToken !== this.owner) return { success: false, error: 'owner mismatch' };
    this.reconnected = true;
    this.device = {};
    this.deviceInfo = { ...this._returnedIdentity };
    this.lastState.device = { ...this._returnedIdentity };
    this.lastState.connected = true;
    return { success: true, identity: { ...this._returnedIdentity } };
  }

  async restoreFirmwareConfiguration(source, options = {}) {
    this.calls.push({ kind: 'restore', source, owner: options.ownerToken === this.owner });
    if (this.options.restoreFailure) {
      return {
        success: false,
        error: 'mock restore failed after writes',
        writesStarted: true,
        partial: true,
        restorationVerified: false,
        backupRetained: true
      };
    }
    return { success: true, restorationVerified: true, backupRetained: true };
  }

  async releaseFirmwareOwnership(ownerToken) {
    this.calls.push({ kind: 'release', owner: ownerToken === this.owner });
    if (ownerToken !== this.owner) return { success: false, error: 'owner mismatch' };
    this.owner = null;
    return { success: true, released: true };
  }
}

function createSessionDoubles(options = {}) {
  const identity = options.omitTopology
    ? (options.identity || nodeHidReceiverHandle())
    : (options.identity || receiverIdentity());
  const catalog = options.catalog || createMockUiCatalog();
  const transport = new MockSessionTransport({
    identity,
    omitTopology: options.omitTopology,
    info: options.info,
    afterInfo: options.afterInfo,
    returnedIdentity: options.returnedIdentity || identity,
    backupFailure: options.backupFailure,
    restoreFailure: options.restoreFailure
  });
  let native = null;
  const nativeOptions = {
    normalIdentity: identity,
    bootIdentity: bootIdentityFromNormal(identity, options.targetKey || 'receiver'),
    returnedNormalIdentity: options.returnedIdentity || identity,
    holdPhase: options.holdPhase,
    rejectPhase: options.rejectPhase
  };
  return {
    catalog,
    transport,
    identity,
    getNative: () => native,
    nativeIoFactory: () => {
      native = new MockNativeFirmwareIo(nativeOptions);
      return native;
    }
  };
}

module.exports = {
  KEYBOARD_BYTES,
  RECEIVER_BYTES,
  MISMATCH_BYTES,
  RECEIVER_INFO_BEFORE,
  RECEIVER_INFO_AFTER,
  KEYBOARD_INFO_BEFORE,
  KEYBOARD_INFO_AFTER,
  createMockUiCatalog,
  nodeHidReceiverHandle,
  receiverIdentity,
  keyboardIdentity,
  bootIdentityFromNormal,
  MockNativeFirmwareIo,
  MockSessionTransport,
  createSessionDoubles
};
