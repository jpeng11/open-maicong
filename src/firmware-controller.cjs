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
const fs = require('node:fs');
const path = require('node:path');

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

function resolveBootAnchorPath({ backupDir, anchorPath } = {}) {
  if (typeof anchorPath === 'string' && anchorPath) return anchorPath;
  return firmwareBackup.bootAnchorPath(backupDir);
}

function backupFilePresent(filePath) {
  if (typeof filePath !== 'string' || !filePath) return false;
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function confirmationAccepted(options = {}) {
  return options.confirmed === true || options.confirm === true || options.confirmation === true;
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
      ownershipReleased: details.ownershipReleased,
      resumedFromBoot: Boolean(operation && operation.resumedFromBoot)
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
      resumedFromBoot: Boolean(operation.resumedFromBoot),
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

  // A GET_INFO reply admitted through the echoed-checksum quirk exception (see
  // protocol.decodePacket) proves the request was heard, not that the payload
  // is intact, so it can never gate completion. Retry the read on a fresh
  // request and fail closed if the device keeps echoing.
  async _readTrustedFirmwareInfo(identity, ownerToken) {
    let result = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      result = await this.transport.readFirmwareInfo({ identity, ownerToken });
      if (!result || result.checksumEchoed !== true) break;
    }
    return result;
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
    if (!confirmationAccepted(options)) {
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
      abortListener: null,
      bootAnchorPath: null,
      bootAnchorPersisted: false,
      bootAnchorCleared: false
    };
    this._operation = operation;
    this._reviews.delete(record.token.reviewId);
    if (options.signal && typeof options.signal.addEventListener === 'function') {
      operation.abortListener = () => this.cancel('Firmware update cancelled by user');
      if (options.signal.aborted) operation.abortListener();
      else options.signal.addEventListener('abort', operation.abortListener, { once: true });
    }

    let outcome;
    let cleanup;
    try {
      outcome = await this._runUpdate(operation, options);
    } finally {
      try {
        cleanup = await this._cleanupOperation(operation, options);
      } catch (error) {
        cleanup = { closeError: error.message || String(error), releaseError: null };
      }
    }
    return this._adjustOutcome(operation, outcome, cleanup);
  }

  interruptedUpdateStatus(options = {}) {
    const filePath = resolveBootAnchorPath(options);
    if (!filePath) {
      return {
        success: false,
        present: false,
        error: 'A backup directory or boot-anchor path is required',
        reason: 'backup-required'
      };
    }
    const read = firmwareBackup.readBootAnchor(filePath);
    if (read.missing) {
      return { success: true, present: false, missing: true, filePath };
    }
    if (!read.success) {
      return {
        success: false,
        present: false,
        error: read.error || 'Boot recovery anchor could not be read',
        reason: 'invalid-anchor',
        filePath,
        retained: read.retained === true
      };
    }
    return {
      success: true,
      present: true,
      anchor: read.anchor,
      filePath,
      backupPresent: backupFilePresent(read.anchor && read.anchor.backupPath)
    };
  }

  discardInterruptedUpdate(options = {}) {
    if (this._operation) {
      return { success: false, error: 'A firmware update is already in progress', reason: 'busy' };
    }
    const filePath = resolveBootAnchorPath(options);
    if (!filePath) {
      return {
        success: false,
        cleared: false,
        error: 'A backup directory or boot-anchor path is required',
        reason: 'backup-required'
      };
    }
    const cleared = firmwareBackup.clearBootAnchor(filePath);
    if (!cleared.success) {
      return {
        success: false,
        cleared: false,
        error: cleared.error || 'Boot recovery anchor could not be discarded',
        reason: 'invalid-anchor',
        filePath
      };
    }
    return {
      success: true,
      cleared: cleared.cleared === true,
      filePath
    };
  }

  /**
   * Resume a transfer whose previous run left the device in bootloader mode.
   * There is no normal collection to own yet, so this path never calls
   * openNormal and never takes exclusive transport ownership until the
   * device is proven back in normal mode.
   */
  async resumeInterruptedUpdate(options = {}) {
    if (this._operation) {
      return { success: false, fullUpdaterSuccess: false, error: 'A firmware update is already in progress', reason: 'busy' };
    }
    if (!confirmationAccepted(options)) {
      return { success: false, fullUpdaterSuccess: false, error: 'Explicit firmware update confirmation is required', reason: 'confirmation-required' };
    }
    const missingHooks = this._requiredRecoveryHooks();
    if (missingHooks.length > 0) {
      return {
        success: false,
        fullUpdaterSuccess: false,
        error: `Firmware updater integration is incomplete: missing ${missingHooks.join(', ')}`,
        reason: 'unsupported'
      };
    }

    const filePath = resolveBootAnchorPath(options);
    if (!filePath) {
      return {
        success: false,
        fullUpdaterSuccess: false,
        error: 'A backup directory or boot-anchor path is required',
        reason: 'backup-required',
        dispatched: false,
        uncertain: false
      };
    }
    const read = firmwareBackup.readBootAnchor(filePath);
    if (read.missing) {
      return {
        success: false,
        fullUpdaterSuccess: false,
        error: 'No interrupted firmware update is waiting to be resumed',
        reason: 'missing-anchor',
        dispatched: false,
        uncertain: false,
        filePath
      };
    }
    if (!read.success || !read.anchor) {
      return {
        success: false,
        fullUpdaterSuccess: false,
        error: (read && read.error) || 'Boot recovery anchor is missing or malformed',
        reason: 'invalid-anchor',
        dispatched: false,
        uncertain: false,
        filePath
      };
    }
    const anchor = read.anchor;
    const backupPath = typeof options.backupPath === 'string' && options.backupPath
      ? options.backupPath
      : (typeof anchor.backupPath === 'string' && anchor.backupPath ? anchor.backupPath : null);
    if (!backupFilePresent(backupPath)) {
      return {
        success: false,
        fullUpdaterSuccess: false,
        error: 'The interrupted update backup file is missing; recovery cannot restore configuration',
        reason: 'backup-missing',
        dispatched: false,
        uncertain: false,
        filePath,
        backupPath
      };
    }

    const packageInfo = firmware.validateFirmwarePackage(options.packageBytes, anchor.targetKey, { catalog: this.catalog });
    if (!packageInfo.valid) {
      return {
        success: false,
        fullUpdaterSuccess: false,
        error: packageInfo.error,
        reason: 'invalid-package',
        dispatched: false,
        uncertain: false
      };
    }
    if (options.allowDifferentPackage !== true) {
      if (!firmwareBackup.isPackageSha256(anchor.packageSha256)) {
        return {
          success: false,
          fullUpdaterSuccess: false,
          error: 'Boot recovery anchor package SHA-256 is missing or malformed',
          reason: 'invalid-anchor',
          dispatched: false,
          uncertain: false
        };
      }
      if (anchor.packageSha256 !== packageInfo.sha256) {
        return {
          success: false,
          fullUpdaterSuccess: false,
          error: 'Firmware package does not match the interrupted update; pass allowDifferentPackage to reflash anyway',
          reason: 'package-mismatch',
          dispatched: false,
          uncertain: false
        };
      }
    }

    const operation = {
      id: crypto.randomUUID(),
      review: {
        target: packageInfo.target,
        packageInfo,
        identity: null,
        currentVersion: null,
        backupPath
      },
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
      backupResult: {
        success: true,
        persisted: true,
        backupRetained: true,
        filePath: backupPath
      },
      versionResult: null,
      restorationResult: null,
      abortListener: null,
      bootAnchorPath: filePath,
      bootAnchorPersisted: true,
      bootAnchorCleared: false,
      resumedFromBoot: true,
      bootAnchor: anchor
    };
    this._operation = operation;
    if (options.signal && typeof options.signal.addEventListener === 'function') {
      operation.abortListener = () => this.cancel('Firmware update cancelled by user');
      if (options.signal.aborted) operation.abortListener();
      else options.signal.addEventListener('abort', operation.abortListener, { once: true });
    }

    let outcome;
    let cleanup;
    try {
      outcome = await this._runRecovery(operation, options);
    } finally {
      try {
        cleanup = await this._cleanupOperation(operation, options);
      } catch (error) {
        cleanup = { closeError: error.message || String(error), releaseError: null };
      }
    }
    return this._adjustOutcome(operation, outcome, cleanup);
  }

  _requiredRecoveryHooks() {
    const missing = this._requiredStartHooks();
    if (!methodAvailable(this.transport, 'connect')) missing.push('connect');
    return missing;
  }

  /**
   * Releases every resource the operation held. It never determines the
   * return value: close/release failures are handed to _adjustOutcome, which
   * adjusts the result before the single real return, so they cannot be
   * discarded by a return value already captured inside a try.
   */
  async _cleanupOperation(operation, options = {}) {
    let closeError = null;
    let releaseError = null;
    try {
      if (operation.abortListener && options.signal && typeof options.signal.removeEventListener === 'function') {
        options.signal.removeEventListener('abort', operation.abortListener);
      }
      if (operation.nativeIo && !operation.nativeClosed) {
        closeError = await this._closeNative(operation);
      }
      if (operation.ownerToken) {
        try {
          const released = await this.transport.releaseFirmwareOwnership(operation.ownerToken);
          if (!released || !released.success) releaseError = (released && released.error) || 'Firmware transport ownership could not be released';
        } catch (error) {
          releaseError = error.message || String(error);
        }
      }
    } finally {
      this._operation = null;
    }
    return { closeError, releaseError };
  }

  _adjustOutcome(operation, outcome, { closeError = null, releaseError = null } = {}) {
    let result = outcome;
    if (!result || typeof result.success !== 'boolean') {
      result = this._resultFailure(operation, {
        failedPhase: 'controller',
        reason: 'controller-error',
        error: 'Firmware update returned no structured outcome',
        uncertain: true,
        backupRetained: true
      });
    }
    if (closeError && result.success) {
      result = this._resultFailure(operation, {
        failedPhase: 'native-close',
        reason: 'handoff-failed',
        error: closeError,
        uncertain: true,
        backupRetained: true
      });
    }
    if (releaseError && result.success) {
      result = this._resultFailure(operation, {
        failedPhase: 'handoff-release',
        reason: 'handoff-failed',
        error: releaseError,
        uncertain: true,
        backupRetained: true,
        ownershipReleased: false
      });
    }
    result.ownershipReleased = !releaseError;
    result.progress = operation.progress.slice();
    return result;
  }

  /**
   * Persists the boot recovery anchor next to the backup file. The transfer
   * coordinator invokes this immediately before enter-boot is dispatched and
   * aborts pre-mutation when it throws, so an interrupted update is always
   * resumable from the dispatch moment on.
   */
  _persistBootAnchor(operation, anchorData) {
    const record = operation.review;
    const anchorPath = firmwareBackup.bootAnchorPath(path.dirname(operation.backupPath));
    if (!anchorPath) throw new Error('A backup directory is required to persist the boot recovery anchor');
    const field = record.target.package && record.target.package.firmwareField;
    const rawKey = field ? `raw${field[0].toUpperCase()}${field.slice(1)}` : null;
    const beforeVersionRaw = rawKey && record.currentVersion && Number.isInteger(record.currentVersion[rawKey])
      ? record.currentVersion[rawKey]
      : null;
    const written = firmwareBackup.writeBootAnchor(anchorPath, {
      schema: firmwareBackup.BOOT_ANCHOR_SCHEMA,
      version: firmwareBackup.BOOT_ANCHOR_SCHEMA_VERSION,
      targetKey: anchorData.targetKey,
      locationId: anchorData.locationId,
      serialNumber: anchorData.serialNumber || null,
      packageSha256: anchorData.packageSha256,
      backupPath: operation.backupPath,
      firmwareField: field || null,
      beforeVersionRaw,
      enteredAt: safeNow(this.clock)
    });
    if (!written.success) throw new Error(written.error || 'Boot recovery anchor could not be persisted');
    operation.bootAnchorPath = anchorPath;
    operation.bootAnchorPersisted = true;
  }

  // The anchor only applies while the device may sit in bootloader mode. Once
  // the device is verifiably back in normal mode (or never left it), keeping
  // the anchor would only raise a spurious resume prompt.
  _clearBootAnchor(operation) {
    if (!operation.bootAnchorPath) return;
    const cleared = firmwareBackup.clearBootAnchor(operation.bootAnchorPath);
    operation.bootAnchorCleared = cleared.success === true;
  }

  /**
   * Post-update success predicate: the reconnected device must prove its
   * identity and report a trusted (non-echoed) version matching the catalog
   * pin. Same-version readback is success when the transfer already verified
   * the write. Returns null on success or a structured failure outcome.
   * Callers must restore erased configuration before invoking this.
   */
  async _runVersionGate(operation, { returnedIdentity, pkg, beforeRaw, beforeSnapshot = null, failureMessage }) {
    this._emit(operation, 'version-readback', { percent: 99, message: 'Reading the actual MCU/RF version from the reconnected device' });
    const afterVersion = await this._readTrustedFirmwareInfo(returnedIdentity, operation.ownerToken);
    const expectedField = pkg && pkg.firmwareField;
    const expectedRaw = pkg && (Number.isInteger(pkg.versionRaw) ? pkg.versionRaw : pkg.versionNumber);
    const actualInfo = afterVersion && afterVersion.info;
    const rawKey = expectedField ? `raw${expectedField[0].toUpperCase()}${expectedField.slice(1)}` : null;
    const actualRaw = actualInfo && rawKey ? actualInfo[rawKey] : null;
    const identityVerified = Boolean(
      afterVersion && afterVersion.success && afterVersion.checksumEchoed !== true && afterVersion.identity
      && firmwareBackup.identitiesMatch(returnedIdentity, afterVersion.identity)
    );
    const versionMatched = identityVerified && firmware.catalogVersionMatchesRaw(actualRaw, pkg);
    operation.versionResult = {
      before: beforeSnapshot,
      after: versionSnapshot(actualInfo),
      field: expectedField,
      expected: expectedRaw,
      beforeRaw: Number.isInteger(beforeRaw) ? beforeRaw : null,
      actual: Number.isInteger(actualRaw) ? actualRaw : null,
      matched: versionMatched
    };
    if (versionMatched) return null;
    const echoed = Boolean(afterVersion && afterVersion.checksumEchoed === true);
    return this._resultFailure(operation, {
      failedPhase: 'version-readback',
      reason: echoed ? 'version-untrusted' : 'version-mismatch',
      error: echoed
        ? 'Post-update version readback arrived with an echoed checksum and cannot be trusted'
        : ((afterVersion && afterVersion.error) || failureMessage || `Post-update ${expectedField || 'firmware'} version did not match the reviewed catalog package`),
      uncertain: true,
      backupRetained: true,
      version: operation.versionResult
    });
  }

  async _restoreThenEvaluateVersion(operation, {
    returnedIdentity,
    pkg,
    beforeRaw,
    beforeSnapshot = null,
    backupPath
  }) {
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
      return this._resultFailure(operation, {
        failedPhase: (operation.restorationResult && operation.restorationResult.failedSection) || 'restore',
        reason: 'restoration-failed',
        error: (operation.restorationResult && operation.restorationResult.error) || 'Configuration restoration was not verified',
        uncertain: Boolean(operation.restorationResult && operation.restorationResult.uncertain),
        backupRetained: true
      });
    }

    const versionFailure = await this._runVersionGate(operation, {
      returnedIdentity,
      pkg,
      beforeRaw,
      beforeSnapshot
    });
    if (versionFailure) return versionFailure;

    this._emit(operation, 'complete', { state: 'completed', percent: 100, message: 'Firmware version and complete configuration restoration verified' });
    const outcome = this._resultSuccess(operation);
    outcome.bootAnchorCleared = operation.bootAnchorCleared === true;
    return outcome;
  }

  /**
   * Recovery body for a device already in bootloader mode. Native IO is
   * constructed without openNormal, and exclusive ownership is taken only
   * after transport.connect() on the proven normal path — connectFirmwareNormal
   * requires an owner token this run does not yet hold.
   */
  async _runRecovery(operation, options = {}) {
    const record = operation.review;
    const anchor = operation.bootAnchor;
    const backupPath = operation.backupPath;
    let outcome = null;
    try {
      this._emit(operation, 'preflight', { percent: 0, message: 'Confirming the interrupted bootloader against the persisted anchor' });
      if (operation.cancelRequested) {
        outcome = this._checkCancelled(operation, 'preflight');
        return outcome;
      }

      operation.nativeIo = await this.nativeIoFactory({
        target: record.target.key,
        catalog: this.catalog,
        timeouts: this.timeouts
      });
      if (!operation.nativeIo || !methodAvailable(operation.nativeIo, 'waitForIdentity')) {
        outcome = this._resultFailure(operation, {
          failedPhase: 'native-open',
          reason: 'unsupported',
          error: 'Native firmware IO adapter cannot rediscover the interrupted bootloader',
          backupRetained: true,
          dispatched: false,
          uncertain: false
        });
        return outcome;
      }

      operation.transfer = this.transferFactory({
        io: operation.nativeIo,
        target: record.target.key,
        catalog: this.catalog,
        packageBytes: record.packageInfo.bytes,
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
          backupRetained: true,
          dispatched: false,
          uncertain: false
        });
        return outcome;
      }

      const transferResult = await operation.transfer.run({
        resumeFromBoot: true,
        bootAnchor: anchor,
        allowDifferentPackage: options.allowDifferentPackage === true,
        target: record.target.key,
        catalog: this.catalog,
        packageBytes: record.packageInfo.bytes,
        timeouts: this.timeouts,
        signal: options.signal
      });
      operation.transferResult = transferResult;
      if (!transferResult || !transferResult.success) {
        outcome = this._resultFailure(operation, {
          failedPhase: (transferResult && transferResult.failedPhase) || 'transfer',
          reason: (transferResult && transferResult.reason) || 'transfer-failed',
          error: (transferResult && transferResult.error) || 'Firmware recovery transfer failed',
          uncertain: Boolean(transferResult && transferResult.uncertain),
          rejected: Boolean(transferResult && transferResult.rejected),
          dispatched: transferResult && transferResult.dispatched,
          dispatchStatus: transferResult && transferResult.dispatchStatus,
          backupRetained: true
        });
        return outcome;
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
      const evidence = firmware.transitionIdentityEvidence(anchor, returnedIdentity);
      if (!returnedIdentity || !firmware.matchesNormalIdentity(returnedIdentity, record.target, this.catalog)
        || !evidence.match) {
        outcome = this._resultFailure(operation, {
          failedPhase: 'normal-reconnect',
          reason: 'ambiguous-identity',
          error: 'Recovery returned without a verified same-device normal identity',
          uncertain: true,
          backupRetained: true
        });
        return outcome;
      }
      operation.review.identity = identitySnapshot(returnedIdentity);
      // The device is verifiably back in normal mode, so the persisted boot
      // recovery anchor no longer applies. Restore still runs if the later
      // version predicate fails.
      this._clearBootAnchor(operation);

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

      this._emit(operation, 'normal-reconnect', { percent: 98, message: 'Reconnecting the verified normal HID path' });
      const connected = this.transport.connect(returnedIdentity.path);
      if (!connected || !connected.success) {
        outcome = this._resultFailure(operation, {
          failedPhase: 'normal-reconnect',
          reason: (connected && connected.reason) || 'ambiguous-identity',
          error: (connected && connected.error) || 'Verified normal transport reconnect failed',
          stale: Boolean(connected && connected.stale),
          uncertain: true,
          backupRetained: true
        });
        return outcome;
      }

      const acquired = await this.transport.acquireFirmwareOwnership(returnedIdentity, {
        drainTimeoutMs: options.drainTimeoutMs
      });
      if (!acquired || !acquired.success || !acquired.token) {
        outcome = this._resultFailure(operation, {
          failedPhase: 'handoff',
          reason: (acquired && acquired.reason) || 'handoff-failed',
          error: (acquired && acquired.error) || 'Normal transport could not be handed off exclusively',
          backupRetained: true,
          uncertain: true
        });
        return outcome;
      }
      operation.ownerToken = acquired.token;
      if (acquired.identity && !firmwareBackup.identitiesMatch(returnedIdentity, acquired.identity)) {
        outcome = this._resultFailure(operation, {
          failedPhase: 'handoff',
          reason: 'ambiguous-identity',
          error: 'The device identity changed during exclusive handoff after recovery',
          stale: true,
          backupRetained: true,
          uncertain: true
        });
        return outcome;
      }

      outcome = await this._restoreThenEvaluateVersion(operation, {
        returnedIdentity,
        pkg: record.target.package,
        beforeRaw: anchor.beforeVersionRaw,
        beforeSnapshot: null,
        backupPath
      });
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
    }
  }

  /**
   * The update body. Every path returns a structured outcome and the catch-all
   * converts unexpected throws, so the caller's cleanup section never has to
   * influence the return value.
   */
  async _runUpdate(operation, options = {}) {
    const record = operation.review;
    const backupPath = operation.backupPath;
    let outcome = null;
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
        signal: options.signal,
        onBootAnchor: anchorData => this._persistBootAnchor(operation, anchorData)
      });
      operation.transferResult = transferResult;
      if (!transferResult || !transferResult.success) {
        // enter-boot proven not dispatched means the device never left
        // normal mode, so an anchor persisted during this run is stale.
        if (operation.bootAnchorPersisted && transferResult
          && transferResult.failedPhase === 'enter-boot'
          && (transferResult.dispatchStatus === 'no' || transferResult.dispatched === false)) {
          this._clearBootAnchor(operation);
        }
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
      // The device is verifiably back in normal mode, so the boot recovery
      // anchor persisted at enter-boot no longer applies.
      this._clearBootAnchor(operation);

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

      const gateField = record.target.package && record.target.package.firmwareField;
      const gateRawKey = gateField ? `raw${gateField[0].toUpperCase()}${gateField.slice(1)}` : null;
      const beforeRaw = record.currentVersion && gateRawKey ? record.currentVersion[gateRawKey] : null;
      outcome = await this._restoreThenEvaluateVersion(operation, {
        returnedIdentity,
        pkg: record.target.package,
        beforeRaw,
        beforeSnapshot: record.currentVersion,
        backupPath
      });
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
    }
  }
}

module.exports = {
  DEFAULT_REVIEW_TTL_MS,
  FirmwareUpdateController,
  identitySnapshot,
  versionSnapshot
};
