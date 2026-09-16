const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const transport = require('../src/transport.cjs');
const protocol = require('../src/protocol.cjs');
const validators = require('../src/schema-validators.cjs');
const { ELIGIBLE_ADVANCED_SLOTS, getDefaultTuple } = require('../src/layout-g75v2.cjs');
const { MockGlwMemoryDevice } = require('./mock-glw-memory.cjs');

const SLOT_A = 11;
const SLOT_S = 19;
const TAP_A = [16, 0, 4];
const HOLD_SHIFT = [16, 2, 0];

function attachMockDevice(mock) {
  transport.device = mock;
  transport.lastState.connected = true;
  transport.needsReconnect = false;
  mock.on('data', (data) => transport.handleIncomingData(data));
}

describe('Advanced protocol, edit-target, macros, and backup preflight (mocked memory)', () => {
  beforeEach(() => {
    transport.disconnect();
  });

  afterEach(() => {
    transport.disconnect();
  });

  test('malformed advanced inputs fail closed with zero writes', async () => {
    const mock = new MockGlwMemoryDevice();
    attachMockDevice(mock);

    const cases = [
      { profileIndex: 0, layer: 0, slot: 11, kind: 'mt', tapKey: [16, 0, -1], holdKey: HOLD_SHIFT },
      { profileIndex: 0, layer: 0, slot: 11, kind: 'mt', tapKey: [16, 0], holdKey: HOLD_SHIFT },
      { profileIndex: 0, layer: 0, slot: 11, kind: 'mt', tapKey: [16, 0, Number.NaN], holdKey: HOLD_SHIFT },
      { profileIndex: 0, layer: 0, slot: 11, kind: 'mt', tapKey: [146, 0, 15], holdKey: HOLD_SHIFT },
      { profileIndex: 0, layer: 0, slot: 37, kind: 'tgl', targetKey: TAP_A },
      { profileIndex: 0, layer: 0, slot: 85, kind: 'tgl', targetKey: TAP_A },
      { profileIndex: 0, layer: 0, slot: 11, kind: 'socd', partnerSlot: 37, priority: 0 },
      { profileIndex: 0, layer: 0, slot: 11, kind: 'cb', modifierKey: TAP_A, regularKey: TAP_A },
      { profileIndex: 0, layer: 0, slot: 11, kind: 'cb', modifierKey: HOLD_SHIFT, regularKey: HOLD_SHIFT },
      { profileIndex: 0, layer: 0, slot: 11, kind: 'cb', modifierKey: [16, 1, 0], regularKey: [48, 233, 0] },
      { profileIndex: 0, layer: 0, slot: 11, kind: 'cb', modifierKey: [16, 1, 0, 0], regularKey: TAP_A },
      { profileIndex: 0, layer: 0, slot: 11, kind: 'cb', modifierKey: [16, 1, 0], regularKey: [16, 0, 4, 0] },
      { profileIndex: 0, layer: 0, slot: 11, kind: 'cb', modifierKey: [16, 3, 0, 0], regularKey: TAP_A }
    ];

    for (const spec of cases) {
      mock.writtenBuffers.length = 0;
      const res = await transport.applyAdvancedBinding(spec);
      assert.strictEqual(res.success, false, `expected reject for ${JSON.stringify(spec)}`);
      assert.strictEqual(mock.wroteCommand(protocol.COMMANDS.SET_MT_KEYS), false);
      assert.strictEqual(mock.wroteCommand(protocol.COMMANDS.SET_USER_KEY_MATRIX), false);
    }
  });

  test('MT apply writes table then binding; delay floors to 10ms; reserved bytes preserved', async () => {
    const mock = new MockGlwMemoryDevice();
    mock.mt.fill(0xAB, 192, 256);
    attachMockDevice(mock);

    const res = await transport.applyAdvancedBinding({
      profileIndex: 0,
      layer: 0,
      slot: SLOT_A,
      kind: 'mt',
      tapKey: TAP_A,
      holdKey: HOLD_SHIFT,
      delayMs: 155
    });
    assert.strictEqual(res.success, true, res.error);
    assert.ok(res.completedSections.includes('mtTable'));
    assert.ok(res.completedSections.includes('binding'));

    const mt = mock.mtEntry(0, 0);
    assert.deepStrictEqual(mt.tap, TAP_A);
    assert.deepStrictEqual(mt.hold, HOLD_SHIFT);
    assert.ok(mock.mt.subarray(192, 256).every((b) => b === 0xAB));
    assert.deepStrictEqual(mock.readUserKey(0, 0, SLOT_A), [146, 0, 15]);
  });

  test('TGL apply and SOCD reversed second MT entry with complementary extras priority', async () => {
    const mock = new MockGlwMemoryDevice();
    attachMockDevice(mock);

    const tglRes = await transport.applyAdvancedBinding({
      profileIndex: 0,
      layer: 0,
      slot: 0,
      kind: 'tgl',
      targetKey: TAP_A
    });
    assert.strictEqual(tglRes.success, true, tglRes.error);
    assert.deepStrictEqual(mock.readUserKey(0, 0, 0), [145, 0, 0]);

    const extrasBefore = Buffer.from(mock.extras.subarray(0, 1024));
    const socdRes = await transport.applyAdvancedBinding({
      profileIndex: 0,
      layer: 0,
      slot: SLOT_A,
      kind: 'socd',
      partnerSlot: SLOT_S,
      priority: 1
    });
    assert.strictEqual(socdRes.success, true, socdRes.error);

    const defA = getDefaultTuple(0, SLOT_A);
    const defS = getDefaultTuple(0, SLOT_S);
    const first = mock.mtEntry(0, 0);
    const second = mock.mtEntry(0, 1);
    // Index 0 was used by the TGL-only... wait TGL uses TGL table, MT table still free at 0.
    // SOCD should have used MT 0 and 1.
    assert.deepStrictEqual(first.tap, defA);
    assert.deepStrictEqual(first.hold, defS);
    assert.deepStrictEqual(second.tap, defS);
    assert.deepStrictEqual(second.hold, defA);
    assert.deepStrictEqual(mock.readUserKey(0, 0, SLOT_A), [148, 0, SLOT_S]);
    assert.deepStrictEqual(mock.readUserKey(0, 0, SLOT_S), [148, 1, SLOT_A]);
    assert.strictEqual((mock.extrasByte1(0, SLOT_A) >> 4) & 0x0F, 1);
    assert.strictEqual((mock.extrasByte1(0, SLOT_S) >> 4) & 0x0F, 2);

    // Unrelated extras slots preserved (slot 0 byte pattern)
    assert.strictEqual(mock.extras[0], extrasBefore[0]);
    assert.strictEqual(mock.extras[8], extrasBefore[8]);
  });

  test('paired SOCD removal restores both defaults and preserves orphan MT table bytes', async () => {
    const mock = new MockGlwMemoryDevice();
    attachMockDevice(mock);

    const created = await transport.applyAdvancedBinding({
      profileIndex: 0, layer: 0, slot: SLOT_A, kind: 'socd', partnerSlot: SLOT_S, priority: 0
    });
    assert.strictEqual(created.success, true, created.error);
    const mtSnapshot = Buffer.from(mock.mt.subarray(0, 256));

    const removed = await transport.removeAdvancedBinding(0, 0, SLOT_A);
    assert.strictEqual(removed.success, true, removed.error);
    assert.deepStrictEqual(mock.readUserKey(0, 0, SLOT_A), getDefaultTuple(0, SLOT_A));
    assert.deepStrictEqual(mock.readUserKey(0, 0, SLOT_S), getDefaultTuple(0, SLOT_S));
    assert.deepStrictEqual(Array.from(mock.mt.subarray(0, 256)), Array.from(mtSnapshot));
  });

  test('CB combo merges modifier+regular to type-16 and does not write MT/TGL tables', async () => {
    const mock = new MockGlwMemoryDevice();
    attachMockDevice(mock);
    mock.writtenBuffers.length = 0;

    const res = await transport.applyAdvancedBinding({
      profileIndex: 0,
      layer: 0,
      slot: SLOT_A,
      kind: 'cb',
      modifierKey: [16, 1, 0],
      regularKey: TAP_A
    });
    assert.strictEqual(res.success, true, res.error);
    assert.deepStrictEqual(mock.readUserKey(0, 0, SLOT_A), [16, 1, 4]);
    assert.strictEqual(mock.wroteCommand(protocol.COMMANDS.SET_MT_KEYS), false);
    assert.strictEqual(mock.wroteCommand(protocol.COMMANDS.SET_TGL_KEYS), false);
    assert.ok(mock.wroteCommand(protocol.COMMANDS.SET_USER_KEY_MATRIX));
    assert.ok(res.completedSections.includes('binding'));
    assert.ok(!res.completedSections.includes('mtTable'));
  });

  test('CB combo accepts compound modifier mask Ctrl+Shift+A', async () => {
    const mock = new MockGlwMemoryDevice();
    attachMockDevice(mock);
    mock.writtenBuffers.length = 0;

    const res = await transport.applyAdvancedBinding({
      profileIndex: 0,
      layer: 0,
      slot: SLOT_A,
      kind: 'cb',
      modifierKey: [16, 3, 0],
      regularKey: TAP_A
    });
    assert.strictEqual(res.success, true, res.error);
    assert.deepStrictEqual(mock.readUserKey(0, 0, SLOT_A), [16, 3, 4]);
    assert.strictEqual(mock.wroteCommand(protocol.COMMANDS.SET_MT_KEYS), false);
    assert.ok(mock.wroteCommand(protocol.COMMANDS.SET_USER_KEY_MATRIX));
  });

  test('CB over MT uses remainingRefs so shared table index is not rewritten; remove restores default', async () => {
    const mock = new MockGlwMemoryDevice();
    attachMockDevice(mock);

    const mtRes = await transport.applyAdvancedBinding({
      profileIndex: 0,
      layer: 0,
      slot: SLOT_A,
      kind: 'mt',
      tapKey: TAP_A,
      holdKey: HOLD_SHIFT,
      delayMs: 150
    });
    assert.strictEqual(mtRes.success, true, mtRes.error);
    mock.pokeUserKey(0, 2, SLOT_S, [146, 0, 15]);
    const mtSnapshot = Buffer.from(mock.mt.subarray(0, 12));

    const cbRes = await transport.applyAdvancedBinding({
      profileIndex: 0,
      layer: 0,
      slot: SLOT_A,
      kind: 'cb',
      modifierKey: [16, 8, 0],
      regularKey: [16, 0, 7]
    });
    assert.strictEqual(cbRes.success, true, cbRes.error);
    assert.deepStrictEqual(mock.readUserKey(0, 0, SLOT_A), [16, 8, 7]);
    assert.deepStrictEqual(mock.readUserKey(0, 2, SLOT_S), [146, 0, 15]);
    assert.deepStrictEqual(Array.from(mock.mt.subarray(0, 12)), Array.from(mtSnapshot));

    const removed = await transport.removeAdvancedBinding(0, 0, SLOT_A);
    assert.strictEqual(removed.success, true, removed.error);
    assert.deepStrictEqual(mock.readUserKey(0, 0, SLOT_A), getDefaultTuple(0, SLOT_A));
  });

  test('cross-layer table preservation: new MT does not rewrite another layer\'s referenced entry', async () => {
    const mock = new MockGlwMemoryDevice();
    attachMockDevice(mock);

    const first = await transport.applyAdvancedBinding({
      profileIndex: 0, layer: 0, slot: SLOT_A, kind: 'mt', tapKey: TAP_A, holdKey: HOLD_SHIFT, delayMs: 150
    });
    assert.strictEqual(first.success, true, first.error);

    const second = await transport.applyAdvancedBinding({
      profileIndex: 0, layer: 1, slot: SLOT_S, kind: 'mt', tapKey: [16, 0, 22], holdKey: HOLD_SHIFT, delayMs: 200
    });
    assert.strictEqual(second.success, true, second.error);

    const e0 = mock.mtEntry(0, 0);
    const e1 = mock.mtEntry(0, 1);
    assert.deepStrictEqual(e0.tap, TAP_A);
    assert.deepStrictEqual(e1.tap, [16, 0, 22]);
    assert.deepStrictEqual(mock.readUserKey(0, 0, SLOT_A), [146, 0, 15]);
    assert.deepStrictEqual(mock.readUserKey(0, 1, SLOT_S), [146, 1, 20]);
  });

  test('full MT table capacity fails clearly without mutating bindings', async () => {
    const mock = new MockGlwMemoryDevice();
    attachMockDevice(mock);
    const slots = [...ELIGIBLE_ADVANCED_SLOTS].slice(0, 32);

    for (let i = 0; i < 32; i++) {
      const res = await transport.applyAdvancedBinding({
        profileIndex: 0,
        layer: 0,
        slot: slots[i],
        kind: 'mt',
        tapKey: TAP_A,
        holdKey: HOLD_SHIFT,
        delayMs: 150
      });
      assert.strictEqual(res.success, true, `fill ${i} slot ${slots[i]}: ${res.error}`);
    }

    mock.writtenBuffers.length = 0;
    const extra = await transport.applyAdvancedBinding({
      profileIndex: 0,
      layer: 1,
      slot: SLOT_A,
      kind: 'mt',
      tapKey: TAP_A,
      holdKey: HOLD_SHIFT,
      delayMs: 150
    });
    assert.strictEqual(extra.success, false);
    assert.match(extra.error, /no free MT table entries/i);
    assert.strictEqual(mock.wroteCommand(protocol.COMMANDS.SET_MT_KEYS), false);
    assert.strictEqual(mock.wroteCommand(protocol.COMMANDS.SET_USER_KEY_MATRIX), false);
  });

  test('dropped MT table write is uncertain and prevents the binding write', async () => {
    const mock = new MockGlwMemoryDevice();
    mock.dropCommands.add(protocol.COMMANDS.SET_MT_KEYS);
    attachMockDevice(mock);

    const res = await transport.applyAdvancedBinding({
      profileIndex: 0, layer: 0, slot: SLOT_A, kind: 'mt', tapKey: TAP_A, holdKey: HOLD_SHIFT, delayMs: 150
    });
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.failedSection, 'mtTable');
    assert.strictEqual(res.uncertain, true);
    assert.strictEqual(mock.wroteCommand(protocol.COMMANDS.SET_USER_KEY_MATRIX), false);
    assert.deepStrictEqual(mock.readUserKey(0, 0, SLOT_A), getDefaultTuple(0, SLOT_A));
    assert.deepStrictEqual(mock.mtEntry(0, 0).tap, [0, 0, 0]);
  });

  test('table write that sticks plus dropped binding reports partial failure', async () => {
    const mock = new MockGlwMemoryDevice();
    mock.dropCommands.add(protocol.COMMANDS.SET_USER_KEY_MATRIX);
    attachMockDevice(mock);

    const res = await transport.applyAdvancedBinding({
      profileIndex: 0, layer: 0, slot: SLOT_A, kind: 'mt', tapKey: TAP_A, holdKey: HOLD_SHIFT, delayMs: 150
    });
    assert.strictEqual(res.success, false);
    assert.ok(res.completedSections.includes('mtTable'));
    assert.strictEqual(res.failedSection, 'binding');
    assert.deepStrictEqual(mock.mtEntry(0, 0).tap, TAP_A);
    assert.deepStrictEqual(mock.readUserKey(0, 0, SLOT_A), getDefaultTuple(0, SLOT_A));
  });

  test('enableProfiles(4) preserves active profile, order, and marker bytes', async () => {
    const mock = new MockGlwMemoryDevice();
    attachMockDevice(mock);
    const markers = Buffer.from(mock.base.subarray(6, 56));
    const order = Array.from(mock.base.subarray(2, 6));

    const res = await transport.enableProfiles(4);
    assert.strictEqual(res.success, true, res.error);
    assert.strictEqual(mock.base[1], 4);
    assert.strictEqual(mock.base[0], 0);
    assert.deepStrictEqual(Array.from(mock.base.subarray(2, 6)), order);
    assert.deepStrictEqual(Array.from(mock.base.subarray(6, 56)), Array.from(markers));
    assert.strictEqual(res.base.profileCount, 4);
    assert.strictEqual(res.base.activeProfile, 0);
  });

  test('setEditTarget and readLayer never send SET_BASE while hardware active profile stays 0', async () => {
    const mock = new MockGlwMemoryDevice();
    attachMockDevice(mock);

    const setRes = transport.setEditTarget(2, 2);
    assert.strictEqual(setRes.success, true);
    assert.deepStrictEqual(setRes.editTarget, { profileIndex: 2, layer: 2 });
    assert.strictEqual(setRes.activeProfileIndex, 0);

    const layerRes = await transport.readLayer(1, 0, false);
    assert.strictEqual(layerRes.success, true, layerRes.error);
    assert.strictEqual(mock.wroteCommand(protocol.COMMANDS.SET_BASE), false);
    assert.strictEqual(transport.editTarget.profileIndex, 2);
    assert.strictEqual(mock.base[0], 0);
  });

  test('readFuncConfig(1) returns profile 1 lighting/settings without SET_BASE while active is 0', async () => {
    const mock = new MockGlwMemoryDevice();
    mock.func[64 + 9] = 40;
    attachMockDevice(mock);
    mock.writtenBuffers.length = 0;

    const res = await transport.readFuncConfig(1);
    assert.strictEqual(res.success, true, res.error);
    assert.strictEqual(res.lighting.brightness, 40);
    assert.strictEqual(res.lighting.effect, 6);
    assert.strictEqual(res.settings.macMode, 0);

    const active = await transport.readFuncConfig(0);
    assert.strictEqual(active.success, true, active.error);
    assert.strictEqual(active.lighting.brightness, 100);
    assert.strictEqual(active.settings.macMode, 2);
    assert.notStrictEqual(active.lighting.effect, res.lighting.effect);

    assert.strictEqual(mock.wroteCommand(protocol.COMMANDS.SET_BASE), false);
    assert.strictEqual(mock.base[0], 0);
    const funcReads = mock.writtenBuffers.filter((b) => b[2] === protocol.COMMANDS.GET_FUNC_CONFIG);
    assert.ok(funcReads.some((b) => (b[6] | (b[7] << 8)) === 64), 'profile 1 funcConfig offset must be 64');
  });

  test('macro playback mode change updates every physical 112 binding across 16 layers; action-only does not', async () => {
    const mock = new MockGlwMemoryDevice();
    mock.pokeUserKey(0, 0, 0, [112, 0, 1]);
    mock.pokeUserKey(3, 2, SLOT_A, [112, 0, 1]);
    mock.pokeUserKey(1, 1, SLOT_S, [16, 0, 22]);
    attachMockDevice(mock);

    const modeRes = await transport.applyMacros([{ id: 0, type: 255 }]);
    assert.strictEqual(modeRes.success, true, modeRes.error);
    assert.ok(modeRes.completedSections.includes('macros'));
    assert.ok(modeRes.completedSections.includes('macroBindings'));
    assert.deepStrictEqual(mock.readUserKey(0, 0, 0), [112, 0, 255]);
    assert.deepStrictEqual(mock.readUserKey(3, 2, SLOT_A), [112, 0, 255]);
    assert.deepStrictEqual(mock.readUserKey(1, 1, SLOT_S), [16, 0, 22]);

    mock.writtenBuffers.length = 0;
    const actionRes = await transport.applyMacros([{
      id: 0,
      type: 255,
      actions: [
        { action: 'keydown', code: 4, delay: 20 },
        { action: 'keyup', code: 4, delay: 20 }
      ]
    }]);
    assert.strictEqual(actionRes.success, true, actionRes.error);
    assert.strictEqual(mock.wroteCommand(protocol.COMMANDS.SET_USER_KEY_MATRIX), false);
    assert.ok(mock.wroteCommand(protocol.COMMANDS.SET_MACROS));
  });

  test('export/import roundtrip and applyProfile partial result after a successful prior section', async () => {
    const mock = new MockGlwMemoryDevice();
    attachMockDevice(mock);

    const exported = await transport.exportProfile(0);
    assert.strictEqual(exported.success, true, exported.error);
    const schema = validators.validateProfileSchema(exported.data);
    assert.strictEqual(schema.valid, true, schema.error);

    const applied = await transport.applyProfile(exported.data, 1);
    assert.strictEqual(applied.success, true, applied.error);
    const reexport = await transport.exportProfile(1);
    assert.strictEqual(reexport.success, true, reexport.error);
    assert.strictEqual(reexport.data.settings.macMode, exported.data.settings.macMode);
    assert.strictEqual(reexport.data.advanced.mt, exported.data.advanced.mt);
    assert.deepStrictEqual(reexport.data.layers['0'][String(SLOT_A)], exported.data.layers['0'][String(SLOT_A)]);

    exported.data.macros[0].actions = [
      { action: 'keydown', code: 4, delay: 20 },
      { action: 'keyup', code: 4, delay: 20 }
    ];
    mock.dropCommands.add(protocol.COMMANDS.SET_MACROS);
    const partial = await transport.applyProfile(exported.data, 1);
    assert.strictEqual(partial.success, false);
    assert.ok(partial.completedSections.includes('lighting'));
    assert.ok(partial.completedSections.includes('settings'));
    assert.strictEqual(partial.failedSection, 'macros');
    assert.strictEqual(partial.uncertain, true);
  });

  test('malformed advanced import is rejected before any write', async () => {
    const mock = new MockGlwMemoryDevice();
    attachMockDevice(mock);

    const bad = await transport.applyProfile({
      model: 'MCHOSE G75 V2',
      protocol: 'GLW',
      version: '2.0.0',
      lighting: { effect: 0 },
      settings: { macMode: 2 },
      layers: { 0: {}, 1: {}, 2: {}, 3: {} },
      perKeyRgb: {},
      macros: [],
      advanced: { mt: 5 }
    });
    assert.strictEqual(bad.success, false);
    assert.match(bad.error, /invalid profile schema/i);
    assert.strictEqual(mock.wroteCommand(protocol.COMMANDS.SET_FUNC_CONFIG), false);
    assert.strictEqual(mock.wroteCommand(protocol.COMMANDS.SET_MT_KEYS), false);
  });

  test('generic remap of one SOCD key is rejected; restoring both defaults together is allowed', async () => {
    const mock = new MockGlwMemoryDevice();
    attachMockDevice(mock);

    const created = await transport.applyAdvancedBinding({
      profileIndex: 0, layer: 0, slot: SLOT_A, kind: 'socd', partnerSlot: SLOT_S, priority: 3
    });
    assert.strictEqual(created.success, true, created.error);

    const oneSided = await transport.applyKeymap(0, 0, [
      { slot: SLOT_A, type: 16, code1: 0, code2: 41 }
    ]);
    assert.strictEqual(oneSided.success, false);
    assert.match(oneSided.error, /Advanced/i);
    assert.deepStrictEqual(mock.readUserKey(0, 0, SLOT_A)[0], 148);
    assert.deepStrictEqual(mock.readUserKey(0, 0, SLOT_S)[0], 148);

    const defA = getDefaultTuple(0, SLOT_A);
    const defS = getDefaultTuple(0, SLOT_S);
    const both = await transport.applyKeymap(0, 0, [
      { slot: SLOT_A, type: defA[0], code1: defA[1], code2: defA[2] },
      { slot: SLOT_S, type: defS[0], code1: defS[1], code2: defS[2] }
    ]);
    assert.strictEqual(both.success, true, both.error);
    assert.deepStrictEqual(mock.readUserKey(0, 0, SLOT_A), defA);
    assert.deepStrictEqual(mock.readUserKey(0, 0, SLOT_S), defS);
  });

  test('shared MT index is not reused or rewritten when another layer still references it', async () => {
    const mock = new MockGlwMemoryDevice();
    mock.pokeUserKey(0, 0, SLOT_A, [146, 0, 15]);
    mock.pokeUserKey(0, 2, SLOT_S, [146, 0, 15]);
    mock.mt[0] = 16; mock.mt[1] = 0; mock.mt[2] = 4;
    mock.mt[3] = 16; mock.mt[4] = 1; mock.mt[5] = 0;
    attachMockDevice(mock);

    const res = await transport.applyAdvancedBinding({
      profileIndex: 0,
      layer: 0,
      slot: SLOT_A,
      kind: 'mt',
      tapKey: [16, 0, 5],
      holdKey: HOLD_SHIFT,
      delayMs: 150
    });
    assert.strictEqual(res.success, true, res.error);
    assert.deepStrictEqual(mock.mtEntry(0, 0).tap, [16, 0, 4]);
    assert.deepStrictEqual(mock.mtEntry(0, 0).hold, [16, 1, 0]);
    const newBind = mock.readUserKey(0, 0, SLOT_A);
    assert.strictEqual(newBind[0], 146);
    assert.notStrictEqual(newBind[1], 0);
    assert.deepStrictEqual(mock.readUserKey(0, 2, SLOT_S), [146, 0, 15]);
    assert.deepStrictEqual(mock.mtEntry(0, newBind[1]).tap, [16, 0, 5]);
  });

  test('shared TGL index is not rewritten; SOCD conversion does not steal an index still referenced elsewhere', async () => {
    const mock = new MockGlwMemoryDevice();
    mock.pokeUserKey(0, 0, SLOT_A, [145, 0, 0]);
    mock.pokeUserKey(0, 1, SLOT_S, [145, 0, 0]);
    mock.tgl[0] = 16; mock.tgl[1] = 0; mock.tgl[2] = 4;
    attachMockDevice(mock);

    const tglRes = await transport.applyAdvancedBinding({
      profileIndex: 0, layer: 0, slot: SLOT_A, kind: 'tgl', targetKey: [16, 0, 41]
    });
    assert.strictEqual(tglRes.success, true, tglRes.error);
    assert.deepStrictEqual(Array.from(mock.tgl.subarray(0, 3)), [16, 0, 4]);
    assert.notStrictEqual(mock.readUserKey(0, 0, SLOT_A)[1], 0);
    assert.deepStrictEqual(mock.readUserKey(0, 1, SLOT_S), [145, 0, 0]);

    mock.pokeUserKey(0, 0, SLOT_A, [146, 0, 15]);
    mock.pokeUserKey(0, 2, 8, [146, 0, 15]);
    mock.mt[0] = 16; mock.mt[1] = 0; mock.mt[2] = 4;
    mock.mt[3] = 16; mock.mt[4] = 1; mock.mt[5] = 0;
    const socdRes = await transport.applyAdvancedBinding({
      profileIndex: 0, layer: 0, slot: SLOT_A, kind: 'socd', partnerSlot: SLOT_S, priority: 0
    });
    assert.strictEqual(socdRes.success, true, socdRes.error);
    assert.deepStrictEqual(mock.mtEntry(0, 0).tap, [16, 0, 4]);
    assert.deepStrictEqual(mock.readUserKey(0, 2, 8), [146, 0, 15]);
    assert.notStrictEqual(mock.readUserKey(0, 0, SLOT_A)[1], 0);
  });

  test('malformed SOCD remove fails closed and does not wipe the unrelated partner; partner remap is allowed', async () => {
    const mock = new MockGlwMemoryDevice();
    mock.pokeUserKey(0, 0, SLOT_A, [148, 0, SLOT_S]);
    attachMockDevice(mock);
    const partnerBefore = mock.readUserKey(0, 0, SLOT_S);

    const removed = await transport.removeAdvancedBinding(0, 0, SLOT_A);
    assert.strictEqual(removed.success, false);
    assert.match(removed.error, /reciprocal|unrelated/i);
    assert.deepStrictEqual(mock.readUserKey(0, 0, SLOT_A), [148, 0, SLOT_S]);
    assert.deepStrictEqual(mock.readUserKey(0, 0, SLOT_S), partnerBefore);

    const remapPartner = await transport.applyKeymap(0, 0, [
      { slot: SLOT_S, type: 16, code1: 0, code2: 41 }
    ]);
    assert.strictEqual(remapPartner.success, true, remapPartner.error);
    assert.deepStrictEqual(mock.readUserKey(0, 0, SLOT_S), [16, 0, 41]);
    assert.deepStrictEqual(mock.readUserKey(0, 0, SLOT_A), [148, 0, SLOT_S]);
  });

  test('partial advanced import does not clobber shared table entries or extras reserved bytes', async () => {
    const mock = new MockGlwMemoryDevice();
    mock.pokeUserKey(0, 0, SLOT_A, [146, 0, 15]);
    mock.pokeUserKey(0, 2, SLOT_S, [146, 0, 15]);
    mock.mt[0] = 16; mock.mt[1] = 0; mock.mt[2] = 4;
    mock.mt[3] = 16; mock.mt[4] = 1; mock.mt[5] = 0;
    mock.mt.fill(0xAB, 192, 256);
    mock.tgl.fill(0xCD, 96, 128);
    const extrasBefore = Buffer.from(mock.extras.subarray(0, 1024));
    attachMockDevice(mock);

    const zerosMt = Buffer.alloc(256, 0).toString('hex');
    const exported = await transport.exportProfile(0);
    assert.strictEqual(exported.success, true, exported.error);
    exported.data.layers = { 0: {}, 1: {}, 2: {}, 3: {} };
    exported.data.advanced = {
      mt: zerosMt,
      tgl: exported.data.advanced.tgl,
      keyExtras: Buffer.alloc(1024, 0xff).toString('hex')
    };

    const applied = await transport.applyProfile(exported.data, 0);
    assert.strictEqual(applied.success, false);
    assert.match(applied.error, /unimported key|4 physical keymap layers/i);
    assert.deepStrictEqual(mock.mtEntry(0, 0).tap, [16, 0, 4]);
    assert.ok(mock.mt.subarray(192, 256).every((b) => b === 0xAB));
    assert.ok(mock.tgl.subarray(96, 128).every((b) => b === 0xCD));
    assert.deepStrictEqual(Array.from(mock.extras.subarray(0, 1024)), Array.from(extrasBefore));
    assert.strictEqual(mock.wroteCommand(protocol.COMMANDS.SET_MT_KEYS), false);
  });

  test('macro-mode import updates other-profile bindings; action-only import does not rewrite keys', async () => {
    const mock = new MockGlwMemoryDevice();
    mock.pokeUserKey(2, 1, SLOT_A, [112, 0, 1]);
    mock.pokeUserKey(0, 0, 0, [16, 0, 41]);
    attachMockDevice(mock);

    const exported = await transport.exportProfile(0);
    assert.strictEqual(exported.success, true, exported.error);
    exported.data.macros[0].type = 255;

    const modeImport = await transport.applyProfile(exported.data, 0);
    assert.strictEqual(modeImport.success, true, modeImport.error);
    assert.ok(modeImport.completedSections.includes('macroBindings'));
    assert.deepStrictEqual(mock.readUserKey(2, 1, SLOT_A), [112, 0, 255]);
    assert.deepStrictEqual(mock.readUserKey(0, 0, 0)[0], 16);

    mock.writtenBuffers.length = 0;
    exported.data.macros[0].actions = [
      { action: 'keydown', code: 4, delay: 20 },
      { action: 'keyup', code: 4, delay: 20 }
    ];
    exported.data.macros[0].type = 255;
    const actionImport = await transport.applyProfile(exported.data, 0);
    assert.strictEqual(actionImport.success, true, actionImport.error);
    assert.ok(!actionImport.completedSections.includes('macroBindings'));
    assert.deepStrictEqual(mock.readUserKey(2, 1, SLOT_A), [112, 0, 255]);
    assert.ok(mock.wroteCommand(protocol.COMMANDS.SET_MACROS));
  });

  test('malformed CB length 40 is rejected before any write; unrelated MT leaves customParam identical', async () => {
    const protocolParse = protocol.parseCbCustomParam;
    const malformed = Buffer.alloc(protocol.CB_CUSTOM_PARAM_LENGTH, 0);
    malformed[3] = 255;
    malformed[4] = 1;
    malformed[5] = 11;
    malformed[6] = 40;
    malformed[55] = 173;
    const parsed = protocolParse(malformed);
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /length 40/i);

    const mock = new MockGlwMemoryDevice();
    malformed.copy(mock.custom, protocol.cbCustomParamOffset(0));
    attachMockDevice(mock);
    const before = Buffer.from(mock.custom.subarray(protocol.cbCustomParamOffset(0), protocol.cbCustomParamOffset(0) + 56));

    mock.writtenBuffers.length = 0;
    const cbRes = await transport.applyAdvancedBinding({
      profileIndex: 0,
      layer: 0,
      slot: SLOT_A,
      kind: 'cb',
      modifierKey: [16, 1, 0],
      regularKey: TAP_A
    });
    assert.equal(cbRes.success, false);
    assert.match(cbRes.error, /malformed/i);
    assert.equal(mock.wroteCommand(protocol.COMMANDS.SET_USER_KEY_MATRIX), false);
    assert.equal(mock.wroteCommand(protocol.COMMANDS.SET_CUSTOM_PARAM), false);
    assert.deepEqual(
      Array.from(mock.custom.subarray(protocol.cbCustomParamOffset(0), protocol.cbCustomParamOffset(0) + 56)),
      Array.from(before)
    );

    mock.writtenBuffers.length = 0;
    const mtRes = await transport.applyAdvancedBinding({
      profileIndex: 0,
      layer: 0,
      slot: SLOT_S,
      kind: 'mt',
      tapKey: TAP_A,
      holdKey: HOLD_SHIFT,
      delayMs: 150
    });
    assert.equal(mtRes.success, true, mtRes.error);
    assert.equal(mock.wroteCommand(protocol.COMMANDS.SET_CUSTOM_PARAM), false);
    assert.deepEqual(
      Array.from(mock.custom.subarray(protocol.cbCustomParamOffset(0), protocol.cbCustomParamOffset(0) + 56)),
      Array.from(before)
    );
    assert.equal(before[55], 173);
  });

  test('clear-all restores advanced keys across four layers, preserves ordinary remaps and table reserved tails, and is not CMD 238', async () => {
    const mock = new MockGlwMemoryDevice();
    mock.mt.fill(0xAB, 192, 256);
    mock.tgl.fill(0xCD, 96, 128);
    attachMockDevice(mock);

    const mtOk = await transport.applyAdvancedBinding({
      profileIndex: 0, layer: 0, slot: SLOT_A, kind: 'mt', tapKey: TAP_A, holdKey: HOLD_SHIFT, delayMs: 150
    });
    assert.equal(mtOk.success, true, mtOk.error);
    const tglOk = await transport.applyAdvancedBinding({
      profileIndex: 0, layer: 1, slot: SLOT_S, kind: 'tgl', targetKey: TAP_A
    });
    assert.equal(tglOk.success, true, tglOk.error);
    const socdOk = await transport.applyAdvancedBinding({
      profileIndex: 0, layer: 2, slot: SLOT_A, kind: 'socd', partnerSlot: SLOT_S, priority: 1
    });
    assert.equal(socdOk.success, true, socdOk.error);
    const ordinary = [16, 1, 7];
    mock.pokeUserKey(0, 3, 0, ordinary);

    mock.writtenBuffers.length = 0;
    const cleared = await transport.clearAllAdvancedBindings({ profileIndex: 0 });
    assert.equal(cleared.success, true, cleared.error);
    assert.equal(cleared.factoryReset, false);
    assert.equal(mock.wroteCommand(protocol.COMMANDS.FACTORY_RESET), false);
    assert.deepEqual(mock.readUserKey(0, 0, SLOT_A), getDefaultTuple(0, SLOT_A));
    assert.deepEqual(mock.readUserKey(0, 1, SLOT_S), getDefaultTuple(1, SLOT_S));
    assert.deepEqual(mock.readUserKey(0, 2, SLOT_A), getDefaultTuple(2, SLOT_A));
    assert.deepEqual(mock.readUserKey(0, 2, SLOT_S), getDefaultTuple(2, SLOT_S));
    assert.deepEqual(mock.readUserKey(0, 3, 0), ordinary);
    assert.ok(mock.mt.subarray(192, 256).every((b) => b === 0xAB));
    assert.ok(mock.tgl.subarray(96, 128).every((b) => b === 0xCD));
    const extras = protocol.parseKeyExtras(mock.extras.subarray(0, 1024));
    assert.equal(extras[SLOT_A].priority, 0);
    assert.equal(extras[SLOT_S].priority, 0);
  });

  test('clear-all reports partial extras success when a later binding write is dropped', async () => {
    const mock = new MockGlwMemoryDevice();
    attachMockDevice(mock);
    const socdOk = await transport.applyAdvancedBinding({
      profileIndex: 0, layer: 0, slot: SLOT_A, kind: 'socd', partnerSlot: SLOT_S, priority: 2
    });
    assert.equal(socdOk.success, true, socdOk.error);
    mock.writtenBuffers.length = 0;
    mock.dropCommands.add(protocol.COMMANDS.SET_USER_KEY_MATRIX);
    const cleared = await transport.clearAllAdvancedBindings({ profileIndex: 0 });
    assert.equal(cleared.success, false);
    assert.ok(Array.isArray(cleared.completedSections));
    assert.ok(cleared.completedSections.includes('keyExtras'));
    assert.match(String(cleared.failedSection || ''), /binding/);
    assert.equal(mock.wroteCommand(protocol.COMMANDS.FACTORY_RESET), false);
  });

  test('local snapshot apply implements MT/TGL/SOCD/CB with zero HID and rejects asymmetric SOCD remove', () => {
    const advancedPlan = require('../src/advanced-plan.cjs');
    const { getDefaultLayersData } = require('../src/layout-g75v2.cjs');
    const defaults = getDefaultLayersData();
    const snapshot = {
      layers: { 0: {}, 1: {}, 2: {}, 3: {} },
      advanced: {}
    };
    const mt = advancedPlan.applyAdvancedToLocalSnapshot(snapshot, {
      profileIndex: 0, layer: 0, slot: SLOT_A, kind: 'mt', tapKey: TAP_A, holdKey: HOLD_SHIFT, delayMs: 150
    }, defaults);
    assert.equal(mt.success, true, mt.error);
    assert.equal(mt.hardwareWrites, 0);
    assert.equal(mt.layers[0][SLOT_A].type, 146);

    const tgl = advancedPlan.applyAdvancedToLocalSnapshot({ layers: mt.layers, advanced: mt.advanced }, {
      profileIndex: 0, layer: 0, slot: SLOT_S, kind: 'tgl', targetKey: TAP_A
    }, defaults);
    assert.equal(tgl.success, true, tgl.error);
    assert.equal(tgl.layers[0][SLOT_S].type, 145);

    const cb = advancedPlan.applyAdvancedToLocalSnapshot({ layers: tgl.layers, advanced: tgl.advanced }, {
      profileIndex: 0, layer: 1, slot: SLOT_A, kind: 'cb', modifierKey: [16, 1, 0], regularKey: TAP_A
    }, defaults);
    assert.equal(cb.success, true, cb.error);
    assert.equal(cb.layers[1][SLOT_A].type, 16);
    assert.equal(cb.layers[1][SLOT_A].code1, 1);
    assert.ok(cb.customParam.cbKeyIndexList[1].includes(SLOT_A));

    const socd = advancedPlan.applyAdvancedToLocalSnapshot({ layers: cb.layers, advanced: cb.advanced }, {
      profileIndex: 0, layer: 2, slot: SLOT_A, kind: 'socd', partnerSlot: SLOT_S, priority: 1
    }, defaults);
    assert.equal(socd.success, true, socd.error);
    assert.equal(socd.layers[2][SLOT_A].type, 148);
    assert.equal(socd.layers[2][SLOT_S].type, 148);
    assert.equal(socd.keyExtras[SLOT_A].priority, 1);
    assert.equal(socd.keyExtras[SLOT_S].priority, 2);

    const broken = {
      layers: {
        0: { 11: { type: 148, code1: 0, code2: 19 }, 19: { type: 16, code1: 0, code2: 22 } },
        1: {},
        2: {},
        3: {}
      },
      advanced: socd.advanced
    };
    const removed = advancedPlan.applyAdvancedToLocalSnapshot(broken, {
      profileIndex: 0, layer: 0, slot: 11, kind: 'remove'
    }, defaults);
    assert.equal(removed.success, false);
    assert.match(removed.error, /reciprocal|unrelated/i);
    assert.equal(removed.hardwareWrites, 0);
  });

  test('clear-all rejects malformed customParam instead of succeeding with unknown CB membership', async () => {
    const advancedPlan = require('../src/advanced-plan.cjs');
    const malformed = Buffer.alloc(protocol.CB_CUSTOM_PARAM_LENGTH, 0);
    malformed[3] = 255;
    malformed[4] = 1;
    malformed[5] = 11;
    malformed[6] = 40;
    malformed[55] = 173;
    const layer0 = Buffer.alloc(protocol.USED_KEY_AREA_SIZE, 0);
    layer0[11 * 3] = 16;
    layer0[11 * 3 + 1] = 1;
    layer0[11 * 3 + 2] = 4;
    const planned = advancedPlan.planClearAllAdvanced({
      layerBuffers: [layer0, Buffer.alloc(protocol.USED_KEY_AREA_SIZE, 0), Buffer.alloc(protocol.USED_KEY_AREA_SIZE, 0), Buffer.alloc(protocol.USED_KEY_AREA_SIZE, 0)],
      extrasBuf: Buffer.alloc(protocol.KEY_EXTRAS_SIZE, 0),
      customBuf: malformed,
      defaultLayers: require('../src/layout-g75v2.cjs').getDefaultLayersData()
    });
    assert.equal(planned.ok, false);
    assert.equal(planned.customValid, false);
    assert.match(planned.error, /malformed|membership/i);

    const mock = new MockGlwMemoryDevice();
    malformed.copy(mock.custom, protocol.cbCustomParamOffset(0));
    mock.pokeUserKey(0, 0, SLOT_A, [16, 1, 4]);
    attachMockDevice(mock);
    mock.writtenBuffers.length = 0;
    const cleared = await transport.clearAllAdvancedBindings({ profileIndex: 0 });
    assert.equal(cleared.success, false);
    assert.match(cleared.error, /malformed|membership/i);
    assert.equal(mock.wroteCommand(protocol.COMMANDS.SET_USER_KEY_MATRIX), false);
    assert.equal(mock.wroteCommand(protocol.COMMANDS.SET_CUSTOM_PARAM), false);
    assert.deepEqual(mock.readUserKey(0, 0, SLOT_A), [16, 1, 4]);
  });

  test('replacing a reciprocal SOCD pair with MT clears old pair extras priorities', async () => {
    const mock = new MockGlwMemoryDevice();
    attachMockDevice(mock);
    const socdOk = await transport.applyAdvancedBinding({
      profileIndex: 0, layer: 0, slot: SLOT_A, kind: 'socd', partnerSlot: SLOT_S, priority: 1
    });
    assert.equal(socdOk.success, true, socdOk.error);
    let extras = protocol.parseKeyExtras(mock.extras.subarray(0, 1024));
    assert.equal(extras[SLOT_A].priority, 1);
    assert.equal(extras[SLOT_S].priority, 2);

    const mtOk = await transport.applyAdvancedBinding({
      profileIndex: 0,
      layer: 0,
      slot: SLOT_A,
      kind: 'mt',
      tapKey: TAP_A,
      holdKey: [16, 0, 5],
      delayMs: 150
    });
    assert.equal(mtOk.success, true, mtOk.error);
    assert.equal(mock.readUserKey(0, 0, SLOT_A)[0], 146);
    assert.deepEqual(mock.readUserKey(0, 0, SLOT_S), getDefaultTuple(0, SLOT_S));
    extras = protocol.parseKeyExtras(mock.extras.subarray(0, 1024));
    assert.equal(extras[SLOT_A].priority, 0);
    assert.equal(extras[SLOT_S].priority, 0);
  });

  test('truncated local advanced tables are rejected instead of zero-padded', () => {
    const advancedPlan = require('../src/advanced-plan.cjs');
    const { getDefaultLayersData } = require('../src/layout-g75v2.cjs');
    const res = advancedPlan.applyAdvancedToLocalSnapshot({
      layers: { 0: {}, 1: {}, 2: {}, 3: {} },
      advanced: { mt: 'aabb' }
    }, {
      profileIndex: 0, layer: 0, slot: SLOT_A, kind: 'mt', tapKey: TAP_A, holdKey: HOLD_SHIFT, delayMs: 150
    }, getDefaultLayersData());
    assert.equal(res.success, false);
    assert.match(res.error, /incomplete/i);
    assert.equal(res.hardwareWrites, 0);
  });
});
