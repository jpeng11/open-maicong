const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const firmware = require('../src/firmware-protocol.cjs');
const native = require('../src/firmware-native.cjs');

const locationId = 0x02400000;

const normalDevice = {
  vendorId: 0x3837,
  productId: 0x3033,
  path: 'DevSrvsID:4295538287',
  serialNumber: 'NATIVE-SERIAL',
  interface: 1,
  usagePage: 1,
  usage: 0,
  product: 'not used for target matching'
};

const bootDevice = {
  vendorId: 0x3837,
  productId: 0x2010,
  path: 'DevSrvsID:4295539001',
  serialNumber: 'NATIVE-SERIAL',
  interface: 1,
  usagePage: 0xFF00,
  usage: 1,
  product: 'also not used for target matching'
};

const returnedNormalDevice = {
  ...normalDevice,
  path: 'DevSrvsID:4295539444'
};

const normalIdentity = {
  ...normalDevice,
  locationId,
  registryEntryId: 4295538287,
  path: 'DevSrvsID:4295538287'
};

function registryRecord(device, entryId, serial = device.serialNumber) {
  return {
    IORegistryEntryID: entryId,
    VendorID: device.vendorId,
    ProductID: device.productId,
    PrimaryUsagePage: device.usagePage,
    PrimaryUsage: device.usage,
    InterfaceNumber: device.interface,
    LocationID: `0x${locationId.toString(16).padStart(8, '0')}`,
    'USB Serial Number String': serial
  };
}

const registryFixture = [
  registryRecord(normalDevice, 4295538287),
  registryRecord(bootDevice, 4295539001),
  registryRecord(returnedNormalDevice, 4295539444)
];

function makeProcessRunner(registry = registryFixture) {
  const calls = [];
  const runner = async (file, args, options) => {
    calls.push({ file, args: [...args], options: { ...options } });
    if (file === native.MAC_COMMANDS.ioreg) return '<plist fixture bytes>';
    assert.equal(file, native.MAC_COMMANDS.plutil);
    assert.equal(options.input, '<plist fixture bytes>');
    return JSON.stringify({ IORegistryEntryChildren: registry });
  };
  runner.calls = calls;
  return runner;
}

function makeClock() {
  const active = new Set();
  return {
    now: () => Date.now(),
    setTimeout(handler, delay) {
      let timer;
      timer = setTimeout(() => {
        active.delete(timer);
        handler();
      }, delay);
      active.add(timer);
      return timer;
    },
    clearTimeout(timer) {
      active.delete(timer);
      clearTimeout(timer);
    },
    activeCount: () => active.size
  };
}

class FakeHandle extends EventEmitter {
  constructor(info, options = {}) {
    super();
    this.info = { ...info };
    this.options = options;
    this.closed = false;
    this.writes = [];
  }

  async getDeviceInfo() {
    if (this.closed) throw new Error('fake handle is closed');
    if (this.options.pendingInfo) {
      return new Promise(resolve => {
        this.options.resolveInfo = () => resolve({ ...this.info });
      });
    }
    if (Number.isFinite(this.options.infoDelayMs) && this.options.infoDelayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, this.options.infoDelayMs));
    }
    return { ...this.info };
  }

  async write(packet) {
    if (this.closed) throw new Error('fake handle is closed');
    this.writes.push(Buffer.from(packet));
    if (this.options.writeError) throw this.options.writeError;
    if (this.options.pendingWrite) return new Promise(resolve => { this.options.resolveWrite = resolve; });
    return this.options.writeResult === undefined ? packet.length : this.options.writeResult;
  }

  async close() {
    this.closed = true;
    this.removeAllListeners();
  }
}

function makeHid(deviceSequences, handles, options = {}) {
  let sequenceIndex = 0;
  const calls = { devices: 0, opens: [] };
  const hid = {
    devicesAsync: async () => {
      calls.devices += 1;
      const sequence = deviceSequences[Math.min(sequenceIndex, deviceSequences.length - 1)];
      sequenceIndex += 1;
      if (options.devicesAsync) return options.devicesAsync(sequence, calls.devices);
      return sequence;
    },
    HIDAsync: {
      open: async (path, openOptions) => {
        calls.opens.push({ path, options: { ...openOptions } });
        if (options.open) return options.open(path, openOptions);
        const handle = handles[path];
        if (!handle) throw new Error(`no fake handle for ${path}`);
        return handle;
      }
    }
  };
  hid.calls = calls;
  return hid;
}

function fixtureAdapter(deviceSequences = [[normalDevice], [bootDevice], [returnedNormalDevice]], options = {}) {
  const handles = {
    [normalDevice.path]: new FakeHandle(normalDevice, options.normalHandle),
    [bootDevice.path]: new FakeHandle(bootDevice, options.bootHandle),
    [returnedNormalDevice.path]: new FakeHandle(returnedNormalDevice, options.returnHandle)
  };
  const hid = makeHid(deviceSequences, handles, options);
  const processRunner = makeProcessRunner(options.registry || registryFixture);
  const clock = options.clock || makeClock();
  const adapter = new native.NativeFirmwareIo({
    hid,
    processRunner,
    clock,
    platform: 'darwin',
    timeouts: {
      enumerateMs: 40,
      commandMs: 40,
      openMs: 40,
      writeMs: 40,
      identityMs: 60,
      pollMs: 1,
      ...(options.timeouts || {})
    }
  });
  return { adapter, hid, handles, processRunner, clock };
}

describe('macOS firmware topology parsing', () => {
  test('runs ioreg and plutil as separate bounded commands and correlates DevSrvsID to location', async () => {
    const processRunner = makeProcessRunner();
    const clock = makeClock();
    const entries = await native.readMacTopology({ processRunner, clock, timeoutMs: 40 });

    assert.equal(entries.length, 3);
    assert.equal(entries[0].registryEntryId, 4295538287);
    assert.equal(entries[0].locationId, locationId);
    assert.equal(entries[0].vendorId, 0x3837);
    assert.equal(entries[0].productId, 0x3033);
    assert.deepEqual(processRunner.calls.map(call => [call.file, call.args]), [
      [native.MAC_COMMANDS.ioreg, ['-a', '-r', '-c', 'IOHIDDevice']],
      [native.MAC_COMMANDS.plutil, ['-convert', 'json', '-o', '-', '--', '-']]
    ]);
    assert.equal(processRunner.calls[1].options.input, '<plist fixture bytes>');
  });

  test('matches exact descriptors, ignores product names, and fails closed on malformed topology', () => {
    const registry = native.parseIoregJson({ IORegistryEntryChildren: registryFixture });
    const candidate = native.resolveUniqueTopologyCandidate({
      hidDevices: [normalDevice],
      registry,
      target: 'receiver',
      mode: 'normal'
    });
    assert.equal(candidate.valid, true);
    assert.equal(candidate.candidate.identity.locationId, locationId);
    assert.equal(candidate.candidate.identity.serialNumber, 'NATIVE-SERIAL');

    assert.equal(native.parseDevSrvsId('DevSrvsID:4295538287'), 4295538287);
    assert.equal(native.parseDevSrvsId('DevSrvsID:4295538287junk'), null);
    assert.equal(native.parseDevSrvsId('DevSrvsID:+4295538287'), null);

    const wrongInterface = { ...normalDevice, interface: 2 };
    const wrongUsage = { ...normalDevice, usage: 1 };
    assert.equal(native.resolveTopologyCandidates({
      hidDevices: [wrongInterface], registry, target: 'receiver', mode: 'normal'
    }).length, 0);
    assert.equal(native.resolveTopologyCandidates({
      hidDevices: [wrongUsage], registry, target: 'receiver', mode: 'normal'
    }).length, 0);

    const malformedLocation = registryFixture.map(entry => ({ ...entry }));
    malformedLocation[0].LocationID = '0x02400000junk';
    assert.equal(native.resolveTopologyCandidates({
      hidDevices: [normalDevice],
      registry: native.parseIoregJson({ IORegistryEntryChildren: malformedLocation }),
      target: 'receiver',
      mode: 'normal'
    }).length, 0);
  });

  test('requires a unique candidate and compatible serial instead of product-name fallback', () => {
    const duplicateDevice = { ...normalDevice, path: 'DevSrvsID:4295539555' };
    const duplicateRegistry = [
      ...registryFixture,
      registryRecord(duplicateDevice, 4295539555)
    ];
    const ambiguous = native.resolveUniqueTopologyCandidate({
      hidDevices: [normalDevice, duplicateDevice],
      registry: native.parseIoregJson({ IORegistryEntryChildren: duplicateRegistry }),
      target: 'receiver',
      mode: 'normal'
    });
    assert.equal(ambiguous.valid, false);
    assert.equal(ambiguous.reason, 'ambiguous-identity');
    assert.equal(ambiguous.candidateCount, 2);

    const mismatchedSerialDevice = { ...normalDevice, serialNumber: 'OTHER-SERIAL' };
    const mismatch = native.resolveTopologyCandidates({
      hidDevices: [mismatchedSerialDevice],
      registry: native.parseIoregJson({ IORegistryEntryChildren: registryFixture }),
      target: 'receiver',
      mode: 'normal'
    });
    assert.equal(mismatch.length, 0);
  });

  test('correlateLiveHandleTopology binds LocationID onto a node-hid handle that has none', async () => {
    const handle = {
      vendorId: normalDevice.vendorId,
      productId: normalDevice.productId,
      interface: normalDevice.interface,
      usagePage: normalDevice.usagePage,
      usage: normalDevice.usage,
      serialNumber: normalDevice.serialNumber,
      path: normalDevice.path
    };
    assert.equal(handle.locationId, undefined);
    const processRunner = makeProcessRunner();
    const correlated = await native.correlateLiveHandleTopology(handle, { processRunner, timeoutMs: 40 });
    assert.equal(correlated.valid, true, correlated.error);
    assert.equal(correlated.identity.locationId, locationId);
    assert.equal(correlated.identity.path, handle.path);
    assert.equal(processRunner.calls[0].file, native.MAC_COMMANDS.ioreg);

    const missing = await native.correlateLiveHandleTopology(handle, {
      processRunner: async (file) => {
        if (file === native.MAC_COMMANDS.ioreg) return '<plist>';
        return JSON.stringify({ IORegistryEntryChildren: [] });
      },
      timeoutMs: 40
    });
    assert.equal(missing.valid, false);
    assert.equal(missing.reason, 'no-candidate');
  });
});

describe('native firmware IO adapter', () => {
  test('constructor is inert and openNormal uses a fresh exact reviewed normal identity', async () => {
    const fixture = fixtureAdapter([[normalDevice]]);
    assert.equal(fixture.hid.calls.devices, 0);
    assert.equal(fixture.hid.calls.opens.length, 0);
    assert.equal(fixture.adapter.isConnected(), false);
    assert.equal(fixture.adapter.getIdentity(), null);

    const identity = await fixture.adapter.openNormal({ target: 'receiver', reviewedIdentity: normalIdentity });
    assert.equal(identity.locationId, locationId);
    assert.equal(identity.serialNumber, 'NATIVE-SERIAL');
    assert.equal(fixture.adapter.getIdentity().path, normalDevice.path);
    assert.equal(fixture.hid.calls.devices, 1);
    assert.deepEqual(fixture.hid.calls.opens, [{
      path: normalDevice.path,
      options: { nonExclusive: true }
    }]);
    await fixture.adapter.close();
    assert.equal(fixture.handles[normalDevice.path].closed, true);
  });

  test('cancellation before the deferred enumeration invocation performs no HID call', async () => {
    const fixture = fixtureAdapter([[normalDevice]]);
    const pending = fixture.adapter.openNormal({ target: 'receiver', reviewedIdentity: normalIdentity });
    fixture.adapter.cancel('cancel before native enumeration invocation');

    await assert.rejects(pending, error => error.reason === 'cancelled');
    assert.equal(fixture.hid.calls.devices, 0);
    assert.equal(fixture.hid.calls.opens.length, 0);
  });

  test('rejected HID open is observed without an unhandled derived rejection', async () => {
    const openError = new Error('fixture open rejected');
    const fixture = fixtureAdapter([[normalDevice]], { open: () => Promise.reject(openError) });
    const unhandled = [];
    const onUnhandled = error => unhandled.push(error);
    process.on('unhandledRejection', onUnhandled);
    try {
      await assert.rejects(
        fixture.adapter.openNormal({ target: 'receiver', reviewedIdentity: normalIdentity }),
        error => error.reason === 'open-error' && error.cause === openError
      );
      await new Promise(resolve => setImmediate(resolve));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    assert.deepEqual(unhandled, []);
  });

  test('normal to boot to normal rediscovery handles actual detach events and isolates stale handles', async () => {
    const fixture = fixtureAdapter();
    const disconnects = [];
    const data = [];
    fixture.adapter.onDisconnect(event => disconnects.push(event));
    fixture.adapter.onData(report => data.push(Buffer.from(report)));

    const openedNormal = await fixture.adapter.openNormal({ target: 'receiver', reviewedIdentity: normalIdentity });
    const oldNormal = fixture.handles[normalDevice.path];
    const staleNormalData = oldNormal.listeners('data')[0];
    oldNormal.emit('error', new Error('normal collection detached for boot transition'));
    assert.equal(fixture.adapter.isConnected(), false);

    const openedBoot = await fixture.adapter.waitForIdentity({
      phase: 'boot-confirmation',
      expected: firmware.OFFICIAL_CATALOG.receiver.boot,
      anchor: openedNormal,
      target: 'receiver',
      timeoutMs: 60
    });
    assert.equal(openedBoot.productId, 0x2010);
    assert.equal(openedBoot.locationId, locationId);
    assert.equal(fixture.adapter.isConnected(), true);

    staleNormalData(Buffer.from([9, 9, 9]));
    assert.equal(data.length, 0, 'late data from the retired normal handle must be ignored');
    fixture.handles[bootDevice.path].emit('data', Buffer.from([1, 2, 3]));
    assert.deepEqual(Array.from(data[0]), [1, 2, 3]);

    const packet = Buffer.alloc(firmware.WRITE_BUFFER_SIZE);
    packet[0] = firmware.REPORT_ID;
    const writeResult = await fixture.adapter.write(packet);
    assert.equal(writeResult.dispatched, true);
    assert.equal(fixture.handles[bootDevice.path].writes[0].length, firmware.WRITE_BUFFER_SIZE);

    const oldBoot = fixture.handles[bootDevice.path];
    const staleBootError = oldBoot.listeners('error')[0];
    oldBoot.emit('error', new Error('boot collection detached for normal transition'));
    const openedNormalAgain = await fixture.adapter.waitForIdentity({
      phase: 'normal-reconnect',
      expected: firmware.OFFICIAL_CATALOG.receiver.normal,
      anchor: openedBoot,
      target: 'receiver',
      timeoutMs: 60
    });
    assert.equal(openedNormalAgain.productId, 0x3033);
    assert.equal(fixture.adapter.isConnected(), true);
    staleBootError(new Error('late stale boot error'));
    assert.equal(disconnects.length, 2);
    assert.equal(fixture.clock.activeCount(), 0);

    await fixture.adapter.close();
    assert.equal(fixture.handles[returnedNormalDevice.path].closed, true);
    assert.equal(fixture.adapter.isConnected(), false);
  });

  test('refuses missing review topology before enumeration/open and never falls back to names', async () => {
    const fixture = fixtureAdapter([[normalDevice]]);
    await assert.rejects(
      fixture.adapter.openNormal({
        target: 'receiver',
        reviewedIdentity: { ...normalIdentity, locationId: undefined, product: 'MCHOSE G75 V2 2.4G' }
      }),
      error => error.reason === 'ambiguous-identity'
    );
    assert.equal(fixture.hid.calls.devices, 0);
    assert.equal(fixture.hid.calls.opens.length, 0);

    const malformedReview = fixtureAdapter([[normalDevice]]);
    await assert.rejects(
      malformedReview.adapter.openNormal({
        target: 'receiver',
        reviewedIdentity: { ...normalIdentity, locationId: '0x02400000junk' }
      }),
      error => error.reason === 'ambiguous-identity'
    );
    assert.equal(malformedReview.hid.calls.devices, 0);
    assert.equal(malformedReview.hid.calls.opens.length, 0);
  });

  test('write framing and native submission errors preserve honest dispatch state', async () => {
    const invalid = fixtureAdapter();
    await assert.rejects(invalid.adapter.write(Buffer.alloc(64)), error => (
      error.reason === 'invalid-packet' && error.dispatched === false
    ));

    const failure = new Error('native write failed after queue submission');
    const fixture = fixtureAdapter([[normalDevice]], { normalHandle: { writeError: failure } });
    await fixture.adapter.openNormal({ target: 'receiver', reviewedIdentity: normalIdentity });
    const packet = Buffer.alloc(firmware.WRITE_BUFFER_SIZE);
    await assert.rejects(fixture.adapter.write(packet), error => (
      error.dispatchStatus === 'unknown' && error.dispatched === undefined
    ));
    assert.equal(fixture.handles[normalDevice.path].writes.length, 1);
    await fixture.adapter.close();
  });

  test('ambiguous boot rediscovery opens no candidate and closes the old owned handle', async () => {
    const duplicateBoot = { ...bootDevice, path: 'DevSrvsID:4295539666' };
    const registry = [
      ...registryFixture,
      registryRecord(duplicateBoot, 4295539666)
    ];
    const fixture = fixtureAdapter([[normalDevice], [bootDevice, duplicateBoot]], { registry });
    await fixture.adapter.openNormal({ target: 'receiver', reviewedIdentity: normalIdentity });
    fixture.handles[normalDevice.path].emit('error', new Error('normal detached'));
    await assert.rejects(
      fixture.adapter.waitForIdentity({
        phase: 'boot-confirmation',
        anchor: normalIdentity,
        target: 'receiver',
        timeoutMs: 40
      }),
      error => error.reason === 'ambiguous-identity'
    );
    assert.equal(fixture.hid.calls.opens.length, 1);
    assert.equal(fixture.adapter.isConnected(), false);
    assert.equal(fixture.handles[normalDevice.path].closed, true);
  });

  test('cancelled pending open closes a late handle and does not attach it', async () => {
    const clock = makeClock();
    let resolveOpen;
    const lateHandle = new FakeHandle(normalDevice);
    const fixture = fixtureAdapter([[normalDevice]], {
      clock,
      open: () => new Promise(resolve => { resolveOpen = resolve; })
    });
    const pending = fixture.adapter.openNormal({ target: 'receiver', reviewedIdentity: normalIdentity });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(typeof resolveOpen, 'function');
    fixture.adapter.cancel('cancel pending native open');
    await assert.rejects(pending, error => error.reason === 'cancelled');
    resolveOpen(lateHandle);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(lateHandle.closed, true);
    assert.equal(fixture.adapter.isConnected(), false);
    assert.equal(clock.activeCount(), 0);
  });

  test('timed-out HID open retires the attempt and closes a handle that resolves late', async () => {
    const clock = makeClock();
    let resolveOpen;
    const lateHandle = new FakeHandle(normalDevice);
    const fixture = fixtureAdapter([[normalDevice]], {
      clock,
      timeouts: { openMs: 5 },
      open: () => new Promise(resolve => { resolveOpen = resolve; })
    });
    const pending = fixture.adapter.openNormal({ target: 'receiver', reviewedIdentity: normalIdentity });
    await assert.rejects(pending, error => error.reason === 'timeout');
    resolveOpen(lateHandle);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(lateHandle.closed, true);
    assert.equal(fixture.adapter.isConnected(), false);
    assert.equal(clock.activeCount(), 0);
  });

  test('cancellation during getDeviceInfo closes the unbound handle and cannot bind after the await', async () => {
    const infoOptions = { pendingInfo: true };
    const fixture = fixtureAdapter([[normalDevice]], { normalHandle: infoOptions });
    const pending = fixture.adapter.openNormal({ target: 'receiver', reviewedIdentity: normalIdentity });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(typeof infoOptions.resolveInfo, 'function');

    fixture.adapter.cancel('cancel during opened identity read');
    await assert.rejects(pending, error => error.reason === 'cancelled');
    infoOptions.resolveInfo();
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(fixture.handles[normalDevice.path].closed, true);
    assert.equal(fixture.adapter.isConnected(), false);
    assert.equal(fixture.adapter.getIdentity(), null);
  });

  test('identity rediscovery uses one total deadline across topology, open, and device-info awaits', async () => {
    const clock = (() => {
      let current = 0;
      let nextId = 0;
      const timers = new Map();
      const runDue = () => {
        let changed = true;
        while (changed) {
          changed = false;
          for (const [id, timer] of timers) {
            if (timer.at <= current) {
              timers.delete(id);
              timer.handler();
              changed = true;
            }
          }
        }
      };
      return {
        now: () => current,
        setTimeout(handler, delay) {
          const id = ++nextId;
          timers.set(id, { at: current + delay, handler });
          return id;
        },
        clearTimeout(id) { timers.delete(id); },
        advance(delay) {
          current += delay;
          runDue();
        },
        activeCount: () => timers.size
      };
    })();
    const infoOptions = { pendingInfo: true };
    const fixture = fixtureAdapter([[bootDevice]], {
      clock,
      bootHandle: infoOptions,
      timeouts: { enumerateMs: 100, commandMs: 100, openMs: 100, identityMs: 20, pollMs: 1 }
    });
    const pending = fixture.adapter.waitForIdentity({
      phase: 'boot-confirmation',
      expected: firmware.OFFICIAL_CATALOG.receiver.boot,
      anchor: normalIdentity,
      target: 'receiver',
      timeoutMs: 20
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(typeof infoOptions.resolveInfo, 'function');

    let settled = false;
    pending.finally(() => { settled = true; }).catch(() => {});
    clock.advance(20);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, true, 'identity work must not receive a fresh per-open deadline');
    await assert.rejects(pending, error => error.reason === 'timeout');
    assert.equal(fixture.handles[bootDevice.path].closed, true);
    assert.equal(fixture.adapter.isConnected(), false);
    assert.equal(clock.activeCount(), 0);
  });

  test('close cancels a pending identity poll and prevents a late discovery from opening', async () => {
    const fixture = fixtureAdapter([[normalDevice]], {
      devicesAsync: (sequence, count) => count === 1 ? sequence : new Promise(() => {})
    });
    await fixture.adapter.openNormal({ target: 'receiver', reviewedIdentity: normalIdentity });
    const normalHandle = fixture.handles[normalDevice.path];
    normalHandle.emit('error', new Error('normal detached'));
    const pending = fixture.adapter.waitForIdentity({
      phase: 'boot-confirmation',
      anchor: normalIdentity,
      target: 'receiver',
      timeoutMs: 1000
    });
    await new Promise(resolve => setImmediate(resolve));
    await fixture.adapter.close();
    await assert.rejects(pending, error => error.reason === 'closed');
    assert.equal(fixture.hid.calls.opens.length, 1);
    assert.equal(fixture.adapter.isConnected(), false);
  });
});
