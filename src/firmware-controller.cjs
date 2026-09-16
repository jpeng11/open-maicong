'use strict';

/**
 * Exclusive native G75 V2 firmware update controller.
 *
 * This module is deliberately not wired to Electron, IPC, startup, or a
 * download service.  A caller supplies a fresh topology-backed normal
 * identity during review, presents the returned review token to the user, and
 * calls start() only after an explicit confirmation.  The controller then
 * owns the existing configuration transport until the native adapter has been
 * closed, the exact normal collection has been reconnected, the real version
 * has been read back, and the persisted backup has been verified restored.
 */

const crypto = require('node:crypto');

const firmware = require('./firmware-protocol.cjs');
const firmwareBackup = require('./firmware-backup.cjs');
const { FirmwareTransferCoordinator } = require('./firmware-transfer.cjs');
const { NativeFirmwareIo } = require('./firmware-native.cjs');

const DEFAULT_REVIEW_TTL_MS = 5 * 60 * 1000;

function realClock() {
  return {
    now: () => Date.now()
  };
}

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function identitySnapshot(identity) {
  if (!identity || typeof identity !== 'object') return null;
  return {
    vendorId: identity.vendorId,
    productId: identity.productId,
    interface: identity.interface,
    usagePage: identity.usagePage,
    usage: identity.usage,
    serialNumber: identity.serialNumber == null ? null : String(identity.serialNumber),
    path: identity.path == null ? null : String(identity.path),
    locationId: identity.locationId ?? identity.locationID ?? identity.usbLocation ?? identity.usbLocationId ?? null,
    registryEntryId: identity.registryEntryId ?? identity.registryEntryID ?? null,
    registryPath: identity.registryPath == null ? null : String(identity.registryPath)
  };
}

function versionSnapshot(info) {
  if (!info || typeof info !== 'object') return null;
  return {
    firmwareVersion: info.firmwareVersion ?? null,
    rawFirmwareVersion: Number.isInteger(info.rawFirmwareVersion) ? info.rawFirmwareVersion : null,
    rfFirmwareVersion: info.rfFirmwareVersion ?? null,
    rawRfFirmwareVersion: Number.isInteger(info.rawRfFirmwareVersion) ? info.rawRfFirmwareVersion : null
  };
}

function isPositiveFinite(value) {
  return Number.isFinite(value) && value > 0;
}

function safeNow(clock) {
  try {
    const value = clock && typeof clock.now === 'function' ? clock.now() : Date.now();
    return Number.isFinite(value) ? value : Date.now();
  } catch {
    return Date.now();
  }
}

function safeProgress(callback, event) {
  if (typeof callback !== 'function') return;
  try { callback(Object.freeze({ ...event })); } catch {}
}

function methodAvailable(object, name) {
  return Boolean(object && typeof object[name] === 'function');
}

class FirmwareUpdateController {
  constructor(options = {}) {
    this.transport = options.transport || require('./transport.cjs');
    this.catalog = options.catalog || firmware.OFFICIAL_CATALOG;
    this.clock = options.clock || realClock();
    this.reviewTtlMs = Number.isFinite(options.reviewTtlMs) && options.reviewTtlMs > 0
      ? options.reviewTtlMs : DEFAULT_REVIEW_TTL_MS;
    this.timeouts = options.timeouts || {};
    this.nativeIoFactory = options.nativeIoFactory || ((nativeOptions) => new NativeFirmwareIo(nativeOptions));
    this.transferFactory = options.transferFactory || ((transferOptions) => new FirmwareTransferCoordinator(transferOptions));
    this._reviews = new Map();
    this._operation = null;
  }

  _emit(operation, phase, details = {}) {
    const event = {
      phase,
      state: details.state || 'running',
      percent: Number.isFinite(details.percent) ? details.percent : undefined,
      message: details.message || undefined,
      failedPhase: details.failedPhase || undefined,
      reason: details.reason || undefined,
      operationId: operation && operation.id
    };
    if (operation) operation.progress.push(event);
    safeProgress(operation && operation.onProgress, event);
    return event;
  }

  _resultFailure(operation, details = {}) {
    const transfer = details.transfer || (operation && operation.transferResult) || null;
    const backup = details.backup || (operation && operation.backupResult) || null;
    const restoration = details.restoration || (operation && operation.restorationResult) || null;
    const error = details.error || 'Firmware update did not complete';
    const uncertain = details.uncertain !== undefined
      ? Boolean(details.uncertain)
      : Boolean(transfer && (transfer.uncertain || transfer.dispatchUnknown || transfer.priorMutation));
    const backupRetained = details.backupRetained !== undefined
      ? Boolean(details.backupRetained)
      : Boolean(
        (backup && backup.backupRetained)
        || (backup && backup.persisted)
        || (operation && operation.backupPath && backup)
      );
    const partialRestoration = Boolean(
      restoration
      && !restoration.restorationVerified
      && (restoration.partial || restoration.writesStarted || restoration.dispatched || restoration.uncertain)
    );
    const result = {
      success: false,
      fullUpdaterSuccess: false,
      phase: 'failed',
      failedPhase: details.failedPhase || (transfer && transfer.failedPhase) || 'controller',
      reason: details.reason || (transfer && transfer.reason) || 'failed',
      error,
      uncertain,
      backupPath: operation && operation.backupPath || null,
      backupRetained,
      backup: backup || null,
      transfer,
      version: details.version || operation && operation.versionResult || null,
      restoration,
      restorationVerified: Boolean(restoration && restoration.restorationVerified),
      partialRestoration,
      progress: operation ? operation.progress.slice() : [],
      ownershipReleased: details.ownershipReleased
    };
    if (details.stale) result.stale = true;
    if (details.rejected) result.rejected = true;
    if (details.dispatched !== undefined) result.dispatched = details.dispatched;
    if (details.dispatchStatus) result.dispatchStatus = details.dispatchStatus;
    this._emit(operation, 'failed', {
      state: 'failed',
      failedPhase: result.failedPhase,
      reason: result.reason,
      message: error,
      percent: 100
    });
    result.progress = operation ? operation.progress.slice() : [];
    return result;
  }

  _resultSuccess(operation) {
    const reviewedPackage = (operation.review && (operation.review.packageInfo || operation.review.package)) || null;
    return {
      success: true,
      fullUpdaterSuccess: true,
      phase: 'complete',
      targetKey: operation.review.target.key,
      targetId: operation.review.target.id,
      targetVersion: reviewedPackage && reviewedPackage.version,
      package: cloneJson(firmware.packageReview(reviewedPackage) || reviewedPackage),
      identity: identitySnapshot(operation.review.identity),
      backupPath: operation.backupPath,
      backupRetained: true,
      transfer: operation.transferResult,
      version: operation.versionResult,
      restoration: operation.restorationResult,
      restorationVerified: true,
      partialRestoration: false,
      ownershipReleased: true,
      progress: operation.progress.slice()
    };
  }

  _reviewRecordMatchesToken(record, token) {
    if (!record || !token || typeof token !== 'object') return false;
    if (token.reviewId !== record.token.reviewId
      || token.targetKey !== record.token.targetKey
      || token.targetId !== record.token.targetId
      || token.issuedAt !== record.token.issuedAt
      || token.expiresAt !== record.token.expiresAt
      || !token.package
      || token.package.sha256 !== record.token.package.sha256
      || token.package.size !== record.token.package.size) return false;
    return firmwareBackup.identitiesMatch(record.identity, token.identity);
  }

  _validateToken(token, { requireUnexpired = true } = {}) {
    const record = token && typeof token.reviewId === 'string' ? this._reviews.get(token.reviewId) : null;
    if (!record || !this._reviewRecordMatchesToken(record, token)) {
      return { valid: false, error: 'Firmware review token is unknown or has been altered', reason: 'stale-review' };
    }
    const now = safeNow(this.clock);
    if (requireUnexpired && now >= record.token.expiresAt) {
      this._reviews.delete(record.token.reviewId);
      return { valid: false, error: 'Firmware review token has expired; review the device and package again', reason: 'expired-review' };
    }
    return { valid: true, record };
  }

  _transportReviewIdentity(identity, infoResult) {
    const candidate = infoResult && infoResult.identity ? infoResult.identity : identity;
    const current = firmwareBackup.currentDeviceIdentity(this.transport, candidate || null);
    const valid = firmwareBackup.validateNormalIdentity(current, this.catalog);
    if (!valid.valid) return { valid: false, error: valid.error };
    if (identity && !firmwareBackup.identitiesMatch(identity, current)) {
      return { valid: false, error: 'Current device identity does not match the reviewed topology', reason: 'stale-review' };
    }
    return { valid: true, identity: current };
  }

  /**
   * Read-only review.  `identity` must come from a fresh native topology
   * resolver (or an equivalent caller-owned proof); product names and HID
   * paths alone are not accepted as a target identity.
   */
  async review({ target, packageBytes, identity = null, backupPath = null } = {}) {
    if (this._operation) {
      return { success: false, error: 'A firmware update is already in progress', reason: 'busy' };
    }
    const packageInfo = firmware.validateFirmwarePackage(packageBytes, target, { catalog: this.catalog });
    if (!packageInfo.valid) {
      return { success: false, error: packageInfo.error, reason: 'invalid-package' };
    }
    if (!methodAvailable(this.transport, 'readFirmwareInfo')) {
      return { success: false, error: 'Normal transport cannot perform a strict firmware-info review', reason: 'unsupported' };
    }
    if (identity && !firmware.matchesNormalIdentity(identity, packageInfo.target, this.catalog)) {
      return { success: false, error: 'Reviewed identity is not the exact normal interface for the catalog target', reason: 'unsupported-target' };
    }

    let infoResult;
    try {
      infoResult = await this.transport.readFirmwareInfo(identity ? { identity } : {});
    } catch (error) {
      return { success: false, error: error.message || String(error), reason: 'identity-error' };
    }
    if (!infoResult || !infoResult.success || !infoResult.info) {
      return {
        success: false,
        error: (infoResult && infoResult.error) || 'Current MCU/RF version could not be read',
        reason: (infoResult && infoResult.reason) || 'identity-error',
        stale: Boolean(infoResult && infoResult.stale)
      };
    }

    const identityResult = this._transportReviewIdentity(identity, infoResult);
    if (!identityResult.valid) {
      return {
        success: false,
        error: identityResult.error,
        reason: identityResult.reason || 'ambiguous-identity'
      };
    }
    const currentVersion = versionSnapshot(infoResult.info);
    if (!currentVersion) {
      return { success: false, error: 'Current MCU/RF version readback is malformed', reason: 'identity-error' };
    }
    const issuedAt = safeNow(this.clock);
    const expiresAt = issuedAt + this.reviewTtlMs;
    const reviewId = crypto.randomUUID();
    const packageReview = firmware.packageReview(packageInfo);
    const token = {
      reviewId,
      issuedAt,
      expiresAt,
      targetKey: packageInfo.targetKey,
      targetId: packageInfo.targetId,
      targetKind: packageInfo.targetKind,
      package: packageReview,
      identity: identitySnapshot(identityResult.identity),
      currentVersion,
      // This states the source of the value without treating package header
      // bytes as a version.  The package is still held privately by the
      // controller until start() consumes this token.
      versionSource: 'normal-GET_INFO-readback-and-official-catalog'
    };
    this._reviews.set(reviewId, {
      token,
      target: packageInfo.target,
      packageInfo,
      packageBytes: Buffer.from(packageInfo.bytes),
      identity: identitySnapshot(identityResult.identity),
      currentVersion,
      backupPath: typeof backupPath === 'string' && backupPath ? backupPath : null
    });
    return {
      success: true,
      reviewToken: cloneJson(token),
      target: {
        key: packageInfo.target.key,
        id: packageInfo.target.id,
        kind: packageInfo.target.kind,
        transport: packageInfo.target.transport
      },
      package: packageReview,
      identity: identitySnapshot(identityResult.identity),
      currentVersion,
      expiresAt
    };
  }

  cancel(reason = 'Firmware update cancelled by user') {
    const operation = this._operation;
    if (!operation) return { success: false, error: 'No firmware update is in progress' };
    operation.cancelRequested = true;
    operation.cancelReason = String(reason || 'Firmware update cancelled by user');
    let transferCancelled = false;
    let nativeCancelled = false;
    try {
      if (operation.transfer && typeof operation.transfer.cancel === 'function') {
        transferCancelled = Boolean(operation.transfer.cancel(operation.cancelReason));
      }
    } catch {}
    try {
      if (operation.nativeIo && typeof operation.nativeIo.cancel === 'function') {
        nativeCancelled = Boolean(operation.nativeIo.cancel(operation.cancelReason));
      }
    } catch {}
    return { success: true, transferCancelled, nativeCancelled };
  }

  _checkCancelled(operation, phase) {
    if (!operation.cancelRequested) return null;
    return this._resultFailure(operation, {
      failedPhase: phase,
      reason: 'cancelled',
      error: operation.cancelReason || 'Firmware update cancelled by user',
      uncertain: Boolean(operation.transferResult && operation.transferResult.uncertain),
      backupRetained: Boolean(operation.backupResult && (operation.backupResult.persisted || operation.backupResult.backupRetained))
    });
  }

  async _closeNative(operation) {
    if (!operation.nativeIo || operation.nativeClosed) return null;
    operation.nativeClosed = true;
    try {
      if (typeof operation.nativeIo.close === 'function') await operation.nativeIo.close();
      return null;
    } catch (error) {
      return error.message || String(error);
    }
  }

  _requiredStartHooks() {
    const required = [
      'acquireFirmwareOwnership',
      'releaseFirmwareOwnership',
      'closeFirmwareNormalHandle',
      'connectFirmwareNormal',
      'backupFirmwareConfiguration',
      'restoreFirmwareConfiguration',
      'readFirmwareInfo'
    ];
    return required.filter(name => !methodAvailable(this.transport, name));
  }

  /**
   * Explicitly confirmed update.  The method makes exactly one transfer
   * attempt; it never retries a destructive command or auto-restores a failed
   * transfer.  A persisted backup remains the recovery artifact on every
   * failure path.
   */
  async start(reviewToken, options = {}) {
    if (this._operation) {
      return { success: false, fullUpdaterSuccess: false, error: 'A firmware update is already in progress', reason: 'busy' };
    }
    if (options.confirmed !== true && options.confirm !== true && options.confirmation !== true) {
      return { success: false, fullUpdaterSuccess: false, error: 'Explicit firmware update confirmation is required', reason: 'confirmation-required' };
    }
    const validatedToken = this._validateToken(reviewToken);
    if (!validatedToken.valid) {
      return { success: false, fullUpdaterSuccess: false, error: validatedToken.error, reason: validatedToken.reason };
    }
    const missingHooks = this._requiredStartHooks();
    if (missingHooks.length > 0) {
      return {
        success: false,
        fullUpdaterSuccess: false,
        error: `Firmware updater integration is incomplete: missing ${missingHooks.join(', ')}`,
        reason: 'unsupported'
      };
    }
    const record = validatedToken.record;
    const backupPath = typeof options.backupPath === 'string' && options.backupPath
      ? options.backupPath : record.backupPath;
    if (!backupPath) {
      return {
        success: false,
        fullUpdaterSuccess: false,
        error: 'A recoverable backup path is required before firmware update confirmation',
        reason: 'backup-required'
      };
    }

    const operation = {
      id: crypto.randomUUID(),
      review: record,
      backupPath,
      onProgress: options.onProgress,
      progress: [],
      cancelRequested: false,
      cancelReason: null,
      ownerToken: null,
      nativeIo: null,
      nativeClosed: false,
      transfer: null,
      transferResult: null,
      backupResult: null,
      versionResult: null,
      restorationResult: null,
      abortListener: null
    };
    this._operation = operation;
    this._reviews.delete(record.token.reviewId);
    if (options.signal && typeof options.signal.addEventListener === 'function') {
      operation.abortListener = () => this.cancel('Firmware update cancelled by user');
      if (options.signal.aborted) operation.abortListener();
      else options.signal.addEventListener('abort', operation.abortListener, { once: true });
    }

    let outcome = null;
    let releaseError = null;
    try {
      this._emit(operation, 'preflight', { percent: 0, message: 'Rechecking the reviewed device identity and current version' });
      if (operation.cancelRequested) {
        outcome = this._checkCancelled(operation, 'preflight');
        return outcome;
      }
      let current;
      try {
        current = await this.transport.readFirmwareInfo({ identity: record.identity });
      } catch (error) {
        outcome = this._resultFailure(operation, {
          failedPhase: 'preflight',
          reason: 'identity-error',
          error: error.message || String(error),
          stale: true,
          backupRetained: false
        });
        return outcome;
      }
      if (!current || !current.success || !current.info || !current.identity
        || !firmwareBackup.identitiesMatch(record.identity, current.identity)) {
        outcome = this._resultFailure(operation, {
          failedPhase: 'preflight',
          reason: 'stale-review',
          error: (current && current.error) || 'The reviewed device identity changed before confirmation',
          stale: true,
          backupRetained: false
        });
        return outcome;
      }
      const currentVersion = versionSnapshot(current.info);
      if (!currentVersion || JSON.stringify(currentVersion) !== JSON.stringify(record.currentVersion)) {
        outcome = this._resultFailure(operation, {
          failedPhase: 'preflight',
          reason: 'stale-review',
          error: 'The current MCU/RF version changed after review; review the update again',
          stale: true,
          version: { before: record.currentVersion, current: currentVersion },
          backupRetained: false
        });
        return outcome;
      }
      operation.versionResult = { before: record.currentVersion, current: currentVersion };

      this._emit(operation, 'handoff', { percent: 1, message: 'Draining configuration work and acquiring exclusive transport ownership' });
      const acquired = await this.transport.acquireFirmwareOwnership(record.identity, {
        drainTimeoutMs: options.drainTimeoutMs
      });
      if (!acquired || !acquired.success || !acquired.token) {
        outcome = this._resultFailure(operation, {
          failedPhase: 'handoff',
          reason: (acquired && acquired.reason) || 'handoff-failed',
          error: (acquired && acquired.error) || 'Normal transport could not be handed off exclusively',
          backupRetained: false
        });
        return outcome;
      }
      operation.ownerToken = acquired.token;
      if (acquired.identity && !firmwareBackup.identitiesMatch(record.identity, acquired.identity)) {
        outcome = this._resultFailure(operation, {
          failedPhase: 'handoff',
          reason: 'stale-review',
          error: 'The device identity changed during exclusive handoff',
          stale: true,
          backupRetained: false
        });
        return outcome;
      }

      this._emit(operation, 'backup', { percent: 3, message: 'Capturing and atomically persisting the complete onboard configuration' });
      operation.backupResult = await this.transport.backupFirmwareConfiguration({
        filePath: backupPath,
        identity: record.identity,
        ownerToken: operation.ownerToken,
        onProgress: event => this._emit(operation, `backup:${event.phase || 'progress'}`, {
          percent: event.percent,
          message: event.message || 'Backing up firmware configuration'
        })
      });
      if (!operation.backupResult || !operation.backupResult.success
        || operation.backupResult.persisted !== true
        || operation.backupResult.readyForUpdate !== true
        || operation.backupResult.filePath !== backupPath) {
        outcome = this._resultFailure(operation, {
          failedPhase: 'backup',
          reason: 'backup-failed',
          error: (operation.backupResult && operation.backupResult.error) || 'Complete backup was not atomically persisted',
          backupRetained: Boolean(operation.backupResult && operation.backupResult.backupRetained)
        });
        return outcome;
      }
      const cancelledAfterBackup = this._checkCancelled(operation, 'backup');
      if (cancelledAfterBackup) {
        outcome = cancelledAfterBackup;
        return outcome;
      }

      this._emit(operation, 'normal-close', { percent: 5, message: 'Closing the normal configuration handle before native firmware ownership' });
      const closed = await this.transport.closeFirmwareNormalHandle(operation.ownerToken);
      if (!closed || !closed.success) {
        outcome = this._resultFailure(operation, {
          failedPhase: 'normal-close',
          reason: 'handoff-failed',
          error: (closed && closed.error) || 'Normal configuration handle could not be closed',
          backupRetained: true
        });
        return outcome;
      }

      this._emit(operation, 'native-open', { percent: 6, message: 'Opening the reviewed normal collection with the native adapter' });
      operation.nativeIo = await this.nativeIoFactory({
        target: record.target.key,
        catalog: this.catalog,
        timeouts: this.timeouts,
        reviewedIdentity: record.identity
      });
      if (!operation.nativeIo || !methodAvailable(operation.nativeIo, 'openNormal')) {
        outcome = this._resultFailure(operation, {
          failedPhase: 'native-open',
          reason: 'unsupported',
          error: 'Native firmware IO adapter cannot open the reviewed normal collection',
          backupRetained: true
        });
        return outcome;
      }
      await operation.nativeIo.openNormal({ target: record.target.key, reviewedIdentity: record.identity });
      const nativeIdentity = methodAvailable(operation.nativeIo, 'getIdentity')
        ? operation.nativeIo.getIdentity() : null;
      if (!nativeIdentity || !firmware.matchesNormalIdentity(nativeIdentity, record.target, this.catalog)
        || !firmwareBackup.identitiesMatch(record.identity, nativeIdentity)) {
        outcome = this._resultFailure(operation, {
          failedPhase: 'native-open',
          reason: 'ambiguous-identity',
          error: 'Native adapter opened a collection that is not the reviewed normal device',
          stale: true,
          backupRetained: true
        });
        return outcome;
      }

      operation.transfer = this.transferFactory({
        io: operation.nativeIo,
        target: record.target.key,
        catalog: this.catalog,
        packageBytes: record.packageInfo.bytes,
        normalIdentity: record.identity,
        timeouts: this.timeouts,
        signal: options.signal,
        onProgress: event => this._emit(operation, event.phase, {
          percent: event.percent,
          message: event.message,
          state: event.state,
          failedPhase: event.failedPhase,
          reason: event.reason
        })
      });
      if (!operation.transfer || !methodAvailable(operation.transfer, 'run')) {
        outcome = this._resultFailure(operation, {
          failedPhase: 'preflight',
          reason: 'unsupported',
          error: 'Firmware transfer coordinator is unavailable',
          backupRetained: true
        });
        return outcome;
      }
      const transferResult = await operation.transfer.run({
        target: record.target.key,
        catalog: this.catalog,
        packageBytes: record.packageInfo.bytes,
        normalIdentity: record.identity,
        timeouts: this.timeouts,
        signal: options.signal
      });
      operation.transferResult = transferResult;
      if (!transferResult || !transferResult.success || transferResult.fullUpdaterSuccess === true) {
        if (!transferResult || !transferResult.success) {
          outcome = this._resultFailure(operation, {
            failedPhase: (transferResult && transferResult.failedPhase) || 'transfer',
            reason: (transferResult && transferResult.reason) || 'transfer-failed',
            error: (transferResult && transferResult.error) || 'Firmware transfer failed',
            uncertain: Boolean(transferResult && transferResult.uncertain),
            rejected: Boolean(transferResult && transferResult.rejected),
            dispatched: transferResult && transferResult.dispatched,
            dispatchStatus: transferResult && transferResult.dispatchStatus,
            backupRetained: true
          });
          return outcome;
        }
      }
      if (operation.cancelRequested) {
        outcome = this._resultFailure(operation, {
          failedPhase: 'transfer',
          reason: 'cancelled',
          error: operation.cancelReason || 'Firmware update cancelled by user',
          uncertain: Boolean(transferResult.uncertain),
          backupRetained: true
        });
        return outcome;
      }

      const returnedIdentity = transferResult.returnedNormalIdentity;
      if (!returnedIdentity || !firmware.matchesNormalIdentity(returnedIdentity, record.target, this.catalog)
        || !firmwareBackup.identitiesMatch(record.identity, returnedIdentity)) {
        outcome = this._resultFailure(operation, {
          failedPhase: 'normal-reconnect',
          reason: 'ambiguous-identity',
          error: 'Transfer returned without a verified same-device normal identity',
          uncertain: true,
          backupRetained: true
        });
        return outcome;
      }

      this._emit(operation, 'native-close', { percent: 98, message: 'Closing the native handle before normal transport reconnect' });
      const nativeCloseError = await this._closeNative(operation);
      if (nativeCloseError) {
        outcome = this._resultFailure(operation, {
          failedPhase: 'native-close',
          reason: 'handoff-failed',
          error: nativeCloseError,
          uncertain: true,
          backupRetained: true
        });
        return outcome;
      }

      this._emit(operation, 'normal-reconnect', { percent: 98, message: 'Reconnecting the exact verified normal HID path' });
      const reconnect = await this.transport.connectFirmwareNormal(returnedIdentity, operation.ownerToken);
      if (!reconnect || !reconnect.success) {
        outcome = this._resultFailure(operation, {
          failedPhase: 'normal-reconnect',
          reason: (reconnect && reconnect.reason) || 'ambiguous-identity',
          error: (reconnect && reconnect.error) || 'Verified normal transport reconnect failed',
          stale: Boolean(reconnect && reconnect.stale),
          uncertain: true,
          backupRetained: true
        });
        return outcome;
      }

      this._emit(operation, 'version-readback', { percent: 99, message: 'Reading the actual MCU/RF version from the reconnected device' });
      const afterVersion = await this.transport.readFirmwareInfo({
        identity: returnedIdentity,
        ownerToken: operation.ownerToken
      });
      const expectedField = record.target.package && record.target.package.firmwareField;
      const expectedRaw = record.target.package && record.target.package.versionNumber;
      const actualInfo = afterVersion && afterVersion.info;
      const actualRaw = actualInfo && expectedField ? actualInfo[`raw${expectedField[0].toUpperCase()}${expectedField.slice(1)}`] : null;
      const identityVerified = Boolean(
        afterVersion && afterVersion.success && afterVersion.identity
        && firmwareBackup.identitiesMatch(returnedIdentity, afterVersion.identity)
      );
      const versionMatched = identityVerified
        && Number.isInteger(actualRaw)
        && firmware.catalogVersionMatchesRaw(actualRaw, record.target.package);
      operation.versionResult = {
        before: record.currentVersion,
        after: versionSnapshot(actualInfo),
        field: expectedField,
        expected: expectedRaw,
        actual: Number.isInteger(actualRaw) ? actualRaw : null,
        matched: versionMatched
      };
      if (!operation.versionResult.matched) {
        outcome = this._resultFailure(operation, {
          failedPhase: 'version-readback',
          reason: 'version-mismatch',
          error: (afterVersion && afterVersion.error) || `Post-update ${expectedField || 'firmware'} version did not match the reviewed catalog package`,
          uncertain: true,
          backupRetained: true,
          version: operation.versionResult
        });
        return outcome;
      }

      this._emit(operation, 'restore', { percent: 99, message: 'Restoring the persisted complete configuration and verifying readback' });
      operation.restorationResult = await this.transport.restoreFirmwareConfiguration(backupPath, {
        filePath: backupPath,
        identity: returnedIdentity,
        ownerToken: operation.ownerToken,
        onProgress: event => this._emit(operation, `restore:${event.phase || 'progress'}`, {
          percent: event.percent,
          message: event.message || 'Restoring firmware configuration'
        })
      });
      if (!operation.restorationResult || !operation.restorationResult.success
        || operation.restorationResult.restorationVerified !== true) {
        outcome = this._resultFailure(operation, {
          failedPhase: (operation.restorationResult && operation.restorationResult.failedSection) || 'restore',
          reason: 'restoration-failed',
          error: (operation.restorationResult && operation.restorationResult.error) || 'Configuration restoration was not verified',
          uncertain: Boolean(operation.restorationResult && operation.restorationResult.uncertain),
          backupRetained: true
        });
        return outcome;
      }
      this._emit(operation, 'complete', { state: 'completed', percent: 100, message: 'Firmware version and complete configuration restoration verified' });
      outcome = this._resultSuccess(operation);
      return outcome;
    } catch (error) {
      outcome = this._resultFailure(operation, {
        failedPhase: (operation.transferResult && operation.transferResult.failedPhase) || 'controller',
        reason: operation.cancelRequested ? 'cancelled' : (error.reason || 'controller-error'),
        error: error.message || String(error),
        uncertain: Boolean(operation.transferResult && operation.transferResult.uncertain),
        backupRetained: Boolean(operation.backupResult && (operation.backupResult.persisted || operation.backupResult.backupRetained))
      });
      return outcome;
    } finally {
      if (operation.abortListener && options.signal && typeof options.signal.removeEventListener === 'function') {
        options.signal.removeEventListener('abort', operation.abortListener);
      }
      if (operation.nativeIo && !operation.nativeClosed) {
        const closeError = await this._closeNative(operation);
        if (closeError && outcome && outcome.success) {
          outcome = this._resultFailure(operation, {
            failedPhase: 'native-close',
            reason: 'handoff-failed',
            error: closeError,
            uncertain: true,
            backupRetained: true
          });
        }
      }
      if (operation.ownerToken) {
        try {
          const released = await this.transport.releaseFirmwareOwnership(operation.ownerToken);
          if (!released || !released.success) releaseError = (released && released.error) || 'Firmware transport ownership could not be released';
        } catch (error) {
          releaseError = error.message || String(error);
        }
      }
      if (releaseError && outcome && outcome.success) {
        outcome = this._resultFailure(operation, {
          failedPhase: 'handoff-release',
          reason: 'handoff-failed',
          error: releaseError,
          uncertain: true,
          backupRetained: true,
          ownershipReleased: false
        });
      } else if (outcome) {
        outcome.ownershipReleased = !releaseError;
        outcome.progress = operation.progress.slice();
      }
      this._operation = null;
    }
  }
}

module.exports = {
  DEFAULT_REVIEW_TTL_MS,
  FirmwareUpdateController,
  identitySnapshot,
  versionSnapshot
};
