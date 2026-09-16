const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const lightingMemory = require('../src/lighting-memory.cjs');
const transport = require('../src/transport.cjs');
const protocol = require('../src/protocol.cjs');
const { MockGlwMemoryDevice } = require('./mock-glw-memory.cjs');
const { validateProfileSchema } = require('../src/schema-validators.cjs');

const literal = require('./fixtures/g75-lighting-memory-literal.json');

function attachMock(mock, serial = 'A') {
  transport.disconnect();
  transport.device = mock;
  transport.needsReconnect = false;
  transport.statusError = null;
  transport._lightMemoryHardwareOk = null;
  transport._lightMemoryCache = null;
  transport.lightMemoryFallback = 'hardware';
  transport.lastState.connected = true;
  transport.lastState.device = {
    vendorId: 14391,
    productId: 12339,
    serialNumber: serial,
    path: `mock://g75v2/${serial}`,
    interface: 1,
    mock: true
  };
  if (typeof mock.on === 'function') transport._bindDeviceListeners(mock);
}

function literalBuffer() {
  const buf = Buffer.alloc(112, literal.fillByte);
  Buffer.from(literal.ordinaryPrefix).copy(buf, 0);
  return buf;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const profileBase = {
  app: 'Maicong Studio',
  model: 'MCHOSE G75 V2',
  protocol: 'GLW',
  version: '2.0.0',
  lighting: {
    effect: 1, brightness: 100, speed: 4, direction: 0, customColorDisabled: false, hexColor: '#00E5FF',
    sideEffect: 1, sideBrightness: 80, sideSpeed: 4, sideCustomColorDisabled: false, sideHexColor: '#00E5FF'
  },
  settings: { sleepTime: 6, sleepMode: 0, debounceLevel: 2, macMode: 0, reporteRate: 4, lockWin: false },
  layers: { 0: {}, 1: {}, 2: {}, 3: {} },
  perKeyRgb: {},
  macros: []
};

describe('Lighting memory codec and 16-record normalization', () => {
  test('all-zero markerless region is a valid empty hardware store', () => {
    const parsed = lightingMemory.parseLightMemory(Buffer.alloc(112, 0));
    assert.equal(parsed.valid, true);
    assert.equal(parsed.empty, true);
    assert.equal(parsed.store.main.length, 0);
  });

  test('wrong length is invalid', () => {
    const parsed = lightingMemory.parseLightMemory(Buffer.alloc(64, 0));
    assert.equal(parsed.valid, false);
  });

  test('counts that overrun the region are invalid', () => {
    const buf = Buffer.alloc(112, 0);
    Buffer.from('<light@v2>', 'ascii').copy(buf);
    buf[10] = 15;
    buf[11] = 15;
    buf[12] = 15;
    const parsed = lightingMemory.parseLightMemory(buf);
    assert.equal(parsed.valid, false);
    assert.match(parsed.error, /exceed/i);
  });

  test('literal ten-byte marker fixture parses independent expected fields', () => {
    assert.deepStrictEqual(literal.marker, [60, 108, 105, 103, 104, 116, 64, 118, 50, 62]);
    assert.strictEqual(Buffer.from(literal.marker).toString('ascii'), '<light@v2>');
    const buf = literalBuffer();
    const parsed = lightingMemory.parseLightMemory(buf);
    assert.equal(parsed.valid, true);
    assert.equal(parsed.store.main[0].effect, literal.ordinaryExpected.main[0].effect);
    assert.equal(parsed.store.main[0].hexColor, literal.ordinaryExpected.main[0].hexColor);
    assert.equal(parsed.store.main[0].speed, literal.ordinaryExpected.main[0].speed);
    assert.equal(parsed.store.main[0].direction, literal.ordinaryExpected.main[0].direction);
    assert.equal(parsed.store.main[0].customColorDisabled, true);
    assert.equal(parsed.store.main[0].brightness, 75);
    assert.equal(parsed.store.main[0].flags, 67);
    assert.equal(parsed.store.side[0].sideEffect, 3);
    assert.equal(parsed.store.side[0].sideHexColor, '#ABCDEF');
    assert.equal(parsed.store.side[0].flags, 32);
    const round = lightingMemory.serializeLightMemory(parsed.store, buf);
    assert.deepStrictEqual(Buffer.from(round), buf);
  });

  test('unknown main direction bits and side reserved flags survive parse-serialize and edits to another record', () => {
    const buf = literalBuffer();
    buf[literal.unknownMainFlagsOffset] = literal.unknownMainFlags;
    buf[literal.unknownSideFlagsOffset] = literal.unknownSideFlags;
    buf[12] = 1;
    Buffer.from(literal.side2Record).copy(buf, 25);
    const parsed = lightingMemory.parseLightMemory(buf);
    assert.equal(parsed.store.main[0].flags, 79);
    assert.equal(parsed.store.main[0].direction, 7);
    assert.equal(parsed.store.side[0].flags, 46);
    assert.equal(parsed.store.side2[0].effect, 99);
    const unchanged = lightingMemory.serializeLightMemory(parsed.store, buf);
    assert.equal(unchanged[literal.unknownMainFlagsOffset], 79);
    assert.equal(unchanged[literal.unknownSideFlagsOffset], 46);
    const edited = lightingMemory.rememberLighting(parsed.store, {
      effect: 4, brightness: 50, speed: 1, hexColor: '#010101',
      sideEffect: 2, sideBrightness: 20, sideHexColor: '#020202'
    });
    const after = lightingMemory.serializeLightMemory(edited, buf);
    const parsedAfter = lightingMemory.parseLightMemory(after);
    const wave = parsedAfter.store.main.find((r) => r.effect === 6);
    assert.ok(wave);
    assert.equal(wave.flags, 79);
    const side = parsedAfter.store.side.find((r) => r.sideEffect === 3);
    assert.ok(side);
    assert.equal(side.flags, 46);
    assert.equal(parsedAfter.store.side2[0].effect, 99);
    assert.equal(parsedAfter.store.side2[0].flags, 46);
  });

  test('round-trip preserves records and unused tail bytes', () => {
    const prior = Buffer.alloc(112, 0xAA);
    const store = lightingMemory.normalizeLightMemory({
      main: [{
        effect: 6, hexColor: '#FF0000', speed: 2, direction: 1,
        customColorDisabled: true, brightness: 80
      }],
      side: [{
        sideEffect: 2, sideHexColor: '#00FF00', sideSpeed: 1,
        sideCustomColorDisabled: false, sideBrightness: 41
      }],
      side2: []
    });
    const serialized = lightingMemory.serializeLightMemory(store, prior);
    assert.equal(serialized.length, 112);
    const parsed = lightingMemory.parseLightMemory(serialized);
    assert.equal(parsed.valid, true);
    assert.equal(parsed.store.main[0].effect, 6);
    assert.equal(parsed.store.main[0].brightness, 80);
    assert.equal(parsed.store.main[0].direction, 1);
    assert.equal(parsed.store.main[0].speed, 2);
    assert.equal(parsed.store.side[0].sideEffect, 2);
    assert.equal(parsed.store.side[0].sideBrightness, 41);
    const used = 13 + 6 + 6;
    assert.equal(serialized[used], 0xAA);
    assert.equal(serialized[111], 0xAA);
  });

  test('first-occurrence dedup and 16-record round-robin keep newest first', () => {
    const main = [];
    for (let i = 0; i < 12; i++) {
      main.push({ effect: i, hexColor: '#000000', speed: 1, direction: 0, customColorDisabled: false, brightness: 10 + i });
    }
    main.unshift({ effect: 0, hexColor: '#FFFFFF', speed: 4, direction: 0, customColorDisabled: false, brightness: 99 });
    const side = [];
    for (let i = 1; i <= 8; i++) {
      side.push({
        sideEffect: i, sideHexColor: '#000000', sideSpeed: 1,
        sideCustomColorDisabled: false, sideBrightness: 20
      });
    }
    const normalized = lightingMemory.normalizeLightMemory({ main, side, side2: [] });
    assert.equal(normalized.main[0].effect, 0);
    assert.equal(normalized.main[0].brightness, 99);
    assert.equal(normalized.main.filter((r) => r.effect === 0).length, 1);
    assert.ok(normalized.main.length + normalized.side.length <= 16);
    assert.equal(normalized.main.length + normalized.side.length, 16);
  });

  test('zero brightness does not replace a nonzero remembered record', () => {
    let store = lightingMemory.emptyStore();
    store = lightingMemory.rememberLighting(store, {
      effect: 6, brightness: 80, speed: 2, direction: 1,
      customColorDisabled: false, hexColor: '#010203',
      sideEffect: 2, sideBrightness: 41, sideSpeed: 1, sideHexColor: '#112233'
    });
    store = lightingMemory.rememberLighting(store, {
      effect: 6, brightness: 0, speed: 4, direction: 0,
      customColorDisabled: true, hexColor: '#FFFFFF',
      sideEffect: 2, sideBrightness: 0, sideSpeed: 0, sideHexColor: '#000000'
    });
    assert.equal(store.main[0].brightness, 80);
    assert.equal(store.main[0].speed, 2);
    assert.equal(store.side[0].sideBrightness, 41);
  });

  test('numeric restore uses remembered OR current OR 100', () => {
    const store = {
      main: [{ effect: 6, brightness: 80, speed: 2, direction: 1, customColorDisabled: false, hexColor: '#AABBCC' }],
      side: [{ sideEffect: 2, sideBrightness: 33, sideSpeed: 1, sideCustomColorDisabled: false, sideHexColor: '#010101' }],
      side2: []
    };
    const a = lightingMemory.restoreMainSelection(store, 6, { brightness: 0, speed: 4 });
    assert.equal(a.effect, 6);
    assert.equal(a.brightness, 80);
    assert.equal(a.speed, 2);
    const unknown = lightingMemory.restoreMainSelection(store, 5, { brightness: 0 });
    assert.equal(unknown.effect, 5);
    assert.equal(unknown.brightness, 100);
    const side = lightingMemory.restoreSideSelection(store, 2, { sideBrightness: 0 });
    assert.equal(side.sideBrightness, 33);
  });

  test('remembering a main/side edit keeps nonempty unknown side2 records', () => {
    const store = lightingMemory.rememberLighting(
      { main: [], side: [], side2: [{ effect: 99, brightness: 10, hexColor: '#010203', speed: 1, customColorDisabled: false, flags: 46 }] },
      { effect: 4, brightness: 50, speed: 1, hexColor: '#000000', sideEffect: 3, sideBrightness: 20, sideHexColor: '#000000' },
      { hasSide: true }
    );
    assert.equal(store.side2.length, 1);
    assert.equal(store.side2[0].effect, 99);
    assert.equal(store.side2[0].flags, 46);
    assert.equal(store.main[0].effect, 4);
    assert.equal(store.side[0].sideEffect, 3);
  });

  test('serial numbers isolate local keys; firmware is not part of the key', () => {
    const a = lightingMemory.deviceStorageKey({ vendorId: 14391, productId: 12339, serialNumber: 'A' });
    const b = lightingMemory.deviceStorageKey({ vendorId: 14391, productId: 12339, serialNumber: 'B' });
    const aFw = lightingMemory.deviceStorageKey(
      { vendorId: 14391, productId: 12339, serialNumber: 'A' },
      { firmwareVersion: '9.99', rfFirmwareVersion: '9.99' }
    );
    assert.notEqual(a, b);
    assert.equal(a, aFw);
    assert.match(a, /:sn:A$/);
  });
});

describe('Lighting memory local fallback file', () => {
  let dir;
  let file;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maicong-lm-'));
    file = path.join(dir, 'lighting-memory.json');
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('restart persistence is device/profile separated', () => {
    const keyA = lightingMemory.deviceStorageKey({ vendorId: 14391, productId: 12339, serialNumber: 'A' });
    const keyB = lightingMemory.deviceStorageKey({ vendorId: 14391, productId: 12339, serialNumber: 'B' });
    lightingMemory.writeLocalProfile(file, keyA, 0, {
      main: [{ effect: 6, brightness: 80, hexColor: '#FF0000', speed: 1, direction: 0, customColorDisabled: false }],
      side: [],
      side2: []
    });
    lightingMemory.writeLocalProfile(file, keyA, 1, {
      main: [{ effect: 4, brightness: 40, hexColor: '#00FF00', speed: 1, direction: 0, customColorDisabled: false }],
      side: [],
      side2: []
    });
    lightingMemory.writeLocalProfile(file, keyB, 0, {
      main: [{ effect: 1, brightness: 10, hexColor: '#0000FF', speed: 1, direction: 0, customColorDisabled: false }],
      side: [],
      side2: []
    });
    const p0 = lightingMemory.readLocalProfile(file, keyA, 0);
    const p1 = lightingMemory.readLocalProfile(file, keyA, 1);
    const other = lightingMemory.readLocalProfile(file, keyB, 0);
    assert.equal(p0.main[0].effect, 6);
    assert.equal(p1.main[0].effect, 4);
    assert.equal(other.main[0].effect, 1);
    lightingMemory.clearLocalProfiles(file, keyA, 0);
    assert.equal(lightingMemory.readLocalProfile(file, keyA, 0).main.length, 0);
    assert.equal(lightingMemory.readLocalProfile(file, keyA, 1).main[0].effect, 4);
  });

  test('malformed import is rejected before any write', () => {
    const cases = [
      { version: '1.0.0', extra: true },
      { version: '1.0.0', main: [{}] },
      { version: '1.0.0', main: [{ effect: -1, hexColor: 'wrong', speed: 999, brightness: 'bad' }] },
      { version: 'future', main: [] }
    ];
    for (const sample of cases) {
      const bad = lightingMemory.validateImportedLightingMemory(sample);
      assert.equal(bad.valid, false, JSON.stringify(sample));
    }
    const ok = lightingMemory.validateImportedLightingMemory({
      version: '1.0.0',
      main: [{
        effect: 99, hexColor: '#123456', speed: 4, direction: 7,
        customColorDisabled: true, brightness: 75, flags: 79
      }],
      side: []
    });
    assert.equal(ok.valid, true);
    assert.equal(ok.store.main[0].effect, 99);
    assert.equal(ok.store.main[0].flags, 79);
    const omitted = lightingMemory.validateImportedLightingMemory(undefined);
    assert.equal(omitted.valid, true);
    assert.equal(omitted.omitted, true);
  });

  test('bounded local store recovers from oversized, corrupt, and null records', () => {
    const huge = path.join(dir, 'huge.json');
    fs.writeFileSync(huge, 'x'.repeat(lightingMemory.MAX_LOCAL_FILE_BYTES + 8));
    const hugeLoad = lightingMemory.loadLocalFile(huge);
    assert.equal(hugeLoad.recovered, true);
    assert.equal(lightingMemory.readLocalProfile(huge, 'k', 0).main.length, 0);

    const corrupt = path.join(dir, 'corrupt.json');
    fs.writeFileSync(corrupt, '{not json');
    const corruptLoad = lightingMemory.loadLocalFile(corrupt);
    assert.equal(corruptLoad.recovered, true);

    const messy = path.join(dir, 'messy.json');
    fs.writeFileSync(messy, JSON.stringify({
      version: '1.0.0',
      devices: { k: { profiles: { 0: { main: null, side: { nope: true }, side2: [null] } } } }
    }));
    const recovered = lightingMemory.readLocalProfile(messy, 'k', 0);
    assert.equal(recovered.main.length, 0);
    assert.equal(recovered.side.length, 0);
  });

  test('HID path identity is not durable across reconnects; serial is', () => {
    const serial = lightingMemory.deviceIdentity({
      vendorId: 14391, productId: 12339, serialNumber: 'SN-A', path: 'usb-1'
    });
    const pathA = lightingMemory.deviceIdentity({
      vendorId: 14391, productId: 12339, path: 'usb-1'
    });
    const pathB = lightingMemory.deviceIdentity({
      vendorId: 14391, productId: 12339, path: 'usb-2'
    });
    const unscoped = lightingMemory.deviceIdentity({ vendorId: 14391, productId: 12339 });
    assert.equal(serial.kind, 'serial');
    assert.equal(serial.durable, true);
    assert.equal(pathA.kind, 'path');
    assert.equal(pathA.durable, false);
    assert.notEqual(pathA.key, pathB.key);
    assert.equal(unscoped.kind, 'unscoped');
    assert.equal(unscoped.durable, false);
    assert.match(
      lightingMemory.describeMemoryIdentity({ vendorId: 14391, productId: 12339, path: 'usb-1' }, 'local'),
      /not a durable keyboard identity/i
    );
    assert.match(
      lightingMemory.describeMemoryIdentity({ vendorId: 14391, productId: 12339, serialNumber: 'SN-A' }, 'hardware'),
      /on this keyboard/i
    );
  });

  test('corrupt or unsupported-version files are left unchanged on the next save', () => {
    const key = lightingMemory.deviceStorageKey({ vendorId: 14391, productId: 12339, serialNumber: 'A' });
    const store = {
      main: [{ effect: 6, brightness: 80, hexColor: '#FF0000', speed: 1, direction: 0, customColorDisabled: false }],
      side: [],
      side2: []
    };
    const corrupt = '{not json';
    fs.writeFileSync(file, corrupt);
    assert.throws(() => lightingMemory.writeLocalProfile(file, key, 0, store), /left unchanged|not valid JSON|unreadable/i);
    assert.throws(() => lightingMemory.writeDeviceFallback(file, key, 'local', { kind: 'serial', durable: true }), /left unchanged|not valid JSON|unreadable/i);
    assert.equal(fs.readFileSync(file, 'utf8'), corrupt);
    const pref = lightingMemory.readDeviceFallback(file, key);
    assert.equal(pref.unwritable, true);
    assert.equal(pref.recovered, true);
    assert.equal(pref.fallback, 'hardware');

    const futureBody = JSON.stringify({
      version: '9.9.9',
      devices: {
        [key]: {
          profiles: {
            0: {
              main: [{ effect: 6, hexColor: '#FF0000', speed: 1, brightness: 10, direction: 0, customColorDisabled: false }],
              side: [],
              side2: []
            }
          }
        }
      }
    });
    fs.writeFileSync(file, futureBody);
    assert.throws(() => lightingMemory.writeLocalProfile(file, key, 0, store), /unsupported|left unchanged/i);
    assert.equal(fs.readFileSync(file, 'utf8'), futureBody);
    assert.equal(lightingMemory.parseLocalDocument(file).unwritable, true);
  });

  test('saving one valid profile does not discard a sibling malformed profile or fallback metadata', () => {
    const key = lightingMemory.deviceStorageKey({ vendorId: 14391, productId: 12339, serialNumber: 'A' });
    fs.writeFileSync(file, JSON.stringify({
      version: '1.0.0',
      devices: {
        [key]: {
          fallback: 'local',
          identityKind: 'serial',
          durable: true,
          profiles: {
            0: { main: [{ effect: -1, hexColor: 'bad' }], side: [], side2: [] },
            1: {
              main: [{ effect: 6, hexColor: '#FF0000', speed: 1, brightness: 10, direction: 0, customColorDisabled: false }],
              side: [],
              side2: []
            }
          }
        }
      }
    }));
    lightingMemory.writeLocalProfile(file, key, 1, {
      main: [{ effect: 4, hexColor: '#00FF00', speed: 1, brightness: 20, direction: 0, customColorDisabled: false }],
      side: [],
      side2: []
    });
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(raw.devices[key].profiles['0'].main[0].effect, -1);
    assert.equal(raw.devices[key].fallback, 'local');
    assert.equal(raw.devices[key].identityKind, 'serial');
    assert.equal(lightingMemory.readLocalProfile(file, key, 0).main.length, 0);
    assert.equal(lightingMemory.readLocalProfile(file, key, 1).main[0].effect, 4);
  });
});

describe('Lighting memory transport (mocked HID, no physical writes)', () => {
  let tmp;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maicong-lm-hw-'));
    transport.lightingMemoryPath = path.join(tmp, 'lighting-memory.json');
    transport.disconnect();
  });
  afterEach(() => {
    transport.disconnect();
    transport.lightingMemoryPath = null;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('A then B then A restores remembered main settings on hardware custom region', async () => {
    const mock = new MockGlwMemoryDevice();
    attachMock(mock);
    const first = await transport.applyLighting({ effect: 6, brightness: 80, speed: 2, direction: 1, hexColor: '#AABBCC' }, 0);
    assert.equal(first.success, true, first.error);
    const second = await transport.applyLighting({ effect: 4, brightness: 45, speed: 3, hexColor: '#112233' }, 0);
    assert.equal(second.success, true, second.error);
    assert.ok(mock.wroteCommand(protocol.COMMANDS.SET_CUSTOM_PARAM));
    const offset = lightingMemory.lightingMemoryOffset(0);
    const region = mock.custom.subarray(offset, offset + 112);
    const parsed = lightingMemory.parseLightMemory(region);
    assert.equal(parsed.valid, true);
    assert.equal(parsed.store.main[0].effect, 4);
    const wave = parsed.store.main.find((r) => r.effect === 6);
    assert.ok(wave);
    assert.equal(wave.brightness, 80);
    assert.equal(wave.speed, 2);
    const restored = lightingMemory.restoreMainSelection(parsed.store, 6, { brightness: 45 });
    assert.equal(restored.brightness, 80);
    assert.equal(restored.speed, 2);
  });

  test('main and side memories stay isolated', async () => {
    const mock = new MockGlwMemoryDevice();
    attachMock(mock);
    const res = await transport.applyLighting({
      effect: 6,
      brightness: 70,
      sideEffect: 2,
      sideBrightness: 33
    }, 0);
    assert.equal(res.success, true, res.error);
    const parsed = lightingMemory.parseLightMemory(
      mock.custom.subarray(lightingMemory.lightingMemoryOffset(0), lightingMemory.lightingMemoryOffset(0) + 112)
    );
    assert.equal(parsed.store.main[0].effect, 6);
    assert.equal(parsed.store.side[0].sideEffect, 2);
    assert.equal(parsed.store.side[0].sideBrightness, 33);
    const onlyMain = await transport.applyLighting({ effect: 4, brightness: 50 }, 0);
    assert.equal(onlyMain.success, true, onlyMain.error);
    const parsed2 = lightingMemory.parseLightMemory(
      mock.custom.subarray(lightingMemory.lightingMemoryOffset(0), lightingMemory.lightingMemoryOffset(0) + 112)
    );
    assert.equal(parsed2.store.main[0].effect, 4);
    assert.equal(parsed2.store.side[0].sideEffect, 2);
    assert.equal(parsed2.store.side[0].sideBrightness, 33);
  });

  test('FUNC success plus CMD242 failure reports memory save failure without rolling back FUNC', async () => {
    const mock = new MockGlwMemoryDevice();
    attachMock(mock);
    await transport.readFuncConfig(0);
    mock.failCommands.add(protocol.COMMANDS.SET_CUSTOM_PARAM);
    const res = await transport.applyLighting({ brightness: 55 }, 0);
    mock.failCommands.delete(protocol.COMMANDS.SET_CUSTOM_PARAM);
    assert.equal(res.success, true);
    assert.equal(res.memorySaveFailed, true);
    assert.equal(mock.func[9], 55);
    const parsed = lightingMemory.parseLightMemory(
      mock.custom.subarray(lightingMemory.lightingMemoryOffset(0), lightingMemory.lightingMemoryOffset(0) + 112)
    );
    assert.equal(parsed.empty || parsed.store.main.length === 0, true);
  });

  test('transient custom-read failure is unavailable, not a local success', async () => {
    const mock = new MockGlwMemoryDevice();
    attachMock(mock);
    mock.failCommands.add(protocol.COMMANDS.GET_CUSTOM_PARAM);
    const read = await transport.readFuncConfig(0);
    assert.equal(read.success, true);
    assert.equal(read.lightMemory.success, false);
    assert.equal(read.lightMemory.backend, 'unavailable');
    const apply = await transport.applyLighting({ effect: 6, brightness: 80 }, 0);
    assert.equal(apply.success, true, apply.error);
    assert.equal(apply.memorySaveFailed, true);
    assert.equal(apply.memoryBackend, 'unavailable');
    const stored = lightingMemory.readLocalProfile(transport.lightingMemoryPath, transport._lightingDeviceKey(), 0);
    assert.equal(stored.main.length, 0);
    assert.equal(mock.custom[lightingMemory.lightingMemoryOffset(0)], 0);
    assert.equal(mock.func[8], 6);
  });

  test('explicit local fallback persists across a new transport path for the same serial', async () => {
    const mock = new MockGlwMemoryDevice();
    attachMock(mock, 'SN-1');
    transport.lightMemoryFallback = 'local';
    const apply = await transport.applyLighting({ effect: 6, brightness: 80 }, 0);
    assert.equal(apply.success, true, apply.error);
    assert.equal(apply.lightMemory.backend, 'local');
    const key = lightingMemory.deviceStorageKey({ vendorId: 14391, productId: 12339, serialNumber: 'SN-1' });
    transport._lightMemoryCache = null;
    const again = lightingMemory.readLocalProfile(transport.lightingMemoryPath, key, 0);
    assert.equal(again.main[0].effect, 6);
    assert.equal(again.main[0].brightness, 80);
  });

  test('profile 0 memory is not inherited by profile 1', async () => {
    const mock = new MockGlwMemoryDevice();
    attachMock(mock);
    await transport.applyLighting({ effect: 6, brightness: 80 }, 0);
    await transport.applyLighting({ effect: 4, brightness: 40 }, 1);
    const p0 = lightingMemory.parseLightMemory(
      mock.custom.subarray(lightingMemory.lightingMemoryOffset(0), lightingMemory.lightingMemoryOffset(0) + 112)
    );
    const p1 = lightingMemory.parseLightMemory(
      mock.custom.subarray(lightingMemory.lightingMemoryOffset(1), lightingMemory.lightingMemoryOffset(1) + 112)
    );
    assert.equal(p0.store.main[0].effect, 6);
    assert.equal(p1.store.main[0].effect, 4);
  });

  test('confirmed-style local clear cannot resurrect a profile memory', async () => {
    const mock = new MockGlwMemoryDevice();
    attachMock(mock, 'SN-1');
    transport.lightMemoryFallback = 'local';
    await transport.applyLighting({ effect: 6, brightness: 80 }, 0);
    transport.clearLightingMemoryFallback('active', 0);
    const stored = lightingMemory.readLocalProfile(transport.lightingMemoryPath, transport._lightingDeviceKey(), 0);
    assert.equal(stored.main.length, 0);
  });

  test('legacy backups without lightingMemory still validate; malformed lightingMemory fails closed', () => {
    assert.equal(validateProfileSchema(profileBase).valid, true);
    assert.equal(validateProfileSchema({ ...profileBase, lightingMemory: { nope: true } }).valid, false);
    assert.equal(validateProfileSchema({
      ...profileBase,
      lightingMemory: { version: '1.0.0', main: [], side: [] }
    }).valid, true);
  });

  test('each malformed lightingMemory class is rejected with zero transport writes', async () => {
    const mock = new MockGlwMemoryDevice();
    attachMock(mock);
    const malformed = [
      { version: '1.0.0', main: [{}] },
      { version: '1.0.0', main: [{ effect: -1, hexColor: 'wrong', speed: 999, brightness: 'bad' }] },
      { version: 'future', main: [] }
    ];
    for (const lightingMemoryPayload of malformed) {
      mock.writtenBuffers.length = 0;
      const res = await transport.applyProfile({ ...profileBase, lightingMemory: lightingMemoryPayload }, 0);
      assert.equal(res.success, false, JSON.stringify(lightingMemoryPayload));
      assert.equal(mock.writtenBuffers.length, 0, `malformed ${JSON.stringify(lightingMemoryPayload)} must not write`);
    }
  });

  test('stale memory transaction after serial swap does not write the replacement device fallback', async () => {
    const mock = new MockGlwMemoryDevice();
    attachMock(mock, 'A');
    mock.delayCommands.set(protocol.COMMANDS.GET_CUSTOM_PARAM, 350);
    const pending = transport.applyLighting({ effect: 6, brightness: 80 }, 0);
    await sleep(80);
    transport.lastState.device = {
      ...transport.lastState.device,
      serialNumber: 'B',
      path: 'mock://g75v2/B'
    };
    const res = await pending;
    mock.delayCommands.delete(protocol.COMMANDS.GET_CUSTOM_PARAM);
    assert.equal(res.success, true);
    assert.equal(res.memorySaveFailed, true);
    const keyA = lightingMemory.deviceStorageKey({ vendorId: 14391, productId: 12339, serialNumber: 'A' });
    const keyB = lightingMemory.deviceStorageKey({ vendorId: 14391, productId: 12339, serialNumber: 'B' });
    assert.equal(lightingMemory.readLocalProfile(transport.lightingMemoryPath, keyA, 0).main.length, 0);
    assert.equal(lightingMemory.readLocalProfile(transport.lightingMemoryPath, keyB, 0).main.length, 0);
    assert.equal(transport._lightMemoryCache, null);
  });

  test('stale memory transaction after reset epoch bump does not repopulate cache', async () => {
    const mock = new MockGlwMemoryDevice();
    attachMock(mock, 'A');
    mock.delayCommands.set(protocol.COMMANDS.GET_CUSTOM_PARAM, 350);
    const pending = transport.readFuncConfig(0);
    await sleep(80);
    transport.resetEpoch += 1;
    transport._lightMemoryCache = null;
    const res = await pending;
    mock.delayCommands.delete(protocol.COMMANDS.GET_CUSTOM_PARAM);
    assert.equal(res.success, true);
    assert.equal(res.lightMemory.success, false);
    assert.equal(res.lightMemory.backend, 'unavailable');
    assert.equal(transport._lightMemoryCache, null);
  });

  test('calibration-only apply does not alter remembered records', async () => {
    const mock = new MockGlwMemoryDevice();
    attachMock(mock);
    await transport.applyLighting({ effect: 6, brightness: 80 }, 0);
    mock.writtenBuffers.length = 0;
    const cal = await transport.applyLighting({ calibrationRgb: { r: 10, g: 20, b: 30 } }, 0);
    assert.equal(cal.success, true, cal.error);
    assert.equal(mock.wroteCommand(protocol.COMMANDS.SET_CUSTOM_PARAM), false);
  });

  test('setLightMemoryFallback persists This Mac for the captured serial and reloads after reset', async () => {
    const mock = new MockGlwMemoryDevice();
    attachMock(mock, 'SN-PREF');
    const set = transport.setLightMemoryFallback('local');
    assert.equal(set.success, true, set.error);
    assert.equal(set.persisted, true);
    assert.equal(set.identityKind, 'serial');
    assert.equal(set.durable, true);
    const device = { ...transport.lastState.device };
    transport.resetState();
    assert.equal(transport.lightMemoryFallback, 'hardware');
    transport.device = mock;
    transport.lastState.connected = true;
    transport.lastState.device = device;
    transport._loadLightMemoryPreference();
    assert.equal(transport.lightMemoryFallback, 'local');
    const pref = transport.getLightMemoryPreference();
    assert.equal(pref.fallback, 'local');
    assert.equal(pref.persisted, true);
    assert.equal(pref.identityKind, 'serial');
    mock.writtenBuffers.length = 0;
    const apply = await transport.applyLighting({ effect: 6, brightness: 80 }, 0);
    assert.equal(apply.success, true, apply.error);
    assert.equal(apply.lightMemory.backend, 'local');
    assert.equal(mock.wroteCommand(protocol.COMMANDS.SET_CUSTOM_PARAM), false);
    const stored = lightingMemory.readLocalProfile(transport.lightingMemoryPath, transport._lightingDeviceKey(), 0);
    assert.equal(stored.main[0].effect, 6);
  });

  test('no-serial HID path preference is honest and not claimed durable', () => {
    const mock = new MockGlwMemoryDevice();
    attachMock(mock, 'IGNORED');
    transport.lastState.device = {
      vendorId: 14391,
      productId: 12339,
      serialNumber: '',
      path: 'IOService:/AppleUSB/HID@123',
      interface: 1,
      mock: true
    };
    const pref = transport.getLightMemoryPreference();
    assert.equal(pref.identityKind, 'path');
    assert.equal(pref.durable, false);
    assert.equal(pref.serialPresent, false);
    assert.match(pref.hint, /no serial number|not a durable/i);
    const set = transport.setLightMemoryFallback('local');
    assert.equal(set.success, true, set.error);
    assert.equal(set.durable, false);
    assert.equal(set.identityKind, 'path');
    assert.match(set.hint, /path can change|not a durable/i);
  });

  test('malformed prior is rejected before any CMD 242 and does not zero unknown bytes', async () => {
    const mock = new MockGlwMemoryDevice();
    attachMock(mock);
    const offset = lightingMemory.lightingMemoryOffset(0);
    mock.custom.fill(0xA5, offset, offset + 112);
    Buffer.from('<light@v2>', 'ascii').copy(mock.custom, offset);
    mock.custom[offset + 10] = 15;
    mock.custom[offset + 11] = 15;
    mock.custom[offset + 12] = 15;
    mock.writtenBuffers.length = 0;
    const apply = await transport.applyLighting({ effect: 6, brightness: 80 }, 0);
    assert.equal(apply.success, true, apply.error);
    assert.equal(apply.memorySaveFailed, true);
    assert.equal(mock.wroteCommand(protocol.COMMANDS.SET_CUSTOM_PARAM), false);
    assert.equal(mock.custom[offset + 13], 0xA5);

    const prior = Buffer.from(mock.custom.subarray(offset, offset + 112));
    mock.writtenBuffers.length = 0;
    const write = await transport._writeLightMemoryInTransaction(
      0,
      {
        main: [{ effect: 6, brightness: 80, hexColor: '#AABBCC', speed: 2, direction: 1, customColorDisabled: false }],
        side: [],
        side2: []
      },
      transport.generation,
      transport._captureMemoryGuard(),
      prior
    );
    assert.equal(write.success, false);
    assert.match(write.error, /malformed|exceed/i);
    assert.equal(mock.wroteCommand(protocol.COMMANDS.SET_CUSTOM_PARAM), false);
    assert.equal(mock.custom[offset + 13], 0xA5);

    mock.writtenBuffers.length = 0;
    const imported = await transport.applyProfile({
      ...profileBase,
      lightingMemory: {
        version: '1.0.0',
        main: [{
          effect: 6, hexColor: '#AABBCC', speed: 1, direction: 0, customColorDisabled: false, brightness: 80
        }],
        side: []
      }
    }, 0);
    assert.equal(imported.success, false);
    assert.equal(imported.failedSection, 'lightingMemory');
    assert.equal(mock.wroteCommand(protocol.COMMANDS.SET_CUSTOM_PARAM), false);
    assert.equal(mock.custom[offset + 13], 0xA5);
  });

  test('persistMemory false writes FUNC but does not send CMD 242', async () => {
    const mock = new MockGlwMemoryDevice();
    attachMock(mock);
    mock.writtenBuffers.length = 0;
    const res = await transport.applyLighting({ brightness: 44 }, 0, { persistMemory: false });
    assert.equal(res.success, true, res.error);
    assert.equal(res.memorySkipped, true);
    assert.equal(mock.func[9], 44);
    assert.equal(mock.wroteCommand(protocol.COMMANDS.SET_CUSTOM_PARAM), false);
  });

  test('in-flight applyLighting keeps the captured fallback if preference flips during the write', async () => {
    const mock = new MockGlwMemoryDevice();
    attachMock(mock, 'SN-FLIP');
    mock.delayCommands.set(protocol.COMMANDS.SET_FUNC_CONFIG, 250);
    const pending = transport.applyLighting({ effect: 6, brightness: 80 }, 0);
    await sleep(40);
    transport.lightMemoryFallback = 'local';
    const res = await pending;
    mock.delayCommands.delete(protocol.COMMANDS.SET_FUNC_CONFIG);
    assert.equal(res.success, true, res.error);
    assert.equal(res.lightMemory && res.lightMemory.backend, 'hardware');
    assert.ok(mock.wroteCommand(protocol.COMMANDS.SET_CUSTOM_PARAM));
    const stored = lightingMemory.readLocalProfile(transport.lightingMemoryPath, transport._lightingDeviceKey(), 0);
    assert.equal(stored.main.length, 0);
  });

  test('corrupt local file is not replaced when This Mac apply or preference write fails', async () => {
    const mock = new MockGlwMemoryDevice();
    attachMock(mock, 'SN-BAD');
    const corrupt = '{not json';
    fs.writeFileSync(transport.lightingMemoryPath, corrupt);
    const set = transport.setLightMemoryFallback('local');
    assert.equal(set.success, false);
    assert.equal(transport.lightMemoryFallback, 'hardware');
    assert.equal(fs.readFileSync(transport.lightingMemoryPath, 'utf8'), corrupt);
    transport.lightMemoryFallback = 'local';
    const apply = await transport.applyLighting({ effect: 6, brightness: 80 }, 0);
    assert.equal(apply.success, true);
    assert.equal(apply.memorySaveFailed, true);
    assert.equal(fs.readFileSync(transport.lightingMemoryPath, 'utf8'), corrupt);
    assert.equal(mock.wroteCommand(protocol.COMMANDS.SET_CUSTOM_PARAM), false);
  });
});
