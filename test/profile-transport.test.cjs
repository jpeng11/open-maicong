const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const protocol = require('../src/protocol.cjs');
const transport = require('../src/transport.cjs');
const profileNames = require('../src/profile-names.cjs');
const official = require('./fixtures/official-keyboard-profile-v3.json');
const tokenNames = require('./fixtures/profile-names-i18n-default-onboard.json');
const officialAdvanced = require('./fixtures/official-keyboard-profile-v3-advanced-mt-tgl.json');
const { MockGlwMemoryDevice } = require('./mock-glw-memory.cjs');
const library = require('../src/profile-library.cjs');

function attachMock(mock, serial = 'PROF-A') {
  transport.installTestAdapter(mock, { product: 'MCHOSE G75 V2 2.4G' });
  transport.lastState.device.serialNumber = serial;
  transport.lastState.device.productName = 'MCHOSE G75 V2 2.4G';
  transport.lastState.device.path = `mock://g75v2/${serial}`;
}

describe('profile library hardware path (mock HID only)', () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maicong-prof-'));
    transport.profileLibraryPath = path.join(tmpDir, 'profile-library.json');
    transport.stillLibraryPath = path.join(tmpDir, 'still.json');
    transport.gifLibraryPath = path.join(tmpDir, 'gif.json');
    transport.lightingMemoryPath = path.join(tmpDir, 'lightmem.json');
  });
  afterEach(() => {
    transport.disconnect();
    transport.profileLibraryPath = null;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  test('stored i18n tokens display as Default Onboard and are not written on query', async () => {
    const mock = new MockGlwMemoryDevice();
    const seeded = profileNames.seedDeviceProfileNames(mock, tokenNames.stored);
    assert.equal(seeded.valid, true, seeded.error);
    attachMock(mock);
    mock.writtenBuffers.length = 0;
    await transport.queryStatus();
    const writes = mock.writtenBuffers.filter((b) => b[2] === protocol.COMMANDS.SET_CUSTOM_PARAM);
    assert.equal(writes.length, 0, 'query must not rewrite stored name tokens');
    assert.deepEqual(transport.lastState.profileNamesStored.slice(0, 3), tokenNames.stored.slice(0, 3));
    assert.deepEqual(transport.lastState.profileNames.slice(0, 3), ['Default Onboard', 'Default Onboard2', 'Default Onboard3']);
    const copied = await transport.copyOnboardToLocal(1);
    assert.equal(copied.success, true, copied.error);
    assert.equal(copied.item.name.includes('i18n<'), false);
    assert.equal(copied.item.extra.storedName, 'i18n<defaultOnboard>2');
    assert.equal(copied.item.extra.displayName, 'Default Onboard2');
    const created = await transport.createLocalProfile('XY');
    const move = await transport.moveLocalToOnboard(created.key, 'KeyboardProfile@keyboard@1', { activate: false });
    assert.equal(move.success, true, move.error);
    const after = profileNames.decodeProfileNames(mock.custom.subarray(profileNames.namesOffset(0), profileNames.namesOffset(0) + 280));
    assert.equal(after.stored[0], 'i18n<defaultOnboard>');
    assert.equal(after.stored[1], 'XY');
    assert.equal(after.stored[2], 'i18n<defaultOnboard>3');
  });

  test('queryStatus reads names and does not write missing names', async () => {
    const mock = new MockGlwMemoryDevice();
    attachMock(mock);
    mock.writtenBuffers.length = 0;
    await transport.queryStatus();
    const writes = mock.writtenBuffers.filter((b) => b[2] === protocol.COMMANDS.SET_CUSTOM_PARAM);
    assert.equal(writes.length, 0, 'connect/query must not initialize names');
    assert.equal(transport.lastState.profileNames[0], 'Default Onboard');
    assert.equal(transport.lastState.profileNamesSource, 'default');
  });

  test('copy of default slots 0-3 yields unique 2..15 local names and keeps originals', async () => {
    const mock = new MockGlwMemoryDevice();
    attachMock(mock);
    await transport.queryStatus();
    const originals = [];
    const localNames = [];
    for (let slot = 0; slot < 4; slot++) {
      originals.push(transport.lastState.profileNames[slot]);
      const copied = await transport.copyOnboardToLocal(slot);
      assert.equal(copied.success, true, copied.error || `slot ${slot}`);
      assert.equal(copied.hardwareWrites, 0);
      assert.ok(copied.item.name.length >= 2 && copied.item.name.length <= 15, copied.item.name);
      localNames.push(copied.item.name);
      if (originals[slot].length > 15) {
        assert.equal(copied.item.extra.displayName, originals[slot]);
      }
    }
    assert.equal(new Set(localNames).size, 4);
    assert.deepEqual(transport.lastState.profileNames.slice(0, 4), originals);
  });

  test('copy onboard to local stores the hardware snapshot even when sideEffect is 0', async () => {
    const mock = new MockGlwMemoryDevice();
    mock.func[24] = 0;
    attachMock(mock);
    await transport.queryStatus();
    const copied = await transport.copyOnboardToLocal(0);
    assert.equal(copied.success, true, copied.error);
    assert.equal(copied.hardwareWrites, 0);
    assert.equal(copied.item.data.lighting.sideEffect, 0);
    assert.equal(copied.item.data.lighting.effect, mock.func[8]);
  });

  test('copy onboard to local stores unknown hardware sideEffect 9 and main effect 99', async () => {
    const mock = new MockGlwMemoryDevice();
    mock.func[8] = 99;
    mock.func[24] = 9;
    attachMock(mock);
    await transport.queryStatus();
    const copied = await transport.copyOnboardToLocal(0);
    assert.equal(copied.success, true, copied.error);
    assert.equal(copied.hardwareWrites, 0);
    assert.equal(copied.item.data.lighting.sideEffect, 9);
    assert.equal(copied.item.data.lighting.effect, 99);
  });

  test('local create and official import write no HID', async () => {
    const mock = new MockGlwMemoryDevice();
    attachMock(mock);
    await transport.queryStatus();
    mock.writtenBuffers.length = 0;
    const created = await transport.createLocalProfile('AB');
    assert.equal(created.success, true, created.error);
    assert.equal(created.hardwareWrites, 0);
    const imported = await transport.importOfficialProfile(official);
    assert.equal(imported.success, true, imported.error);
    assert.equal(imported.hardwareWrites, 0);
    assert.equal(mock.writtenBuffers.length, 0);
    const preview = transport.loadLocalProfilePreview(imported.key);
    assert.equal(preview.success, true);
    assert.equal(preview.hardwareWrites, 0);
    const draft = await transport.saveLocalProfileDraft(imported.key, preview.item.data);
    assert.equal(draft.success, true);
    assert.equal(draft.hardwareWrites, 0);
    assert.equal(mock.writtenBuffers.length, 0);
  });

  test('local draft save retries once on a rev conflict and preserves the concurrent write', async () => {
    const mock = new MockGlwMemoryDevice();
    attachMock(mock);
    await transport.queryStatus();
    const created = await transport.createLocalProfile('AB');
    assert.equal(created.success, true, created.error);

    const origWrite = library.writeDevice;
    let calls = 0;
    library.writeDevice = function (...args) {
      calls++;
      if (calls === 1) {
        // A concurrent actor commits between this transport's read and write
        const [file, deviceKey] = args;
        const fresh = library.readDevice(file, deviceKey);
        const concurrent = library.createFromDefaults(fresh.items, 'Concurrent', 4);
        origWrite(file, deviceKey, concurrent.items, { expectedRev: fresh.rev });
        const conflict = new Error('Profile library changed on disk since it was read');
        conflict.code = 'REV_MISMATCH';
        throw conflict;
      }
      return origWrite.apply(this, args);
    };
    try {
      const preview = transport.loadLocalProfilePreview(created.key);
      const draft = await transport.saveLocalProfileDraft(created.key, preview.item.data);
      assert.equal(draft.success, true, draft.error);
      assert.equal(calls, 2, 'first write conflicts, the retry re-reads and succeeds');
    } finally {
      library.writeDevice = origWrite;
    }
    const loaded = library.readDevice(transport.profileLibraryPath, library.deviceStorageKey(transport.lastState.device));
    assert.ok(loaded.items.some((i) => i.name === 'Concurrent'), 'concurrent save must survive');
    assert.ok(loaded.items.some((i) => i.key === created.key), 'draft target must survive');
  });

  test('autosave landing during moveLocalToOnboard is preserved by the conflict merge', async () => {
    const mock = new MockGlwMemoryDevice();
    attachMock(mock);
    await transport.queryStatus();
    const keep = await transport.createLocalProfile('Keep');
    const moving = await transport.createLocalProfile('Move');
    assert.equal(keep.success, true, keep.error);
    assert.equal(moving.success, true, moving.error);

    mock.delayCommands.set(protocol.COMMANDS.SET_FUNC_CONFIG, 80);
    const pending = transport.moveLocalToOnboard(moving.key, 'KeyboardProfile@keyboard@1', { activate: false });
    await new Promise((r) => setTimeout(r, 20));
    const preview = transport.loadLocalProfilePreview(keep.key);
    const autosaved = await transport.saveLocalProfileDraft(keep.key, preview.item.data);
    assert.equal(autosaved.success, true, autosaved.error);
    const res = await pending;
    assert.equal(res.success, true, res.error);

    const loaded = library.readDevice(transport.profileLibraryPath, library.deviceStorageKey(transport.lastState.device));
    assert.ok(loaded.items.some((i) => i.key === keep.key), 'autosaved profile must survive the move');
    assert.ok(loaded.items.every((i) => i.key !== moving.key), 'moved profile must leave local storage');
    assert.equal(loaded.items.length, 2, 'parked outgoing profile replaces the moved one');
  });

  test('local save during outgoing export of moveLocalToOnboard survives persist', async () => {
    const mock = new MockGlwMemoryDevice();
    attachMock(mock);
    await transport.queryStatus();
    const keep = await transport.createLocalProfile('Keep');
    const moving = await transport.createLocalProfile('Move');
    assert.equal(keep.success, true, keep.error);
    assert.equal(moving.success, true, moving.error);

    mock.delayCommands.set(protocol.COMMANDS.GET_FUNC_CONFIG, 80);
    const pending = transport.moveLocalToOnboard(moving.key, 'KeyboardProfile@keyboard@1', { activate: false });
    await new Promise((r) => setTimeout(r, 20));
    const concurrent = await transport.createLocalProfile('Concurrent');
    assert.equal(concurrent.success, true, concurrent.error);
    const res = await pending;
    assert.equal(res.success, true, res.error);

    const loaded = library.readDevice(transport.profileLibraryPath, library.deviceStorageKey(transport.lastState.device));
    assert.ok(loaded.items.some((i) => i.key === keep.key), 'unrelated local profile must survive');
    assert.ok(loaded.items.some((i) => i.key === concurrent.key), 'save that landed during exportProfile must survive');
    assert.ok(loaded.items.every((i) => i.key !== moving.key), 'moved profile must leave local storage');
    assert.ok(loaded.items.some((i) => i.name && i.name !== 'Keep' && i.name !== 'Concurrent'), 'outgoing onboard snapshot must be parked');
  });

  test('copy, delete, and onboard reorder still persist through the hardware plan', async () => {
    const mock = new MockGlwMemoryDevice();
    attachMock(mock);
    await transport.queryStatus();
    const local = await transport.createLocalProfile('Stay');
    assert.equal(local.success, true, local.error);

    const copied = await transport.copyOnboardToOnboard(
      'KeyboardProfile@keyboard@0',
      'KeyboardProfile@keyboard@2',
      { activate: false }
    );
    assert.equal(copied.success, true, copied.error);
    let loaded = library.readDevice(transport.profileLibraryPath, library.deviceStorageKey(transport.lastState.device));
    assert.ok(loaded.items.some((i) => i.key === local.key), 'local profile must survive onboard copy');
    assert.ok(loaded.items.some((i) => i.extra && i.extra.displayName), 'replaced onboard slot must be parked locally');

    const beforeDelete = transport.getProfileLibrary();
    const onboardBefore = (beforeDelete.list || []).filter((i) => i.type === 'keyboard');
    const toDelete = onboardBefore.find((i) => i.profileIndex !== transport.lastState.activeProfileIndex);
    assert.ok(toDelete, 'need a non-active onboard slot to delete');
    const deleted = await transport.deleteOnboardProfile(toDelete.key);
    assert.equal(deleted.success, true, deleted.error);
    assert.equal(transport.lastState.base.profileCount, onboardBefore.length - 1);

    const snap = transport.getProfileLibrary();
    const onboardKeys = (snap.list || []).filter((i) => i.type === 'keyboard').map((i) => i.key);
    const localKeys = (snap.list || []).filter((i) => i.type === 'localstorage').map((i) => i.key);
    const reordered = await transport.reorderProfiles([...onboardKeys.slice().reverse(), ...localKeys]);
    assert.equal(reordered.success, true, reordered.error);
    loaded = library.readDevice(transport.profileLibraryPath, library.deviceStorageKey(transport.lastState.device));
    assert.ok(loaded.items.some((i) => i.key === local.key), 'local profile must survive onboard reorder');
    assert.deepEqual(
      (transport.lastState.base.profileOrder || []).slice(0, transport.lastState.base.profileCount),
      onboardKeys.slice().reverse().map((key) => Number(key.split('@').pop()))
    );
  });

  test('failed name replication reports partial slots and does not claim all names', async () => {
    const mock = new MockGlwMemoryDevice();
    attachMock(mock);
    await transport.queryStatus();
    mock.failWriteOffsets.add(profileNames.namesOffset(2));
    const res = await transport.renameProfile({
      kind: 'keyboard',
      profileIndex: 0,
      key: 'KeyboardProfile@keyboard@0',
      name: 'HomeBoard'
    });
    assert.equal(res.success, false);
    assert.ok(Array.isArray(res.written));
    assert.ok(res.written.includes(0) || res.written.includes(1) || res.partial);
    assert.equal(res.written.includes(3), false);
    assert.match(res.error, /slot 2|physical slot 2|Confirmed slots/i);
  });

  test('tE saves outgoing locally before a failed profile write and keeps recovery', async () => {
    const mock = new MockGlwMemoryDevice();
    attachMock(mock);
    await transport.queryStatus();
    const created = await transport.createLocalProfile('XY');
    assert.equal(created.success, true, created.error);
    mock.failCommands.add(protocol.COMMANDS.SET_FUNC_CONFIG);
    const move = await transport.moveLocalToOnboard(created.key, 'KeyboardProfile@keyboard@0', { activate: false });
    assert.equal(move.success, false);
    assert.equal(move.hardwareRollback, false);
    assert.equal(move.recoveryRetained, true);
    const loaded = require('../src/profile-library.cjs').readDevice(
      transport.profileLibraryPath,
      require('../src/profile-library.cjs').deviceStorageKey(transport.lastState.device)
    );
    assert.ok(loaded.recovery && loaded.recovery.length >= 1);
  });

  test('malformed official file is rejected with zero writes', async () => {
    const mock = new MockGlwMemoryDevice();
    attachMock(mock);
    await transport.queryStatus();
    mock.writtenBuffers.length = 0;
    const res = await transport.importOfficialProfile({ version: 9, data: { nope: true } });
    assert.equal(res.success, false);
    assert.equal(mock.writtenBuffers.length, 0);
  });

  test('disconnect during local-to-onboard does not continue writes', async () => {
    const mock = new MockGlwMemoryDevice();
    attachMock(mock);
    await transport.queryStatus();
    const created = await transport.createLocalProfile('ZZ');
    mock.delayCommands.set(protocol.COMMANDS.SET_FUNC_CONFIG, 80);
    const pending = transport.moveLocalToOnboard(created.key, 'KeyboardProfile@keyboard@1', { activate: false });
    await new Promise((r) => setTimeout(r, 20));
    transport.disconnect();
    const res = await pending;
    assert.equal(res.success, false);
  });

  test('nontrivial order free-slot tE writes order[length]', async () => {
    const mock = new MockGlwMemoryDevice();
    mock.base[0] = 0;
    mock.base[1] = 3;
    mock.base[2] = 2;
    mock.base[3] = 0;
    mock.base[4] = 1;
    mock.base[5] = 3;
    attachMock(mock);
    await transport.queryStatus();
    const created = await transport.createLocalProfile('QK');
    const move = await transport.moveLocalToOnboard(created.key, null, { activate: true });
    assert.equal(move.success, true, move.error);
    const parsed = protocol.parseBase(mock.base);
    assert.equal(parsed.profileCount, 4);
    assert.equal(parsed.profileOrder[3], 3);
  });

  test('moving the last onboard profile is refused', async () => {
    const mock = new MockGlwMemoryDevice();
    mock.base[0] = 0;
    mock.base[1] = 1;
    mock.base[2] = 0;
    mock.base[3] = 1;
    mock.base[4] = 2;
    mock.base[5] = 3;
    attachMock(mock);
    await transport.queryStatus();
    const res = await transport.moveOnboardToLocal('KeyboardProfile@keyboard@0');
    assert.equal(res.success, false);
  });

  test('unsolicited reset during name replication does not claim success', async () => {
    const mock = new MockGlwMemoryDevice();
    attachMock(mock);
    await transport.queryStatus();
    mock.delayCommands.set(protocol.COMMANDS.SET_CUSTOM_PARAM, 80);
    const pending = transport.renameProfile({
      kind: 'keyboard',
      profileIndex: 0,
      key: 'KeyboardProfile@keyboard@0',
      name: 'ResetName'
    });
    await new Promise((r) => setTimeout(r, 20));
    const a2 = Buffer.alloc(64, 0);
    a2[0] = 0xA2;
    mock.emit('data', a2);
    const res = await pending;
    assert.equal(res.success, false);
    mock.delayCommands.delete(protocol.COMMANDS.SET_CUSTOM_PARAM);
  });

  test('imported official MT/TGL become native tables and onboard export serializes them', async () => {
    const mock = new MockGlwMemoryDevice();
    mock.mt[512] = 0xAB;
    mock.mt[513] = 0xCD;
    mock.tgl[256] = 0xEF;
    attachMock(mock);
    await transport.queryStatus();
    const imported = await transport.importOfficialProfile(officialAdvanced);
    assert.equal(imported.success, true, imported.error);
    assert.equal(imported.hardwareWrites, 0);
    assert.equal(imported.item.data.officialAdvanced, undefined);
    assert.ok(imported.item.data.advanced);
    assert.equal(imported.item.data.macros[0].name, 'Burst');
    assert.equal(imported.item.data.macroMetadata.slots[2].defaultDelay, 50);
    const localExport = await transport.exportOfficialProfile({ key: imported.key });
    assert.equal(localExport.success, true, localExport.error);
    assert.deepEqual(localExport.data.data.advancedKeys.mt[3].clickKey, { type: 16, code1: 0, code2: 4 });
    assert.deepEqual(localExport.data.data.advancedKeys.tgl[1], { type: 16, code1: 0, code2: 41 });
    const writesBefore = mock.writtenBuffers.length;
    const move = await transport.moveLocalToOnboard(imported.key, 'KeyboardProfile@keyboard@0', { activate: false });
    assert.equal(move.success, true, move.error);
    assert.ok(mock.writtenBuffers.length > writesBefore);
    assert.deepEqual(mock.mtEntry(0, 3), { tap: [16, 0, 4], hold: [16, 2, 0] });
    assert.deepEqual(
      [mock.tgl[3], mock.tgl[4], mock.tgl[5]],
      [16, 0, 41]
    );
    assert.deepEqual(mock.readUserKey(0, 0, 11), [146, 3, 20]);
    assert.deepEqual(mock.readUserKey(0, 0, 19), [146, 3, 20]);
    assert.deepEqual(mock.readUserKey(0, 0, 27), [145, 1, 0]);
    assert.equal(mock.mt[512], 0xAB);
    assert.equal(mock.mt[513], 0xCD);
    assert.equal(mock.tgl[256], 0xEF);
    const onboardExport = await transport.exportOfficialProfile({ profileIndex: 0 });
    assert.equal(onboardExport.success, true, onboardExport.error);
    assert.deepEqual(onboardExport.data.data.advancedKeys.mt[3].downKey, { type: 16, code1: 2, code2: 0 });
    assert.equal(onboardExport.data.data.advancedKeys.tgl[1].code2, 41);
    assert.equal(onboardExport.data.data.advancedKeys.dks.length, 0);
  });

  test('tE tI tk recovery keeps outgoing snapshots and valid local names for default slots', async () => {
    const mock = new MockGlwMemoryDevice();
    attachMock(mock);
    await transport.queryStatus();
    const originals = transport.lastState.profileNames.slice();

    for (const slot of [1, 2]) {
      const created = await transport.createLocalProfile('XY');
      assert.equal(created.success, true, created.error);
      mock.failCommands.add(protocol.COMMANDS.SET_FUNC_CONFIG);
      const move = await transport.moveLocalToOnboard(created.key, `KeyboardProfile@keyboard@${slot}`, { activate: false });
      assert.equal(move.success, false, `tE slot ${slot} should fail closed`);
      assert.equal(move.recoveryRetained, true);
      const loaded = library.readDevice(
        transport.profileLibraryPath,
        library.deviceStorageKey(transport.lastState.device)
      );
      assert.ok(loaded.recovery && loaded.recovery.length >= 1);
      const recovered = loaded.recovery[0].item;
      assert.ok(recovered.name.length >= 2 && recovered.name.length <= 15, recovered.name);
      assert.equal(recovered.extra.displayName, originals[slot]);
      assert.ok(recovered.data && recovered.data.lighting);
      assert.ok(recovered.data.advanced);
      mock.failCommands.delete(protocol.COMMANDS.SET_FUNC_CONFIG);
    }

    mock.failCommands.add(protocol.COMMANDS.SET_FUNC_CONFIG);
    const copied = await transport.copyOnboardToOnboard('KeyboardProfile@keyboard@0', 'KeyboardProfile@keyboard@2', { activate: false });
    assert.equal(copied.success, false);
    assert.equal(copied.recoveryRetained, true);
    let loaded = library.readDevice(
      transport.profileLibraryPath,
      library.deviceStorageKey(transport.lastState.device)
    );
    const tI = loaded.recovery[0].item;
    assert.ok(tI.name.length >= 2 && tI.name.length <= 15, tI.name);
    assert.equal(tI.extra.displayName, originals[2]);
    assert.ok(tI.data && tI.data.settings);
    mock.failCommands.delete(protocol.COMMANDS.SET_FUNC_CONFIG);

    mock.failCommands.add(protocol.COMMANDS.SET_BASE);
    const moved = await transport.moveOnboardToLocal('KeyboardProfile@keyboard@1');
    assert.equal(moved.success, false);
    assert.equal(moved.recoveryRetained, true);
    loaded = library.readDevice(
      transport.profileLibraryPath,
      library.deviceStorageKey(transport.lastState.device)
    );
    const tk = loaded.recovery[0].item;
    assert.ok(tk.name.length >= 2 && tk.name.length <= 15, tk.name);
    assert.equal(tk.extra.displayName, originals[1]);
    assert.ok(tk.data && tk.data.layers);
  });

  test('failed profile write recovery retains native advanced from the outgoing onboard snapshot', async () => {
    const mock = new MockGlwMemoryDevice();
    mock.mt[0] = 16;
    mock.mt[1] = 0;
    mock.mt[2] = 4;
    mock.mt[3] = 16;
    mock.mt[4] = 2;
    mock.mt[5] = 0;
    attachMock(mock);
    await transport.queryStatus();
    const created = await transport.createLocalProfile('XY');
    assert.equal(created.success, true, created.error);
    mock.failCommands.add(protocol.COMMANDS.SET_FUNC_CONFIG);
    const move = await transport.moveLocalToOnboard(created.key, 'KeyboardProfile@keyboard@0', { activate: false });
    assert.equal(move.success, false);
    assert.equal(move.hardwareRollback, false);
    assert.equal(move.recoveryRetained, true);
    const loaded = library.readDevice(
      transport.profileLibraryPath,
      library.deviceStorageKey(transport.lastState.device)
    );
    assert.ok(loaded.recovery && loaded.recovery.length >= 1);
    const recovered = loaded.recovery[0].item.data;
    assert.ok(recovered.advanced);
    assert.match(recovered.advanced.mt, /^100004100200/i);
  });

  test('mutateBaseConfig preserves marker bytes and encodes nontrivial order', () => {
    const buf = Buffer.alloc(56, 7);
    buf[0] = 0;
    buf[1] = 3;
    buf[2] = 0;
    buf[3] = 1;
    buf[4] = 2;
    buf[5] = 3;
    const out = protocol.mutateBaseConfig(buf, { profileCount: 4, profileOrder: [2, 0, 1, 3], activeProfile: 2 });
    assert.equal(out[0], 0);
    assert.equal(out[1], 4);
    assert.deepEqual([out[2], out[3], out[4], out[5]], [2, 0, 1, 3]);
    assert.equal(out[6], 7);
  });
});
