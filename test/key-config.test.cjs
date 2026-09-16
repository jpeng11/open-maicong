const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const KeyConfig = require('../src/key-config.cjs');
const { getDefaultTuple, VALID_PHYSICAL_SLOTS } = require('../src/layout-g75v2.cjs');
const protocol = require('../src/protocol.cjs');
const transport = require('../src/transport.cjs');
const { MockGlwMemoryDevice } = require('./mock-glw-memory.cjs');
const baseline = require('./fixtures/readonly-baseline.json');

function layersWith(slot, tuple, layer = 0) {
  const maps = { 0: {}, 1: {}, 2: {}, 3: {} };
  maps[layer][slot] = tuple;
  return maps;
}

describe('G75 Key Config drag / clipboard / reset / recorder', () => {
  test('drag payload is keyCode source and drop rejects other tabs and junk', () => {
    const made = KeyConfig.makeDragPayload({ type: 16, code1: 0, code2: 4 });
    assert.equal(made.ok, true);
    assert.equal(made.data.source, 'keyCode');
    assert.deepEqual(made.data.payload, { type: 16, code1: 0, code2: 4 });
    const drop = KeyConfig.readDragPayload(made.data, 'keyCode');
    assert.equal(drop.ok, true);
    assert.deepEqual(drop.tuple, { type: 16, code1: 0, code2: 4 });
    assert.equal(KeyConfig.readDragPayload(made.data, 'trigger').ok, false);
    assert.equal(KeyConfig.readDragPayload('not-json', 'keyCode').ok, false);
    assert.equal(KeyConfig.readDragPayload({ source: 'profileItem', payload: made.data.payload }, 'keyCode').ok, false);
    assert.equal(KeyConfig.makeDragPayload({ type: 16, code1: 0 }).ok, false);
  });

  test('copy/paste ordinary and macro bindings; malformed clipboard is rejected', () => {
    const source = { kind: 'onboard', profileIndex: 0 };
    const copied = KeyConfig.copyBinding({ type: 16, code1: 1, code2: 6 }, source);
    assert.equal(copied.ok, true);
    const pasted = KeyConfig.pasteBinding(copied.clip, source, layersWith(11, { type: 16, code1: 0, code2: 4 }));
    assert.equal(pasted.ok, true);
    assert.deepEqual(pasted.tuple, { type: 16, code1: 1, code2: 6 });

    const destMacros = Array.from({ length: 16 }, () => ({ type: 0, bodyKey: '' }));
    destMacros[3] = { type: 1, bodyKey: 'aabbccdd' };
    const macro = KeyConfig.copyBinding(
      { type: 112, code1: 3, code2: 1 },
      source,
      { macro: { playbackType: 1, bodyKey: 'aabbccdd' } }
    );
    assert.equal(macro.ok, true);
    const macroPaste = KeyConfig.pasteBinding(
      macro.clip,
      { kind: 'onboard', profileIndex: 2 },
      { 0: {}, 1: {}, 2: {}, 3: {} },
      { macros: destMacros }
    );
    assert.equal(macroPaste.ok, true, 'matching onboard macro content may share the device bank');
    assert.deepEqual(macroPaste.tuple, { type: 112, code1: 3, code2: 1 });
    assert.deepEqual(macroPaste.expectedMacro, {
      type: 112,
      index: 3,
      playbackType: 1,
      bodyKey: 'aabbccdd'
    });

    assert.equal(KeyConfig.copyBinding({ type: 112, code1: 3, code2: 1 }, source).ok, false);
    assert.equal(KeyConfig.parseClipboard('{"v":1}').ok, false);
    assert.equal(KeyConfig.parseClipboard({ v: 1, kind: 'nope', binding: { type: 16, code1: 0, code2: 4 } }).ok, false);
    assert.equal(KeyConfig.parseClipboard('{"v":1,"kind":"g75-key-binding","binding":{"type":16}}').ok, false);
    assert.equal(KeyConfig.pasteBinding(null, source, {}).ok, false);
  });

  test('reference-bearing clipboard rejects missing source and does not default onboard0', () => {
    const mt = { type: 146, code1: 2, code2: 15 };
    const layers = layersWith(11, mt);
    assert.equal(KeyConfig.parseClipboard({
      v: 1,
      kind: 'g75-key-binding',
      binding: mt
    }).ok, false);
    assert.equal(KeyConfig.parseClipboard({
      v: 1,
      kind: 'g75-key-binding',
      binding: mt,
      source: { kind: 'onboard' },
      tableBytes: [16, 0, 4, 16, 1, 0]
    }).ok, false);
    const pasted = KeyConfig.pasteBinding({
      v: 1,
      kind: 'g75-key-binding',
      binding: mt,
      tableBytes: [16, 0, 4, 16, 1, 0]
    }, { kind: 'onboard', profileIndex: 0 }, layers, {
      mtTable: (() => {
        const table = new Array(256).fill(0);
        table.splice(12, 6, 16, 0, 4, 16, 1, 0);
        return table;
      })()
    });
    assert.equal(pasted.ok, false);
    assert.match(pasted.error, /source/i);
  });

  test('macro paste migrates matching local content and rejects incompatible banks', () => {
    const localA = { kind: 'local', key: 'KeyboardProfile@localstorage@aaa' };
    const localB = { kind: 'local', key: 'KeyboardProfile@localstorage@bbb' };
    const copied = KeyConfig.copyBinding(
      { type: 112, code1: 0, code2: 1 },
      localA,
      { macro: { playbackType: 1, bodyKey: 'deadbeef' } }
    );
    assert.equal(copied.ok, true);
    const migrated = KeyConfig.pasteBinding(
      copied.clip,
      localB,
      { 0: {}, 1: {}, 2: {}, 3: {} },
      { macros: [{ type: 1, bodyKey: 'cccc' }, { type: 1, bodyKey: 'deadbeef' }] }
    );
    assert.equal(migrated.ok, true);
    assert.equal(migrated.migrated, true);
    assert.deepEqual(migrated.tuple, { type: 112, code1: 1, code2: 1 });

    const rejected = KeyConfig.pasteBinding(
      copied.clip,
      localB,
      { 0: {}, 1: {}, 2: {}, 3: {} },
      { macros: [{ type: 1, bodyKey: 'cccc' }, { type: 0, bodyKey: 'ffff' }] }
    );
    assert.equal(rejected.ok, false);
    assert.match(rejected.error, /not found/i);

    const silentIndex = KeyConfig.pasteBinding(
      copied.clip,
      localB,
      { 0: {}, 1: {}, 2: {}, 3: {} },
      { macros: [{ type: 1, bodyKey: 'other-at-index-0' }] }
    );
    assert.equal(silentIndex.ok, false);

    const cutBare = KeyConfig.cutBinding({ type: 112, code1: 0, code2: 1, slot: 11, source: localA }, new Set());
    assert.equal(cutBare.ok, false);
    const cutMacro = KeyConfig.cutBinding(
      { type: 112, code1: 0, code2: 1, slot: 11, source: localA },
      new Set(),
      { macro: { playbackType: 1, bodyKey: 'deadbeef' } }
    );
    assert.equal(cutMacro.ok, true);
    assert.equal(cutMacro.restoreDefault, true);
    assert.equal(cutMacro.clip.macro.bodyKey, 'deadbeef');
  });

  test('resolveExpectedMacroUpdates migrates by body and playback and rejects replaced banks', () => {
    const planned = [{ slot: 19, type: 112, code1: 0, code2: 1 }];
    const migrated = KeyConfig.resolveExpectedMacroUpdates(
      planned,
      [{ type: 0, bodyKey: 'bbbb' }, { type: 1, bodyKey: 'aaaa' }],
      [{ type: 112, index: 0, playbackType: 1, bodyKey: 'aaaa' }]
    );
    assert.equal(migrated.ok, true);
    assert.deepEqual(migrated.planned[0], { slot: 19, type: 112, code1: 1, code2: 1 });
    assert.equal(planned[0].code1, 0, 'resolver must not mutate the original updates');

    const playbackMiss = KeyConfig.resolveExpectedMacroUpdates(
      planned,
      [{ type: 0, bodyKey: 'aaaa' }, { type: 1, bodyKey: 'bbbb' }],
      [{ type: 112, index: 0, playbackType: 1, bodyKey: 'aaaa' }]
    );
    assert.equal(playbackMiss.ok, false);

    const gone = KeyConfig.resolveExpectedMacroUpdates(
      planned,
      [{ type: 1, bodyKey: 'cccc' }],
      [{ type: 112, index: 0, playbackType: 1, bodyKey: 'aaaa' }]
    );
    assert.equal(gone.ok, false);
    assert.equal(gone.rejectStage, 'resolveExpectedMacroUpdates');
    assert.ok(Array.isArray(gone.have));

    const nullRef = KeyConfig.resolveExpectedMacroUpdates(
      planned,
      [{ type: 1, bodyKey: 'aaaa' }],
      [null]
    );
    assert.equal(nullRef.ok, false);
    const wrongType = KeyConfig.resolveExpectedMacroUpdates(
      planned,
      [{ type: 1, bodyKey: 'aaaa' }],
      [{ type: 145, index: 0, playbackType: 1, bodyKey: 'aaaa' }]
    );
    assert.equal(wrongType.ok, false);

    const first = KeyConfig.resolveExpectedMacroUpdates(
      [{ slot: 11, type: 112, code1: 0, code2: 0 }],
      [{ type: 1, bodyKey: 'bbbb' }, { type: 0, bodyKey: 'aaaa' }],
      [{ type: 112, index: 0, slot: 11, playbackType: 0, bodyKey: 'aaaa' }]
    );
    assert.equal(first.ok, true);
    assert.equal(first.planned[0].code1, 1);
    const second = KeyConfig.resolveExpectedMacroUpdates(
      first.planned,
      [{ type: 1, bodyKey: 'bbbb' }, { type: 1, bodyKey: 'cccc' }, { type: 0, bodyKey: 'aaaa' }],
      [{ type: 112, index: 0, slot: 11, playbackType: 0, bodyKey: 'aaaa' }]
    );
    assert.equal(second.ok, true);
    assert.equal(second.planned[0].code1, 2, 'second resolution must follow slot identity, not the original index');
    assert.equal(second.planned[0].slot, 11);
  });

  test('slot revision ownership hydrates matching edits and preserves newer drafts including ABA', () => {
    const revs = {};
    const persisted = {};
    const layerMap = {
      11: { slot: 11, type: 32, code1: 1, code2: 0 },
      19: { slot: 19, type: 33, code1: 0, code2: 1 }
    };
    assert.equal(KeyConfig.bumpSlotRev(revs, 0, 11), 1);
    const capturedA = KeyConfig.captureSlotRevs(revs, 0, [{ slot: 11 }]);
    assert.equal(capturedA[11], 1);
    assert.equal(KeyConfig.bumpSlotRev(revs, 0, 11), 2);
    layerMap[11] = { slot: 11, type: 33, code1: 0, code2: 1 };
    const skipped = KeyConfig.applyPlannedIfCurrent(
      layerMap,
      [{ slot: 11, type: 32, code1: 1, code2: 0 }],
      revs,
      capturedA,
      0
    );
    assert.deepEqual(skipped, []);
    assert.equal(layerMap[11].type, 33, 'older ACK must not overwrite a newer same-slot draft');

    const capturedB = KeyConfig.captureSlotRevs(revs, 0, [{ slot: 11 }]);
    KeyConfig.markSlotsPersisted(persisted, 0, capturedA, revs);
    assert.equal(KeyConfig.hasUnpersistedSlotRevs(revs, persisted), true, 'unpersisted B remains dirty after stale A');

    KeyConfig.bumpSlotRev(revs, 0, 11);
    layerMap[11] = { slot: 11, type: 32, code1: 1, code2: 0 };
    const staleAAgain = KeyConfig.applyPlannedIfCurrent(
      layerMap,
      [{ slot: 11, type: 32, code1: 1, code2: 0 }],
      revs,
      capturedA,
      0
    );
    assert.deepEqual(staleAAgain, []);
    assert.equal(KeyConfig.getSlotRev(revs, 0, 11), 3);

    const capturedOther = KeyConfig.captureSlotRevs(revs, 0, [{ slot: 19 }]);
    KeyConfig.bumpSlotRev(revs, 0, 19);
    const appliedOther = KeyConfig.applyPlannedIfCurrent(
      layerMap,
      [{ slot: 19, type: 33, code1: 0, code2: 1 }],
      revs,
      capturedOther,
      0
    );
    assert.deepEqual(appliedOther, []);
    const capturedOther2 = KeyConfig.captureSlotRevs(revs, 0, [{ slot: 19 }]);
    const appliedNow = KeyConfig.applyPlannedIfCurrent(
      layerMap,
      [{ slot: 19, type: 48, code1: 226, code2: 0 }],
      revs,
      capturedOther2,
      0
    );
    assert.deepEqual(appliedNow, [19]);
    assert.equal(layerMap[19].type, 48);
    KeyConfig.markSlotsPersisted(persisted, 0, capturedOther2, revs);
    KeyConfig.markSlotsPersisted(persisted, 0, capturedB, revs);
    assert.equal(KeyConfig.hasUnpersistedSlotRevs(revs, persisted), true);
    const capturedFinal = KeyConfig.captureSlotRevs(revs, 0, [{ slot: 11 }]);
    KeyConfig.applyPlannedIfCurrent(
      layerMap,
      [{ slot: 11, type: 146, code1: 2, code2: 15 }],
      revs,
      capturedFinal,
      0
    );
    assert.equal(layerMap[11].type, 146);
    assert.equal(layerMap[11].code1, 2);
    KeyConfig.markSlotsPersisted(persisted, 0, capturedFinal, revs);
    assert.equal(KeyConfig.hasUnpersistedSlotRevs(revs, persisted), false);

    const capturedMacro = KeyConfig.captureSlotRevs(revs, 0, [{ slot: 11 }]);
    KeyConfig.bumpSlotRev(revs, 0, 11);
    layerMap[11] = { slot: 11, type: 112, code1: 0, code2: 0 };
    const staleMacro = KeyConfig.applyPlannedIfCurrent(
      layerMap,
      [{ slot: 11, type: 112, code1: 1, code2: 0 }],
      revs,
      capturedMacro,
      0
    );
    assert.deepEqual(staleMacro, []);
    const capturedMacroNow = KeyConfig.captureSlotRevs(revs, 0, [{ slot: 11 }]);
    const appliedMacro = KeyConfig.applyPlannedIfCurrent(
      layerMap,
      [{ slot: 11, type: 112, code1: 1, code2: 0 }],
      revs,
      capturedMacroNow,
      0
    );
    assert.deepEqual(appliedMacro, [11]);
    assert.equal(layerMap[11].code1, 1, 'matching rev hydrates the migrated macro index');
    KeyConfig.markSlotsPersisted(persisted, 0, capturedMacroNow, revs);

    const capturedTgl = KeyConfig.captureSlotRevs(revs, 0, [{ slot: 19 }]);
    KeyConfig.bumpSlotRev(revs, 0, 19);
    layerMap[19] = { slot: 19, type: 145, code1: 0, code2: 0 };
    assert.deepEqual(KeyConfig.applyPlannedIfCurrent(
      layerMap,
      [{ slot: 19, type: 145, code1: 4, code2: 0 }],
      revs,
      capturedTgl,
      0
    ), []);
    const capturedTglNow = KeyConfig.captureSlotRevs(revs, 0, [{ slot: 19 }]);
    KeyConfig.applyPlannedIfCurrent(
      layerMap,
      [{ slot: 19, type: 145, code1: 4, code2: 0 }],
      revs,
      capturedTglNow,
      0
    );
    assert.equal(layerMap[19].type, 145);
    assert.equal(layerMap[19].code1, 4);
    KeyConfig.markSlotsPersisted(persisted, 0, capturedTglNow, revs);
    assert.equal(KeyConfig.hasUnpersistedSlotRevs(revs, persisted), false);

    const incoming = {
      11: { slot: 11, type: 32, code1: 1, code2: 0 },
      19: { slot: 19, type: 16, code1: 0, code2: 22 }
    };
    KeyConfig.bumpSlotRev(revs, 0, 11);
    layerMap[11] = { slot: 11, type: 33, code1: 0, code2: 1 };
    const merged = KeyConfig.mergeLayerHydration(layerMap, incoming, revs, persisted, 0);
    assert.equal(merged[11].type, 33, 'full layer hydration must not clobber a dirty later edit');
    assert.equal(merged[19].type, 16);
    assert.equal(KeyConfig.getSlotRev(revs, 0, 11) > 0, true);
    assert.equal(KeyConfig.getSlotRev(revs, 0, 19), 0);

    const prevLayers = {
      0: {
        11: { slot: 11, type: 16, code1: 0, code2: 4 },
        19: { slot: 19, type: 16, code1: 0, code2: 22 }
      }
    };
    const curLayers = {
      0: {
        11: { slot: 11, type: 32, code1: 1, code2: 0 },
        19: { slot: 19, type: 112, code1: 0, code2: 0 }
      }
    };
    const persistRevs = {};
    const persistMarked = {};
    KeyConfig.bumpSlotRev(persistRevs, 0, 11);
    KeyConfig.bumpSlotRev(persistRevs, 0, 19);
    const owned11 = KeyConfig.captureSlotRevs(persistRevs, 0, [{ slot: 11 }]);
    const sanitized = KeyConfig.layersForLocalPersist(
      curLayers,
      prevLayers,
      persistRevs,
      persistMarked,
      owned11,
      0
    );
    assert.deepEqual(
      [sanitized[0][11].type, sanitized[0][11].code1, sanitized[0][11].code2],
      [32, 1, 0]
    );
    assert.deepEqual(
      [sanitized[0][19].type, sanitized[0][19].code1, sanitized[0][19].code2],
      [16, 0, 22],
      'unowned dirty rejected macro must persist the last-valid entry'
    );
    const ownedKeys = KeyConfig.ownedSnapshotRevs(persistRevs, owned11, 0);
    assert.deepEqual(Object.keys(ownedKeys), ['0:11']);
    KeyConfig.markRevSnapshotPersisted(persistMarked, ownedKeys, persistRevs);
    assert.equal(KeyConfig.hasUnpersistedSlotRevs(persistRevs, persistMarked), true);

    const idA = KeyConfig.captureSaveIdentity({ kind: 'onboard', profileIndex: 0 }, 4, 2, 0);
    assert.equal(KeyConfig.saveIdentityMatches(idA, {
      gen: 4,
      resetEpoch: 2,
      profile: 0,
      source: { kind: 'onboard', profileIndex: 0 }
    }), true);
    assert.equal(KeyConfig.saveIdentityMatches(idA, {
      gen: 5,
      resetEpoch: 2,
      profile: 0,
      source: { kind: 'onboard', profileIndex: 0 }
    }), false, 'queued work must not adopt a later generation');
    assert.equal(KeyConfig.saveIdentityMatches(idA, {
      gen: 4,
      resetEpoch: 2,
      profile: 1,
      source: { kind: 'onboard', profileIndex: 1 }
    }), false);
    const idLocal = KeyConfig.captureSaveIdentity({ kind: 'local', key: 'KeyboardProfile@localstorage@aaa' }, 1, 1, 0);
    assert.equal(KeyConfig.saveIdentityMatches(idLocal, {
      gen: 1,
      resetEpoch: 1,
      profile: 0,
      source: { kind: 'local', key: 'KeyboardProfile@localstorage@bbb' }
    }), false);

    KeyConfig.clearSlotRevs(revs, persisted);
    assert.equal(KeyConfig.getSlotRev(revs, 0, 11), 0);
  });

  test('MT/TGL paste snapshots table bytes and rejects stale or cross-profile indexes', () => {
    const source = { kind: 'onboard', profileIndex: 0 };
    const mt = { type: 146, code1: 3, code2: 15 };
    const layers = layersWith(11, mt);
    layers[0][19] = { type: 16, code1: 0, code2: 7 };
    const mtBytes = [16, 0, 4, 16, 1, 0];
    const table = new Array(256).fill(0);
    for (let i = 0; i < 6; i++) table[3 * 6 + i] = mtBytes[i];
    const copied = KeyConfig.copyBinding(mt, source, { tableBytes: mtBytes });
    assert.equal(copied.ok, true);
    const share = KeyConfig.pasteBinding(copied.clip, source, layers, { mtTable: table });
    assert.equal(share.ok, true);
    assert.equal(share.sharedAdvanced, true);
    assert.deepEqual(share.tuple, mt);
    assert.deepEqual(share.expectedRef.bytes, mtBytes);

    const staleTable = table.slice();
    staleTable[3 * 6 + 2] = 7;
    const stale = KeyConfig.pasteBinding(copied.clip, source, layers, { mtTable: staleTable });
    assert.equal(stale.ok, false);
    assert.match(stale.error, /no longer matches/);

    const migratedTable = new Array(256).fill(0);
    for (let i = 0; i < 6; i++) migratedTable[5 * 6 + i] = mtBytes[i];
    const layersMigrated = layersWith(8, { type: 146, code1: 5, code2: 15 });
    const migrated = KeyConfig.pasteBinding(copied.clip, source, layersMigrated, { mtTable: migratedTable });
    assert.equal(migrated.ok, true);
    assert.equal(migrated.tuple.code1, 5);
    assert.equal(migrated.migrated, true);

    const cross = KeyConfig.pasteBinding(copied.clip, { kind: 'onboard', profileIndex: 1 }, layers, { mtTable: table });
    assert.equal(cross.ok, false);
    assert.match(cross.error, /across profiles/);

    const dangling = KeyConfig.pasteBinding(copied.clip, source, { 0: {}, 1: {}, 2: {}, 3: {} }, { mtTable: table });
    assert.equal(dangling.ok, false);
    assert.match(dangling.error, /unreferenced/);

    const localA = KeyConfig.copyBinding(mt, { kind: 'local', key: 'KeyboardProfile@localstorage@aaa' }, { tableBytes: mtBytes });
    const localB = KeyConfig.pasteBinding(
      localA.clip,
      { kind: 'local', key: 'KeyboardProfile@localstorage@bbb' },
      layers,
      { mtTable: table }
    );
    assert.equal(localB.ok, false);
    assert.equal(KeyConfig.copyBinding(mt, source).ok, false);
  });

  test('SOCD and magnetic types cannot be pasted or cut from Key Config', () => {
    const source = { kind: 'onboard', profileIndex: 0 };
    const socd = KeyConfig.copyBinding({ type: 148, code1: 1, code2: 19 }, source);
    assert.equal(socd.ok, true);
    const pasted = KeyConfig.pasteBinding(socd.clip, source, layersWith(11, { type: 148, code1: 1, code2: 19 }));
    assert.equal(pasted.ok, false);
    const cutAdv = KeyConfig.cutBinding({ type: 146, code1: 3, code2: 15, slot: 11, source });
    assert.equal(cutAdv.ok, false);
    const cutOk = KeyConfig.cutBinding({ type: 16, code1: 0, code2: 4, slot: 11, source });
    assert.equal(cutOk.ok, true);
    assert.equal(cutOk.restoreDefault, true);
  });

  test('restore defaults skip definite advanced and only emit changed ordinary slots across four layers', () => {
    const layerMaps = { 0: {}, 1: {}, 2: {}, 3: {} };
    const defaults = { 0: {}, 1: {}, 2: {}, 3: {} };
    for (const slot of [0, 8, 11, 19]) {
      for (let layer = 0; layer < 4; layer++) {
        const def = getDefaultTuple(layer, slot);
        defaults[layer][slot] = { type: def[0], code1: def[1], code2: def[2] };
        layerMaps[layer][slot] = { type: def[0], code1: def[1], code2: def[2] };
      }
    }
    layerMaps[0][11] = { type: 48, code1: 226, code2: 0 };
    layerMaps[2][11] = { type: 32, code1: 1, code2: 0 };
    layerMaps[0][19] = { type: 146, code1: 3, code2: 15 };
    layerMaps[1][8] = { type: 145, code1: 1, code2: 0 };

    assert.equal(KeyConfig.isSomeKeyChanged(layerMaps, defaults, new Set(), [0, 8, 11, 19]), true);
    const l0 = KeyConfig.resetUpdatesForLayer(0, layerMaps[0], defaults[0], new Set(), [0, 8, 11, 19]);
    assert.deepEqual(l0.updates.map((u) => u.slot), [11]);
    assert.ok(l0.skipped.includes(19));
    assert.deepEqual(l0.updates[0], {
      slot: 11,
      type: defaults[0][11].type,
      code1: defaults[0][11].code1,
      code2: defaults[0][11].code2
    });
    const l1 = KeyConfig.resetUpdatesForLayer(1, layerMaps[1], defaults[1], new Set(), [0, 8, 11, 19]);
    assert.ok(l1.skipped.includes(8));
    assert.equal(l1.updates.length, 0);
    const l2 = KeyConfig.resetUpdatesForLayer(2, layerMaps[2], defaults[2], new Set(), [0, 8, 11, 19]);
    assert.equal(l2.updates.length, 1);
    assert.equal(l2.updates[0].slot, 11);
  });

  test('maybe-CB chords are advanced only when the slot is listed', () => {
    const chord = { type: 16, code1: 1, code2: 6, slot: 11 };
    assert.equal(KeyConfig.isMaybeCb(chord), true);
    assert.equal(KeyConfig.isAdvancedBinding(chord, new Set()), false);
    assert.equal(KeyConfig.isAdvancedBinding(chord, new Set([11])), true);
    const plan = KeyConfig.resetUpdatesForLayer(
      0,
      { 11: chord },
      { 11: { type: 16, code1: 0, code2: 4 } },
      new Set([11]),
      [11]
    );
    assert.deepEqual(plan.updates, []);
    assert.ok(plan.skipped.includes(11));
  });

  test('recorder Record/Pause/Resume labels and modifier+key complete a type-16 chord', () => {
    let rec = KeyConfig.emptyRecorder();
    assert.equal(KeyConfig.recorderLabel(rec), '111');
    rec = KeyConfig.toggleRecorder(rec);
    assert.equal(rec.active, true);
    assert.equal(KeyConfig.recorderLabel(rec), '112');
    rec = KeyConfig.toggleRecorder(rec);
    assert.equal(rec.active, false);
    assert.equal(KeyConfig.recorderLabel(rec), '111');

    rec = KeyConfig.toggleRecorder(rec);
    const ctrl = KeyConfig.applyRecorderKey(rec, 224, true);
    assert.equal(ctrl.complete, null);
    rec = ctrl.rec;
    const shift = KeyConfig.applyRecorderKey(rec, 225, true);
    rec = shift.rec;
    const letter = KeyConfig.applyRecorderKey(rec, 4, true);
    assert.deepEqual(letter.complete, { type: 16, code1: 1 | 2, code2: 4 });
    assert.equal(letter.rec.active, false);
    assert.equal(KeyConfig.recorderLabel(letter.rec), '113');

    const paused = KeyConfig.pauseRecorder(letter.rec);
    assert.equal(paused.active, false);
    const ignored = KeyConfig.applyRecorderKey(paused, 7, true);
    assert.equal(ignored.complete, null);

    let held = KeyConfig.emptyRecorder();
    held = KeyConfig.toggleRecorder(held);
    held = KeyConfig.applyRecorderKey(held, 224, true).rec;
    held = KeyConfig.applyRecorderKey(held, 224, false).rec;
    const afterRelease = KeyConfig.applyRecorderKey(held, 4, true);
    assert.deepEqual(afterRelease.complete, { type: 16, code1: 0, code2: 4 });
  });

  test('save gate serializes overlapping work and drain does not drop pending', async () => {
    const gate = KeyConfig.createSaveGate();
    const order = [];
    let releaseFirst;
    const first = gate.enqueue(() => new Promise((resolve) => {
      order.push('a-start');
      releaseFirst = resolve;
    }));
    const second = gate.enqueue(() => {
      order.push('b');
      return Promise.resolve('b-done');
    });
    assert.equal(gate.pending, 2);
    assert.equal(await gate.drain(40), false);
    assert.equal(gate.pending, 2);
    releaseFirst('a-done');
    const results = await Promise.all([first, second]);
    assert.deepEqual(order, ['a-start', 'b']);
    assert.deepEqual(results, ['a-done', 'b-done']);
    assert.equal(gate.pending, 0);
    assert.equal(await gate.drain(20), true);
  });

  test('local snapshot merge keeps GIF selectedLightEffect and advanced tables', () => {
    const prev = {
      app: 'Maicong Studio',
      model: 'MCHOSE G75 V2',
      protocol: 'GLW',
      version: '2.0.0',
      lighting: { effect: 16, brightness: 80 },
      settings: { sleepTime: 6, reporteRate: 4 },
      layers: { 0: {}, 1: {}, 2: {}, 3: {} },
      selectedLightEffect: ['gif', 'Wave'],
      advanced: { mt: 'aabb', tgl: 'ccdd' },
      lightingMemory: { main: [{ effect: 16 }] },
      customParam: { cbKeyIndexList: [[11]] }
    };
    const editor = {
      lighting: { effect: 16, brightness: 40 },
      settings: { sleepTime: 6, reporteRate: 4 },
      layers: { 0: { 11: { type: 16, code1: 0, code2: 7 } }, 1: {}, 2: {}, 3: {} },
      selectedLightEffect: ['gif', 'Wave']
    };
    const merged = KeyConfig.mergeLocalSnapshot(prev, editor);
    assert.deepEqual(merged.selectedLightEffect, ['gif', 'Wave']);
    assert.deepEqual(merged.advanced, { mt: 'aabb', tgl: 'ccdd' });
    assert.deepEqual(merged.lightingMemory.main[0], { effect: 16 });
    assert.deepEqual(merged.customParam, { cbKeyIndexList: [[11]] });
    assert.equal(merged.layers[0][11].code2, 7);
    assert.equal(merged.lighting.brightness, 40);
  });

  test('applyKeymap still rejects unsolicited MT writes; shared-ref option writes the tuple without table bytes', async () => {
    const mock = new MockGlwMemoryDevice({ baseline });
    transport.device = mock;
    transport.lastState.connected = true;
    transport.needsReconnect = false;
    mock.on('data', (data) => transport.handleIncomingData(data));

    const denied = await transport.applyKeymap(0, 0, [{ slot: 11, type: 146, code1: 0, code2: 15 }]);
    assert.equal(denied.success, false);
    assert.match(denied.error, /Advanced API|MT\/TGL\/SOCD/);

    const mtOk = await transport.applyAdvancedBinding({
      profileIndex: 0,
      layer: 0,
      slot: 11,
      kind: 'mt',
      tapKey: [16, 0, 4],
      holdKey: [16, 1, 0],
      delayMs: 150
    });
    assert.equal(mtOk.success, true);
    const afterMt = await transport.readLayer(0, 0);
    const src = afterMt.keys.find((k) => k.index === 11);
    assert.equal(src.type, 146);
    const adv = await transport.readAdvanced(0);
    const mtBuf = Buffer.from(adv.raw.mt, 'hex');
    const bytes = Array.from(mtBuf.subarray(src.code1 * 6, src.code1 * 6 + 6));
    const noSnap = await transport.applyKeymap(
      0,
      0,
      [{ slot: 19, type: 146, code1: src.code1, code2: src.code2 }],
      { allowSharedAdvancedRefs: true }
    );
    assert.equal(noSnap.success, false);

    mock.writtenBuffers.length = 0;
    const savedMt = Buffer.from(mock.mt);
    mock.mt.fill(0xff, 0, protocol.MT_TABLE_SIZE);
    const stale = await transport.applyKeymap(
      0,
      0,
      [{ slot: 19, type: 146, code1: src.code1, code2: src.code2 }],
      { allowSharedAdvancedRefs: true, expectedRefs: [{ type: 146, index: src.code1, bytes }] }
    );
    assert.equal(stale.success, false);
    assert.match(stale.error, /no longer matches/);
    assert.equal(mock.wroteCommand(protocol.COMMANDS.SET_USER_KEY_MATRIX), false);
    savedMt.copy(mock.mt);

    mock.writtenBuffers.length = 0;
    const shared = await transport.applyKeymap(
      0,
      0,
      [{ slot: 19, type: 146, code1: src.code1, code2: src.code2 }],
      { allowSharedAdvancedRefs: true, expectedRefs: [{ type: 146, index: src.code1, bytes }] }
    );
    assert.equal(shared.success, true, shared.error);
    const read = await transport.readLayer(0, 0);
    const dest = read.keys.find((k) => k.index === 19);
    assert.equal(dest.type, 146);
    assert.equal(dest.code1, src.code1);
    assert.equal(mock.wroteCommand(protocol.COMMANDS.SET_MT_KEYS), false, 'shared paste must not rewrite MT tables');

    const dangling = await transport.applyKeymap(
      1,
      0,
      [{ slot: 11, type: 146, code1: src.code1, code2: src.code2 }],
      { allowSharedAdvancedRefs: true, expectedRefs: [{ type: 146, index: src.code1, bytes }] }
    );
    assert.equal(dangling.success, false);
    transport.disconnect();
  });

  test('applyKeymap revalidates macro body and playback inside the transaction', async () => {
    const mock = new MockGlwMemoryDevice({ baseline });
    transport.device = mock;
    transport.lastState.connected = true;
    transport.needsReconnect = false;
    mock.on('data', (data) => transport.handleIncomingData(data));

    const bodyA = [
      { action: 'keydown', code: 4, delay: 20 },
      { action: 'keyup', code: 4, delay: 20 }
    ];
    const bodyB = [
      { action: 'keydown', code: 7, delay: 20 },
      { action: 'keyup', code: 7, delay: 20 }
    ];
    const keyA = protocol.getNormalizedBodyKey(bodyA);
    const seeded = await transport.applyMacros([{ id: 0, type: 1, actions: bodyA }]);
    assert.equal(seeded.success, true, seeded.error);

    mock.writtenBuffers.length = 0;
    const first = await transport.applyKeymap(
      0,
      0,
      [{ slot: 19, type: 112, code1: 0, code2: 1 }],
      { expectedMacroRefs: [{ type: 112, index: 0, playbackType: 1, bodyKey: keyA }] }
    );
    assert.equal(first.success, true, first.error);
    let layer = await transport.readLayer(0, 0);
    let dest = layer.keys.find((k) => k.index === 19);
    assert.equal(dest.type, 112);
    assert.equal(dest.code1, 0);
    assert.equal(dest.code2, 1);

    const replaced = await transport.applyMacros([
      { id: 0, type: 0, actions: bodyB },
      { id: 1, type: 0, actions: bodyA },
      { id: 2, type: 1, actions: bodyA }
    ]);
    assert.equal(replaced.success, true, replaced.error);

    mock.writtenBuffers.length = 0;
    const migrated = await transport.applyKeymap(
      0,
      0,
      [{ slot: 11, type: 112, code1: 0, code2: 1 }],
      { expectedMacroRefs: [{ type: 112, index: 0, playbackType: 1, bodyKey: keyA }] }
    );
    assert.equal(migrated.success, true, migrated.error);
    layer = await transport.readLayer(0, 0);
    dest = layer.keys.find((k) => k.index === 11);
    assert.equal(dest.type, 112);
    assert.equal(dest.code1, 2, 'must prefer matching playback type, not a same-body different mode');
    assert.equal(dest.code2, 1);
    assert.equal(mock.wroteCommand(protocol.COMMANDS.SET_MACROS), false);

    mock.writtenBuffers.length = 0;
    const wiped = await transport.applyMacros([
      { id: 0, type: 0, actions: bodyB },
      { id: 1, type: 0, actions: bodyB },
      { id: 2, type: 0, actions: bodyB }
    ]);
    assert.equal(wiped.success, true, wiped.error);
    mock.writtenBuffers.length = 0;
    const rejected = await transport.applyKeymap(
      0,
      0,
      [{ slot: 8, type: 112, code1: 0, code2: 1 }],
      { expectedMacroRefs: [{ type: 112, index: 0, playbackType: 1, bodyKey: keyA }] }
    );
    assert.equal(rejected.success, false);
    assert.match(rejected.error, /not found/i);
    assert.equal(mock.wroteCommand(protocol.COMMANDS.SET_USER_KEY_MATRIX), false);
    transport.disconnect();
  });

  test('applyKeymap overlapping a delayed SET_MACROS migrates by slot identity', async () => {
    const mock = new MockGlwMemoryDevice({ baseline });
    transport.device = mock;
    transport.lastState.connected = true;
    transport.needsReconnect = false;
    mock.on('data', (data) => transport.handleIncomingData(data));

    const bodyA = [
      { action: 'keydown', code: 4, delay: 20 },
      { action: 'keyup', code: 4, delay: 20 }
    ];
    const bodyB = [
      { action: 'keydown', code: 7, delay: 20 },
      { action: 'keyup', code: 7, delay: 20 }
    ];
    const keyA = protocol.getNormalizedBodyKey(bodyA);
    const seeded = await transport.applyMacros([{ id: 0, type: 0, actions: bodyA }]);
    assert.equal(seeded.success, true, seeded.error);

    mock.writtenBuffers.length = 0;
    mock.delayOnceCommands.set(protocol.COMMANDS.SET_MACROS, 400);
    const macroP = transport.applyMacros([
      { id: 0, type: 1, actions: bodyB },
      { id: 1, type: 0, actions: bodyA }
    ]);
    let saw = false;
    for (let i = 0; i < 80; i++) {
      if (mock.wroteCommand(protocol.COMMANDS.SET_MACROS)) {
        saw = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(saw, true);
    const keyP = transport.applyKeymap(
      0,
      0,
      [{ slot: 19, type: 112, code1: 0, code2: 0 }],
      { expectedMacroRefs: [{ type: 112, index: 0, slot: 19, playbackType: 0, bodyKey: keyA }] }
    );
    const macroRes = await macroP;
    assert.equal(macroRes.success, true, macroRes.error);
    const keyRes = await keyP;
    assert.equal(keyRes.success, true, `${keyRes.error} stage=${keyRes.rejectStage} have=${JSON.stringify(keyRes.have)}`);
    const layer = await transport.readLayer(0, 0);
    const dest = layer.keys.find((k) => k.index === 19);
    assert.equal(dest.type, 112);
    assert.equal(dest.code1, 1, `overlapping write must migrate; planned=${JSON.stringify(keyRes.planned)}`);
    assert.equal(dest.code2, 0);
    transport.disconnect();
  });

  test('physical slot set still covers G75 reset targets', () => {
    assert.equal(VALID_PHYSICAL_SLOTS.has(11), true);
    assert.equal(VALID_PHYSICAL_SLOTS.has(125), false);
  });

  test('collectAdvancedBindings lists malformed SOCD slots separately and does not imply a pair', () => {
    const maps = {
      0: {
        11: { type: 148, code1: 0, code2: 19, slot: 11 },
        19: { type: 16, code1: 0, code2: 22, slot: 19 }
      },
      1: {},
      2: {},
      3: {}
    };
    const items = KeyConfig.collectAdvancedBindings(maps, new Set(), [11, 19]);
    assert.equal(items.length, 1);
    assert.equal(items[0].malformed, true);
    assert.equal(items[0].reciprocal, false);
    assert.equal(items[0].slot, 11);
    assert.match(items[0].id, /malformed/);
    assert.equal(KeyConfig.isReciprocalSocdBinding(maps[0], 11), false);
  });

  test('collectAdvancedBindings dedups only reciprocal SOCD pairs', () => {
    const maps = {
      0: {
        11: { type: 148, code1: 0, code2: 19, slot: 11 },
        19: { type: 148, code1: 1, code2: 11, slot: 19 }
      },
      1: {},
      2: {},
      3: {}
    };
    const items = KeyConfig.collectAdvancedBindings(maps, new Set(), [11, 19]);
    assert.equal(items.length, 1);
    assert.equal(items[0].malformed, false);
    assert.equal(items[0].reciprocal, true);
  });

  test('advancedResetUpdatesForLayer fails closed when a default is missing', () => {
    const plan = KeyConfig.advancedResetUpdatesForLayer(
      0,
      { 11: { type: 146, code1: 0, code2: 15 } },
      {},
      new Set(),
      [11]
    );
    assert.equal(plan.ok, false);
    assert.equal(plan.missingSlot, 11);
    assert.match(plan.error, /default tuple unavailable/i);
  });

  test('mergeOwnedAdvancedBindings applies only captured slots and rejects stale revs', () => {
    const store = { '0:11': 1, '0:19': 4 };
    const current = {
      0: {
        11: { type: 16, code1: 0, code2: 4, slot: 11 },
        19: { type: 33, code1: 0, code2: 1, slot: 19 }
      },
      1: {},
      2: {},
      3: {}
    };
    const incoming = {
      0: {
        11: { type: 146, code1: 0, code2: 15, slot: 11 },
        19: { type: 16, code1: 0, code2: 22, slot: 19 }
      },
      1: {},
      2: {},
      3: {}
    };
    const ok = KeyConfig.mergeOwnedAdvancedBindings(
      current,
      incoming,
      [{ layer: 0, slot: 11 }],
      store,
      { '0:11': 1, '0:19': 4 }
    );
    assert.equal(ok.ok, true);
    assert.equal(ok.maps[0][11].type, 146);
    assert.equal(ok.maps[0][19].type, 33);
    const stale = KeyConfig.mergeOwnedAdvancedBindings(
      current,
      incoming,
      [{ layer: 0, slot: 11 }],
      { '0:11': 2, '0:19': 4 },
      { '0:11': 1, '0:19': 4 }
    );
    assert.equal(stale.ok, false);
    assert.equal(stale.stale, true);
  });

  test('binding tester is newest-first, capped at 100, and expires after 4s', () => {
    let list = [];
    list = KeyConfig.pushBindingTestEvent(list, 'A', 1000, 100, 4000);
    list = KeyConfig.pushBindingTestEvent(list, 'B', 1100, 100, 4000);
    assert.deepEqual(list.map((e) => e.code), ['B', 'A']);
    for (let i = 0; i < 120; i++) {
      list = KeyConfig.pushBindingTestEvent(list, String(i), 2000 + i, 100, 4000);
    }
    assert.equal(list.length, 100);
    assert.equal(list[0].code, '119');
    const pruned = KeyConfig.pruneBindingTestEvents(list, 2000 + 119 + 4000 + 1);
    assert.equal(pruned.length, 0);
    assert.equal(KeyConfig.toBindingTestCode({ code: 'KeyA' }, () => { throw new Error('x'); }), 'KeyA');
    assert.equal(KeyConfig.toBindingTestCode({ code: 'KeyA' }, () => ({ keyCode: 4 })), '4');
    assert.equal(KeyConfig.toBindingTestCode({ code: 'KeyA' }, () => ({})), null);
  });
});
