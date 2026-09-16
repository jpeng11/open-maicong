'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const firmware = require('../src/firmware-protocol.cjs');
const { FirmwareUpdateController } = require('../src/firmware-controller.cjs');
const transport = require('../src/transport.cjs');
const { MockGlwMemoryDevice } = require('./mock-glw-memory.cjs');

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
      versionSource: 'fixture',
      firmwareField: 'firmwareVersion'
    }
  }
};

const normalIdentity = {
  ...fixtureCatalog.fixture.normal,
  serialNumber: 'CONTROLLER-SERIAL',
  locationId: 0x02400000,
  registryEntryId: 100,
  registryPath: 'DevSrvsID:normal-old',
  path: 'DevSrvsID:normal-old'
};
const bootIdentity = {
  ...fixtureCatalog.fixture.boot,
  serialNumber: normalIdentity.serialNumber,
  locationId: normalIdentity.locationId,
  registryEntryId: 200,
  registryPath: 'DevSrvsID:boot',
  path: 'DevSrvsID:boot'
};
const returnedNormalIdentity = {
  ...normalIdentity,
  registryEntryId: 300,
  registryPath: 'DevSrvsID:normal-new',
  path: 'DevSrvsID:normal-new'
};

const beforeInfo = {
  firmwareVersion: '0.99',
  rawFirmwareVersion: 99,
  rfFirmwareVersion: '1.00',
  rawRfFirmwareVersion: 100,
  buildDate: 'fixture-before',
  dongleInfo: null
};
const afterInfo = {
  firmwareVersion: '1.00',
  rawFirmwareVersion: 100,
  rfFirmwareVersion: '1.00',
  rawRfFirmwareVersion: 100,
  buildDate: 'fixture-after',
  dongleInfo: null
};

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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
    this._attach(reviewedIdentity);
    return this.getIdentity();
  }

  getIdentity() {
    return this.identity ? { ...this.identity } : null;
  }

  async waitForIdentity(request) {
    if (request.phase === 'boot-confirmation') {
      this._attach(bootIdentity);
      return this.getIdentity();
    }
    if (request.phase === 'normal-reconnect') {
      this._attach(returnedNormalIdentity);
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
      if (!this.entered) this.entered = new Promise(resolve => { this.releaseHeld = resolve; });
      await this.entered;
    }
    if (this.options.rejectPhase === meta.phase) {
      setImmediate(() => this._emitData(firmware.buildFlagResponse(1)));
      return { dispatched: true };
    }
    setImmediate(() => {
      this._emitData(firmware.buildFlagResponse(0));
      if (meta.phase === 'success') this._detach();
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

class MockControllerTransport {
  constructor(options = {}) {
    this.options = options;
    this.device = {};
    this.deviceInfo = { ...normalIdentity };
    this.lastState = { device: { ...normalIdentity } };
    this.firmwareTopologyIdentity = { ...normalIdentity };
    this.generation = 7;
    this.resetEpoch = 3;
    this.needsReconnect = false;
    this.calls = [];
    this.owner = null;
    this.reconnected = false;
    this.nativeClosed = false;
  }

  async readFirmwareInfo(options = {}) {
    this.calls.push({ kind: 'read-version', owner: Boolean(options.ownerToken) });
    const identity = this.reconnected ? returnedNormalIdentity : normalIdentity;
    return {
      success: true,
      identity: { ...identity },
      info: this.reconnected ? { ...afterInfo } : { ...beforeInfo }
    };
  }

  async acquireFirmwareOwnership(expected) {
    this.calls.push({ kind: 'acquire' });
    if (this.owner) return { success: false, error: 'already owned', reason: 'busy' };
    if (!expected || expected.locationId !== normalIdentity.locationId) {
      return { success: false, error: 'identity mismatch', reason: 'stale-review' };
    }
    this.owner = { owner: 'controller' };
    return {
      success: true,
      token: this.owner,
      identity: { ...normalIdentity },
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

  async connectFirmwareNormal(identity, ownerToken) {
    this.calls.push({ kind: 'connect-normal', path: identity.path, owner: ownerToken === this.owner });
    if (ownerToken !== this.owner) return { success: false, error: 'owner mismatch' };
    this.reconnected = true;
    this.nativeClosed = true;
    this.device = {};
    return { success: true, identity: { ...returnedNormalIdentity } };
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

function makeController(options = {}) {
  const transportFixture = options.transport || new MockControllerTransport(options);
  let nativeFixture = null;
  const controller = new FirmwareUpdateController({
    transport: transportFixture,
    catalog: fixtureCatalog,
    reviewTtlMs: options.reviewTtlMs || 60_000,
    nativeIoFactory: () => {
      nativeFixture = new MockNativeFirmwareIo(options);
      return nativeFixture;
    },
    timeouts: { dispatchMs: 40, flagMs: 40, identityMs: 40 }
  });
  return { controller, transport: transportFixture, getNative: () => nativeFixture };
}

async function reviewFixture(controller, backupPath = '/tmp/maicong-controller-backup.json') {
  const result = await controller.review({
    target: 'fixture',
    packageBytes: fixtureBytes,
    identity: normalIdentity,
    backupPath
  });
  assert.equal(result.success, true, result.error);
  return result.reviewToken;
}

describe('exclusive native firmware update controller', () => {
  test('catalog-hash mismatch review sends zero boot/erase writes', async () => {
    const { controller, getNative } = makeController();
    const review = await controller.review({
      target: 'fixture',
      packageBytes: Buffer.from('not-the-fixture-bytes'),
      identity: normalIdentity,
      backupPath: '/tmp/controller-hash-mismatch.json'
    });
    assert.equal(review.success, false);
    assert.equal(review.reason, 'invalid-package');
    const start = await controller.start(review.reviewToken, { confirmed: true });
    assert.equal(start.success, false);
    assert.equal(getNative(), null);
  });

  test('requires explicit confirmation and consumes an expiring identity-bound review token', async () => {
    const { controller } = makeController();
    const review = await controller.review({
      target: 'fixture', packageBytes: fixtureBytes, identity: normalIdentity,
      backupPath: '/tmp/controller-confirmation.json'
    });
    assert.equal(review.success, true, review.error);
    assert.equal(review.reviewToken.package.fullFile, true);
    assert.deepEqual(review.reviewToken.identity, {
      vendorId: normalIdentity.vendorId,
      productId: normalIdentity.productId,
      interface: normalIdentity.interface,
      usagePage: normalIdentity.usagePage,
      usage: normalIdentity.usage,
      serialNumber: normalIdentity.serialNumber,
      path: normalIdentity.path,
      locationId: normalIdentity.locationId,
      registryEntryId: normalIdentity.registryEntryId,
      registryPath: normalIdentity.registryPath
    });

    const denied = await controller.start(review.reviewToken);
    assert.equal(denied.success, false);
    assert.equal(denied.reason, 'confirmation-required');

    const forged = { ...review.reviewToken, targetKey: 'receiver' };
    const forgedResult = await controller.start(forged, { confirmed: true });
    assert.equal(forgedResult.success, false);
    assert.equal(forgedResult.reason, 'stale-review');

    const success = await controller.start(review.reviewToken, { confirmed: true });
    assert.equal(success.success, true, success.error);
    assert.equal(success.fullUpdaterSuccess, true);
  });

  test('runs backup, one serialized native transfer, exact normal reconnect, real version gate, and verified restore', async () => {
    const { controller, transport, getNative } = makeController();
    const progress = [];
    const backupPath = '/tmp/maicong-controller-success.json';
    const token = await reviewFixture(controller, backupPath);
    const result = await controller.start(token, { confirmed: true, onProgress: event => progress.push(event) });

    assert.equal(result.success, true, result.error);
    assert.equal(result.fullUpdaterSuccess, true);
    assert.equal(result.version.matched, true);
    assert.equal(result.restorationVerified, true);
    assert.equal(result.backupRetained, true);
    assert.equal(result.backupPath, backupPath);
    assert.equal(result.transfer.fullUpdaterSuccess, false, 'raw transfer must not claim full updater success');
    assert.deepEqual(getNative().writes.map(write => write.meta.phase), [
      'enter-boot', 'erase', 'write', 'write', 'verify', 'verify', 'end', 'success'
    ]);
    assert.deepEqual(transport.calls.map(call => call.kind), [
      'read-version', 'read-version', 'acquire', 'backup', 'close-normal', 'connect-normal',
      'read-version', 'restore', 'release'
    ]);
    assert.ok(transport.calls.find(call => call.kind === 'backup').owner);
    assert.ok(transport.calls.find(call => call.kind === 'restore').owner);
    assert.equal(transport.calls.find(call => call.kind === 'connect-normal').path, returnedNormalIdentity.path);
    assert.ok(progress.some(event => event.phase === 'handoff'));
    assert.ok(progress.some(event => event.phase === 'version-readback'));
    assert.equal(progress.at(-1).phase, 'complete');
  });

  test('keeps the persisted backup and refuses to restore when post-update version readback mismatches', async () => {
    const { controller, transport } = makeController();
    const originalRead = transport.readFirmwareInfo.bind(transport);
    transport.readFirmwareInfo = async options => {
      const result = await originalRead(options);
      if (transport.reconnected) result.info.rawFirmwareVersion = 101;
      return result;
    };
    const token = await reviewFixture(controller, '/tmp/maicong-controller-version-mismatch.json');
    const result = await controller.start(token, { confirmed: true });

    assert.equal(result.success, false);
    assert.equal(result.fullUpdaterSuccess, false);
    assert.equal(result.reason, 'version-mismatch');
    assert.equal(result.version.matched, false);
    assert.equal(result.backupRetained, true);
    assert.equal(result.restoration, null);
    assert.equal(transport.calls.some(call => call.kind === 'restore'), false);
  });

  test('reports partial restoration after writes without converting it into updater success', async () => {
    const { controller, transport } = makeController({ restoreFailure: true });
    const token = await reviewFixture(controller, '/tmp/maicong-controller-partial-restore.json');
    const result = await controller.start(token, { confirmed: true });

    assert.equal(result.success, false);
    assert.equal(result.reason, 'restoration-failed');
    assert.equal(result.restorationVerified, false);
    assert.equal(result.partialRestoration, true);
    assert.equal(result.backupRetained, true);
    assert.equal(transport.calls.at(-1).kind, 'release');
  });

  test('does not continue after an explicit boot rejection and retains the backup', async () => {
    const { controller, transport, getNative } = makeController({ rejectPhase: 'erase' });
    const token = await reviewFixture(controller, '/tmp/maicong-controller-rejected.json');
    const result = await controller.start(token, { confirmed: true });

    assert.equal(result.success, false);
    assert.equal(result.reason, 'rejected');
    assert.equal(result.rejected, true);
    assert.equal(result.uncertain, false);
    assert.equal(result.backupRetained, true);
    assert.deepEqual(getNative().writes.map(write => write.meta.phase), ['enter-boot', 'erase']);
    assert.equal(transport.calls.some(call => call.kind === 'connect-normal'), false);
    assert.equal(transport.calls.some(call => call.kind === 'restore'), false);
  });

  test('serializes controller ownership and rejects a competing start while the first update is active', async () => {
    const { controller, transport, getNative } = makeController({ holdPhase: 'erase' });
    const firstToken = await reviewFixture(controller, '/tmp/maicong-controller-busy-a.json');
    const secondReview = await controller.review({
      target: 'fixture', packageBytes: fixtureBytes, identity: normalIdentity,
      backupPath: '/tmp/maicong-controller-busy-b.json'
    });
    assert.equal(secondReview.success, true, secondReview.error);

    const running = controller.start(firstToken, { confirmed: true });
    await new Promise(resolve => {
      const poll = () => getNative() && getNative().writes.some(write => write.meta.phase === 'erase')
        ? resolve() : setImmediate(poll);
      poll();
    });
    const competing = await controller.start(secondReview.reviewToken, { confirmed: true });
    assert.equal(competing.success, false);
    assert.equal(competing.reason, 'busy');

    getNative().releaseHeldWrite();
    const result = await running;
    assert.equal(result.success, true, result.error);
    assert.equal(transport.owner, null);
  });
});

describe('normal transport firmware ownership gate', () => {
  beforeEach(() => {
    transport.disconnect();
    delete transport.firmwareTopologyIdentity;
  });

  afterEach(() => {
    if (transport.isFirmwareExclusive && transport.isFirmwareExclusive()) {
      const owner = transport._firmwareExclusive && transport._firmwareExclusive.token;
      transport.releaseFirmwareOwnership(owner);
    }
    transport.disconnect();
    delete transport.firmwareTopologyIdentity;
  });

  test('blocks queued configuration, streaming, status watcher reconnect, and direct disconnect while owned', async () => {
    const mock = new MockGlwMemoryDevice();
    const identity = { ...normalIdentity, path: 'mock://controller', registryPath: 'mock://controller' };
    const installed = transport.installTestAdapter(mock);
    assert.equal(installed.success, true, installed.error);
    transport.deviceInfo = { ...transport.deviceInfo, ...identity };
    transport.lastState.device = { ...transport.lastState.device, ...identity };
    transport.firmwareTopologyIdentity = { ...identity };

    const acquired = await transport.acquireFirmwareOwnership(identity);
    assert.equal(acquired.success, true, acquired.error);
    await assert.rejects(
      () => transport.runTransaction(async () => ({ success: true })),
      /Firmware updater owns/
    );
  });
});
