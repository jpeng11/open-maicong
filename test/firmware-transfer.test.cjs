const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const firmware = require('../src/firmware-protocol.cjs');
const { FirmwareTransferCoordinator } = require('../src/firmware-transfer.cjs');

const fixtureBytes = Buffer.from([
  0x37, 0x38, 0x21, 0x20, 0x14, 0x01, 0xAA, 0xBB,
  0x00, 0x00, 0x00, 0x00, 0x10, 0x11, 0x12, 0x13,
  0x20, 0x21, 0x22, 0x23, 0x30, 0x31, 0x32, 0x33,
  0x40, 0x41, 0x42, 0x43, 0x50, 0x51, 0x52, 0x53,
  0x60, 0x61, 0x62
]);

const fixtureCatalog = {
  fixture: {
    key: 'fixture',
    id: 'fixture-g75-wired',
    kind: 'keyboard',
    transport: 'wired-usb',
    normal: { vendorId: 0x3837, productId: 0x2021, interface: 1, usagePage: 1, usage: 0 },
    boot: { vendorId: 0x3837, productId: 0x2022, usagePage: 0xFF00, usage: 1 },
    package: {
      fileName: 'fixture.bin',
      size: fixtureBytes.length,
      sha256: crypto.createHash('sha256').update(fixtureBytes).digest('hex'),
      version: 'fixture-1.0',
      versionNumber: 100,
      versionSource: 'fixture'
    }
  }
};

const normalIdentity = {
  ...fixtureCatalog.fixture.normal,
  serialNumber: 'FIXTURE-SERIAL',
  locationId: 0x02400000,
  path: 'DevSrvsID:normal'
};
const bootIdentity = {
  ...fixtureCatalog.fixture.boot,
  serialNumber: 'FIXTURE-SERIAL',
  locationId: 0x02400000,
  path: 'DevSrvsID:boot'
};
const returnedNormalIdentity = {
  ...fixtureCatalog.fixture.normal,
  serialNumber: 'FIXTURE-SERIAL',
  locationId: 0x02400000,
  path: 'DevSrvsID:normal-return'
};

class MockFirmwareIo {
  constructor(options = {}) {
    this.connected = true;
    this.writes = [];
    this.identityRequests = [];
    this.dataListeners = new Set();
    this.disconnectListeners = new Set();
    this.responsePlan = options.responsePlan || (() => 'ok');
    this.identityPlan = options.identityPlan || ((request) => (
      request.phase === 'boot-confirmation'
        ? (this.attach(), bootIdentity)
        : (this.attach(), returnedNormalIdentity)
    ));
    this.detachOnEnter = Boolean(options.detachOnEnter);
    this.detachOnSuccess = Boolean(options.detachOnSuccess);
    this.hangPhase = options.hangPhase || null;
    this.hangResolvers = [];
    this.throwPhase = options.throwPhase || null;
    this.throwError = options.throwError || null;
    this.explicitNotDispatchedPhase = options.explicitNotDispatchedPhase || null;
    this.disconnectCount = 0;
    this.inFlight = 0;
    this.maxInFlight = 0;
    this.onWrite = null;
    this.ackDuringDrain = Boolean(options.ackDuringDrain);
    this._dataSequence = 0;
    this._recentData = [];
    this._pendingDrainAck = null;
    this._detachAfterDrain = false;
  }

  get dataSequence() {
    return this.ackDuringDrain ? this._dataSequence : undefined;
  }

  _stampAndEmit(data) {
    this._dataSequence += 1;
    const stamp = this._dataSequence;
    this._recentData.push({ sequence: stamp, data });
    for (const listener of this.dataListeners) listener(data, { sequence: stamp });
    if (this._detachAfterDrain) {
      this._detachAfterDrain = false;
      this.disconnect();
    }
  }

  drainDataSince(sequence) {
    const items = this._recentData
      .filter(item => item.sequence > sequence)
      .map(item => ({ sequence: item.sequence, data: item.data }));
    if (this.ackDuringDrain && this._pendingDrainAck) {
      const data = this._pendingDrainAck;
      this._pendingDrainAck = null;
      this._stampAndEmit(data);
    }
    return items;
  }

  isConnected() {
    return this.connected;
  }

  onData(handler) {
    this.dataListeners.add(handler);
    return () => this.dataListeners.delete(handler);
  }

  onDisconnect(handler) {
    this.disconnectListeners.add(handler);
    return () => this.disconnectListeners.delete(handler);
  }

  emitData(data) {
    for (const listener of this.dataListeners) listener(data);
  }

  disconnect() {
    this.connected = false;
    this.disconnectCount += 1;
    for (const listener of this.disconnectListeners) listener();
  }

  attach() {
    this.connected = true;
  }

  resolveHangingWrites() {
    const resolvers = this.hangResolvers.splice(0);
    for (const resolve of resolvers) resolve({ dispatched: true });
  }

  async write(packet, meta) {
    if (!this.connected) throw new Error('mock device disconnected');
    if (meta.phase !== 'enter-boot') {
      this.inFlight += 1;
      this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    }
    this.writes.push({ packet: Buffer.from(packet), meta: { ...meta } });
    if (this.onWrite) this.onWrite(packet, meta, this);

    if (this.throwPhase === meta.phase) {
      const error = this.throwError || new Error(`mock ${meta.phase} write failed after submission`);
      throw error;
    }
    if (this.explicitNotDispatchedPhase === meta.phase) {
      return { dispatched: false };
    }
    if (this.hangPhase === meta.phase) {
      return new Promise(resolve => this.hangResolvers.push(resolve));
    }

    if (meta.phase === 'enter-boot' && this.detachOnEnter) this.disconnect();

    if (meta.phase !== 'enter-boot') {
      const plan = this.responsePlan(meta, this.writes.length);
      if (this.ackDuringDrain && (plan === 'ok' || plan === 'reject')) {
        this.inFlight = Math.max(0, this.inFlight - 1);
        this._pendingDrainAck = firmware.buildFlagResponse(plan === 'reject' ? 1 : 0);
        this._detachAfterDrain = meta.phase === 'success' && this.detachOnSuccess;
        return { dispatched: true };
      }
      if (plan === 'ok' || plan === 'reject' || plan === 'unrelated') {
        setImmediate(() => {
          this.inFlight = Math.max(0, this.inFlight - 1);
          if (plan === 'unrelated') this.emitData(Buffer.from([2, 0, 0, 0]));
          else this.emitData(firmware.buildFlagResponse(plan === 'reject' ? 1 : 0));
          if (meta.phase === 'success' && this.detachOnSuccess) this.disconnect();
        });
      }
    }
    return { dispatched: true };
  }

  waitForIdentity(request) {
    this.identityRequests.push({ ...request });
    return this.identityPlan(request);
  }
}

function makeCoordinator(io, options = {}) {
  return new FirmwareTransferCoordinator({
    io,
    target: 'fixture',
    catalog: fixtureCatalog,
    packageBytes: fixtureBytes,
    normalIdentity,
    timeouts: { dispatchMs: 30, flagMs: 30, identityMs: 30 },
    onBootAnchor: async () => {},
    ...options
  });
}

function commandBytes(write) {
  return write.packet.subarray(1);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('serialized G75 V2 firmware transfer coordinator', () => {
  test('runs entry, boot identity, erase, full-file write/check, end, success, and normal reconnect in order', async () => {
    const progress = [];
    const io = new MockFirmwareIo({ detachOnEnter: true, detachOnSuccess: true });
    const coordinator = makeCoordinator(io, { onProgress: event => progress.push(event) });
    const result = await coordinator.run();

    assert.equal(result.success, true, result.error);
    assert.equal(result.transferSuccess, true);
    assert.equal(result.fullUpdaterSuccess, false);
    assert.equal(result.versionReadbackRequired, true);
    assert.equal(result.targetVersion, 'fixture-1.0');
    assert.equal(result.package.fullFile, true);
    assert.equal(result.package.headerPreserved, true);
    assert.equal(result.bytesWritten, fixtureBytes.length);
    assert.equal(result.bytesVerified, fixtureBytes.length);
    assert.equal(io.maxInFlight, 1, 'every flag request must be serialized');
    assert.deepEqual(io.identityRequests.map(request => request.phase), ['boot-confirmation', 'normal-reconnect']);
    assert.equal(io.disconnectCount, 2, 'the fixture must exercise both real detach transitions');
    assert.deepEqual(result.transition, {
      bootDetachObserved: true,
      bootIdentityConfirmed: true,
      normalDetachObserved: true,
      normalIdentityConfirmed: true,
      bootSerialEvidence: 'both',
      normalSerialEvidence: 'both'
    });
    assert.equal(result.wireResponseCorrelation, 'serialized-untagged-flag');

    const phases = io.writes.map(write => write.meta.phase);
    assert.deepEqual(phases, [
      'enter-boot', 'erase', 'write', 'write', 'verify', 'verify', 'end', 'success'
    ]);
    assert.equal(commandBytes(io.writes[0])[0], firmware.OPCODES.ENTER_BOOT);
    assert.equal(commandBytes(io.writes[1])[0], firmware.OPCODES.ERASE);
    assert.deepEqual(Array.from(commandBytes(io.writes[1]).subarray(0, 7)), [0x81, 7, 0x37, 0x38, 0x22, 0x20, 0]);

    const writes = io.writes.filter(write => write.meta.phase === 'write');
    const checks = io.writes.filter(write => write.meta.phase === 'verify');
    assert.deepEqual(writes.map(write => write.meta.offset), [0, 32]);
    assert.deepEqual(checks.map(write => write.meta.offset), [0, 32]);
    assert.equal(writes[0].meta.length, 32);
    assert.equal(writes[1].meta.length, 3);
    assert.deepEqual(Array.from(commandBytes(writes[0]).subarray(6, 38)), Array.from(fixtureBytes.subarray(0, 32)));
    assert.deepEqual(Array.from(commandBytes(writes[1]).subarray(6, 9)), Array.from(fixtureBytes.subarray(32)));
    assert.deepEqual(Array.from(commandBytes(checks[0]).subarray(6, 38)), Array.from(fixtureBytes.subarray(0, 32)));
    assert.deepEqual(Array.from(commandBytes(checks[1]).subarray(6, 9)), Array.from(fixtureBytes.subarray(32)));
    assert.ok(io.writes.every(write => write.packet.length === firmware.WRITE_BUFFER_SIZE));
    assert.ok(progress.some(event => event.phase === 'write' && event.completed === 1));
    assert.ok(progress.some(event => event.phase === 'verify' && event.completed === 2));
    assert.equal(progress.at(-1).phase, 'complete');
  });

  test('explicit flag rejection stops immediately and never retries or sends follow-on commands', async () => {
    const io = new MockFirmwareIo({ responsePlan: meta => meta.phase === 'erase' ? 'reject' : 'ok' });
    const result = await makeCoordinator(io).run();
    assert.equal(result.success, false);
    assert.equal(result.failedPhase, 'erase');
    assert.equal(result.reason, 'rejected');
    assert.equal(result.rejected, true);
    assert.equal(result.uncertain, false);
    assert.deepEqual(io.writes.map(write => write.meta.phase), ['enter-boot', 'erase']);
    assert.equal(io.writes.filter(write => write.meta.phase === 'erase').length, 1);
    assert.equal(result.nextWriteBlocked, true);
  });

  test('timeout after a dispatched erase is uncertain and sends no write/check/end retry', async () => {
    const io = new MockFirmwareIo({ responsePlan: meta => meta.phase === 'erase' ? 'timeout' : 'ok' });
    const result = await makeCoordinator(io, { timeouts: { flagMs: 10, eraseFlagMs: 10, identityMs: 30 } }).run();
    assert.equal(result.success, false);
    assert.equal(result.failedPhase, 'erase');
    assert.equal(result.reason, 'timeout');
    assert.equal(result.uncertain, true);
    assert.equal(result.dispatched, true);
    assert.deepEqual(io.writes.map(write => write.meta.phase), ['enter-boot', 'erase']);
    assert.equal(io.writes.some(write => ['write', 'verify', 'end', 'success'].includes(write.meta.phase)), false);
  });

  test('unrelated flag responses do not satisfy a request and eventually fail closed as uncertain', async () => {
    const io = new MockFirmwareIo({ responsePlan: meta => meta.phase === 'erase' ? 'unrelated' : 'ok' });
    const result = await makeCoordinator(io, { timeouts: { flagMs: 10, eraseFlagMs: 10, identityMs: 30 } }).run();
    assert.equal(result.success, false);
    assert.equal(result.failedPhase, 'erase');
    assert.equal(result.reason, 'timeout');
    assert.equal(result.uncertain, true);
    assert.deepEqual(io.writes.map(write => write.meta.phase), ['enter-boot', 'erase']);
  });

  test('erase waits under the erase budget instead of the generic flag budget', async () => {
    const io = new MockFirmwareIo({ responsePlan: meta => meta.phase === 'erase' ? 'timeout' : 'ok' });
    io.onWrite = (_packet, meta, mock) => {
      if (meta.phase === 'erase') {
        setTimeout(() => mock.emitData(firmware.buildFlagResponse(0)), 40);
      }
    };
    const result = await makeCoordinator(io, {
      timeouts: { dispatchMs: 30, flagMs: 10, eraseFlagMs: 500, identityMs: 30 }
    }).run();
    assert.equal(result.success, true, result.error);
    assert.deepEqual(io.writes.map(write => write.meta.phase), [
      'enter-boot', 'erase', 'write', 'write', 'verify', 'verify', 'end', 'success'
    ]);
  });

  test('a flag emitted before a request listener is armed cannot satisfy that request', async () => {
    const io = new MockFirmwareIo({ responsePlan: meta => meta.phase === 'write' ? 'timeout' : 'ok' });
    io.onWrite = (_packet, meta, mock) => {
      if (meta.phase === 'write') mock.emitData(firmware.buildFlagResponse(0));
    };
    const result = await makeCoordinator(io, { timeouts: { flagMs: 20, identityMs: 30 } }).run();
    assert.equal(result.success, false);
    assert.equal(result.failedPhase, 'write');
    assert.equal(result.reason, 'timeout');
    assert.equal(result.uncertain, true);
    assert.equal(result.bytesWritten, 0, 'a spurious pre-write flag must not complete the chunk');
    assert.deepEqual(io.writes.map(write => write.meta.phase), ['enter-boot', 'erase', 'write']);
  });

  test('cancellation during a dispatched write stops the current transfer without follow-on writes', async () => {
    const io = new MockFirmwareIo();
    let coordinator;
    coordinator = makeCoordinator(io);
    io.onWrite = (_packet, meta) => {
      if (meta.phase === 'write' && meta.offset === 0) coordinator.cancel('User cancelled firmware update');
    };
    const result = await coordinator.run();
    assert.equal(result.success, false);
    assert.equal(result.reason, 'cancelled');
    assert.equal(result.uncertain, true);
    assert.equal(result.failedPhase, 'write');
    assert.deepEqual(io.writes.map(write => write.meta.phase), ['enter-boot', 'erase', 'write']);
    assert.equal(io.writes.length, 3);
  });

  test('cancellation before deferred write invocation is known non-dispatch and sends zero packets', async () => {
    const io = new MockFirmwareIo();
    const coordinator = makeCoordinator(io);
    const running = coordinator.run();
    coordinator.cancel('cancel before boot-entry submission');

    const result = await running;
    assert.equal(result.success, false);
    assert.equal(result.reason, 'cancelled');
    assert.equal(result.uncertain, false);
    assert.equal(result.dispatched, false);
    assert.equal(result.dispatchStatus, 'no');
    assert.deepEqual(io.writes, []);
    assert.equal(result.nextWriteBlocked, true);
  });

  test('cancellation bounds a never-settling write and a late resolution cannot resume the queue', async () => {
    const io = new MockFirmwareIo({ hangPhase: 'enter-boot' });
    const coordinator = makeCoordinator(io, {
      timeouts: { dispatchMs: 1000, flagMs: 30, identityMs: 30 }
    });
    const running = coordinator.run();
    setTimeout(() => coordinator.cancel('Cancel while native write is pending'), 5);
    const result = await Promise.race([
      running,
      new Promise((_, reject) => setTimeout(() => reject(new Error('coordinator remained pending')), 100))
    ]);

    assert.equal(result.success, false);
    assert.equal(result.reason, 'cancelled');
    assert.equal(result.uncertain, true);
    assert.equal(result.dispatched, null);
    assert.equal(result.dispatchStatus, 'unknown');
    assert.deepEqual(io.writes.map(write => write.meta.phase), ['enter-boot']);
    assert.equal(result.nextWriteBlocked, true);

    io.resolveHangingWrites();
    await delay(5);
    assert.deepEqual(io.writes.map(write => write.meta.phase), ['enter-boot']);
  });

  test('unknown native write failure preserves prior mutation uncertainty', async () => {
    const io = new MockFirmwareIo({ throwPhase: 'write' });
    const coordinator = makeCoordinator(io);
    const result = await coordinator.run();

    assert.equal(result.success, false);
    assert.equal(result.failedPhase, 'write');
    assert.equal(result.reason, 'uncertain');
    assert.equal(result.uncertain, true);
    assert.equal(result.priorMutation, true);
    assert.equal(result.dispatchStatus, 'unknown');
    assert.equal(result.dispatchUnknown, true);
    assert.equal(result.dispatched, null);
    assert.deepEqual(io.writes.map(write => write.meta.phase), ['enter-boot', 'erase', 'write']);
    assert.equal(io.writes.some(write => ['verify', 'end', 'success'].includes(write.meta.phase)), false);
    assert.equal(io.writes.at(-1).meta.phase, 'write');
    assert.equal(io.writes.at(-1).meta.length, 32);
    assert.equal(coordinator.requests.at(-1).dispatchStatus, 'unknown');
  });

  test('explicit non-dispatch evidence is distinct from an unknown native failure', async () => {
    const io = new MockFirmwareIo({ explicitNotDispatchedPhase: 'erase' });
    const result = await makeCoordinator(io).run();

    assert.equal(result.success, false);
    assert.equal(result.failedPhase, 'erase');
    assert.equal(result.reason, 'io-error');
    assert.equal(result.uncertain, false);
    assert.equal(result.dispatched, false);
    assert.equal(result.dispatchStatus, 'no');
    assert.equal(result.dispatchUnknown, false);
    assert.equal(result.priorMutation, false);
    assert.deepEqual(io.writes.map(write => write.meta.phase), ['enter-boot', 'erase']);
  });

  test('disconnect during a dispatched check stops without continuing to end or success', async () => {
    const io = new MockFirmwareIo();
    let coordinator;
    coordinator = makeCoordinator(io);
    io.onWrite = (_packet, meta, mock) => {
      if (meta.phase === 'verify' && meta.offset === 0) mock.disconnect();
    };
    const result = await coordinator.run();
    assert.equal(result.success, false);
    assert.equal(result.reason, 'disconnected');
    assert.equal(result.uncertain, true);
    assert.equal(result.failedPhase, 'verify');
    assert.deepEqual(io.writes.map(write => write.meta.phase), ['enter-boot', 'erase', 'write', 'write', 'verify']);
    assert.equal(io.writes.some(write => ['end', 'success'].includes(write.meta.phase)), false);
  });

  test('invalid package fails in preflight with zero IO writes', async () => {
    const io = new MockFirmwareIo();
    const result = await makeCoordinator(io, { packageBytes: Buffer.from('wrong package') }).run();
    assert.equal(result.success, false);
    assert.equal(result.failedPhase, 'preflight');
    assert.equal(result.reason, 'invalid-package');
    assert.equal(result.dispatched, false);
    assert.equal(io.writes.length, 0);
  });

  test('required response, disconnect, and identity hooks are checked before boot entry', async () => {
    const io = new MockFirmwareIo();
    io.waitForIdentity = undefined;
    const result = await makeCoordinator(io).run();

    assert.equal(result.success, false);
    assert.equal(result.failedPhase, 'preflight');
    assert.equal(result.reason, 'identity-unavailable');
    assert.equal(result.uncertain, false);
    assert.equal(result.dispatched, false);
    assert.equal(io.writes.length, 0);
  });

  test('missing or malformed normal USB location fails preflight before boot entry', async () => {
    for (const locationId of [undefined, '0x02400000-junk']) {
      const io = new MockFirmwareIo();
      const result = await makeCoordinator(io, {
        normalIdentity: { ...normalIdentity, locationId }
      }).run();

      assert.equal(result.success, false);
      assert.equal(result.failedPhase, 'preflight');
      assert.equal(result.reason, 'ambiguous-identity');
      assert.equal(result.uncertain, false);
      assert.equal(result.dispatched, false);
      assert.match(result.error, /stable USB location/i);
      assert.deepEqual(io.writes, [], `location ${String(locationId)} must not enter boot mode`);
    }
  });

  test('cancellation also bounds a never-settling initial identity read before any write', async () => {
    const io = new MockFirmwareIo();
    io.getIdentity = () => new Promise(() => {});
    const coordinator = makeCoordinator(io, {
      normalIdentity: null,
      timeouts: { dispatchMs: 30, flagMs: 30, identityMs: 1000 }
    });
    const running = coordinator.run();
    setTimeout(() => coordinator.cancel('Cancel while reading current identity'), 5);
    const result = await Promise.race([
      running,
      new Promise((_, reject) => setTimeout(() => reject(new Error('identity preflight remained pending')), 100))
    ]);

    assert.equal(result.success, false);
    assert.equal(result.reason, 'cancelled');
    assert.equal(result.uncertain, false);
    assert.equal(result.dispatched, false);
    assert.equal(io.writes.length, 0);
  });

  test('a bootloader without a serial string binds by USB location and is marked location-only', async () => {
    const seriallessBootIdentity = { ...bootIdentity, serialNumber: null };
    const io = new MockFirmwareIo({
      identityPlan: request => (
        request.phase === 'boot-confirmation'
          ? (io.attach(), seriallessBootIdentity)
          : (io.attach(), returnedNormalIdentity)
      )
    });
    const result = await makeCoordinator(io).run();
    assert.equal(result.success, true);
    assert.equal(result.bootIdentity.serialNumber, null);
    assert.equal(result.transition.bootSerialEvidence, 'location-only');
    // The boot->normal transition anchor is the serial-less boot identity, so
    // that binding is location-only too; the stricter normal<->normal check
    // afterwards still confirms serial continuity with the reviewed device.
    assert.equal(result.transition.normalSerialEvidence, 'location-only');
  });

  test('refuses enter-boot when the boot-anchor hook is missing', async () => {
    const io = new MockFirmwareIo();
    const result = await makeCoordinator(io, { onBootAnchor: null }).run();
    assert.equal(result.success, false);
    assert.equal(result.failedPhase, 'enter-boot');
    assert.equal(result.reason, 'anchor-required');
    assert.equal(result.dispatched, false);
    assert.equal(result.dispatchStatus, 'no');
    assert.deepEqual(io.writes, []);
  });

  test('a flag stamped during drain is still accepted when the listener is already armed', async () => {
    const io = new MockFirmwareIo({ detachOnEnter: true, detachOnSuccess: true, ackDuringDrain: true });
    const result = await makeCoordinator(io, { timeouts: { dispatchMs: 30, flagMs: 40, identityMs: 30 } }).run();
    assert.equal(result.success, true, result.error);
    assert.ok(io.writes.some(write => write.meta.phase === 'erase'));
  });

  test('a serial present on both sides must still match during transitions', async () => {
    const io = new MockFirmwareIo({
      identityPlan: request => (
        request.phase === 'boot-confirmation'
          ? (io.attach(), { ...bootIdentity, serialNumber: 'DIFFERENT-SERIAL' })
          : (io.attach(), returnedNormalIdentity)
      )
    });
    const result = await makeCoordinator(io).run();
    assert.equal(result.success, false);
    assert.equal(result.failedPhase, 'boot-confirmation');
    assert.equal(result.reason, 'ambiguous-identity');
    assert.deepEqual(io.writes.map(write => write.meta.phase), ['enter-boot']);
  });

  test('ambiguous boot identity stops before erase', async () => {
    const io = new MockFirmwareIo({
      identityPlan: request => request.phase === 'boot-confirmation' ? [bootIdentity, { ...bootIdentity, path: 'other' }] : returnedNormalIdentity
    });
    const result = await makeCoordinator(io).run();
    assert.equal(result.success, false);
    assert.equal(result.failedPhase, 'boot-confirmation');
    assert.equal(result.reason, 'ambiguous-identity');
    assert.equal(result.uncertain, true);
    assert.deepEqual(io.writes.map(write => write.meta.phase), ['enter-boot']);
  });
});

describe('boot-mode transfer resume', () => {
  const resumeAnchor = {
    targetKey: 'fixture',
    locationId: normalIdentity.locationId,
    serialNumber: normalIdentity.serialNumber,
    packageSha256: fixtureCatalog.fixture.package.sha256
  };

  test('resumeFromBoot skips enter-boot and binds the unique boot candidate to the anchor', async () => {
    const io = new MockFirmwareIo({ detachOnSuccess: true });
    io.connected = false;
    const result = await makeCoordinator(io, { normalIdentity: null }).run({
      resumeFromBoot: true,
      bootAnchor: resumeAnchor
    });
    assert.equal(result.success, true, result.error);
    assert.equal(result.resumedFromBoot, true);
    assert.deepEqual(io.writes.map(write => write.meta.phase), [
      'erase', 'write', 'write', 'verify', 'verify', 'end', 'success'
    ]);
    assert.equal(result.transition.bootSerialEvidence, 'both');
    assert.equal(result.transition.normalSerialEvidence, 'both');
  });

  test('resumeFromBoot fails closed on zero or ambiguous boot candidates without dispatch', async () => {
    const none = new MockFirmwareIo({
      identityPlan: request => request.phase === 'boot-confirmation' ? [] : returnedNormalIdentity
    });
    none.connected = false;
    const missing = await makeCoordinator(none, { normalIdentity: null }).run({
      resumeFromBoot: true,
      bootAnchor: resumeAnchor
    });
    assert.equal(missing.success, false);
    assert.equal(missing.reason, 'no-candidate');
    assert.equal(missing.dispatched, false);
    assert.equal(missing.uncertain, false);
    assert.deepEqual(none.writes, []);

    const many = new MockFirmwareIo({
      identityPlan: request => request.phase === 'boot-confirmation'
        ? [bootIdentity, { ...bootIdentity, path: 'other' }]
        : returnedNormalIdentity
    });
    many.connected = false;
    const ambiguous = await makeCoordinator(many, { normalIdentity: null }).run({
      resumeFromBoot: true,
      bootAnchor: resumeAnchor
    });
    assert.equal(ambiguous.success, false);
    assert.equal(ambiguous.reason, 'ambiguous-identity');
    assert.equal(ambiguous.dispatched, false);
    assert.equal(ambiguous.uncertain, false);
    assert.deepEqual(many.writes, []);
  });

  test('resumeFromBoot unique identity miss reports dispatched no', async () => {
    const wrongPid = new MockFirmwareIo({
      identityPlan: request => request.phase === 'boot-confirmation'
        ? { ...bootIdentity, productId: 0x9999 }
        : returnedNormalIdentity
    });
    wrongPid.connected = false;
    const mismatched = await makeCoordinator(wrongPid, { normalIdentity: null }).run({
      resumeFromBoot: true,
      bootAnchor: resumeAnchor
    });
    assert.equal(mismatched.success, false);
    assert.equal(mismatched.reason, 'ambiguous-identity');
    assert.equal(mismatched.dispatched, false);
    assert.equal(mismatched.dispatchStatus, 'no');
    assert.equal(mismatched.uncertain, false);
    assert.deepEqual(wrongPid.writes, []);

    const wrongLocation = new MockFirmwareIo({
      identityPlan: request => request.phase === 'boot-confirmation'
        ? { ...bootIdentity, locationId: 0x11111111 }
        : returnedNormalIdentity
    });
    wrongLocation.connected = false;
    const unbound = await makeCoordinator(wrongLocation, { normalIdentity: null }).run({
      resumeFromBoot: true,
      bootAnchor: resumeAnchor
    });
    assert.equal(unbound.success, false);
    assert.equal(unbound.reason, 'ambiguous-identity');
    assert.equal(unbound.dispatched, false);
    assert.equal(unbound.dispatchStatus, 'no');
    assert.equal(unbound.uncertain, false);
    assert.deepEqual(wrongLocation.writes, []);
  });

  test('resumeFromBoot refuses a missing package SHA unless allowDifferentPackage is set', async () => {
    const missingSha = { targetKey: resumeAnchor.targetKey, locationId: resumeAnchor.locationId, serialNumber: resumeAnchor.serialNumber };
    const deniedIo = new MockFirmwareIo();
    deniedIo.connected = false;
    const denied = await makeCoordinator(deniedIo, { normalIdentity: null }).run({
      resumeFromBoot: true,
      bootAnchor: missingSha
    });
    assert.equal(denied.success, false);
    assert.equal(denied.reason, 'invalid-anchor');
    assert.equal(denied.dispatched, false);
    assert.deepEqual(deniedIo.writes, []);

    const allowedIo = new MockFirmwareIo({ detachOnSuccess: true });
    allowedIo.connected = false;
    const allowed = await makeCoordinator(allowedIo, { normalIdentity: null }).run({
      resumeFromBoot: true,
      bootAnchor: missingSha,
      allowDifferentPackage: true
    });
    assert.equal(allowed.success, true, allowed.error);
  });

  test('resumeFromBoot refuses a package SHA mismatch unless allowDifferentPackage is set', async () => {
    const mismatched = { ...resumeAnchor, packageSha256: 'ab'.repeat(32) };
    const deniedIo = new MockFirmwareIo();
    deniedIo.connected = false;
    const denied = await makeCoordinator(deniedIo, { normalIdentity: null }).run({
      resumeFromBoot: true,
      bootAnchor: mismatched
    });
    assert.equal(denied.success, false);
    assert.equal(denied.reason, 'package-mismatch');
    assert.equal(denied.dispatched, false);
    assert.equal(denied.uncertain, false);
    assert.deepEqual(deniedIo.writes, []);

    const allowedIo = new MockFirmwareIo({ detachOnSuccess: true });
    allowedIo.connected = false;
    const allowed = await makeCoordinator(allowedIo, { normalIdentity: null }).run({
      resumeFromBoot: true,
      bootAnchor: mismatched,
      allowDifferentPackage: true
    });
    assert.equal(allowed.success, true, allowed.error);
    assert.equal(allowed.resumedFromBoot, true);
    assert.equal(allowedIo.writes.some(write => write.meta.phase === 'enter-boot'), false);
  });
});

