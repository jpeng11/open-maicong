'use strict';

const firmware = require('./firmware-protocol.cjs');

const DEFAULT_TIMEOUTS = Object.freeze({
  dispatchMs: 5000,
  flagMs: 5000,
  identityMs: 10000
});

const PHASES = Object.freeze([
  'preflight',
  'enter-boot',
  'boot-confirmation',
  'erase',
  'write',
  'verify',
  'end',
  'success',
  'normal-reconnect',
  'complete',
  'failed'
]);

const PHASE_PERCENT = Object.freeze({
  preflight: 0,
  'enter-boot': 1,
  'boot-confirmation': 5,
  erase: 8,
  write: 50,
  verify: 90,
  end: 92,
  success: 95,
  'normal-reconnect': 98,
  complete: 100,
  failed: 100
});

class TransferFailure extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'TransferFailure';
    Object.assign(this, details);
  }
}

function asUnsubscribe(value) {
  return typeof value === 'function' ? value : () => {};
}

function subscribeData(io, handler) {
  if (!io) return () => {};
  if (typeof io.onData === 'function') return asUnsubscribe(io.onData(handler));
  if (typeof io.on === 'function') {
    io.on('data', handler);
    return () => {
      if (typeof io.off === 'function') io.off('data', handler);
      else if (typeof io.removeListener === 'function') io.removeListener('data', handler);
    };
  }
  return () => {};
}

function hasDataSubscription(io) {
  return Boolean(io && (typeof io.onData === 'function' || typeof io.on === 'function'));
}

function subscribeDisconnect(io, handler) {
  if (!io) return () => {};
  if (typeof io.onDisconnect === 'function') return asUnsubscribe(io.onDisconnect(handler));
  if (typeof io.on === 'function') {
    io.on('disconnect', handler);
    return () => {
      if (typeof io.off === 'function') io.off('disconnect', handler);
      else if (typeof io.removeListener === 'function') io.removeListener('disconnect', handler);
    };
  }
  return () => {};
}

function hasDisconnectSubscription(io) {
  return Boolean(io && (typeof io.onDisconnect === 'function' || typeof io.on === 'function'));
}

function normalizeIdentityCandidates(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (value && typeof value === 'object' && Array.isArray(value.candidates)) {
    return value.candidates.filter(Boolean);
  }
  if (value && typeof value === 'object' && value.identity && typeof value.identity === 'object') {
    return [value.identity];
  }
  if (value && typeof value === 'object' && value.vendorId !== undefined) return [value];
  return [];
}

function mergeTimeouts(overrides = {}) {
  const result = { ...DEFAULT_TIMEOUTS };
  for (const key of Object.keys(DEFAULT_TIMEOUTS)) {
    if (Number.isFinite(overrides[key]) && overrides[key] >= 0) result[key] = overrides[key];
  }
  return result;
}

/**
 * Serialized, transport-independent G75 V2 firmware transfer coordinator.
 *
 * Injectable IO contract:
 *   write(Buffer, meta) -> void | Promise | { dispatched: boolean }
 *   onData(handler) / onDisconnect(handler) -> unsubscribe (or EventEmitter on)
 *   waitForIdentity({ phase, expected, anchor, target, timeoutMs }) -> identity or candidates
 *   getIdentity() -> identity (optional when normalIdentity is supplied)
 *   isConnected() -> boolean (optional; absence means connected)
 *
 * `waitForIdentity` is required for the boot and normal reconnect proofs. The
 * coordinator never treats a timer as a transition proof, never retries a raw
 * destructive command, and never sends a later packet after a failure.
 */
class FirmwareTransferCoordinator {
  constructor(options = {}) {
    this.io = options.io || null;
    this.targetRef = options.target;
    this.packageBytes = options.packageBytes ?? options.firmware ?? null;
    this.normalIdentity = options.normalIdentity || null;
    this.waitForIdentity = options.waitForIdentity || null;
    this.catalog = options.catalog || firmware.OFFICIAL_CATALOG;
    this.timeouts = mergeTimeouts(options.timeouts);
    this.onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    this._running = false;
    this._runGeneration = 0;
    this._activeRunGeneration = 0;
    this._stopped = false;
    this._cancelled = false;
    this._cancelReason = null;
    this._controlEvent = null;
    this._controlResolve = null;
    this._unsubscribeDisconnect = null;
    this._signal = null;
    this._signalListener = null;
    this.progressHistory = [];
    this.currentProgress = null;
    this.target = null;
    this.packageInfo = null;
    this.bootIdentity = null;
    this.returnedNormalIdentity = null;
    this.bytesWritten = 0;
    this.bytesVerified = 0;
    this.requests = [];
    this._transitionMode = null;
    this._transitionDetachObserved = false;
    this._mutationStarted = false;
  }

  cancel(reason = 'Firmware update cancelled by user') {
    if (!this._running || this._stopped) return false;
    this._cancelled = true;
    this._cancelReason = String(reason || 'Firmware update cancelled by user');
    this._signalControl({ kind: 'cancelled', reason: this._cancelReason });
    return true;
  }

  _signalControl(event) {
    if (this._controlEvent) return;
    this._controlEvent = event;
    if (this._controlResolve) this._controlResolve(event);
  }

  _controlPromise() {
    return new Promise(resolve => {
      this._controlResolve = resolve;
      if (this._controlEvent) resolve(this._controlEvent);
    });
  }

  _emitProgress(phase, details = {}) {
    const event = {
      phase,
      state: details.state || 'running',
      percent: Number.isFinite(details.percent) ? details.percent : (PHASE_PERCENT[phase] ?? 0),
      completed: Number.isInteger(details.completed) ? details.completed : undefined,
      total: Number.isInteger(details.total) ? details.total : undefined,
      offset: Number.isInteger(details.offset) ? details.offset : undefined,
      bytesWritten: this.bytesWritten,
      bytesVerified: this.bytesVerified,
      message: details.message || undefined,
      failedPhase: details.failedPhase || undefined,
      reason: details.reason || undefined
    };
    this.currentProgress = event;
    this.progressHistory.push(event);
    if (this.onProgress) {
      try { this.onProgress({ ...event }); } catch {}
    }
    return event;
  }

  _isConnected() {
    if (!this.io) return false;
    if (typeof this.io.isConnected === 'function') {
      try { return Boolean(this.io.isConnected()); } catch { return false; }
    }
    if (this.io.connected !== undefined) return Boolean(this.io.connected);
    return true;
  }

  _ensureActive(phase, { allowDisconnected = false } = {}) {
    if (this._cancelled || this._controlEvent && this._controlEvent.kind === 'cancelled') {
      throw new TransferFailure(this._cancelReason || 'Firmware update cancelled by user', {
        phase,
        reason: 'cancelled',
        uncertain: false,
        dispatched: false,
        dispatchStatus: 'no'
      });
    }
    if (this._controlEvent && this._controlEvent.kind === 'disconnected') {
      throw new TransferFailure('Device disconnected during firmware update', {
        phase,
        reason: 'disconnected',
        uncertain: this._mutationStarted,
        dispatched: this._mutationStarted ? null : false,
        dispatchStatus: this._mutationStarted ? 'unknown' : 'no'
      });
    }
    if (!allowDisconnected && !this._isConnected()) {
      throw new TransferFailure('Device is not connected for firmware update', {
        phase,
        reason: 'disconnected',
        uncertain: this._mutationStarted,
        dispatched: this._mutationStarted ? null : false,
        dispatchStatus: this._mutationStarted ? 'unknown' : 'no'
      });
    }
    if (this._stopped) {
      throw new TransferFailure('Firmware update has stopped', {
        phase,
        reason: 'stopped',
        uncertain: false,
        dispatched: false,
        dispatchStatus: 'no'
      });
    }
  }

  _recordRequest(meta, dispatchStatus) {
    this.requests.push({
      phase: meta.phase,
      kind: meta.kind,
      opcode: meta.opcode,
      offset: meta.offset,
      length: meta.length,
      dispatchStatus,
      dispatched: dispatchStatus === 'yes' ? true : dispatchStatus === 'no' ? false : null
    });
  }

  _preflightHooks() {
    if (!this.io || typeof this.io.write !== 'function') {
      throw new TransferFailure('Firmware IO adapter does not provide write()', {
        phase: 'preflight', reason: 'io-error', uncertain: false, dispatched: false, dispatchStatus: 'no'
      });
    }
    if (!hasDataSubscription(this.io)) {
      throw new TransferFailure('Firmware IO adapter does not provide a data-response hook', {
        phase: 'preflight', reason: 'io-error', uncertain: false, dispatched: false, dispatchStatus: 'no'
      });
    }
    if (!hasDisconnectSubscription(this.io)) {
      throw new TransferFailure('Firmware IO adapter does not provide a disconnect hook', {
        phase: 'preflight', reason: 'io-error', uncertain: false, dispatched: false, dispatchStatus: 'no'
      });
    }
    const waiter = this.waitForIdentity || this.io.waitForIdentity;
    if (typeof waiter !== 'function') {
      throw new TransferFailure('Identity confirmation adapter is unavailable', {
        phase: 'preflight', reason: 'identity-unavailable', uncertain: false, dispatched: false, dispatchStatus: 'no'
      });
    }
    if (!this.normalIdentity && typeof this.io.getIdentity !== 'function') {
      throw new TransferFailure('Current normal identity adapter is unavailable', {
        phase: 'preflight', reason: 'identity-unavailable', uncertain: false, dispatched: false, dispatchStatus: 'no'
      });
    }
  }

  async _readInitialIdentity() {
    const identityPromise = Promise.resolve().then(() => this.io.getIdentity());
    const timeoutMarker = {};
    let timeoutId = null;
    const timeoutPromise = new Promise(resolve => {
      timeoutId = setTimeout(() => resolve(timeoutMarker), this.timeouts.identityMs);
    });
    try {
      const result = await Promise.race([identityPromise, timeoutPromise, this._controlPromise()]);
      if (result === timeoutMarker) {
        throw new TransferFailure('Timed out reading the current normal identity', {
          phase: 'preflight',
          reason: 'timeout',
          uncertain: false,
          dispatched: false,
          dispatchStatus: 'no'
        });
      }
      if (result && (result.kind === 'cancelled' || result.kind === 'disconnected')) {
        throw new TransferFailure(
          result.kind === 'cancelled' ? result.reason : 'Device disconnected during normal identity read',
          {
            phase: 'preflight',
            reason: result.kind,
            uncertain: false,
            dispatched: false,
            dispatchStatus: 'no'
          }
        );
      }
      return result;
    } catch (err) {
      if (err instanceof TransferFailure) throw err;
      throw new TransferFailure(err && err.message ? err.message : 'Failed to read the current normal identity', {
        phase: 'preflight',
        reason: 'identity-error',
        uncertain: false,
        dispatched: false,
        dispatchStatus: 'no',
        cause: err
      });
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  _dispatchStatusFromResult(result) {
    if (result && typeof result.dispatched === 'boolean') return result.dispatched ? 'yes' : 'no';
    if (result === false) return 'no';
    // A returned value means the adapter call settled. Unless it explicitly
    // proves non-dispatch, the request was handed to the transport.
    return 'yes';
  }

  _dispatchStatusFromError(error) {
    if (error && (error.dispatched === false || error.notDispatched === true)) return 'no';
    if (error && error.dispatched === true) return 'yes';
    // Native HID errors can occur after the write was submitted. Absence of
    // an explicit not-dispatched marker is therefore unknown, never false.
    return 'unknown';
  }

  async _dispatch(packet, meta) {
    this._ensureActive(meta.phase);
    if (!this.io || typeof this.io.write !== 'function') {
      throw new TransferFailure('Firmware IO adapter does not provide write()', {
        phase: meta.phase,
        reason: 'io-error',
        uncertain: false,
        dispatched: false,
        dispatchStatus: 'no'
      });
    }

    const runGeneration = this._activeRunGeneration;
    let writeInvoked = false;
    let requestRecorded = false;
    const recordRequest = dispatchStatus => {
      if (requestRecorded) return;
      requestRecorded = true;
      this._recordRequest(meta, dispatchStatus);
    };
    const ensureDispatchOwnership = () => {
      if (runGeneration !== this._activeRunGeneration || !this._running) {
        const error = new TransferFailure('Firmware request lost coordinator ownership before dispatch', {
          phase: meta.phase,
          reason: 'stopped',
          uncertain: false,
          dispatched: false,
          dispatchStatus: 'no'
        });
        recordRequest('no');
        throw error;
      }
      try {
        this._ensureActive(meta.phase);
      } catch (error) {
        const dispatchStatus = error && error.dispatchStatus
          ? error.dispatchStatus
          : error && error.dispatched === false ? 'no' : 'unknown';
        recordRequest(dispatchStatus);
        throw error;
      }
    };
    const writePromise = Promise.resolve().then(() => {
      // The first active check happens before this microtask. Recheck at the
      // actual IO call so cancel() before submission is known non-dispatch;
      // once io.write() is entered, later cancellation remains uncertain.
      ensureDispatchOwnership();
      writeInvoked = true;
      return this.io.write(Buffer.from(packet), { ...meta });
    });
    const timeoutMarker = {};
    const timeoutPromise = new Promise(resolve => {
      this._dispatchTimeoutId = setTimeout(() => resolve(timeoutMarker), this.timeouts.dispatchMs);
    });
    let outcome;
    try {
      outcome = await Promise.race([writePromise, timeoutPromise, this._controlPromise()]);
      if (outcome === timeoutMarker) {
        recordRequest('unknown');
        throw new TransferFailure(`Timed out waiting for ${meta.kind} write dispatch`, {
          phase: meta.phase,
          reason: 'timeout',
          uncertain: true,
          dispatched: null,
          dispatchStatus: 'unknown',
          opcode: meta.opcode,
          offset: meta.offset
        });
      }
      if (outcome && (outcome.kind === 'cancelled' || outcome.kind === 'disconnected')) {
        const knownNotDispatched = !writeInvoked;
        recordRequest(knownNotDispatched ? 'no' : 'unknown');
        throw new TransferFailure(
          outcome.kind === 'cancelled' ? outcome.reason : 'Device disconnected during firmware request',
          {
            phase: meta.phase,
            reason: outcome.kind,
            uncertain: !knownNotDispatched,
            dispatched: knownNotDispatched ? false : null,
            dispatchStatus: knownNotDispatched ? 'no' : 'unknown',
            opcode: meta.opcode,
            offset: meta.offset
          }
        );
      }
      const dispatchStatus = this._dispatchStatusFromResult(outcome);
      recordRequest(dispatchStatus);
      if (dispatchStatus === 'no') {
        throw new TransferFailure('Firmware IO adapter did not dispatch the request', {
          phase: meta.phase,
          reason: 'io-error',
          uncertain: false,
          dispatched: false,
          dispatchStatus: 'no'
        });
      }
      return { dispatched: true, dispatchStatus, result: outcome };
    } catch (err) {
      if (err instanceof TransferFailure) {
        const dispatchStatus = err.dispatchStatus || this._dispatchStatusFromError(err);
        recordRequest(dispatchStatus);
        throw err;
      }
      const dispatchStatus = this._dispatchStatusFromError(err);
      recordRequest(dispatchStatus);
      throw new TransferFailure(err && err.message ? err.message : 'Firmware IO write failed', {
        phase: meta.phase,
        reason: dispatchStatus === 'no' ? 'io-error' : 'uncertain',
        uncertain: dispatchStatus !== 'no',
        dispatched: dispatchStatus === 'yes' ? true : dispatchStatus === 'no' ? false : null,
        dispatchStatus,
        cause: err
      });
    } finally {
      if (this._dispatchTimeoutId) clearTimeout(this._dispatchTimeoutId);
      this._dispatchTimeoutId = null;
    }
  }

  async _requestFlag(packet, meta) {
    this._ensureActive(meta.phase);
    let responseResolve;
    const responsePromise = new Promise(resolve => { responseResolve = resolve; });
    const unsubscribeData = subscribeData(this.io, raw => {
      let decoded;
      try { decoded = firmware.decodeFlagResponse(raw); } catch { return; }
      if (decoded && decoded.matched) responseResolve(decoded);
    });
    let timeoutId = null;
    const timeoutPromise = new Promise(resolve => {
      timeoutId = setTimeout(() => resolve({ kind: 'timeout' }), this.timeouts.flagMs);
    });
    try {
      await this._dispatch(packet, meta);
      const outcome = await Promise.race([responsePromise, timeoutPromise, this._controlPromise()]);
      if (outcome && outcome.kind === 'timeout') {
        throw new TransferFailure(`No bootloader flag response for ${meta.kind}`, {
          phase: meta.phase,
          reason: 'timeout',
          uncertain: true,
          dispatched: true,
          dispatchStatus: 'yes',
          opcode: meta.opcode,
          offset: meta.offset
        });
      }
      if (outcome && (outcome.kind === 'cancelled' || outcome.kind === 'disconnected')) {
        throw new TransferFailure(
          outcome.kind === 'cancelled' ? outcome.reason : 'Device disconnected during firmware request',
          {
            phase: meta.phase,
            reason: outcome.kind,
            uncertain: true,
            dispatched: true,
            dispatchStatus: 'yes',
            opcode: meta.opcode,
            offset: meta.offset
          }
        );
      }
      if (!outcome || outcome.matched !== true) {
        throw new TransferFailure('Invalid bootloader flag response', {
          phase: meta.phase,
          reason: 'uncertain',
          uncertain: true,
          dispatched: true
        });
      }
      if (!outcome.success) {
        throw new TransferFailure(outcome.error || 'Bootloader rejected the firmware request', {
          phase: meta.phase,
          reason: 'rejected',
          rejected: true,
          uncertain: false,
          dispatched: true,
          dispatchStatus: 'yes',
          receiveFlag: outcome.receiveFlag
        });
      }
      if (meta.destructive) this._mutationStarted = true;
      return outcome;
    } finally {
      // Boot flags are untagged. The serial queue is the only correlation
      // mechanism, so every response listener and timer must be removed before
      // the next request can be sent; late/duplicate flags cannot be reused.
      if (timeoutId) clearTimeout(timeoutId);
      unsubscribeData();
    }
  }

  async _waitForIdentity(phase, expected, anchor) {
    const allowDisconnected = this._transitionMode === 'boot' || this._transitionMode === 'normal';
    this._ensureActive(phase, { allowDisconnected });
    const waiter = this.waitForIdentity || (this.io && this.io.waitForIdentity);
    if (typeof waiter !== 'function') {
      throw new TransferFailure('Identity confirmation adapter is unavailable', {
        phase,
        reason: 'identity-unavailable',
        uncertain: this._mutationStarted,
        dispatched: this._mutationStarted ? null : false,
        dispatchStatus: this._mutationStarted ? 'unknown' : 'no'
      });
    }

    let identityResult;
    const identityPromise = Promise.resolve().then(() => waiter.call(this.io, {
      phase,
      expected: { ...expected },
      anchor,
      target: this.target,
      timeoutMs: this.timeouts.identityMs
    }));
    let timeoutId = null;
    const timeoutPromise = new Promise(resolve => {
      timeoutId = setTimeout(() => resolve({ kind: 'timeout' }), this.timeouts.identityMs);
    });
    let result;
    try {
      result = await Promise.race([identityPromise, timeoutPromise, this._controlPromise()]);
    } catch (err) {
      throw new TransferFailure(err && err.message ? err.message : `Failed waiting for ${phase} identity confirmation`, {
        phase,
        reason: 'identity-error',
        uncertain: true,
        dispatched: this._mutationStarted ? null : true,
        dispatchStatus: this._mutationStarted ? 'unknown' : 'yes',
        cause: err
      });
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
    if (result && (result.kind === 'timeout' || result.kind === 'disconnected' || result.kind === 'cancelled')) {
      throw new TransferFailure(
        result.kind === 'timeout'
          ? `Timed out waiting for ${phase} identity confirmation`
          : (result.kind === 'cancelled' ? result.reason : 'Device disconnected during identity confirmation'),
        {
          phase,
          reason: result.kind,
          uncertain: true,
          dispatched: this._mutationStarted ? null : true,
          dispatchStatus: this._mutationStarted ? 'unknown' : 'yes'
        }
      );
    }
    identityResult = result;
    const candidates = normalizeIdentityCandidates(identityResult);
    if (candidates.length !== 1) {
      throw new TransferFailure(
        candidates.length === 0
          ? `No unique ${phase} identity was discovered`
          : `Ambiguous ${phase} identity: ${candidates.length} candidates match`,
        {
          phase,
          reason: 'ambiguous-identity',
          uncertain: true,
          dispatched: this._mutationStarted ? null : true,
          dispatchStatus: this._mutationStarted ? 'unknown' : 'yes',
          candidateCount: candidates.length
        }
      );
    }
    const identity = candidates[0];
    const matchesExpected = phase === 'boot-confirmation'
      ? firmware.matchesBootIdentity(identity, this.target, this.catalog)
      : firmware.matchesNormalIdentity(identity, this.target, this.catalog);
    if (!matchesExpected) {
      throw new TransferFailure(`Discovered ${phase} identity is not the exact expected G75 V2 interface`, {
        phase,
        reason: 'ambiguous-identity',
        uncertain: true,
        dispatched: this._mutationStarted ? null : true,
        dispatchStatus: this._mutationStarted ? 'unknown' : 'yes'
      });
    }
    if (anchor && !firmware.sameDeviceIdentity(anchor, identity)) {
      throw new TransferFailure(`Discovered ${phase} interface cannot be bound to the same physical device`, {
          phase,
          reason: 'ambiguous-identity',
          uncertain: true,
          dispatched: this._mutationStarted ? null : true,
          dispatchStatus: this._mutationStarted ? 'unknown' : 'yes'
        });
    }
    return identity;
  }

  _resultBase() {
    return {
      targetKey: this.packageInfo && this.packageInfo.targetKey,
      targetId: this.packageInfo && this.packageInfo.targetId,
      targetVersion: this.packageInfo && this.packageInfo.version,
      package: firmware.packageReview(this.packageInfo),
      bytesWritten: this.bytesWritten,
      bytesVerified: this.bytesVerified,
      requests: this.requests.slice(),
      progress: this.progressHistory.slice(),
      // The wire protocol has untagged flag responses. Serialization and
      // listener cleanup provide ordering, not packet-level correlation.
      wireResponseCorrelation: 'serialized-untagged-flag'
    };
  }

  _failure(error) {
    this._stopped = true;
    this._transitionMode = null;
    const failedPhase = error.phase || (this.currentProgress && this.currentProgress.phase) || 'preflight';
    const reason = error.reason || 'failed';
    const priorMutation = this._mutationStarted;
    const dispatchStatus = error.dispatchStatus
      || (error.dispatched === true ? 'yes' : error.dispatched === false ? 'no' : 'unknown');
    const uncertain = Boolean(error.uncertain) || priorMutation;
    const dispatched = error.dispatched === true
      ? true
      : error.dispatched === false
        ? false
        : null;
    this._emitProgress('failed', {
      state: 'failed',
      failedPhase,
      reason,
      message: error.message
    });
    return {
      success: false,
      phase: 'failed',
      failedPhase,
      reason,
      rejected: Boolean(error.rejected),
      uncertain,
      dispatched,
      dispatchStatus,
      dispatchUnknown: dispatchStatus === 'unknown',
      priorMutation,
      candidateCount: error.candidateCount,
      error: error.message || String(error),
      nextWriteBlocked: true,
      ...this._resultBase()
    };
  }

  async run(options = {}) {
    if (this._running) {
      return {
        success: false,
        phase: 'failed',
        failedPhase: 'preflight',
        reason: 'busy',
        uncertain: false,
        dispatched: false,
        nextWriteBlocked: true,
        error: 'Firmware transfer coordinator is already running'
      };
    }

    this._running = true;
    this._activeRunGeneration = ++this._runGeneration;
    this._stopped = false;
    this._cancelled = false;
    this._cancelReason = null;
    this._controlEvent = null;
    this._controlResolve = null;
    this.progressHistory = [];
    this.currentProgress = null;
    this.requests = [];
    this.bytesWritten = 0;
    this.bytesVerified = 0;
    this.target = null;
    this.packageInfo = null;
    this.bootIdentity = null;
    this.returnedNormalIdentity = null;
    this._transitionMode = null;
    this._transitionDetachObserved = false;
    this._mutationStarted = false;

    const targetRef = options.target ?? this.targetRef;
    const packageBytes = options.packageBytes ?? options.firmware ?? this.packageBytes;
    const catalog = options.catalog || this.catalog;
    const timeouts = options.timeouts ? mergeTimeouts({ ...this.timeouts, ...options.timeouts }) : this.timeouts;
    this.timeouts = timeouts;
    this.catalog = catalog;
    this.targetRef = targetRef;
    this.waitForIdentity = options.waitForIdentity || this.waitForIdentity;
    this.normalIdentity = options.normalIdentity || this.normalIdentity;
    this._signal = options.signal || null;

    this._controlPromise();
    this._unsubscribeDisconnect = subscribeDisconnect(this.io, () => {
      if (this._transitionMode === 'boot' || this._transitionMode === 'normal') {
        // Detach is expected only inside the bounded mode transition window.
        // The next identity waiter still has to prove a unique, same-device
        // attach before any subsequent destructive request is allowed.
        this._transitionDetachObserved = true;
        return;
      }
      this._signalControl({ kind: 'disconnected' });
    });
    if (this._signal && typeof this._signal.addEventListener === 'function') {
      this._signalListener = () => this.cancel('Firmware update cancelled by user');
      if (this._signal.aborted) this._signalListener();
      else this._signal.addEventListener('abort', this._signalListener, { once: true });
    }

    try {
      this._emitProgress('preflight', { message: 'Validating firmware target and complete package' });
      if (this._cancelled) {
        throw new TransferFailure(this._cancelReason, { phase: 'preflight', reason: 'cancelled', dispatched: false });
      }
      this.packageInfo = firmware.validateFirmwarePackage(packageBytes, targetRef, { catalog });
      if (!this.packageInfo.valid) {
        throw new TransferFailure(this.packageInfo.error, {
          phase: 'preflight',
          reason: 'invalid-package',
          uncertain: false,
          dispatched: false
        });
      }
      this.target = this.packageInfo.target;
      if (!this.io) {
        throw new TransferFailure('Firmware IO adapter is unavailable', {
          phase: 'preflight', reason: 'io-error', uncertain: false, dispatched: false
        });
      }
      this._preflightHooks();
      if (!this.normalIdentity && typeof this.io.getIdentity === 'function') {
        this.normalIdentity = await this._readInitialIdentity();
      }
      if (!firmware.matchesNormalIdentity(this.normalIdentity, this.target, catalog)) {
        throw new TransferFailure('Current device is not the exact normal G75 V2 target for this package', {
          phase: 'preflight', reason: 'unsupported-target', uncertain: false, dispatched: false
        });
      }
      if (!firmware.hasStableUsbLocation(this.normalIdentity)) {
        throw new TransferFailure('Current device has no valid stable USB location for same-device proof', {
          phase: 'preflight',
          reason: 'ambiguous-identity',
          uncertain: false,
          dispatched: false,
          dispatchStatus: 'no'
        });
      }
      this._ensureActive('preflight');

      this._emitProgress('enter-boot', { message: 'Requesting bootloader transition' });
      this._transitionMode = 'boot';
      this._transitionDetachObserved = false;
      await this._dispatch(firmware.buildEnterBootPacket(), {
        phase: 'enter-boot',
        kind: 'enter-boot',
        opcode: firmware.OPCODES.ENTER_BOOT,
        length: firmware.ENTER_BOOT_PAYLOAD.length
      });

      this._emitProgress('boot-confirmation', { message: 'Confirming the exact bootloader identity' });
      this.bootIdentity = await this._waitForIdentity('boot-confirmation', this.target.boot, this.normalIdentity);
      const bootDetachObserved = this._transitionDetachObserved;
      this._transitionMode = null;

      this._emitProgress('erase', { message: 'Erasing the bootloader target' });
      await this._requestFlag(
        firmware.buildErasePacket({ vendorId: this.bootIdentity.vendorId, productId: this.bootIdentity.productId }),
        {
          phase: 'erase',
          kind: 'erase',
          opcode: firmware.OPCODES.ERASE,
          length: 7,
          destructive: true
        }
      );

      const totalChunks = Math.ceil(this.packageInfo.bytes.length / firmware.FIRMWARE_CHUNK_SIZE);
      for (let offset = 0, index = 0; offset < this.packageInfo.bytes.length; offset += firmware.FIRMWARE_CHUNK_SIZE, index++) {
        const chunk = this.packageInfo.bytes.subarray(offset, offset + firmware.FIRMWARE_CHUNK_SIZE);
        const percent = 10 + ((index + 1) / totalChunks) * 40;
        this._emitProgress('write', {
          completed: index,
          total: totalChunks,
          offset,
          percent,
          message: `Writing firmware chunk ${index + 1} of ${totalChunks}`
        });
        await this._requestFlag(firmware.buildWriteChunkPacket(offset, chunk), {
          phase: 'write',
          kind: 'write',
          opcode: firmware.OPCODES.WRITE,
          offset,
          length: chunk.length,
          destructive: true
        });
        this.bytesWritten += chunk.length;
        this._emitProgress('write', {
          completed: index + 1,
          total: totalChunks,
          offset,
          percent,
          message: `Wrote firmware chunk ${index + 1} of ${totalChunks}`
        });
      }

      for (let offset = 0, index = 0; offset < this.packageInfo.bytes.length; offset += firmware.FIRMWARE_CHUNK_SIZE, index++) {
        const chunk = this.packageInfo.bytes.subarray(offset, offset + firmware.FIRMWARE_CHUNK_SIZE);
        const percent = 55 + ((index + 1) / totalChunks) * 35;
        this._emitProgress('verify', {
          completed: index,
          total: totalChunks,
          offset,
          percent,
          message: `Comparing firmware chunk ${index + 1} of ${totalChunks}`
        });
        await this._requestFlag(firmware.buildCheckChunkPacket(offset, chunk), {
          phase: 'verify',
          kind: 'check',
          opcode: firmware.OPCODES.CHECK,
          offset,
          length: chunk.length,
          destructive: false
        });
        this.bytesVerified += chunk.length;
        this._emitProgress('verify', {
          completed: index + 1,
          total: totalChunks,
          offset,
          percent,
          message: `Compared firmware chunk ${index + 1} of ${totalChunks}`
        });
      }

      this._emitProgress('end', { message: 'Finalizing bootloader transfer' });
      await this._requestFlag(firmware.buildEndPacket(), {
        phase: 'end',
        kind: 'end',
        opcode: firmware.OPCODES.END,
        length: 5,
        destructive: true
      });

      this._emitProgress('success', { message: 'Committing the verified firmware image' });
      this._transitionMode = 'normal';
      this._transitionDetachObserved = false;
      await this._requestFlag(firmware.buildSuccessPacket(), {
        phase: 'success',
        kind: 'success',
        opcode: firmware.OPCODES.SUCCESS,
        length: 5,
        destructive: true
      });

      this._emitProgress('normal-reconnect', { message: 'Confirming same-device return to normal mode' });
      this.returnedNormalIdentity = await this._waitForIdentity('normal-reconnect', this.target.normal, this.bootIdentity);
      const normalDetachObserved = this._transitionDetachObserved;
      this._transitionMode = null;
      if (!firmware.sameDeviceIdentity(this.normalIdentity, this.returnedNormalIdentity)) {
        throw new TransferFailure('Returned normal interface is not bound to the reviewed device', {
          phase: 'normal-reconnect',
          reason: 'ambiguous-identity',
          uncertain: true,
          dispatched: true
        });
      }

      this._stopped = true;
      this._emitProgress('complete', {
        state: 'completed',
        message: 'Firmware transfer completed and identity continuity confirmed; version readback is still required'
      });
      return {
        success: true,
        transferSuccess: true,
        fullUpdaterSuccess: false,
        versionReadbackRequired: true,
        phase: 'complete',
        uncertain: false,
        dispatched: true,
        nextWriteBlocked: false,
        normalIdentity: this.normalIdentity,
        bootIdentity: this.bootIdentity,
        returnedNormalIdentity: this.returnedNormalIdentity,
        transition: {
          bootDetachObserved,
          bootIdentityConfirmed: true,
          normalDetachObserved,
          normalIdentityConfirmed: true
        },
        ...this._resultBase()
      };
    } catch (err) {
      const failure = err instanceof TransferFailure
        ? err
        : new TransferFailure(err && err.message ? err.message : String(err), {
          phase: (this.currentProgress && this.currentProgress.phase) || 'preflight',
          reason: this._mutationStarted ? 'uncertain' : 'error',
          uncertain: this._mutationStarted,
          dispatched: this._mutationStarted ? null : false,
          dispatchStatus: this._mutationStarted ? 'unknown' : 'no'
        });
      return this._failure(failure);
    } finally {
      this._running = false;
      if (this._unsubscribeDisconnect) this._unsubscribeDisconnect();
      this._unsubscribeDisconnect = null;
      if (this._signal && this._signalListener && typeof this._signal.removeEventListener === 'function') {
        this._signal.removeEventListener('abort', this._signalListener);
      }
      this._signal = null;
      this._signalListener = null;
    }
  }
}

async function runFirmwareTransfer(options = {}) {
  const coordinator = new FirmwareTransferCoordinator(options);
  const result = await coordinator.run(options);
  return { coordinator, ...result };
}

module.exports = {
  DEFAULT_TIMEOUTS,
  PHASES,
  TransferFailure,
  FirmwareTransferCoordinator,
  runFirmwareTransfer
};
