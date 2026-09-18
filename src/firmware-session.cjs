'use strict';

/**
 * Electron-facing G75 V2 firmware session.
 *
 * Target is the connected normal HID identity (wired keyboard vs 2.4G
 * receiver). A user-chosen local file must match that identity's official
 * catalog size/hash. Keyboard packages are refused on a receiver; receiver
 * packages are refused on wired USB. Review is read-only; start() requires
 * an explicit confirmation and uses the session-stored review token.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const firmware = require('./firmware-protocol.cjs');
const firmwareBackup = require('./firmware-backup.cjs');
const firmwareNative = require('./firmware-native.cjs');
const {
  FirmwareUpdateController,
  identitySnapshot
} = require('./firmware-controller.cjs');

const MODE_RULES = Object.freeze({
  keyboard: Object.freeze({
    kind: 'keyboard',
    requiredTransport: 'wired-usb',
    requiredPid: firmware.NORMAL_PIDS.WIRED_KEYBOARD,
    error: 'Keyboard firmware can be upgraded only in wired USB mode',
    reason: 'require-wired',
    hint: 'Connect the keyboard with USB and choose the official keyboard package.'
  }),
  receiver: Object.freeze({
    kind: 'receiver',
    requiredTransport: 'wireless-receiver-usb',
    requiredPid: firmware.NORMAL_PIDS.WIRELESS_RECEIVER,
    error: 'Receiver firmware can be upgraded only in 2.4G wireless mode',
    reason: 'require-wireless',
    hint: 'Keep the 2.4G receiver connected and choose the official receiver package.'
  })
});

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function asBuffer(bytes) {
  if (Buffer.isBuffer(bytes)) return bytes;
  if (bytes instanceof Uint8Array) return Buffer.from(bytes);
  return null;
}

function publicPackage(entry) {
  if (!entry || !entry.package) return null;
  return {
    fileName: entry.package.fileName,
    size: entry.package.size,
    sha256: entry.package.sha256,
    version: entry.package.version,
    versionNumber: entry.package.versionNumber
  };
}

function publicTarget(entry) {
  if (!entry) return null;
  return {
    key: entry.key,
    id: entry.id,
    kind: entry.kind,
    transport: entry.transport,
    boot: entry.boot ? { ...entry.boot } : null,
    package: publicPackage(entry)
  };
}

function classifyPackage(bytes, catalog) {
  const data = asBuffer(bytes);
  if (!data) return { matched: false, error: 'Firmware package bytes are missing' };
  const matches = [];
  for (const entry of firmware.catalogEntries(catalog)) {
    const result = firmware.validateFirmwarePackage(data, entry, { catalog });
    if (result.valid) matches.push({ entry, result });
  }
  if (matches.length === 1) {
    return { matched: true, entry: matches[0].entry, result: matches[0].result };
  }
  if (matches.length > 1) {
    return { matched: false, error: 'Firmware package matches more than one catalog target', reason: 'invalid-package' };
  }
  return {
    matched: false,
    error: 'Firmware package does not match the official catalog size and SHA-256',
    reason: 'invalid-package'
  };
}

function defaultBackupPath(backupDir, targetKey) {
  const safeKey = String(targetKey || 'firmware').replace(/[^a-z0-9_-]+/gi, '-');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const name = `g75v2-${safeKey}-backup-${stamp}-${crypto.randomUUID()}.json`;
  return path.join(backupDir || require('node:os').tmpdir(), name);
}

class FirmwareSession {
  constructor(options = {}) {
    this.transport = options.transport;
    this.catalog = options.catalog || firmware.OFFICIAL_CATALOG;
    this.readFile = options.readFile || ((filePath) => fs.readFileSync(filePath));
    this.chooseFile = options.chooseFile || null;
    this.backupDir = options.backupDir || null;
    this.topologyProcessRunner = options.topologyProcessRunner || null;
    this.onProgress = options.onProgress || null;
    this.nativeWrites = [];
    const nativeIoFactory = options.nativeIoFactory || null;
    this.controller = options.controller || new FirmwareUpdateController({
      transport: this.transport,
      catalog: this.catalog,
      nativeIoFactory: nativeIoFactory
        ? (nativeOptions) => {
          const io = nativeIoFactory(nativeOptions);
          this._nativeIo = io;
          return io;
        }
        : undefined,
      transferFactory: options.transferFactory,
      timeouts: options.timeouts,
      reviewTtlMs: options.reviewTtlMs
    });
    this._nativeIo = null;
    this._selected = null;
    this._review = null;
    this._progress = [];
    this._lastOutcome = null;
  }

  _identity() {
    return firmwareBackup.currentDeviceIdentity(this.transport);
  }

  async _ensureFirmwareTopology() {
    let identity = this._identity();
    if (firmware.hasStableUsbLocation(identity)) return { valid: true, identity };
    const pending = this.transport && this.transport._firmwareTopologyPromise;
    if (pending && typeof pending.then === 'function') {
      try { await pending; } catch {}
      identity = this._identity();
      if (firmware.hasStableUsbLocation(identity)) return { valid: true, identity };
    }
    const attachOptions = {
      catalog: this.catalog,
      processRunner: this.topologyProcessRunner || (this.transport && this.transport.topologyProcessRunner)
    };
    let attached;
    try {
      if (this.transport && typeof this.transport.attachFirmwareTopology === 'function') {
        attached = await this.transport.attachFirmwareTopology(attachOptions);
      } else {
        attached = await firmwareNative.attachLiveHandleTopology(this.transport, attachOptions);
      }
    } catch (error) {
      attached = {
        valid: false,
        reason: 'topology-error',
        error: error && error.message ? error.message : 'USB topology correlation failed'
      };
    }
    identity = this._identity();
    if (firmware.hasStableUsbLocation(identity)) return { valid: true, identity };
    return {
      valid: false,
      reason: (attached && attached.reason) || 'ambiguous-identity',
      error: (attached && attached.error) || 'Device identity has no stable USB LocationID topology evidence'
    };
  }

  _identify() {
    return firmware.identifyNormalTarget(this._identity(), this.catalog);
  }

  _enforceMode(target, identity) {
    if (!target || !target.kind) {
      return { ok: false, error: 'Firmware target is unknown', reason: 'unsupported-target' };
    }
    const rule = MODE_RULES[target.kind];
    if (!rule) {
      return { ok: false, error: 'Firmware target is unknown', reason: 'unsupported-target' };
    }
    if (!identity || identity.productId !== rule.requiredPid
      || !firmware.matchesNormalIdentity(identity, target, this.catalog)) {
      return { ok: false, error: rule.error, reason: rule.reason, hint: rule.hint, rule };
    }
    return { ok: true, rule };
  }

  nativeWriteCount() {
    const io = this._nativeIo;
    const writes = io && Array.isArray(io.writes) ? io.writes : this.nativeWrites;
    return writes.length;
  }

  nativeWritePhases() {
    const io = this._nativeIo;
    const writes = io && Array.isArray(io.writes) ? io.writes : this.nativeWrites;
    return writes.map((write) => write && write.meta && write.meta.phase).filter(Boolean);
  }

  status() {
    const identity = this._identity();
    const identified = firmware.identifyNormalTarget(identity, this.catalog);
    const info = (this.transport && this.transport.lastState && this.transport.lastState.info) || {};
    const target = identified.valid ? identified.target : null;
    const mode = target ? MODE_RULES[target.kind] : null;
    const connected = Boolean(this.transport && this.transport.lastState && this.transport.lastState.connected);
    return {
      success: true,
      connected,
      identity: identitySnapshot(identity),
      target: publicTarget(target),
      targetError: identified.valid ? null : identified.error,
      modeRule: mode ? cloneJson(mode) : null,
      versions: {
        firmwareVersion: info.firmwareVersion ?? null,
        rawFirmwareVersion: Number.isInteger(info.rawFirmwareVersion) ? info.rawFirmwareVersion : null,
        rfFirmwareVersion: info.rfFirmwareVersion ?? null,
        rawRfFirmwareVersion: Number.isInteger(info.rawRfFirmwareVersion) ? info.rawRfFirmwareVersion : null
      },
      selectedPackage: this._selected ? {
        filePath: this._selected.filePath,
        fileName: this._selected.fileName,
        size: this._selected.bytes.length
      } : null,
      review: this._review ? {
        target: this._review.target,
        package: this._review.package,
        currentVersion: this._review.currentVersion,
        expiresAt: this._review.expiresAt,
        boot: this._review.target && this._review.target.boot ? this._review.target.boot : (target && target.boot),
        modeRule: mode ? cloneJson(mode) : null
      } : null,
      inProgress: this.isUpdateInFlight(),
      progress: this._progress.slice(),
      lastOutcome: this._lastOutcome,
      nativeWriteCount: this.nativeWriteCount(),
      nativeWritePhases: this.nativeWritePhases()
    };
  }

  selectPackageFromBytes(bytes, filePath = null) {
    const data = asBuffer(bytes);
    if (!data) {
      return { success: false, error: 'Firmware package bytes are missing', reason: 'invalid-package' };
    }
    this._selected = {
      filePath: filePath || null,
      fileName: filePath ? path.basename(filePath) : 'firmware.bin',
      bytes: Buffer.from(data)
    };
    this._review = null;
    return {
      success: true,
      filePath: this._selected.filePath,
      fileName: this._selected.fileName,
      size: this._selected.bytes.length
    };
  }

  selectPackageFile(filePath) {
    if (typeof filePath !== 'string' || !filePath) {
      return { success: false, error: 'A firmware package file path is required', reason: 'invalid-package' };
    }
    let bytes;
    try {
      bytes = this.readFile(filePath);
    } catch (err) {
      return { success: false, error: err.message || String(err), reason: 'invalid-package' };
    }
    return this.selectPackageFromBytes(bytes, filePath);
  }

  async choosePackage() {
    if (typeof this.chooseFile !== 'function') {
      return { success: false, error: 'No firmware package picker is available', reason: 'unsupported' };
    }
    let picked;
    try {
      picked = await this.chooseFile();
    } catch (err) {
      return { success: false, error: err.message || String(err), reason: 'invalid-package' };
    }
    if (!picked || picked.canceled || !picked.filePath) {
      return { success: false, canceled: true };
    }
    return this.selectPackageFile(picked.filePath);
  }

  async review(options = {}) {
    if (this.controller && this.controller._operation) {
      return { success: false, error: 'A firmware update is already in progress', reason: 'busy' };
    }
    const topology = await this._ensureFirmwareTopology();
    if (!topology.valid) {
      return {
        success: false,
        error: topology.error,
        reason: topology.reason || 'ambiguous-identity',
        nativeWriteCount: this.nativeWriteCount()
      };
    }
    const identity = topology.identity || this._identity();
    const identified = firmware.identifyNormalTarget(identity, this.catalog);
    if (!identified.valid) {
      return { success: false, error: identified.error, reason: 'unsupported-target' };
    }
    const mode = this._enforceMode(identified.target, identity);
    if (!mode.ok) {
      return { success: false, error: mode.error, reason: mode.reason, hint: mode.hint };
    }

    let bytes = asBuffer(options.packageBytes);
    let filePath = typeof options.filePath === 'string' ? options.filePath : null;
    if (!bytes && filePath) {
      const loaded = this.selectPackageFile(filePath);
      if (!loaded.success) return loaded;
      bytes = this._selected.bytes;
    }
    if (!bytes && this._selected) bytes = this._selected.bytes;
    if (!bytes) {
      return { success: false, error: 'Choose an official firmware package file first', reason: 'invalid-package' };
    }

    const classified = classifyPackage(bytes, this.catalog);
    if (classified.matched && classified.entry.key !== identified.target.key) {
      const other = this._enforceMode(classified.entry, identity);
      const fallback = classified.entry.kind === 'keyboard' ? MODE_RULES.keyboard : MODE_RULES.receiver;
      return {
        success: false,
        error: other.error || fallback.error,
        reason: other.reason || fallback.reason,
        hint: other.hint || fallback.hint,
        nativeWriteCount: this.nativeWriteCount()
      };
    }
    if (!classified.matched) {
      return {
        success: false,
        error: classified.error,
        reason: classified.reason || 'invalid-package',
        nativeWriteCount: this.nativeWriteCount()
      };
    }

    const backupPath = typeof options.backupPath === 'string' && options.backupPath
      ? options.backupPath
      : defaultBackupPath(this.backupDir, identified.target.key);

    const result = await this.controller.review({
      target: identified.target.key,
      packageBytes: bytes,
      identity,
      backupPath
    });
    if (!result || !result.success) {
      this._review = null;
      return {
        ...(result || { success: false, error: 'Firmware review failed' }),
        nativeWriteCount: this.nativeWriteCount()
      };
    }
    this._review = {
      ...result,
      backupPath,
      boot: identified.target.boot
    };
    return {
      success: true,
      target: result.target,
      package: result.package,
      identity: result.identity,
      currentVersion: result.currentVersion,
      expiresAt: result.expiresAt,
      boot: identified.target.boot,
      modeRule: cloneJson(mode.rule),
      backupPath,
      nativeWriteCount: this.nativeWriteCount()
    };
  }

  dismissReview() {
    this._review = null;
    return { success: true, nativeWriteCount: this.nativeWriteCount() };
  }

  async confirmStart(options = {}) {
    const confirmed = options.confirmed === true || options.confirm === true || options.confirmation === true;
    if (!confirmed) {
      const denied = await this.controller.start(this._review && this._review.reviewToken, { confirmed: false });
      return {
        ...(denied || {
          success: false,
          fullUpdaterSuccess: false,
          error: 'Explicit firmware update confirmation is required',
          reason: 'confirmation-required'
        }),
        nativeWriteCount: this.nativeWriteCount(),
        nativeWritePhases: this.nativeWritePhases()
      };
    }
    if (!this._review || !this._review.reviewToken) {
      return {
        success: false,
        fullUpdaterSuccess: false,
        error: 'Review the firmware package before confirming the update',
        reason: 'review-required',
        nativeWriteCount: this.nativeWriteCount(),
        nativeWritePhases: this.nativeWritePhases()
      };
    }
    this._progress = [];
    const result = await this.controller.start(this._review.reviewToken, {
      confirmed: true,
      backupPath: options.backupPath || this._review.backupPath,
      onProgress: (event) => {
        this._progress.push(event);
        if (typeof this.onProgress === 'function') this.onProgress(event);
        if (typeof options.onProgress === 'function') options.onProgress(event);
      },
      signal: options.signal,
      drainTimeoutMs: options.drainTimeoutMs
    });
    this._lastOutcome = result;
    if (result && result.success) this._review = null;
    return {
      ...result,
      nativeWriteCount: this.nativeWriteCount(),
      nativeWritePhases: this.nativeWritePhases()
    };
  }

  cancel(reason = 'Firmware update cancelled by user') {
    const result = this.controller.cancel(reason);
    return {
      ...result,
      nativeWriteCount: this.nativeWriteCount(),
      nativeWritePhases: this.nativeWritePhases()
    };
  }

  isUpdateInFlight() {
    return Boolean(this.controller && this.controller._operation);
  }

  interruptedUpdateStatus() {
    return this.controller.interruptedUpdateStatus({ backupDir: this.backupDir });
  }

  discardInterruptedUpdate() {
    return this.controller.discardInterruptedUpdate({ backupDir: this.backupDir });
  }

  async resumeInterruptedUpdate(options = {}) {
    const confirmed = options.confirmed === true || options.confirm === true || options.confirmation === true;
    if (!confirmed) {
      const denied = await this.controller.resumeInterruptedUpdate({
        confirmed: false,
        backupDir: this.backupDir
      });
      return {
        ...(denied || {
          success: false,
          fullUpdaterSuccess: false,
          error: 'Explicit firmware update confirmation is required',
          reason: 'confirmation-required'
        }),
        nativeWriteCount: this.nativeWriteCount(),
        nativeWritePhases: this.nativeWritePhases()
      };
    }

    let bytes = asBuffer(options.packageBytes);
    if (!bytes && this._selected) bytes = this._selected.bytes;
    if (!bytes && typeof options.filePath === 'string' && options.filePath) {
      const loaded = this.selectPackageFile(options.filePath);
      if (!loaded.success) {
        return {
          ...loaded,
          fullUpdaterSuccess: false,
          nativeWriteCount: this.nativeWriteCount(),
          nativeWritePhases: this.nativeWritePhases()
        };
      }
      bytes = this._selected.bytes;
    }
    if (!bytes) {
      return {
        success: false,
        fullUpdaterSuccess: false,
        error: 'Choose an official firmware package file first',
        reason: 'invalid-package',
        nativeWriteCount: this.nativeWriteCount(),
        nativeWritePhases: this.nativeWritePhases()
      };
    }

    this._progress = [];
    const result = await this.controller.resumeInterruptedUpdate({
      confirmed: true,
      backupDir: this.backupDir,
      packageBytes: bytes,
      allowDifferentPackage: options.allowDifferentPackage === true,
      backupPath: typeof options.backupPath === 'string' && options.backupPath
        ? options.backupPath
        : undefined,
      onProgress: (event) => {
        this._progress.push(event);
        if (typeof this.onProgress === 'function') this.onProgress(event);
        if (typeof options.onProgress === 'function') options.onProgress(event);
      },
      signal: options.signal,
      drainTimeoutMs: options.drainTimeoutMs
    });
    this._lastOutcome = result;
    return {
      ...result,
      nativeWriteCount: this.nativeWriteCount(),
      nativeWritePhases: this.nativeWritePhases()
    };
  }
}

module.exports = {
  FirmwareSession,
  MODE_RULES,
  classifyPackage,
  defaultBackupPath
};
