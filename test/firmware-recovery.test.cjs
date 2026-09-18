'use strict';

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const firmware = require('../src/firmware-protocol.cjs');
const firmwareBackup = require('../src/firmware-backup.cjs');
const { FirmwareUpdateController } = require('../src/firmware-controller.cjs');

const fixtureBytes = Buffer.from([
  0x37, 0x38, 0x21, 0x20, 0x14, 0x01, 0xAA, 0xBB,
  0x00, 0x00, 0x00, 0x00, 0x10, 0x11, 0x12, 0x13,
  0x20, 0x21, 0x22, 0x23, 0x30, 0x31, 0x32, 0x33,
  0x40, 0x41, 0x42, 0x43, 0x50, 0x51, 0x52, 0x53,
  0x60, 0x61, 0x62
]);
const fixtureSha = crypto.createHash('sha256').update(fixtureBytes).digest('hex');
const otherPackageSha = 'ab'.repeat(32);

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
      sha256: fixtureSha,
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

let tempDirs = [];

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maicong-fw-recovery-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  tempDirs = [];
});

class MockNativeFirmwareIo {
  constructor(options = {}) {
    this.options = options;
    this.connected = false;
    this.identity = null;
    this.writes = [];
    this.dataListeners = new Set();
    this.disconnectListeners = new Set();
    this.closed = false;
    this.openedNormal = false;
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
    this.openedNormal = true;
    this._attach(reviewedIdentity);
    return this.getIdentity();
  }

  getIdentity() {
    return this.identity ? { ...this.identity } : null;
  }

  async waitForIdentity(request) {
    if (request.phase === 'boot-confirmation') {
      const count = this.options.bootCandidates;
      if (count === 0) return [];
      if (Number.isInteger(count) && count > 1) {
        const candidates = [];
        for (let i = 0; i < count; i += 1) {
          candidates.push({ ...bootIdentity, path: `${bootIdentity.path}-${i}` });
        }
        return candidates;
      }
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

class MockRecoveryTransport {
  constructor(options = {}) {
    this.options = options;
    this.device = {};
    this.deviceInfo = { ...normalIdentity };
    this.lastState = { device: { ...normalIdentity } };
    this.firmwareTopologyIdentity = { ...normalIdentity };
    this.calls = [];
    this.owner = null;
    this.reconnected = false;
  }

  async readFirmwareInfo(options = {}) {
    this.calls.push({ kind: 'read-version', owner: Boolean(options.ownerToken) });
    const identity = this.reconnected ? returnedNormalIdentity : normalIdentity;
    const result = {
      success: true,
      identity: { ...identity },
      info: this.reconnected ? { ...afterInfo } : { ...beforeInfo }
    };
    if (this.reconnected && this.options.echoVersionChecksum) result.checksumEchoed = true;
    if (this.reconnected && this.options.afterInfo) result.info = { ...this.options.afterInfo };
    if (!this.reconnected && this.options.beforeInfo) result.info = { ...this.options.beforeInfo };
    return result;
  }

  async acquireFirmwareOwnership(expected) {
    this.calls.push({ kind: 'acquire', path: expected && expected.path });
    if (this.owner) return { success: false, error: 'already owned', reason: 'busy' };
    this.owner = { owner: 'controller' };
    const identity = this.reconnected ? returnedNormalIdentity : normalIdentity;
    return {
      success: true,
      token: this.owner,
      identity: { ...identity }
    };
  }

  async backupFirmwareConfiguration(options = {}) {
    this.calls.push({ kind: 'backup', path: options.filePath, owner: options.ownerToken === this.owner });
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
    this.deviceInfo = { ...returnedNormalIdentity };
    this.lastState.device = { ...returnedNormalIdentity };
    return { success: true, device: { ...returnedNormalIdentity } };
  }

  async connectFirmwareNormal(identity, ownerToken) {
    this.calls.push({ kind: 'connect-normal', path: identity && identity.path, owner: ownerToken === this.owner });
    if (ownerToken !== this.owner) return { success: false, error: 'owner mismatch' };
    this.reconnected = true;
    this.device = {};
    return { success: true, identity: { ...returnedNormalIdentity } };
  }

  async restoreFirmwareConfiguration(source, options = {}) {
    this.calls.push({ kind: 'restore', source, owner: options.ownerToken === this.owner });
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
  const transportFixture = options.transport || new MockRecoveryTransport(options);
  let nativeFixture = null;
  let factoryOptions = null;
  const controller = new FirmwareUpdateController({
    transport: transportFixture,
    catalog: fixtureCatalog,
    reviewTtlMs: 60_000,
    nativeIoFactory: (nativeOptions) => {
      factoryOptions = nativeOptions;
      nativeFixture = new MockNativeFirmwareIo({ ...options, ...nativeOptions });
      return nativeFixture;
    },
    timeouts: { dispatchMs: 40, flagMs: 40, identityMs: 40 }
  });
  return {
    controller,
    transport: transportFixture,
    getNative: () => nativeFixture,
    getFactoryOptions: () => factoryOptions
  };
}

function writeAnchor(dir, overrides = {}) {
  const backupPath = overrides.backupPath || path.join(dir, 'backup.json');
  if (overrides.createBackup !== false) {
    fs.writeFileSync(backupPath, '{"schema":"fixture-backup"}\n');
  }
  const anchorPath = firmwareBackup.bootAnchorPath(dir);
  const written = firmwareBackup.writeBootAnchor(anchorPath, {
    schema: firmwareBackup.BOOT_ANCHOR_SCHEMA,
    version: firmwareBackup.BOOT_ANCHOR_SCHEMA_VERSION,
    targetKey: 'fixture',
    locationId: normalIdentity.locationId,
    serialNumber: normalIdentity.serialNumber,
    packageSha256: fixtureSha,
    backupPath,
    firmwareField: 'firmwareVersion',
    beforeVersionRaw: 99,
    enteredAt: Date.now(),
    ...overrides.anchor
  });
  assert.equal(written.success, true, written.error);
  return { dir, backupPath, anchorPath };
}

describe('firmware recovery entry point', () => {
  test('resumeInterruptedUpdate restores from a unique boot candidate end to end', async () => {
    const { backupPath, anchorPath, dir } = writeAnchor(tempDir());
    const { controller, transport, getNative, getFactoryOptions } = makeController();
    const progress = [];

    const result = await controller.resumeInterruptedUpdate({
      confirmed: true,
      backupDir: dir,
      packageBytes: fixtureBytes,
      onProgress: event => progress.push(event)
    });

    assert.equal(result.success, true, result.error);
    assert.equal(result.fullUpdaterSuccess, true);
    assert.equal(result.resumedFromBoot, true);
    assert.equal(result.transfer.resumedFromBoot, true);
    assert.equal(result.bootAnchorCleared, true);
    assert.equal(result.version.matched, true);
    assert.equal(result.version.beforeRaw, 99);
    assert.equal(result.version.actual, 100);
    assert.equal(result.restorationVerified, true);
    assert.equal(result.identity.path, returnedNormalIdentity.path);
    assert.equal(getFactoryOptions().reviewedIdentity, undefined);
    assert.equal(getNative().openedNormal, false);
    assert.deepEqual(getNative().writes.map(write => write.meta.phase), [
      'erase', 'write', 'write', 'verify', 'verify', 'end', 'success'
    ]);
    assert.equal(transport.calls.some(call => call.kind === 'connect-normal'), false);
    assert.equal(transport.calls.find(call => call.kind === 'connect').path, returnedNormalIdentity.path);
    assert.equal(transport.calls.find(call => call.kind === 'acquire').path, returnedNormalIdentity.path);
    assert.ok(transport.calls.find(call => call.kind === 'restore').owner);
    assert.equal(transport.owner, null);
    assert.equal(fs.existsSync(anchorPath), false);
    assert.equal(fs.existsSync(backupPath), true);
    assert.ok(progress.some(event => event.phase === 'boot-confirmation'));
    assert.ok(progress.some(event => event.phase === 'version-readback'));
    assert.equal(progress.at(-1).phase, 'complete');
  });

  test('resume restores then succeeds when the catalog version is unchanged after a verified write', async () => {
    const { dir } = writeAnchor(tempDir(), { anchor: { beforeVersionRaw: 100 } });
    const { controller, transport } = makeController({
      beforeInfo: afterInfo,
      afterInfo
    });

    const result = await controller.resumeInterruptedUpdate({
      confirmed: true,
      backupDir: dir,
      packageBytes: fixtureBytes
    });

    assert.equal(result.success, true, result.error);
    assert.equal(result.version.matched, true);
    assert.equal(result.version.beforeRaw, 100);
    assert.equal(result.version.actual, 100);
    assert.equal(result.restorationVerified, true);
    assert.equal(transport.calls.some(call => call.kind === 'restore'), true);
    const restoreIndex = transport.calls.findIndex(call => call.kind === 'restore');
    const versionIndex = transport.calls.findIndex((call, index) => call.kind === 'read-version' && index > restoreIndex);
    assert.ok(versionIndex > restoreIndex);
  });

  test('resume restores configuration even when post-write GET_INFO keeps echoing', async () => {
    const { dir } = writeAnchor(tempDir());
    const { controller, transport } = makeController({ echoVersionChecksum: true });

    const result = await controller.resumeInterruptedUpdate({
      confirmed: true,
      backupDir: dir,
      packageBytes: fixtureBytes
    });

    assert.equal(result.success, false);
    assert.equal(result.reason, 'version-untrusted');
    assert.equal(result.restorationVerified, true);
    assert.equal(transport.calls.some(call => call.kind === 'restore'), true);
    const postReconnectReads = transport.calls.filter((call, index) =>
      call.kind === 'read-version' && transport.calls.findIndex(c => c.kind === 'connect') < index);
    assert.equal(postReconnectReads.length, 3);
  });

  test('writeBootAnchor refuses a missing package SHA-256', () => {
    const dir = tempDir();
    const written = firmwareBackup.writeBootAnchor(firmwareBackup.bootAnchorPath(dir), {
      schema: firmwareBackup.BOOT_ANCHOR_SCHEMA,
      version: firmwareBackup.BOOT_ANCHOR_SCHEMA_VERSION,
      targetKey: 'fixture',
      locationId: normalIdentity.locationId,
      serialNumber: normalIdentity.serialNumber,
      packageSha256: null,
      backupPath: path.join(dir, 'backup.json'),
      firmwareField: 'firmwareVersion',
      beforeVersionRaw: 99,
      enteredAt: Date.now()
    });
    assert.equal(written.success, false);
    assert.match(written.error, /SHA-256/i);
  });

  test('resume refuses when no boot candidate matches the persisted anchor', async () => {
    const { anchorPath, dir } = writeAnchor(tempDir());
    const { controller, transport, getNative } = makeController({ bootCandidates: 0 });

    const result = await controller.resumeInterruptedUpdate({
      confirmed: true,
      backupDir: dir,
      packageBytes: fixtureBytes
    });

    assert.equal(result.success, false);
    assert.equal(result.reason, 'no-candidate');
    assert.equal(result.failedPhase, 'boot-confirmation');
    assert.equal(result.dispatched, false);
    assert.equal(result.uncertain, false);
    assert.equal(result.resumedFromBoot, true);
    assert.deepEqual(getNative().writes, []);
    assert.equal(transport.calls.some(call => call.kind === 'connect'), false);
    assert.equal(transport.calls.some(call => call.kind === 'restore'), false);
    assert.equal(fs.existsSync(anchorPath), true);
  });

  test('resume refuses an ambiguous boot candidate set and does not erase', async () => {
    const { anchorPath, dir } = writeAnchor(tempDir());
    const { controller, transport, getNative } = makeController({ bootCandidates: 2 });

    const result = await controller.resumeInterruptedUpdate({
      confirmed: true,
      backupDir: dir,
      packageBytes: fixtureBytes
    });

    assert.equal(result.success, false);
    assert.equal(result.reason, 'ambiguous-identity');
    assert.equal(result.failedPhase, 'boot-confirmation');
    assert.equal(result.dispatched, false);
    assert.equal(result.uncertain, false);
    assert.deepEqual(getNative().writes, []);
    assert.equal(transport.calls.some(call => call.kind === 'connect'), false);
    assert.equal(fs.existsSync(anchorPath), true);
  });

  test('resume refuses a package SHA mismatch unless allowDifferentPackage is set', async () => {
    const { dir } = writeAnchor(tempDir(), { anchor: { packageSha256: otherPackageSha } });
    const { controller, getNative } = makeController();

    const denied = await controller.resumeInterruptedUpdate({
      confirmed: true,
      backupDir: dir,
      packageBytes: fixtureBytes
    });
    assert.equal(denied.success, false);
    assert.equal(denied.reason, 'package-mismatch');
    assert.equal(denied.dispatched, false);
    assert.equal(denied.uncertain, false);
    assert.equal(getNative(), null);

    const allowed = await controller.resumeInterruptedUpdate({
      confirmed: true,
      backupDir: dir,
      packageBytes: fixtureBytes,
      allowDifferentPackage: true
    });
    assert.equal(allowed.success, true, allowed.error);
    assert.equal(allowed.resumedFromBoot, true);
    assert.equal(allowed.fullUpdaterSuccess, true);
  });

  test('resume refuses a missing anchor or missing backup without opening native IO', async () => {
    const emptyDir = tempDir();
    const { controller, getNative } = makeController();
    const missing = await controller.resumeInterruptedUpdate({
      confirmed: true,
      backupDir: emptyDir,
      packageBytes: fixtureBytes
    });
    assert.equal(missing.success, false);
    assert.equal(missing.reason, 'missing-anchor');
    assert.equal(missing.dispatched, false);
    assert.equal(getNative(), null);

    const { dir, backupPath } = writeAnchor(tempDir());
    fs.unlinkSync(backupPath);
    const noBackup = await controller.resumeInterruptedUpdate({
      confirmed: true,
      backupDir: dir,
      packageBytes: fixtureBytes
    });
    assert.equal(noBackup.success, false);
    assert.equal(noBackup.reason, 'backup-missing');
    assert.equal(noBackup.dispatched, false);
  });

  test('interruptedUpdateStatus and discardInterruptedUpdate wrap the persisted anchor', async () => {
    const emptyDir = tempDir();
    const { controller } = makeController();
    const absent = controller.interruptedUpdateStatus({ backupDir: emptyDir });
    assert.equal(absent.success, true);
    assert.equal(absent.present, false);
    assert.equal(absent.missing, true);

    const { dir, anchorPath, backupPath } = writeAnchor(tempDir());
    const present = controller.interruptedUpdateStatus({ backupDir: dir });
    assert.equal(present.success, true);
    assert.equal(present.present, true);
    assert.equal(present.anchor.targetKey, 'fixture');
    assert.equal(present.anchor.packageSha256, fixtureSha);
    assert.equal(present.backupPresent, true);
    assert.equal(present.filePath, anchorPath);

    fs.unlinkSync(backupPath);
    const missingBackup = controller.interruptedUpdateStatus({ backupDir: dir });
    assert.equal(missingBackup.present, true);
    assert.equal(missingBackup.backupPresent, false);

    const discarded = controller.discardInterruptedUpdate({ backupDir: dir });
    assert.equal(discarded.success, true);
    assert.equal(discarded.cleared, true);
    assert.equal(fs.existsSync(anchorPath), false);
    const after = controller.interruptedUpdateStatus({ backupDir: dir });
    assert.equal(after.present, false);
  });

  test('resume and discard require the same busy/confirmation gates as start()', async () => {
    const { dir } = writeAnchor(tempDir());
    const { controller, getNative } = makeController({ holdPhase: 'erase' });

    const unconfirmed = await controller.resumeInterruptedUpdate({
      backupDir: dir,
      packageBytes: fixtureBytes
    });
    assert.equal(unconfirmed.success, false);
    assert.equal(unconfirmed.reason, 'confirmation-required');

    const running = controller.resumeInterruptedUpdate({
      confirmed: true,
      backupDir: dir,
      packageBytes: fixtureBytes
    });
    await new Promise(resolve => {
      const poll = () => getNative() && getNative().writes.some(write => write.meta.phase === 'erase')
        ? resolve() : setImmediate(poll);
      poll();
    });
    const busyResume = await controller.resumeInterruptedUpdate({
      confirmed: true,
      backupDir: dir,
      packageBytes: fixtureBytes
    });
    assert.equal(busyResume.reason, 'busy');
    const busyDiscard = controller.discardInterruptedUpdate({ backupDir: dir });
    assert.equal(busyDiscard.reason, 'busy');

    getNative().releaseHeldWrite();
    const result = await running;
    assert.equal(result.success, true, result.error);
  });
});

describe('boot recovery anchor persistence in the normal update flow', () => {
  test('persists the boot anchor before enter-boot is dispatched and clears it after normal return', async () => {
    const dir = tempDir();
    const backupPath = path.join(dir, 'backup.json');
    const anchorPath = firmwareBackup.bootAnchorPath(dir);
    let existedAtEnter = false;
    let writesAtEnter = 0;
    const { controller, getNative } = makeController({
      onEnter(io) {
        existedAtEnter = fs.existsSync(anchorPath);
        writesAtEnter = io.writes.length;
      }
    });
    const review = await controller.review({
      target: 'fixture',
      packageBytes: fixtureBytes,
      identity: normalIdentity,
      backupPath
    });
    assert.equal(review.success, true, review.error);
    const result = await controller.start(review.reviewToken, { confirmed: true });
    assert.equal(result.success, true, result.error);
    assert.equal(existedAtEnter, true);
    assert.equal(writesAtEnter, 1);
    assert.equal(getNative().writes[0].meta.phase, 'enter-boot');
    assert.equal(result.bootAnchorCleared, true);
    assert.equal(fs.existsSync(anchorPath), false);
  });

  test('anchor persistence failure aborts pre-mutation with dispatched false', async () => {
    const dir = tempDir();
    const blocked = path.join(dir, 'not-a-directory');
    fs.writeFileSync(blocked, 'cannot-be-a-directory');
    const backupPath = path.join(blocked, 'backup.json');
    const { controller, getNative } = makeController();
    const review = await controller.review({
      target: 'fixture',
      packageBytes: fixtureBytes,
      identity: normalIdentity,
      backupPath
    });
    assert.equal(review.success, true, review.error);
    const result = await controller.start(review.reviewToken, { confirmed: true });
    assert.equal(result.success, false);
    assert.equal(result.failedPhase, 'enter-boot');
    assert.equal(result.reason, 'anchor-persistence-failed');
    assert.equal(result.dispatched, false);
    assert.equal(result.uncertain, false);
    assert.deepEqual(getNative().writes, []);
  });
});
