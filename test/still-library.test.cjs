const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const stillLibrary = require('../src/still-library.cjs');
const transport = require('../src/transport.cjs');
const protocol = require('../src/protocol.cjs');
const { MockGlwMemoryDevice } = require('./mock-glw-memory.cjs');

function attachMock(mock, serial = 'STILL-A') {
  transport.disconnect();
  transport.device = mock;
  transport.needsReconnect = false;
  transport.statusError = null;
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('Still library name, capacity, clone, and CRUD', () => {
  test('create uses hub still shape and prepends', () => {
    const created = stillLibrary.createStill([], ' Aurora ', stillLibrary.emptyStillData(), { lightScopeType: 'main' });
    assert.equal(created.valid, true, created.error);
    assert.equal(created.items.length, 1);
    assert.equal(created.item.name, 'Aurora');
    assert.equal(created.item.type, 'localstorage');
    assert.equal(created.item.profileIndex, -1);
    assert.equal(created.item.data.dataScope, 'LightingEffectProfile');
    assert.equal(created.item.data.type, 'still');
    assert.equal(created.item.data.isPreset, false);
    assert.deepEqual(created.item.data.frames, [{ data: [] }]);
    assert.equal(created.item.key.startsWith('LightingEffectProfile@still@'), true);
    const second = stillLibrary.createStill(created.items, 'Bolt', stillLibrary.emptyStillData());
    assert.equal(second.items[0].name, 'Bolt');
    assert.equal(second.items[1].name, 'Aurora');
  });

  test('name validation matches hub 2–15 trim uniqueness', () => {
    const first = stillLibrary.createStill([], 'AB', stillLibrary.emptyStillData());
    assert.equal(stillLibrary.checkName('', []).valid, false);
    assert.equal(stillLibrary.checkName('A', []).valid, false);
    assert.equal(stillLibrary.checkName('1234567890123456', []).valid, false);
    assert.equal(stillLibrary.checkName('AB', first.items).valid, false);
    assert.equal(stillLibrary.checkName('  CD  ', first.items).valid, true);
    assert.equal(stillLibrary.checkName('AB', first.items, { ignoreKey: first.key }).valid, true);
  });

  test('gif and oversize frames are rejected', () => {
    const gif = stillLibrary.validateStillData({
      dataScope: 'LightingEffectProfile',
      type: 'gif',
      frames: [{ data: [] }],
      isPreset: false
    });
    assert.equal(gif.valid, false);
    const huge = stillLibrary.validateStillData({
      dataScope: 'LightingEffectProfile',
      type: 'still',
      frames: [{ data: Array.from({ length: 129 }, (_, i) => ({ code: i, selectColor: '#FFFFFF' })) }],
      isPreset: false
    });
    assert.equal(huge.valid, false);
    const emptyFrames = stillLibrary.validateStillData({
      dataScope: 'LightingEffectProfile',
      type: 'still',
      frames: [],
      isPreset: false
    });
    assert.equal(emptyFrames.valid, false);
  });

  test('createStill rejects wrong scope, gif type, and malformed frames before normalization', () => {
    const wrongScope = stillLibrary.createStill([], 'Fixture', {
      dataScope: 'WrongScope',
      type: 'gif',
      frames: [{ data: [] }]
    }, {});
    assert.equal(wrongScope.valid, false, 'wrong dataScope/type must not coerce to a still');
    assert.match(wrongScope.error || '', /LightingEffectProfile|still|type|dataScope/i);

    const gif = stillLibrary.createStill([], 'Fixture', {
      dataScope: 'LightingEffectProfile',
      type: 'gif',
      frames: [{ data: [] }],
      isPreset: false
    });
    assert.equal(gif.valid, false);

    const malformed = stillLibrary.createStill([], 'Fixture', { frames: 'malformed' }, {});
    assert.equal(malformed.valid, false);
    assert.match(malformed.error || '', /dataScope|frames|plain object/i);

    const omitted = stillLibrary.createStill([], 'EmptyOk');
    assert.equal(omitted.valid, true, omitted.error);
    assert.equal(omitted.item.data.type, 'still');
    assert.deepEqual(omitted.item.data.frames, [{ data: [] }]);
  });

  test('cloneData forces isPreset false and keeps frames', () => {
    const cloned = stillLibrary.cloneStillData({
      dataScope: 'LightingEffectProfile',
      type: 'still',
      frames: [{ data: [{ code: 4, selectColor: '#FF0000' }] }],
      isPreset: true,
      extraJunk: true
    });
    assert.equal(cloned.isPreset, false);
    assert.equal(cloned.extraJunk, undefined);
    assert.equal(cloned.frames[0].data[0].code, 4);
  });

  test('capacity is 20 local stills', () => {
    let items = [];
    for (let i = 0; i < 20; i++) {
      const name = i < 8 ? `S${i}` : `St${i}`;
      const res = stillLibrary.createStill(items, name, stillLibrary.emptyStillData());
      assert.equal(res.valid, true, res.error);
      items = res.items;
    }
    const full = stillLibrary.createStill(items, 'ZZ', stillLibrary.emptyStillData());
    assert.equal(full.valid, false);
    assert.match(full.error, /full/i);
  });

  test('delete of the active item retargets right then left; non-active preserves', () => {
    let items = [];
    for (const name of ['AA', 'BB', 'CC']) {
      items = stillLibrary.createStill(items, name, stillLibrary.emptyStillData()).items;
    }
    // prepend order: CC, BB, AA
    const active = stillLibrary.deleteStill(items, items[1].key, { isActive: true });
    assert.equal(active.replacement.mode, 'replace');
    assert.equal(active.replacement.item.name, 'AA');
    const preserved = stillLibrary.deleteStill(items, items[1].key, { isActive: false });
    assert.equal(preserved.replacement.mode, 'preserve');
    const last = stillLibrary.deleteStill([items[0]], items[0].key, { isActive: true });
    assert.equal(last.replacement.mode, 'empty');
  });
});

describe('Yz/xW helpers and G75 frame aliases', () => {
  test('Yz and xW and library-to-player round trip', () => {
    const player = [{ dur: 40, colors: [{ code: 4, color: '#00FF00' }] }];
    const lib = stillLibrary.Yz(player);
    assert.deepEqual(lib[0], { duration: 40, data: [{ code: 4, selectColor: '#00FF00' }] });
    assert.deepEqual(stillLibrary.xW([{ code: 7, color: '#0000FF' }]), [{ code: 7, selectColor: '#0000FF' }]);
    const back = stillLibrary.libraryFramesToPlayer([{ duration: undefined, data: [{ code: 4, selectColor: '#ABCDEF' }, 'skip'] }]);
    assert.equal(back[0].dur, 16);
    assert.deepEqual(back[0].colors, [{ code: 4, color: '#ABCDEF' }]);
  });

  test('colors2KeyColorFrame uses 301/302 for split space and keeps ordinary space 44', () => {
    const colors = {};
    colors[45] = '#111111';
    colors[53] = '#222222';
    colors[61] = '#333333';
    colors[85] = '#444444';
    const frame = stillLibrary.colors2KeyColorFrame(colors);
    const byCode = new Map(frame.map((e) => [e.code, e]));
    assert.equal(byCode.get(301).selectColor, '#111111');
    assert.equal(byCode.get(44).selectColor, '#222222');
    assert.equal(byCode.get(302).selectColor, '#333333');
    assert.equal(byCode.has(0), false);
    assert.equal(byCode.get(255).selectColor, '#444444');
  });

  test('keyColorFrame2Colors resolves 301/302/1 independently of visual code 0/255', () => {
    const colors = stillLibrary.keyColorFrame2Colors([
      { code: 301, selectColor: '#AAA000' },
      { code: 302, selectColor: '#BBB000' },
      { code: 1, selectColor: '#CCC000' },
      { code: 44, selectColor: '#DDD000' }
    ]);
    assert.equal(colors[45], '#AAA000');
    assert.equal(colors[61], '#BBB000');
    assert.equal(colors[85], '#CCC000');
    assert.equal(colors[53], '#DDD000');
    assert.equal(colors[0], '#000000');
  });

  test('black colors are omitted from still frames', () => {
    const frame = stillLibrary.colors2KeyColorFrame({ 5: '#000000', 13: '#FFFFFF' });
    assert.equal(frame.some((e) => e.selectColor === '#000000'), false);
    assert.equal(frame.length > 0, true);
    assert.equal(frame.every((e) => e.selectColor !== '#000000'), true);
  });
});

describe('selectedLightEffect 56-byte JSON region', () => {
  test('still setter stores empty first string and getter restores still', () => {
    const encoded = stillLibrary.encodeSelectedLightEffect(['still', 'Aurora']);
    assert.equal(encoded.valid, true);
    assert.equal(encoded.buffer.length, 56);
    assert.equal(encoded.buffer[0], Buffer.from('["","Aurora"]')[0]);
    assert.equal(encoded.buffer[Buffer.from('["","Aurora"]').length], 255);
    const decoded = stillLibrary.decodeSelectedLightEffect(encoded.buffer);
    assert.deepEqual(decoded.pair, ['still', 'Aurora']);
  });

  test('gif type is preserved as the first string', () => {
    const encoded = stillLibrary.encodeSelectedLightEffect(['gif', 'Loop']);
    const decoded = stillLibrary.decodeSelectedLightEffect(encoded.buffer);
    assert.deepEqual(decoded.pair, ['gif', 'Loop']);
  });

  test('malformed bytes fall back to still empty without throwing', () => {
    const buf = Buffer.alloc(56, 255);
    buf[0] = 123;
    const decoded = stillLibrary.decodeSelectedLightEffect(buf);
    assert.deepEqual(decoded.pair, ['still', '']);
  });
});

describe('Still library persistence', () => {
  let tmp;
  let file;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maicong-still-'));
    file = path.join(tmp, 'still-library.json');
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('items persist across reload for the same device key', () => {
    const key = stillLibrary.deviceStorageKey({ vendorId: 14391, productId: 12339, serialNumber: 'SN-1' });
    const created = stillLibrary.createStill([], 'Persist', stillLibrary.emptyStillData());
    stillLibrary.writeDeviceItems(file, key, created.items, { kind: 'serial' });
    const loaded = stillLibrary.readDeviceItems(file, key);
    assert.equal(loaded.ok, true);
    assert.equal(loaded.items[0].name, 'Persist');
  });

  test('devices do not inherit each other and malformed files stay unchanged', () => {
    const a = stillLibrary.deviceStorageKey({ vendorId: 14391, productId: 12339, serialNumber: 'A' });
    const b = stillLibrary.deviceStorageKey({ vendorId: 14391, productId: 12339, serialNumber: 'B' });
    const created = stillLibrary.createStill([], 'OnlyA', stillLibrary.emptyStillData());
    stillLibrary.writeDeviceItems(file, a, created.items);
    assert.equal(stillLibrary.readDeviceItems(file, b).items.length, 0);
    const before = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, '{not json');
    const bad = stillLibrary.readDeviceItems(file, a);
    assert.equal(bad.ok, false);
    assert.equal(fs.readFileSync(file, 'utf8'), '{not json');
    assert.throws(() => stillLibrary.writeDeviceItems(file, a, created.items));
    assert.equal(fs.readFileSync(file, 'utf8'), '{not json');
    fs.writeFileSync(file, before);
  });

  function seedGood(deviceKey) {
    const created = stillLibrary.createStill([], 'Good', stillLibrary.emptyStillData());
    stillLibrary.writeDeviceItems(file, deviceKey, created.items);
    return created;
  }

  test('partial-invalid item lists fail read-only and a later save leaves the file unchanged', () => {
    const key = stillLibrary.deviceStorageKey({ vendorId: 14391, productId: 12339, serialNumber: 'SN-1' });
    seedGood(key);
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    doc.devices[key].items.push({
      key: 'LightingEffectProfile@still@broken',
      name: 'Broken',
      type: 'localstorage',
      profileIndex: -1,
      data: {
        dataScope: 'LightingEffectProfile',
        type: 'still',
        frames: [{ data: [{ code: 4, selectColor: 'invalid' }] }],
        isPreset: false
      },
      extra: { displayName: 'Broken', lightScopeType: 'main', confirmShareFailed: false }
    });
    fs.writeFileSync(file, JSON.stringify(doc, null, 2));
    const before = fs.readFileSync(file, 'utf8');
    const loaded = stillLibrary.readDeviceItems(file, key);
    assert.equal(loaded.ok, false);
    assert.equal(loaded.unwritable, true);
    assert.equal(loaded.items.length, 0);
    assert.match(loaded.error || '', /selectColor|#RRGGBB/i);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    const valid = stillLibrary.createStill([], 'Good', stillLibrary.emptyStillData());
    assert.throws(() => stillLibrary.writeDeviceItems(file, key, valid.items));
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  });

  test('malformed nested data, duplicate keys, overcapacity, and unknown version are preserved', () => {
    const key = stillLibrary.deviceStorageKey({ vendorId: 14391, productId: 12339, serialNumber: 'SN-1' });
    const cases = [];

    seedGood(key);
    const nested = JSON.parse(fs.readFileSync(file, 'utf8'));
    nested.devices[key].items[0].data.frames = 'nope';
    cases.push({ label: 'nested frames', body: JSON.stringify(nested, null, 2), match: /frames|array/i });

    seedGood(key);
    const dup = JSON.parse(fs.readFileSync(file, 'utf8'));
    const clone = { ...dup.devices[key].items[0], name: 'Other' };
    dup.devices[key].items.push(clone);
    cases.push({ label: 'duplicate keys', body: JSON.stringify(dup, null, 2), match: /duplicate/i });

    seedGood(key);
    const over = JSON.parse(fs.readFileSync(file, 'utf8'));
    const template = over.devices[key].items[0];
    over.devices[key].items = Array.from({ length: 21 }, (_, i) => ({
      ...template,
      key: `${stillLibrary.KEY_PREFIX}${i}`,
      name: i < 10 ? `N${i}` : `Nm${i}`,
      extra: { ...template.extra, displayName: i < 10 ? `N${i}` : `Nm${i}` }
    }));
    cases.push({ label: 'overcapacity', body: JSON.stringify(over, null, 2), match: /20|exceed/i });

    cases.push({
      label: 'unknown version',
      body: JSON.stringify({ version: '9.9.9', devices: {} }),
      match: /version/i
    });

    const validItems = stillLibrary.createStill([], 'Good', stillLibrary.emptyStillData()).items;
    for (const c of cases) {
      fs.writeFileSync(file, c.body);
      const loaded = stillLibrary.readDeviceItems(file, key);
      assert.equal(loaded.ok, false, c.label);
      assert.equal(loaded.unwritable, true, c.label);
      assert.match(loaded.error || '', c.match, c.label);
      assert.equal(fs.readFileSync(file, 'utf8'), c.body, c.label);
      assert.throws(() => stillLibrary.writeDeviceItems(file, key, validItems), c.label);
      assert.equal(fs.readFileSync(file, 'utf8'), c.body, `${c.label} write must not replace the file`);
    }
  });
});

describe('Still library transport (mocked HID, no physical writes)', () => {
  let tmp;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maicong-still-hw-'));
    transport.stillLibraryPath = path.join(tmp, 'still-library.json');
    transport.lightingMemoryPath = path.join(tmp, 'lighting-memory.json');
    transport.disconnect();
  });
  afterEach(() => {
    transport.disconnect();
    transport.stillLibraryPath = null;
    transport.lightingMemoryPath = null;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('create/select writes FUNC custom0, static RGB, and selected name; side stays independent', async () => {
    const mock = new MockGlwMemoryDevice();
    mock.func[8] = 6;
    mock.func[24] = 3;
    attachMock(mock);
    const created = await transport.createStill('Wave');
    assert.equal(created.success, true, created.error);
    const setsBefore = mock.writtenBuffers.filter((b) => b[2] === protocol.COMMANDS.SET_CUSTOM_PARAM).length;
    const select = await transport.selectStill(0, created.key);
    assert.equal(select.success, true, select.error);
    assert.equal(mock.func[8], 6, 'selectStill must not itself write FUNC; renderer autosave owns custom0');
    assert.equal(mock.func[24], 3);
    assert.ok(mock.wroteCommand(protocol.COMMANDS.SET_KEY_COLOR));
    assert.ok(mock.wroteCommand(protocol.COMMANDS.SET_CUSTOM_PARAM));
    const offset = stillLibrary.selectedLightOffset(0);
    const region = mock.custom.subarray(offset, offset + 56);
    assert.deepEqual(stillLibrary.decodeSelectedLightEffect(region).pair, ['still', 'Wave']);
    assert.ok(mock.writtenBuffers.filter((b) => b[2] === protocol.COMMANDS.SET_CUSTOM_PARAM).length > setsBefore);
  });

  test('selectStill coordinates optional FUNC custom0 when requested and preserves side', async () => {
    const mock = new MockGlwMemoryDevice();
    mock.func[8] = 6;
    mock.func[24] = 2;
    attachMock(mock);
    const created = await transport.createStill('Solid');
    const select = await transport.selectStill(0, created.key, { applyCustom0: true });
    assert.equal(select.success, true, select.error);
    assert.equal(mock.func[8], 0);
    assert.equal(mock.func[24], 2);
  });

  test('rename of a still selected on another profile does not replace the editor selected name', async () => {
    const mock = new MockGlwMemoryDevice();
    attachMock(mock);
    transport.editTarget = { profileIndex: 0, layer: null };
    const alpha = await transport.createStill('Alpha');
    const beta = await transport.createStill('Beta');
    const editor = await transport.selectStill(0, beta.key);
    assert.equal(editor.success, true, editor.error);
    assert.deepEqual(transport.lastState.selectedLightEffect, ['still', 'Beta']);
    const other = await transport.selectStill(1, alpha.key);
    assert.equal(other.success, true, other.error);
    assert.deepEqual(transport.lastState.selectedLightEffect, ['still', 'Beta']);
    assert.deepEqual(transport._selectedLightEffectByProfile[1], ['still', 'Alpha']);
    const renamed = await transport.renameStill(alpha.key, 'Gamma');
    assert.equal(renamed.success, true, renamed.error);
    assert.deepEqual(transport.lastState.selectedLightEffect, ['still', 'Beta']);
    assert.deepEqual(renamed.selectedLightEffect, ['still', 'Beta']);
    assert.equal(renamed.stillLibrary.selectedKey, beta.key);
    assert.deepEqual(renamed.stillLibrary.selectedPair, ['still', 'Beta']);
    const p0 = stillLibrary.decodeSelectedLightEffect(mock.custom.subarray(stillLibrary.selectedLightOffset(0), stillLibrary.selectedLightOffset(0) + 56));
    const p1 = stillLibrary.decodeSelectedLightEffect(mock.custom.subarray(stillLibrary.selectedLightOffset(1), stillLibrary.selectedLightOffset(1) + 56));
    assert.deepEqual(p0.pair, ['still', 'Beta']);
    assert.deepEqual(p1.pair, ['still', 'Gamma']);
  });

  test('createStill does not overwrite a corrupt still-library file', async () => {
    const mock = new MockGlwMemoryDevice();
    attachMock(mock);
    const key = transport._lightingDeviceKey();
    const created = stillLibrary.createStill([], 'Good', stillLibrary.emptyStillData());
    stillLibrary.writeDeviceItems(transport.stillLibraryPath, key, created.items);
    const doc = JSON.parse(fs.readFileSync(transport.stillLibraryPath, 'utf8'));
    doc.devices[key].items.push({
      key: 'LightingEffectProfile@still@broken',
      name: 'Broken',
      type: 'localstorage',
      profileIndex: -1,
      data: {
        dataScope: 'LightingEffectProfile',
        type: 'still',
        frames: [{ data: [{ code: 4, selectColor: 'invalid' }] }],
        isPreset: false
      },
      extra: { displayName: 'Broken', lightScopeType: 'main', confirmShareFailed: false }
    });
    const before = JSON.stringify(doc, null, 2);
    fs.writeFileSync(transport.stillLibraryPath, before);
    const res = await transport.createStill('Nope');
    assert.equal(res.success, false);
    assert.match(res.error || '', /selectColor|#RRGGBB/i);
    assert.equal(fs.readFileSync(transport.stillLibraryPath, 'utf8'), before);
  });

  test('rename of the editor still updates the returned snapshot after confirmed relink', async () => {
    const mock = new MockGlwMemoryDevice();
    attachMock(mock);
    const created = await transport.createStill('OldN');
    await transport.selectStill(0, created.key);
    const renamed = await transport.renameStill(created.key, 'NewN');
    assert.equal(renamed.success, true, renamed.error);
    assert.deepEqual(transport.lastState.selectedLightEffect, ['still', 'NewN']);
    assert.deepEqual(renamed.stillLibrary.selectedPair, ['still', 'NewN']);
    assert.equal(renamed.stillLibrary.selectedKey, created.key);
    const p0 = stillLibrary.decodeSelectedLightEffect(mock.custom.subarray(stillLibrary.selectedLightOffset(0), stillLibrary.selectedLightOffset(0) + 56));
    assert.deepEqual(p0.pair, ['still', 'NewN']);
  });

  test('failed CMD242 on rename keeps the confirmed editor selected name', async () => {
    const mock = new MockGlwMemoryDevice();
    attachMock(mock);
    const created = await transport.createStill('OldN');
    await transport.selectStill(0, created.key);
    mock.failCommands.add(protocol.COMMANDS.SET_CUSTOM_PARAM);
    const renamed = await transport.renameStill(created.key, 'NewN');
    mock.failCommands.delete(protocol.COMMANDS.SET_CUSTOM_PARAM);
    assert.equal(renamed.success, false);
    assert.equal(renamed.localSaved, true);
    assert.deepEqual(transport.lastState.selectedLightEffect, ['still', 'OldN']);
    assert.deepEqual(renamed.selectedLightEffect, ['still', 'OldN']);
    const p0 = stillLibrary.decodeSelectedLightEffect(mock.custom.subarray(stillLibrary.selectedLightOffset(0), stillLibrary.selectedLightOffset(0) + 56));
    assert.deepEqual(p0.pair, ['still', 'OldN']);
    const disk = stillLibrary.readDeviceItems(transport.stillLibraryPath, transport._lightingDeviceKey());
    assert.equal(disk.items[0].name, 'NewN');
  });

  test('confirmed delete of the selected still retargets the neighbor name on the editor profile', async () => {
    const mock = new MockGlwMemoryDevice();
    attachMock(mock);
    const a = await transport.createStill('DelA');
    const b = await transport.createStill('DelB');
    await transport.selectStill(0, b.key);
    const removed = await transport.deleteStill(b.key, { activeKey: b.key, profileIndex: 0 });
    assert.equal(removed.success, true, removed.error);
    assert.equal(removed.localSaved, true);
    assert.equal(removed.deviceUpdated, true);
    assert.equal(removed.replacement && removed.replacement.name, 'DelA');
    assert.deepEqual(transport.lastState.selectedLightEffect, ['still', 'DelA']);
    assert.deepEqual(removed.selectedLightEffect, ['still', 'DelA']);
    const pair = stillLibrary.decodeSelectedLightEffect(
      mock.custom.subarray(stillLibrary.selectedLightOffset(0), stillLibrary.selectedLightOffset(0) + 56)
    ).pair;
    assert.equal(pair[1], 'DelA');
  });

  test('failed CMD242 on delete keeps the confirmed editor selected name', async () => {
    const mock = new MockGlwMemoryDevice();
    attachMock(mock);
    const a = await transport.createStill('KeepA');
    const b = await transport.createStill('GoneB');
    await transport.selectStill(0, b.key);
    assert.deepEqual(transport.lastState.selectedLightEffect, ['still', 'GoneB']);
    mock.failCommands.add(protocol.COMMANDS.SET_CUSTOM_PARAM);
    const removed = await transport.deleteStill(b.key, { activeKey: b.key, profileIndex: 0 });
    mock.failCommands.delete(protocol.COMMANDS.SET_CUSTOM_PARAM);
    assert.equal(removed.success, false);
    assert.equal(removed.localSaved, true);
    assert.equal(removed.deviceUpdated, false);
    assert.deepEqual(transport.lastState.selectedLightEffect, ['still', 'GoneB']);
    assert.deepEqual(removed.selectedLightEffect, ['still', 'GoneB']);
    const pair = stillLibrary.decodeSelectedLightEffect(
      mock.custom.subarray(stillLibrary.selectedLightOffset(0), stillLibrary.selectedLightOffset(0) + 56)
    ).pair;
    assert.equal(pair[1], 'GoneB');
    const disk = stillLibrary.readDeviceItems(transport.stillLibraryPath, transport._lightingDeviceKey());
    assert.equal(disk.ok, true);
    assert.equal(disk.items.some((item) => item.name === 'GoneB'), false);
    assert.equal(disk.items.some((item) => item.name === 'KeepA'), true);
    assert.ok(a.key);
  });

  test('reset epoch bump during selected-name readback does not commit editor cache', async () => {
    const mock = new MockGlwMemoryDevice();
    attachMock(mock);
    const created = await transport.createStill('Race');
    assert.deepEqual(transport.lastState.selectedLightEffect, ['still', '']);
    mock.delayCommands.set(protocol.COMMANDS.GET_CUSTOM_PARAM, 400);
    const pending = transport.selectStill(0, created.key);
    await sleep(150);
    assert.deepEqual(transport.lastState.selectedLightEffect, ['still', '']);
    transport.resetEpoch += 1;
    const res = await pending;
    mock.delayCommands.delete(protocol.COMMANDS.GET_CUSTOM_PARAM);
    assert.equal(res.success, false);
    assert.deepEqual(transport.lastState.selectedLightEffect, ['still', '']);
    assert.equal(transport._selectedLightEffectByProfile[0], undefined);
  });

  test('disconnect after selectStill has started does not publish a selected still name', async () => {
    const mock = new MockGlwMemoryDevice();
    attachMock(mock);
    const created = await transport.createStill('Disc');
    mock.delayCommands.set(protocol.COMMANDS.SET_KEY_COLOR, 300);
    const pending = transport.selectStill(0, created.key);
    await sleep(40);
    transport.disconnect();
    const res = await pending;
    mock.delayCommands.delete(protocol.COMMANDS.SET_KEY_COLOR);
    assert.equal(res.success, false);
    assert.deepEqual(transport.lastState.selectedLightEffect, ['still', '']);
  });

  test('readFuncConfig reads selected name and does not write', async () => {
    const mock = new MockGlwMemoryDevice();
    const encoded = stillLibrary.encodeSelectedLightEffect(['still', 'OnDev']);
    encoded.buffer.copy(mock.custom, stillLibrary.selectedLightOffset(0));
    attachMock(mock);
    const beforeSets = mock.writtenBuffers.filter((b) => b[2] === protocol.COMMANDS.SET_CUSTOM_PARAM).length;
    const read = await transport.readFuncConfig(0);
    assert.equal(read.success, true, read.error);
    assert.deepEqual(read.selectedLightEffect, ['still', 'OnDev']);
    assert.equal(mock.writtenBuffers.filter((b) => b[2] === protocol.COMMANDS.SET_CUSTOM_PARAM).length, beforeSets);
  });

  test('still color update after 300ms helper writes frames with aliases and can be cancelled by key', async () => {
    const mock = new MockGlwMemoryDevice();
    attachMock(mock);
    const created = await transport.createStill('Paint');
    const colors = { 45: '#ABCDEF', 61: '#123456' };
    const updated = await transport.updateStillFrames(created.key, colors, { profileIndex: 0, applyDevice: true });
    assert.equal(updated.success, true, updated.error);
    const frame = updated.item.data.frames[0].data;
    const byCode = new Map(frame.map((e) => [e.code, e.selectColor]));
    assert.equal(byCode.get(301), '#ABCDEF');
    assert.equal(byCode.get(302), '#123456');
    const stale = await transport.updateStillFrames('LightingEffectProfile@still@missing', colors, {
      profileIndex: 0,
      expectedKey: created.key
    });
    assert.equal(stale.success, false);
  });

  test('queryStatus / connect path does not write still library or selected name', async () => {
    const mock = new MockGlwMemoryDevice();
    attachMock(mock);
    await transport.queryStatus();
    assert.equal(mock.wroteCommand(protocol.COMMANDS.SET_CUSTOM_PARAM), false);
    assert.equal(mock.wroteCommand(protocol.COMMANDS.SET_FUNC_CONFIG), false);
    assert.equal(mock.wroteCommand(protocol.COMMANDS.SET_KEY_COLOR), false);
  });
});
