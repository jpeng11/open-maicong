const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const keys = require('../src/profile-keys.cjs');
const protocol = require('../src/protocol.cjs');
const profileFile = require('../src/profile-file.cjs');
const official = require('./fixtures/official-keyboard-profile-v3.json');
const officialAdvanced = require('./fixtures/official-keyboard-profile-v3-advanced-mt-tgl.json');

describe('portable key identities from factory layer0', () => {
  test('HID4 at slot 11 is 0x100004, Fn is fn-key, side placeholders are relative', () => {
    const lookup = keys.buildLookup(0);
    const hid4 = lookup.bySlot[11];
    assert.ok(hid4);
    assert.equal(hid4.storageKeyByte, '0x100004');
    assert.equal(hid4.occurrence, 0);
    assert.equal(lookup.bySlot[85].storageKeyByte, 'fn-key');
    const side0 = lookup.bySlot[113];
    assert.equal(side0.storageKeyByte, 'side-light-key:relative@0');
    assert.equal(lookup.bySlot[114].storageKeyByte, 'side-light-key:relative@1');
    assert.equal(keys.packKey(16, 0, 4), 0x100004);
  });

  test('independent dataV2 fixture remaps A (HID4) to B (HID5) at factory occurrence 0', () => {
    const layer = keys.decodeLayerDiff(official.data.userKeys[0], 0);
    assert.equal(layer['11'].code2, 5);
    assert.equal(layer['11'].type, 16);
    const fn = layer['85'];
    assert.equal(fn.type, 240);
    assert.equal(fn.code1, 255);
  });

  test('space aliases 301/302 resolve to slots 45 and 61', () => {
    const layer = keys.decodeLayerDiff({
      type: 'diff-keys',
      dataV2: {
        'code:301': [{ type: 16, code1: 0, code2: 44 }],
        'code:302': [{ type: 16, code1: 0, code2: 44 }]
      }
    }, 0);
    assert.equal(layer['45'].code2, 44);
    assert.equal(layer['61'].code2, 44);
  });
});

describe('official KeyboardProfile envelope', () => {
  test('version 3 wired G75 imports to native lighting and layers without guessing', () => {
    const inspected = profileFile.inspectOfficialEnvelope(official);
    assert.equal(inspected.valid, true, inspected.error);
    assert.equal(inspected.identity.modelType, 133);
    assert.equal(inspected.native.lighting.effect, 3);
    assert.equal(inspected.native.lighting.hexColor, '#112233');
    assert.equal(inspected.native.layers['0']['11'].code2, 5);
    assert.equal(inspected.native.macros[0].actions[0].code, 4);
    assert.equal(inspected.native.macros[0].actions[0].delay, 10);
  });

  test('receiver 3033 requires G75 product name; ambiguous receiver is rejected', () => {
    const ok = profileFile.resolveG75Model(14391, 12339, 'MCHOSE G75 V2 2.4G');
    assert.equal(ok.ok, true);
    const ambiguous = profileFile.resolveG75Model(14391, 12339, 'MCHOSE K99 2.4G');
    assert.equal(ambiguous.ok, false);
    const missing = profileFile.resolveG75Model(14391, 12339, '');
    assert.equal(missing.ok, false);
    const hexTrap = profileFile.resolveG75Model('3837', '3033', 'MCHOSE G75 V2 2.4G');
    assert.equal(hexTrap.ok, false);
  });

  test('unsupported schemas fail explicitly', () => {
    assert.equal(profileFile.inspectOfficialEnvelope({ version: 1, data: {} }).valid, false);
    assert.equal(profileFile.inspectOfficialEnvelope({ foo: 1 }).valid, false);
    const qhw = { ...official, dataScope: 'SomethingElse' };
    assert.equal(profileFile.inspectOfficialEnvelope(qhw).valid, false);
  });

  test('literal macro records match traced decoder examples', () => {
    const fromLiteral = profileFile.officialActionsToNative([
      { type: 'action', action: 'keydown', code: 4 },
      { type: 'time', delay: 10 }
    ]);
    assert.equal(fromLiteral.valid, true);
    assert.deepEqual(fromLiteral.actions[0], { action: 'keydown', code: 4, delay: 10 });
    const officialized = profileFile.nativeActionsToOfficial([{ action: 'keydown', code: 4, delay: 10 }]);
    assert.deepEqual(officialized[0], { type: 'action', action: 'keydown', code: 4 });
    assert.deepEqual(officialized[1], { type: 'time', delay: 10 });
    const endUp = profileFile.nativeActionsToOfficial([{ action: 'keyup', code: 4, delay: 4 }]);
    assert.equal(endUp.some((r) => r.type === 'time'), false);
  });

  test('malformed macro records are rejected instead of becoming empty', () => {
    const bad = profileFile.officialActionsToNative([{ type: 'action', action: 'teleport', code: 4 }]);
    assert.equal(bad.valid, false);
  });

  test('consecutive and leading official times become standalone zero-code delays', () => {
    const consecutive = profileFile.officialActionsToNative([
      { type: 'action', action: 'keydown', code: 4 },
      { type: 'time', delay: 10 },
      { type: 'time', delay: 20 },
      { type: 'action', action: 'keyup', code: 4 }
    ]);
    assert.equal(consecutive.valid, true);
    assert.deepEqual(consecutive.actions, [
      { action: 'keydown', code: 4, delay: 10 },
      { action: 'keyup', code: 0, delay: 20 },
      { action: 'keyup', code: 4, delay: 0 }
    ]);
    const leading = profileFile.officialActionsToNative([
      { type: 'time', delay: 10 },
      { type: 'time', delay: 20 },
      { type: 'action', action: 'keydown', code: 4 }
    ]);
    assert.deepEqual(leading.actions, [
      { action: 'keyup', code: 0, delay: 10 },
      { action: 'keyup', code: 0, delay: 20 },
      { action: 'keydown', code: 4, delay: 0 }
    ]);
    const exported = profileFile.nativeActionsToOfficial(consecutive.actions);
    assert.deepEqual(exported, [
      { type: 'action', action: 'keydown', code: 4 },
      { type: 'time', delay: 10 },
      { type: 'time', delay: 20 },
      { type: 'action', action: 'keyup', code: 4 }
    ]);
  });

  test('malformed nested official performance and light are rejected instead of becoming defaults', () => {
    const inspected = profileFile.inspectOfficialEnvelope({
      version: 3,
      dataScope: 'KeyboardProfile',
      vendorId: 14391,
      productId: 8225,
      data: { name: 'Invalid', performance: 42, light: 42, userKeys: [] }
    });
    assert.equal(inspected.valid, false);
    assert.equal(inspected.native, undefined);
    assert.match(inspected.error || '', /performance|light|object/i);
    assert.equal(JSON.stringify(inspected).includes('"sleepTime":6'), false);
    assert.equal(JSON.stringify(inspected).includes('"brightness":100'), false);
  });

  test('malformed official lightValueStore is rejected instead of silently dropped', () => {
    const corrupt = JSON.parse(JSON.stringify(official));
    corrupt.data.lightValueStore = { light: 'totally corrupt', sideLight: 42 };
    const inspected = profileFile.inspectOfficialEnvelope(corrupt);
    assert.equal(inspected.valid, false);
    assert.equal(inspected.native, undefined);
    assert.match(inspected.error || '', /lightValueStore/i);

    const corruptSide2 = JSON.parse(JSON.stringify(official));
    corruptSide2.data.lightValueStore = { light: [], sideLight: [], sideLight2: 'x' };
    const inspectedSide2 = profileFile.inspectOfficialEnvelope(corruptSide2);
    assert.equal(inspectedSide2.valid, false);
    assert.match(inspectedSide2.error || '', /lightValueStore/i);

    const empty = profileFile.inspectOfficialEnvelope(JSON.parse(JSON.stringify(official)));
    assert.equal(empty.valid, true, empty.error);
    assert.equal(empty.native.lightingMemory, undefined);
  });

  test('legacy version 2 envelopes are rejected explicitly', () => {
    const v2 = JSON.parse(JSON.stringify(official));
    v2.version = 2;
    const inspected = profileFile.inspectOfficialEnvelope(v2);
    assert.equal(inspected.valid, false);
    assert.equal(inspected.native, undefined);
    assert.match(inspected.error || '', /legacy.*version: 2/i);
  });

  test('independent official MT/TGL fixture converts to native tables and keeps shared references', () => {
    const raw = fs.readFileSync(path.join(__dirname, 'fixtures', 'official-keyboard-profile-v3-advanced-mt-tgl.json'), 'utf8');
    assert.match(raw, /"clickKey"/);
    assert.match(raw, /"downKey"/);
    assert.doesNotMatch(raw, /officialAdvanced/);
    const inspected = profileFile.inspectOfficialEnvelope(officialAdvanced);
    assert.equal(inspected.valid, true, inspected.error);
    assert.equal(inspected.native.officialAdvanced, undefined);
    assert.equal(inspected.native.layers['0']['11'].type, 146);
    assert.equal(inspected.native.layers['0']['11'].code1, 3);
    assert.equal(inspected.native.layers['0']['19'].type, 146);
    assert.equal(inspected.native.layers['0']['19'].code1, 3);
    assert.equal(inspected.native.layers['0']['27'].type, 145);
    assert.equal(inspected.native.layers['0']['27'].code1, 1);
    const mt = protocol.parseMtTable(Buffer.from(inspected.native.advanced.mt, 'hex'));
    const tgl = protocol.parseTglTable(Buffer.from(inspected.native.advanced.tgl, 'hex'));
    assert.deepEqual(mt[3].rawTap, [16, 0, 4]);
    assert.deepEqual(mt[3].rawHold, [16, 2, 0]);
    assert.deepEqual(tgl[1].rawTarget, [16, 0, 41]);
    assert.deepEqual(inspected.native.macros[0].actions, [
      { action: 'keydown', code: 4, delay: 10 },
      { action: 'keyup', code: 0, delay: 20 },
      { action: 'keyup', code: 4, delay: 0 }
    ]);
    assert.equal(inspected.native.macros[0].name, 'Burst');
    assert.equal(inspected.native.macros[0].type, 1);
    assert.equal(inspected.native.macros[0].defaultDelay, undefined);
    assert.equal(inspected.native.macroMetadata.slots[2].name, 'Burst');
    assert.equal(inspected.native.macroMetadata.slots[2].defaultDelay, 50);
    const exported = profileFile.exportOfficialEnvelope({ name: 'AdvMT', data: inspected.native });
    assert.equal(exported.valid, true, exported.error);
    assert.deepEqual(exported.envelope.data.advancedKeys.mt[3].clickKey, { type: 16, code1: 0, code2: 4 });
    assert.deepEqual(exported.envelope.data.advancedKeys.mt[3].downKey, { type: 16, code1: 2, code2: 0 });
    assert.deepEqual(exported.envelope.data.advancedKeys.tgl[1], { type: 16, code1: 0, code2: 41 });
    assert.equal(exported.envelope.macros[0].name, 'Burst');
    assert.equal(exported.envelope.macros[0].type, 1);
    assert.equal(exported.envelope.macros[0].defaultDelay, 50);
    assert.deepEqual(exported.envelope.macros[0].macroActions[2], { type: 'time', delay: 20 });
  });

  test('official import accepts GLW playback types 0, 1, and 255 and rejects QHW UI OneTime=2', () => {
    for (const type of [0, 1, 255]) {
      const envelope = JSON.parse(JSON.stringify(official));
      envelope.macros[0].type = type;
      const inspected = profileFile.inspectOfficialEnvelope(envelope);
      assert.equal(inspected.valid, true, inspected.error);
      assert.equal(inspected.native.macros[0].type, type);
    }
    const qhwOneTime = JSON.parse(JSON.stringify(official));
    qhwOneTime.macros[0].type = 2;
    const rejected = profileFile.inspectOfficialEnvelope(qhwOneTime);
    assert.equal(rejected.valid, false);
    assert.match(rejected.error || '', /playback type 2/);
  });

  test('official Default Onboard2 name imports as a unique 2..15 local snapshot name', () => {
    const envelope = JSON.parse(JSON.stringify(official));
    envelope.data.name = 'Default Onboard2';
    const inspected = profileFile.inspectOfficialEnvelope(envelope);
    assert.equal(inspected.valid, true, inspected.error);
    assert.equal(inspected.name, 'Default Onboard2');
    const copied = require('../src/profile-library.cjs').copyOnboardToLocal(
      [],
      inspected.name,
      inspected.native,
      inspected.extra,
      4,
      [0, 1, 2, 3].map((i) => ({ name: require('../src/profile-names.cjs').defaultOnboardName(i) }))
    );
    assert.equal(copied.valid, true, copied.error);
    assert.ok(copied.item.name.length >= 2 && copied.item.name.length <= 15);
    assert.equal(copied.item.extra.displayName, 'Default Onboard2');
  });

  test('populated DKS, missing MT rows, duplicate macroIndex, and out-of-range ids fail closed', () => {
    const dks = JSON.parse(JSON.stringify(officialAdvanced));
    dks.data.advancedKeys.dks = [{ action0: { type: 16, code1: 0, code2: 4 } }];
    assert.equal(profileFile.inspectOfficialEnvelope(dks).valid, false);
    const missingMt = JSON.parse(JSON.stringify(officialAdvanced));
    missingMt.data.advancedKeys.mt = [];
    assert.equal(profileFile.inspectOfficialEnvelope(missingMt).valid, false);
    const dup = JSON.parse(JSON.stringify(official));
    dup.macros = [dup.macros[0], { ...dup.macros[0], name: 'Other' }];
    assert.equal(profileFile.inspectOfficialEnvelope(dup).valid, false);
    const oob = JSON.parse(JSON.stringify(official));
    oob.macros = [{ ...oob.macros[0], macroIndex: 16 }];
    assert.equal(profileFile.inspectOfficialEnvelope(oob).valid, false);
  });

  test('macro remap keeps reserved onboard slots and rewrites 112 bindings', () => {
    const current = [];
    for (let i = 0; i < 16; i++) current.push({ id: i, actions: i === 0 ? [{ action: 'keydown', code: 7, delay: 5 }] : [], type: 0 });
    const imported = [{ id: 0, actions: [{ action: 'keydown', code: 4, delay: 10 }], type: 0 }];
    const reserved = new Set([0]);
    const plan = profileFile.planMacroRemap(imported, current, reserved);
    assert.equal(plan.valid, true, plan.error);
    assert.notEqual(plan.remap.get(0), 0);
    assert.equal(current[0].actions[0].code, 7);
    const layers = { 0: { 11: { type: 112, code1: 0, code2: 0 } } };
    const rewritten = profileFile.rewriteMacroBindings(layers, plan.remap, plan.slots);
    assert.equal(rewritten['0']['11'].code1, plan.remap.get(0));
    assert.equal(rewritten['0']['11'].code2, plan.slots[plan.remap.get(0)].type);
  });

  test('macro remap matches body and playback type and preserves imported type', () => {
    const current = [];
    for (let i = 0; i < 16; i++) {
      current.push({
        id: i,
        name: i === 0 ? 'Existing' : `Macro ${i + 1}`,
        type: i === 0 ? 0 : 0,
        actions: i === 0 ? [{ action: 'keydown', code: 4, delay: 10 }] : []
      });
    }
    const sameBodyDifferentType = profileFile.planMacroRemap(
      [{ id: 2, type: 2, name: 'Imported', actions: [{ action: 'keydown', code: 4, delay: 10 }] }],
      current,
      new Set([0])
    );
    assert.equal(sameBodyDifferentType.valid, true, sameBodyDifferentType.error);
    assert.notEqual(sameBodyDifferentType.remap.get(2), 0);
    assert.equal(sameBodyDifferentType.slots[sameBodyDifferentType.remap.get(2)].type, 2);
    assert.equal(sameBodyDifferentType.slots[0].type, 0);
    assert.equal(sameBodyDifferentType.slots[sameBodyDifferentType.remap.get(2)].name, 'Imported');

    const sameBodySameType = profileFile.planMacroRemap(
      [{ id: 2, type: 0, name: 'Imported', actions: [{ action: 'keydown', code: 4, delay: 10 }] }],
      current,
      new Set([0])
    );
    assert.equal(sameBodySameType.remap.get(2), 0);
    assert.equal(sameBodySameType.slots[0].type, 0);

    const full = current.map((s, i) => ({
      ...s,
      actions: [{ action: 'keydown', code: 4 + (i % 10), delay: 10 + i }],
      type: 0
    }));
    const fullBank = profileFile.planMacroRemap(
      [{ id: 2, type: 1, name: 'NoRoom', actions: [{ action: 'keydown', code: 4, delay: 10 }] }],
      full,
      new Set()
    );
    assert.equal(fullBank.valid, false);

    const dupId = profileFile.planMacroRemap(
      [
        { id: 2, type: 0, name: 'A', actions: [{ action: 'keydown', code: 8, delay: 10 }] },
        { id: 2, type: 0, name: 'B', actions: [{ action: 'keydown', code: 9, delay: 10 }] }
      ],
      current,
      new Set()
    );
    assert.equal(dupId.valid, false);
    const oob = profileFile.planMacroRemap(
      [{ id: 16, type: 0, name: 'Oob', actions: [{ action: 'keydown', code: 8, delay: 10 }] }],
      current,
      new Set()
    );
    assert.equal(oob.valid, false);
  });
});

describe('official fixture file is independent of the encoder', () => {
  test('fixture on disk still contains dataV2 0x100004 not a roundtrip artifact', () => {
    const raw = fs.readFileSync(path.join(__dirname, 'fixtures', 'official-keyboard-profile-v3.json'), 'utf8');
    assert.match(raw, /0x100004/);
    assert.match(raw, /"version": 3/);
    assert.doesNotMatch(raw, /Maicong Studio/);
  });
});
