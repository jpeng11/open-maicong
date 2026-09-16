'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const protocol = require('../src/protocol.cjs');
const firmwareIdentity = require('../src/firmware-protocol.cjs');
const profileNames = require('../src/profile-names.cjs');
const {
  VALID_LIGHTING_SLOTS,
  ELIGIBLE_ADVANCED_SLOTS
} = require('../src/layout-g75v2.cjs');
const transport = require('../src/transport.cjs');
const { MockGlwMemoryDevice } = require('./mock-glw-memory.cjs');

const WRITE_COMMANDS = new Set([
  protocol.COMMANDS.SET_FUNC_CONFIG,
  protocol.COMMANDS.SET_USER_KEY_MATRIX,
  protocol.COMMANDS.SET_KEY_COLOR,
  protocol.COMMANDS.SET_MACROS,
  protocol.COMMANDS.SET_BASE,
  protocol.COMMANDS.SET_KEY_EXTRAS,
  protocol.COMMANDS.SET_MT_KEYS,
  protocol.COMMANDS.SET_TGL_KEYS,
  protocol.COMMANDS.SET_CUSTOM_PARAM
]);

let tempRoot;

function tempFile(name = 'g75v2-backup.json') {
  if (!tempRoot) tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'maicong-firmware-backup-'));
  return path.join(tempRoot, name);
}

function reviewedIdentity({ serialNumber = 'G75-SERIAL', locationId = 0x02400000, pathName = 'DevSrvsID:101/old-hid-path' } = {}) {
  return {
    vendorId: firmwareIdentity.VENDOR_ID,
    productId: firmwareIdentity.NORMAL_PIDS.WIRELESS_RECEIVER,
    interface: firmwareIdentity.CONTROL_INTERFACE,
    usagePage: firmwareIdentity.NORMAL_USAGE_PAGE,
    usage: firmwareIdentity.NORMAL_USAGE,
    serialNumber,
    locationId,
    path: pathName,
    registryEntryId: 101,
    registryPath: pathName
  };
}

function attachMock(mock, identity = reviewedIdentity()) {
  transport.installTestAdapter(mock);
  transport.firmwareTopologyIdentity = { ...identity };
  transport.deviceInfo = { ...(transport.deviceInfo || {}), ...identity };
  transport.lastState.device = { ...transport.lastState.device, ...identity };
  return identity;
}

function seedMetadata(mock) {
  const storedNames = ['Alpha', 'Beta', 'Gamma', 'Dormant'];
  const nameBuffer = profileNames.encodeProfileNames(storedNames);
  assert.equal(nameBuffer.valid, true);
  for (let slot = 0; slot < protocol.MAX_KEYBOARD_PROFILES; slot++) {
    nameBuffer.buffer.copy(mock.custom, profileNames.namesOffset(slot));
    const feature = profileNames.encodeFeatureSupport({
      macroUpdatedAt: 1000 + slot,
      profileNameUpdatedAt: 2000 + slot,
      browserId: `browser-${slot}`,
      browserIdExpiredAt: 3000 + slot
    });
    assert.equal(feature.valid, true);
    feature.buffer.copy(mock.custom, profileNames.featureSupportOffset(slot));

    const custom = protocol.serializeCbCustomParam({
      cbKeyIndexList: [[slot], [], [slot + 1], []],
      rtPressPrecisionMode: 1,
      rtReleasePrecisionMode: 2,
      rtSmartCacheValue: 1
    }, Buffer.alloc(protocol.CB_CUSTOM_PARAM_LENGTH, 0xCC));
    custom.copy(mock.custom, protocol.cbCustomParamOffset(slot));
  }
}

function setReorderedBase(mock) {
  const order = [2, 0, 3, 1];
  const count = 2;
  mock.base[0] = order.slice(0, count).indexOf(0);
  mock.base[1] = count;
  order.forEach((slot, index) => { mock.base[2 + index] = slot; });
  return { order, count, activeProfile: 0 };
}

function writeCommands(mock) {
  return mock.writtenBuffers
    .map((buffer) => buffer[2])
    .filter((command) => WRITE_COMMANDS.has(command));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test.beforeEach(() => {
  transport.disconnect();
  delete transport.firmwareTopologyIdentity;
});

test.afterEach(() => {
  transport.disconnect();
  delete transport.firmwareTopologyIdentity;
  if (tempRoot) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  }
});

test('complete backup captures reordered enabled profiles, four full layers, names, macros, globals proof, and advanced metadata', async () => {
  const mock = new MockGlwMemoryDevice();
  seedMetadata(mock);
  const topology = setReorderedBase(mock);
  const identity = attachMock(mock);
  const filePath = tempFile();

  const result = await transport.backupFirmwareConfiguration({ filePath, identity });

  assert.equal(result.success, true, result.error);
  assert.equal(result.readyForUpdate, true);
  assert.equal(result.persisted, true);
  assert.equal(result.backup.base.profileLength, topology.count);
  assert.deepEqual(result.backup.base.profileOrder, topology.order);
  assert.deepEqual(result.backup.profiles.map((profile) => profile.profileIndex), [2, 0]);
  assert.deepEqual(result.backup.profiles.map((profile) => profile.name), ['Gamma', 'Alpha']);
  assert.equal(result.backup.defaults.layers.length, 4);
  assert.ok(result.backup.defaults.layers.every((hex) => hex.length === protocol.TOTAL_KEY_AREA_SIZE * 2));
  for (const profile of result.backup.profiles) {
    assert.equal(profile.layers.length, 4);
    assert.ok(profile.layers.every((hex) => hex.length === protocol.TOTAL_KEY_AREA_SIZE * 2));
    assert.equal(profile.advanced.mtHex.length, protocol.MT_TABLE_SIZE * 2);
    assert.equal(profile.advanced.tglHex.length, protocol.TGL_TABLE_SIZE * 2);
    assert.equal(profile.advanced.keyExtrasHex.length, protocol.KEY_EXTRAS_SIZE * 2);
    assert.equal(profile.advanced.customParamHex.length, protocol.CB_CUSTOM_PARAM_LENGTH * 2);
  }
  assert.equal(result.backup.macros.rawHex.length, protocol.SHARED_MACRO_SIZE * 2);
  assert.equal(result.backup.names.regions.length, 4);
  assert.equal(result.backup.featureSupport.length, 4);
  assert.equal(result.backup.globals.predicate, 'layout.isGlobalKey === true');
  assert.deepEqual(result.backup.globals.eligibleSlots, []);
  assert.deepEqual(result.backup.globals.keys, []);

  const loaded = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(loaded.complete, true);
  assert.equal(loaded.identity.locationId, 0x02400000);
  assert.equal(loaded.deviceInfo.rawRfFirmwareVersion, 0x0130);
  assert.equal(loaded.deviceInfo.rfFirmwareVersion, '1.30');
  assert.equal(loaded.deviceInfo.rawFirmwareVersion, 0x0114);
  assert.equal(loaded.deviceInfo.firmwareVersion, '1.14');
});

test('restore migrates semantic profile state onto post-firmware defaults and preserves reserved/unrelated bytes', async () => {
  const mock = new MockGlwMemoryDevice();
  seedMetadata(mock);
  setReorderedBase(mock);
  const identity = attachMock(mock);

  // Make one physical key a user remap and leave another at the old default.
  const remappedSlot = 5;
  const defaultSlot = 6;
  const oldDefaultRemap = [mock.defaultKeys[remappedSlot * 3], mock.defaultKeys[remappedSlot * 3 + 1], mock.defaultKeys[remappedSlot * 3 + 2]];
  const oldDefaultPlain = [mock.defaultKeys[defaultSlot * 3], mock.defaultKeys[defaultSlot * 3 + 1], mock.defaultKeys[defaultSlot * 3 + 2]];
  mock.pokeUserKey(2, 0, remappedSlot, [0x10, 0x00, 0x7A]);
  mock.pokeUserKey(2, 0, defaultSlot, oldDefaultPlain);

  const filePath = tempFile();
  const captured = await transport.backupFirmwareConfiguration({ filePath, identity });
  assert.equal(captured.success, true, captured.error);
  assert.notDeepEqual(oldDefaultRemap, [0x10, 0x00, 0x7A]);

  // Simulate post-firmware memory: defaults changed, while reserved/unrelated
  // bytes are populated by the new firmware and must not be overwritten.
  const newDefaultPlain = [0x10, 0x00, 0xE1];
  mock.defaultKeys[defaultSlot * 3] = newDefaultPlain[0];
  mock.defaultKeys[defaultSlot * 3 + 1] = newDefaultPlain[1];
  mock.defaultKeys[defaultSlot * 3 + 2] = newDefaultPlain[2];
  mock.pokeUserKey(2, 0, defaultSlot, newDefaultPlain);

  const reservedLayerSlot = 127;
  mock.pokeUserKey(2, 0, reservedLayerSlot, [0xAA, 0xBB, 0xCC]);
  const nonLightingSlot = [...Array(128).keys()].find((slot) => !VALID_LIGHTING_SLOTS.has(slot));
  assert.notEqual(nonLightingSlot, undefined);
  const colorOffset = 2 * 512 + nonLightingSlot * 3;
  mock.colors[colorOffset] = 0xD1;
  mock.colors[colorOffset + 1] = 0xD2;
  mock.colors[colorOffset + 2] = 0xD3;
  const nonAdvancedSlot = [...Array(128).keys()].find((slot) => !ELIGIBLE_ADVANCED_SLOTS.has(slot));
  assert.notEqual(nonAdvancedSlot, undefined);
  const extrasOffset = 2 * 1024 + nonAdvancedSlot * 8;
  mock.extras.fill(0xE7, extrasOffset, extrasOffset + 8);
  mock.mt.fill(0xB1, 2 * 256 + protocol.MT_RESERVED_OFFSET);
  mock.tgl.fill(0xB2, 2 * 128 + protocol.TGL_RESERVED_OFFSET);
  mock.custom[protocol.cbCustomParamOffset(2) + 55] = 0xC5;
  mock.base[10] = 0x9A;
  mock.macros[50] = 0x9B;
  mock.func[2 * 64 + 50] = 0x9C;
  mock.func[2 * 64 + 32] = 0x9D;
  mock.func[2 * 64 + 34] = 0x9E;

  const result = await transport.restoreFirmwareConfiguration(captured.backup, { filePath, identity });
  assert.equal(result.success, true, result.error);
  assert.equal(result.restorationVerified, true);

  assert.equal(mock.readUserKey(2, 0, remappedSlot)[2], 0x7A);
  assert.deepEqual(mock.readUserKey(2, 0, defaultSlot), newDefaultPlain);
  assert.deepEqual(mock.readUserKey(2, 0, reservedLayerSlot), [0xAA, 0xBB, 0xCC]);
  assert.deepEqual(Array.from(mock.colors.subarray(colorOffset, colorOffset + 3)), [0xD1, 0xD2, 0xD3]);
  assert.deepEqual(Array.from(mock.extras.subarray(extrasOffset, extrasOffset + 8)), new Array(8).fill(0xE7));
  assert.ok(mock.mt.subarray(2 * 256 + protocol.MT_RESERVED_OFFSET).every((value) => value === 0xB1));
  assert.ok(mock.tgl.subarray(2 * 128 + protocol.TGL_RESERVED_OFFSET).every((value) => value === 0xB2));
  assert.equal(mock.custom[protocol.cbCustomParamOffset(2) + 55], 0xC5);
  assert.equal(mock.base[10], 0x9A);
  assert.equal(mock.macros[50], 0x9B);
  assert.equal(mock.func[2 * 64 + 50], 0x9C);
  assert.equal(mock.func[2 * 64 + 32], 0x9D);
  assert.equal(mock.func[2 * 64 + 34], 0x9E);

  const namesSlot1 = profileNames.decodeProfileNames(mock.custom.subarray(profileNames.namesOffset(1), profileNames.namesOffset(1) + profileNames.PROFILE_NAMES_LENGTH));
  const namesSlot2 = profileNames.decodeProfileNames(mock.custom.subarray(profileNames.namesOffset(2), profileNames.namesOffset(2) + profileNames.PROFILE_NAMES_LENGTH));
  assert.deepEqual(namesSlot1.stored, ['Alpha', '', 'Gamma', '']);
  assert.deepEqual(namesSlot2.stored, ['Alpha', '', 'Gamma', '']);
  const persisted = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(persisted.restoration.status, 'verified');
});

test('restore accepts a stable LocationID across changed HID paths but rejects a changed topology anchor before writes', async () => {
  const mock = new MockGlwMemoryDevice();
  seedMetadata(mock);
  const original = attachMock(mock, reviewedIdentity({ pathName: 'old/DevSrvsID:10/hid' }));
  const captured = await transport.backupFirmwareConfiguration({ identity: original });
  assert.equal(captured.success, true, captured.error);

  const changedPath = reviewedIdentity({ pathName: 'new/DevSrvsID:99/hid' });
  transport.firmwareTopologyIdentity = { ...changedPath, registryEntryId: 99, registryPath: changedPath.path };
  transport.lastState.device = { ...transport.lastState.device, ...changedPath, path: changedPath.path };
  transport.deviceInfo = { ...transport.deviceInfo, ...changedPath, path: changedPath.path };
  mock.writtenBuffers = [];
  const accepted = await transport.restoreFirmwareConfiguration(captured.backup, { identity: changedPath });
  assert.equal(accepted.success, true, accepted.error);

  // A cached old topology candidate must not be allowed to mask a changed
  // live descriptor, even though the stable serial/location pair looks right.
  transport.firmwareTopologyIdentity = original;
  mock.writtenBuffers = [];
  const staleTopology = await transport.restoreFirmwareConfiguration(captured.backup);
  assert.equal(staleTopology.success, false);
  assert.match(staleTopology.error, /topology|identity/i);
  assert.equal(writeCommands(mock).length, 0);

  const changedLocation = reviewedIdentity({ locationId: 0x02400001, pathName: 'newer/DevSrvsID:100/hid' });
  transport.firmwareTopologyIdentity = changedLocation;
  transport.lastState.device = { ...transport.lastState.device, ...changedLocation };
  transport.deviceInfo = { ...transport.deviceInfo, ...changedLocation };
  mock.writtenBuffers = [];
  const rejected = await transport.restoreFirmwareConfiguration(captured.backup, { identity: changedLocation });
  assert.equal(rejected.success, false);
  assert.match(rejected.error, /identity/i);
  assert.equal(writeCommands(mock).length, 0);
});

test('duplicate or semantically conflicting backup metadata fails closed with zero writes', async () => {
  const mock = new MockGlwMemoryDevice();
  seedMetadata(mock);
  const identity = attachMock(mock);
  const captured = await transport.backupFirmwareConfiguration({ identity });
  assert.equal(captured.success, true, captured.error);

  const cases = [
    ['duplicate feature-support slot', (value) => { value.featureSupport[1].slot = value.featureSupport[0].slot; }],
    ['duplicate profile-name slot', (value) => { value.names.regions[1].slot = value.names.regions[0].slot; }],
    ['ineligible global key', (value) => { value.globals.keys.push({ index: 0, layers: [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]] }); }],
    ['conflicting func semantic field', (value) => { value.profiles[0].funcConfig.settings.sleepTime += 1; }]
  ];
  for (const [label, mutate] of cases) {
    const malformed = clone(captured.backup);
    mutate(malformed);
    mock.writtenBuffers = [];
    const result = await transport.restoreFirmwareConfiguration(malformed);
    assert.equal(result.success, false, label);
    assert.equal(writeCommands(mock).length, 0, `${label} dispatched a write`);
  }
});

test('atomic backup retention and partial restore reporting remain honest after writes begin', async () => {
  const mock = new MockGlwMemoryDevice();
  seedMetadata(mock);
  const identity = attachMock(mock);
  const filePath = tempFile();
  const first = await transport.backupFirmwareConfiguration({ filePath, identity });
  assert.equal(first.success, true, first.error);
  const before = fs.readFileSync(filePath, 'utf8');

  mock.failCommands.add(protocol.COMMANDS.GET_MACROS);
  const failedCapture = await transport.backupFirmwareConfiguration({ filePath, identity });
  assert.equal(failedCapture.success, false);
  assert.equal(failedCapture.backupRetained, true);
  assert.equal(failedCapture.readyForUpdate, false);
  assert.equal(fs.readFileSync(filePath, 'utf8'), before);
  mock.failCommands.delete(protocol.COMMANDS.GET_MACROS);

  mock.failCommands.add(protocol.COMMANDS.SET_FUNC_CONFIG);
  mock.writtenBuffers = [];
  const partial = await transport.restoreFirmwareConfiguration(filePath, { identity });
  assert.equal(partial.success, false);
  assert.equal(partial.partial, true);
  assert.equal(partial.writesStarted, true);
  assert.equal(partial.restorationVerified, false);
  assert.equal(partial.backupRetained, true);
  assert.match(partial.failedSection, /funcConfig/);
  const commands = writeCommands(mock);
  assert.ok(commands.includes(protocol.COMMANDS.SET_MACROS));
  assert.ok(commands.includes(protocol.COMMANDS.SET_BASE));
  assert.equal(commands.filter((command) => command === protocol.COMMANDS.SET_FUNC_CONFIG).length, 1);
  const persisted = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(persisted.restoration.status, 'captured');
});
