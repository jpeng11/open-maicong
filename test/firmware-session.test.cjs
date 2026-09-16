'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

const firmware = require('../src/firmware-protocol.cjs');
const native = require('../src/firmware-native.cjs');
const transport = require('../src/transport.cjs');
const { FirmwareSession } = require('../src/firmware-session.cjs');
const { MockGlwMemoryDevice } = require('./mock-glw-memory.cjs');
const {
  KEYBOARD_BYTES,
  RECEIVER_BYTES,
  MISMATCH_BYTES,
  RECEIVER_INFO_AFTER,
  KEYBOARD_INFO_BEFORE,
  KEYBOARD_INFO_AFTER,
  createMockUiCatalog,
  keyboardIdentity,
  nodeHidReceiverHandle,
  createSessionDoubles
} = require('./mock-firmware-io.cjs');

function backupPath(name) {
  return path.join(os.tmpdir(), `maicong-session-${name}.json`);
}

function makeSession(options = {}) {
  const doubles = createSessionDoubles(options);
  const session = new FirmwareSession({
    transport: doubles.transport,
    catalog: doubles.catalog,
    nativeIoFactory: doubles.nativeIoFactory,
    backupDir: os.tmpdir(),
    timeouts: { dispatchMs: 40, flagMs: 40, identityMs: 40 }
  });
  return { session, ...doubles };
}

describe('firmware catalog version matching', () => {
  test('accepts vendor fwVersion114 as wire 0x0114 and raw equality used by fixtures', () => {
    assert.equal(firmware.catalogVersionMatchesRaw(0x0114, { version: '1.14', versionNumber: 114 }), true);
    assert.equal(firmware.catalogVersionMatchesRaw(0x0130, { version: '1.30', versionNumber: 130 }), true);
    assert.equal(firmware.catalogVersionMatchesRaw(100, { version: 'fixture-1.0', versionNumber: 100 }), true);
    assert.equal(firmware.catalogVersionMatchesRaw(0x0115, { version: '1.14', versionNumber: 114 }), false);
  });
});

describe('shipped firmware session review/start/cancel', () => {
  test('unconfirmed start is rejected and sends zero boot/erase writes', async () => {
    const { session, getNative } = makeSession();
    const review = await session.review({ packageBytes: RECEIVER_BYTES, backupPath: backupPath('unconfirmed') });
    assert.equal(review.success, true, review.error);
    const denied = await session.confirmStart({ confirmed: false });
    assert.equal(denied.success, false);
    assert.equal(denied.fullUpdaterSuccess, false);
    assert.equal(denied.reason, 'confirmation-required');
    assert.equal(denied.nativeWriteCount, 0);
    assert.equal(getNative(), null);
  });

  test('catalog-hash mismatch sends zero boot/erase writes', async () => {
    const { session, getNative } = makeSession();
    const review = await session.review({ packageBytes: MISMATCH_BYTES, backupPath: backupPath('hash') });
    assert.equal(review.success, false);
    assert.equal(review.reason, 'invalid-package');
    assert.match(review.error, /SHA-256|catalog|size/i);
    assert.equal(review.nativeWriteCount, 0);
    const start = await session.confirmStart({ confirmed: true });
    assert.equal(start.success, false);
    assert.equal(start.reason, 'review-required');
    assert.equal(start.nativeWriteCount, 0);
    assert.equal(getNative(), null);
  });

  test('keyboard package on a 2.4G receiver is identity/mode mismatch with zero writes', async () => {
    const { session, getNative } = makeSession();
    const review = await session.review({ packageBytes: KEYBOARD_BYTES, backupPath: backupPath('wired-rule') });
    assert.equal(review.success, false);
    assert.equal(review.reason, 'require-wired');
    assert.match(review.error, /wired/i);
    assert.equal(review.nativeWriteCount, 0);
    assert.equal(getNative(), null);
  });

  test('receiver package on a wired keyboard is identity/mode mismatch with zero writes', async () => {
    const { session, getNative } = makeSession({
      identity: keyboardIdentity(),
      info: KEYBOARD_INFO_BEFORE,
      afterInfo: KEYBOARD_INFO_AFTER,
      targetKey: 'keyboard'
    });
    const review = await session.review({ packageBytes: RECEIVER_BYTES, backupPath: backupPath('wireless-rule') });
    assert.equal(review.success, false);
    assert.equal(review.reason, 'require-wireless');
    assert.match(review.error, /2\.4G|wireless/i);
    assert.equal(review.nativeWriteCount, 0);
    assert.equal(getNative(), null);
  });

  test('successful mock sequence reports version readback and restore', async () => {
    const { session, transport, getNative } = makeSession();
    const review = await session.review({ packageBytes: RECEIVER_BYTES, backupPath: backupPath('success') });
    assert.equal(review.success, true, review.error);
    assert.equal(review.package.sha256, createMockUiCatalog().receiver.package.sha256);
    assert.equal(review.nativeWriteCount, 0);

    const result = await session.confirmStart({ confirmed: true });
    assert.equal(result.success, true, result.error);
    assert.equal(result.fullUpdaterSuccess, true);
    assert.equal(result.version.matched, true);
    assert.equal(result.version.actual, RECEIVER_INFO_AFTER.rawRfFirmwareVersion);
    assert.equal(result.restorationVerified, true);
    assert.deepEqual(getNative().writes.map((write) => write.meta.phase), [
      'enter-boot', 'erase', 'write', 'write', 'verify', 'verify', 'end', 'success'
    ]);
    assert.ok(transport.calls.some((call) => call.kind === 'restore'));
    assert.ok(result.nativeWriteCount > 0);
    assert.equal(session.status().nativeWritePhases.includes('erase'), true);
  });

  test('cancel during erase is not success and does not restore', async () => {
    const { session, transport, getNative } = makeSession({ holdPhase: 'erase' });
    const review = await session.review({ packageBytes: RECEIVER_BYTES, backupPath: backupPath('cancel') });
    assert.equal(review.success, true, review.error);

    const running = session.confirmStart({ confirmed: true });
    await new Promise((resolve) => {
      const poll = () => (getNative() && getNative().writes.some((write) => write.meta.phase === 'erase')
        ? resolve()
        : setImmediate(poll));
      poll();
    });
    const cancelled = session.cancel('User cancelled firmware update');
    assert.equal(cancelled.success, true);
    getNative().releaseHeldWrite();
    const result = await running;
    assert.equal(result.success, false);
    assert.equal(result.fullUpdaterSuccess, false);
    assert.equal(result.reason, 'cancelled');
    assert.equal(transport.calls.some((call) => call.kind === 'restore'), false);
  });

  test('transfer failure is not reported as updater success', async () => {
    const { session } = makeSession({ rejectPhase: 'erase' });
    const review = await session.review({ packageBytes: RECEIVER_BYTES, backupPath: backupPath('fail') });
    assert.equal(review.success, true, review.error);
    const result = await session.confirmStart({ confirmed: true });
    assert.equal(result.success, false);
    assert.equal(result.fullUpdaterSuccess, false);
    assert.notEqual(result.reason, undefined);
    assert.notEqual(result.reason, 'complete');
  });

  test('status exposes MCU and RF versions plus wired vs 2.4G rule for the connected identity', () => {
    const { session } = makeSession();
    const status = session.status();
    assert.equal(status.target.kind, 'receiver');
    assert.equal(status.modeRule.reason, 'require-wireless');
    assert.equal(status.versions.firmwareVersion, '1.14');
    assert.equal(status.versions.rfFirmwareVersion, '1.29');
    assert.equal(status.connected, true);
  });

  test('review fails closed on a node-hid handle until ioreg LocationID is correlated', async () => {
    const handle = nodeHidReceiverHandle();
    assert.equal(Object.prototype.hasOwnProperty.call(handle, 'locationId'), false);
    const mock = new MockGlwMemoryDevice();
    transport.installTestAdapter(mock);
    transport.lastState.device = { ...handle };
    transport.deviceInfo = { ...handle };
    transport.firmwareTopologyIdentity = null;
    transport.topologyProcessRunner = async (file) => {
      if (file === native.MAC_COMMANDS.ioreg) return '<plist fixture bytes>';
      return JSON.stringify({ IORegistryEntryChildren: [] });
    };
    const doubles = createSessionDoubles({ omitTopology: true, identity: handle });
    const session = new FirmwareSession({
      transport,
      catalog: doubles.catalog,
      nativeIoFactory: doubles.nativeIoFactory,
      backupDir: os.tmpdir(),
      timeouts: { dispatchMs: 40, flagMs: 40, identityMs: 40 }
    });
    try {
      const missing = await session.review({
        packageBytes: RECEIVER_BYTES,
        backupPath: backupPath('no-location')
      });
      assert.equal(missing.success, false);
      assert.match(missing.error || '', /LocationID|topology/i);
      assert.equal(missing.nativeWriteCount, 0);
      assert.equal(firmware.hasStableUsbLocation(transport.lastState.device), false);
    } finally {
      transport.topologyProcessRunner = null;
      transport.disconnect();
    }
  });

  test('review succeeds only after correlating ioreg LocationID onto the live node-hid handle', async () => {
    const handle = nodeHidReceiverHandle();
    const registryLocation = 0x02400000;
    const processRunner = async (file, args, options) => {
      processRunner.calls.push({ file, args: [...args], hasInput: Boolean(options && options.input) });
      if (file === native.MAC_COMMANDS.ioreg) return '<plist fixture bytes>';
      assert.equal(file, native.MAC_COMMANDS.plutil);
      return JSON.stringify({
        IORegistryEntryChildren: [{
          IORegistryEntryID: 4295538287,
          VendorID: handle.vendorId,
          ProductID: handle.productId,
          PrimaryUsagePage: handle.usagePage,
          PrimaryUsage: handle.usage,
          InterfaceNumber: handle.interface,
          LocationID: `0x${registryLocation.toString(16).padStart(8, '0')}`,
          'USB Serial Number String': handle.serialNumber
        }]
      });
    };
    processRunner.calls = [];

    const mock = new MockGlwMemoryDevice();
    transport.installTestAdapter(mock);
    transport.lastState.device = { ...handle };
    transport.deviceInfo = { ...handle };
    transport.firmwareTopologyIdentity = null;
    transport.topologyProcessRunner = processRunner;
    const doubles = createSessionDoubles({ omitTopology: true, identity: handle });
    const session = new FirmwareSession({
      transport,
      catalog: doubles.catalog,
      nativeIoFactory: doubles.nativeIoFactory,
      backupDir: os.tmpdir(),
      timeouts: { dispatchMs: 40, flagMs: 40, identityMs: 40 }
    });
    try {
      assert.equal(transport.firmwareTopologyIdentity, null);
      assert.equal(transport.lastState.device.locationId, undefined);
      const review = await session.review({
        packageBytes: RECEIVER_BYTES,
        backupPath: backupPath('live-location')
      });
      assert.equal(review.success, true, review.error);
      assert.equal(processRunner.calls.some((call) => call.file === native.MAC_COMMANDS.ioreg), true);
      assert.equal(processRunner.calls.some((call) => call.file === native.MAC_COMMANDS.plutil), true);
      assert.equal(review.identity.locationId, registryLocation);
      assert.equal(transport.lastState.device.locationId, registryLocation);
      assert.equal(transport.firmwareTopologyIdentity.locationId, registryLocation);
      assert.equal(review.identity.path, handle.path);
      assert.equal(review.nativeWriteCount, 0);
    } finally {
      transport.topologyProcessRunner = null;
      transport.disconnect();
    }
  });
});
