const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { G75_V2_KEYS, G75_V2_LAYOUT_ENTRIES, SPACE_LIGHTING_ZONES, G75_V2_LIGHTING_ENTRIES, REMAP_CATEGORIES, getRemapCategories, G75_PALETTE_SETS, LIGHT_EFFECTS, SIDE_LIGHT_EFFECTS, LIGHT_EFFECT_DISPLAY_ORDER, LIGHT_EFFECT_PRESET_ORDER, SIDE_LIGHT_DISPLAY_ORDER, LIGHT_DIRECTION_PAIRS, getMainPresetEffects, getSidePresetEffects, getLightEffectById, getDirectionPair, VALID_PHYSICAL_SLOTS, VALID_LIGHTING_SLOTS, ELIGIBLE_ADVANCED_SLOTS, SOCD_PRIORITIES, getComplementPriority, getDefaultTuple } = require('../src/layout-g75v2.cjs');
const protocol = require('../src/protocol.cjs');
const validators = require('../src/schema-validators.cjs');

describe('G75 V2 Physical Layout & Capabilities', () => {
  test('has 85 vendor layout entries, minus 3 lighting-only zones yields 82 physical elements', () => {
    assert.strictEqual(G75_V2_LAYOUT_ENTRIES.length, 85, 'Vendor source defines exactly 85 entries');
    assert.strictEqual(G75_V2_KEYS.length, 82, 'Excluding 3 lighting-only entries yields exactly 82 physical elements');
    assert.strictEqual(SPACE_LIGHTING_ZONES.length, 3, 'Spacebar has 3 split RGB lighting zones');
    // Knob slot 37 has no addressable LED; total lighting count is 83 (not 84)
    assert.strictEqual(G75_V2_LIGHTING_ENTRIES.length, 83, 'Total lighting entries is 83');
    assert.strictEqual(VALID_LIGHTING_SLOTS.has(37), false, 'Knob slot 37 has no LED');
    assert.strictEqual(VALID_LIGHTING_SLOTS.size, 83);

    // Advanced MT / TGL / SOCD assignment excludes BOTH Fn (slot 85) and Knob (slot 37)
    assert.strictEqual(ELIGIBLE_ADVANCED_SLOTS.size, 80, 'Exactly 80 physical keys are eligible for advanced assignment');
    assert.strictEqual(ELIGIBLE_ADVANCED_SLOTS.has(37), false);
    assert.strictEqual(ELIGIBLE_ADVANCED_SLOTS.has(85), false);

    // Verify SOCD priorities and complementary logic
    assert.strictEqual(SOCD_PRIORITIES.length, 4);
    assert.strictEqual(getComplementPriority(0), 0);
    assert.strictEqual(getComplementPriority(1), 2);
    assert.strictEqual(getComplementPriority(2), 1);
    assert.strictEqual(getComplementPriority(3), 3);

    // Verify 3 space lighting zones match slots 45, 53, 61
    assert.strictEqual(SPACE_LIGHTING_ZONES[0].slot, 45);
    assert.strictEqual(SPACE_LIGHTING_ZONES[1].slot, 53);
    assert.strictEqual(SPACE_LIGHTING_ZONES[2].slot, 61);

    const knob = G75_V2_KEYS.find(k => k.isKnob);
    assert.notStrictEqual(knob, undefined);
    assert.strictEqual(knob.id, 'k_knob');
    assert.strictEqual(knob.name, 'Knob');
    assert.strictEqual(knob.slot, 37);
    assert.ok(Math.abs(knob.x - 18.02) < 0.1);
    assert.ok(Math.abs(knob.y - 5.26) < 0.1);
    assert.ok(Math.abs(knob.w - 0.2857) < 0.01, 'Knob geometry is slim vertical sidewheel w=0.2857');
  });

  test('all keys have unique non-empty string IDs and unique firmware slots', () => {
    const ids = new Set();
    const slots = new Set();
    for (const key of G75_V2_KEYS) {
      assert.strictEqual(typeof key.id, 'string');
      assert.ok(key.id.length > 0);
      assert.strictEqual(ids.has(key.id), false, `Duplicate key ID: ${key.id}`);
      ids.add(key.id);

      assert.ok(Number.isInteger(key.slot) && key.slot >= 0 && key.slot < 128);
      assert.strictEqual(slots.has(key.slot), false, `Duplicate key slot: ${key.slot}`);
      slots.add(key.slot);
    }
    assert.strictEqual(VALID_PHYSICAL_SLOTS.size, 82);
  });

  test('crucial key positions and slot mappings match immutable hardware default matrix', () => {
    const esc = G75_V2_KEYS.find(k => k.id === 'k_esc');
    assert.strictEqual(esc.slot, 0);
    assert.strictEqual(esc.code, 41);

    const f1 = G75_V2_KEYS.find(k => k.id === 'k_f1');
    assert.strictEqual(f1.slot, 8);
    assert.strictEqual(f1.code, 58);

    const a = G75_V2_KEYS.find(k => k.id === 'k_a');
    assert.strictEqual(a.slot, 11);
    assert.strictEqual(a.code, 4);

    const space = G75_V2_KEYS.find(k => k.id === 'k_space');
    assert.strictEqual(space.slot, 53);
    assert.strictEqual(space.code, 44);

    const fn = G75_V2_KEYS.find(k => k.id === 'k_fn');
    assert.strictEqual(fn.slot, 85);
    assert.strictEqual(fn.code, 255);

    const knob = G75_V2_KEYS.find(k => k.id === 'k_knob');
    assert.strictEqual(knob.slot, 37);

    // Top-right key is Home (slot 14), End below it (slot 22)
    const home = G75_V2_KEYS.find(k => k.id === 'k_home');
    assert.strictEqual(home.slot, 14);
    assert.ok(home.x > 16);

    const end = G75_V2_KEYS.find(k => k.id === 'k_end');
    assert.strictEqual(end.slot, 22);
    assert.ok(end.x > 16);
    assert.ok(end.y > home.y);
  });

  test('contains all 23 official RGB lighting effects from vendor bundle', () => {
    assert.strictEqual(LIGHT_EFFECTS.length, 23);
    for (let i = 0; i < 23; i++) {
      const effect = LIGHT_EFFECTS[i];
      assert.strictEqual(effect.id, i);
      assert.strictEqual(effect.key, `light-${i}`);
      assert.ok(typeof effect.name === 'string' && effect.name.length > 0);
      assert.ok(Array.isArray(effect.kinds));
      assert.equal(typeof effect.brightness, 'boolean');
      assert.equal(typeof effect.speed, 'boolean');
      assert.equal(typeof effect.color, 'boolean');
    }

    assert.strictEqual(LIGHT_EFFECTS[0].name, 'Custom');
    assert.deepStrictEqual(LIGHT_EFFECTS[0].kinds, ['still', 'gif']);
    assert.strictEqual(LIGHT_EFFECTS[0].speed, false);
    assert.strictEqual(LIGHT_EFFECTS[1].name, 'RainbowCycle');
    assert.strictEqual(LIGHT_EFFECTS[1].color, false);
    assert.strictEqual(LIGHT_EFFECTS[2].name, 'Linear Grad');
    assert.strictEqual(LIGHT_EFFECTS[6].direction, 'row');
    assert.strictEqual(LIGHT_EFFECTS[7].direction, 'col');
    assert.strictEqual(LIGHT_EFFECTS[8].direction, 'spiral');
    assert.strictEqual(LIGHT_EFFECTS[10].direction, 'clock');
    assert.strictEqual(LIGHT_EFFECTS[16].name, 'Key Firework');
    assert.strictEqual(LIGHT_EFFECTS[17].name, 'Key Beam');
    assert.strictEqual(LIGHT_EFFECTS[22].name, 'Triangle Bounce');
    assert.strictEqual(getLightEffectById(23), null);
  });

  test('main preset grid is 22 official tiles; Custom is separate; no Off/-1 tile', () => {
    assert.deepStrictEqual(
      LIGHT_EFFECT_DISPLAY_ORDER,
      [0, 6, 7, 8, 9, 4, 1, 5, 3, 2, 11, 12, 10, 18, 19, 20, 21, 22, 14, 13, 15, 16, 17]
    );
    assert.strictEqual(LIGHT_EFFECT_PRESET_ORDER.length, 22);
    assert.equal(LIGHT_EFFECT_PRESET_ORDER.includes(0), false);
    const presets = getMainPresetEffects();
    assert.strictEqual(presets.length, 22);
    assert.deepStrictEqual(presets.map((e) => e.name), [
      'Horiz Wave', 'Vert Wave', 'Center Spread', 'Star Twinkle', 'Breath', 'RainbowCycle',
      'Disco', 'Constant On', 'Linear Grad', 'Bottom Up', 'Recip Rebound', 'Center Spin',
      'Diag Flow', 'Laser Rain', 'Dot Twinkle', 'Fireworks', 'Triangle Bounce', 'Solid Ripple',
      'Key Ripple', 'Key Trail', 'Key Firework', 'Key Beam'
    ]);
    assert.equal(presets.some((e) => e.id === -1 || e.name === 'Off'), false);
  });

  test('contains all 4 official side lighting effects', () => {
    assert.strictEqual(SIDE_LIGHT_EFFECTS.length, 4);
    assert.deepStrictEqual(SIDE_LIGHT_DISPLAY_ORDER, [1, 2, 3, 4]);
    const side = getSidePresetEffects();
    assert.deepStrictEqual(side.map((e) => e.name), ['RainbowCycle', 'Constant On', 'Breath', 'Off']);
    assert.strictEqual(side[0].color, false);
    assert.strictEqual(side[1].speed, false);
    assert.strictEqual(side[3].brightness, false);
    assert.strictEqual(side[3].speed, false);
    assert.strictEqual(side[3].color, false);
  });

  test('model capabilities match independent G75 lighting fixture, not a self-copy', () => {
    const expected = require('./fixtures/g75-lighting-capabilities.json');
    assert.strictEqual(expected.main.length, 23);
    assert.strictEqual(expected.side.length, 4);
    for (const row of expected.main) {
      const got = getLightEffectById(row.id);
      assert.ok(got, `missing main effect ${row.id}`);
      assert.strictEqual(got.name, row.name);
      assert.strictEqual(got.brightness, row.brightness);
      assert.strictEqual(got.speed, row.speed);
      assert.strictEqual(got.color, row.color);
      assert.strictEqual(got.direction || null, row.direction);
    }
    for (const row of expected.side) {
      const got = SIDE_LIGHT_EFFECTS.find((e) => e.id === row.id);
      assert.ok(got, `missing side effect ${row.id}`);
      assert.strictEqual(got.name, row.name);
      assert.strictEqual(got.brightness, row.brightness);
      assert.strictEqual(got.speed, row.speed);
      assert.strictEqual(got.color, row.color);
    }
    assert.deepStrictEqual(LIGHT_EFFECT_PRESET_ORDER, expected.mainPresetOrder);
    assert.deepStrictEqual(SIDE_LIGHT_DISPLAY_ORDER, expected.sideOrder);
  });

  test('GLW direction pairs are four families of value 0/1', () => {
    assert.deepStrictEqual(getDirectionPair('row'), { 0: 'Left to Right', 1: 'Right to Left' });
    assert.deepStrictEqual(LIGHT_DIRECTION_PAIRS.col, { 0: 'From top to bottom', 1: 'From bottom to top' });
    assert.deepStrictEqual(LIGHT_DIRECTION_PAIRS.spiral, { 0: 'From the inside out', 1: 'From the outside in' });
    assert.deepStrictEqual(LIGHT_DIRECTION_PAIRS.clock, { 0: 'Rotate counterclockwise', 1: 'Rotate clockwise' });
    assert.equal(getDirectionPair('qhw'), null);
  });

  test('remap categories expose exact 6 visible G75 categories and preserve backward compatibility aliases', () => {
    const categories = Object.keys(REMAP_CATEGORIES);
    assert.deepStrictEqual(categories, ['Basic', 'Mouse', 'Media', 'Main Lighting', 'Side Lighting', 'Extended']);

    // Non-enumerable backward compatibility getters
    assert.ok(Array.isArray(REMAP_CATEGORIES['Lighting']));
    assert.strictEqual(REMAP_CATEGORIES['Lighting'].length, 17);
    assert.ok(Array.isArray(REMAP_CATEGORIES['Media & Audio']));
    assert.strictEqual(REMAP_CATEGORIES['Media & Audio'].length, 7);
    assert.ok(Array.isArray(REMAP_CATEGORIES['Extended Func']));
    assert.strictEqual(REMAP_CATEGORIES['Extended Func'].length, 50);
    assert.ok(Array.isArray(REMAP_CATEGORIES['Special & Extra']));
    assert.strictEqual(REMAP_CATEGORIES['Special & Extra'].length, 50);

    // Visible palette excludes generic reset, battery, and pairing commands
    for (const cat of categories) {
      for (const item of REMAP_CATEGORIES[cat]) {
        assert.doesNotMatch(item.label, /Factory Reset|Show Battery|Pairing|Bluetooth|Win OS Switch|Mac OS Switch/i);
      }
    }
  });

  test('layer-aware palette produces exact tuple sets across all 4 layers', () => {
    // Layer 0: Windows Default (185 total items)
    const l0 = getRemapCategories(0);
    assert.strictEqual(l0['Basic'].length, 104);
    assert.strictEqual(l0['Mouse'].length, 7);
    assert.strictEqual(l0['Media'].length, 7);
    assert.strictEqual(l0['Main Lighting'].length, 9);
    assert.strictEqual(l0['Side Lighting'].length, 8);
    assert.strictEqual(l0['Extended'].length, 50);
    const l0Total = Object.values(l0).reduce((sum, arr) => sum + arr.length, 0);
    assert.strictEqual(l0Total, 185);

    // Layer 0 Extended includes 47 Windows shortcuts, SwitchProfile, Clear, and Win Fn
    assert.ok(l0['Extended'].some(k => k.label === 'Switch Profile' && k.type === 240 && k.code1 === 250 && k.code2 === 0));
    assert.ok(l0['Extended'].some(k => k.label === 'Clear' && k.type === 16 && k.code1 === 0 && k.code2 === 0));
    assert.ok(l0['Extended'].some(k => k.label === 'FN Layer' && k.type === 240 && k.code1 === 255 && k.code2 === 1));

    // Layer 1: Windows Fn (184 total items, no Fn key)
    const l1 = getRemapCategories(1);
    assert.strictEqual(l1['Basic'].length, 104);
    assert.strictEqual(l1['Mouse'].length, 7);
    assert.strictEqual(l1['Media'].length, 7);
    assert.strictEqual(l1['Main Lighting'].length, 9);
    assert.strictEqual(l1['Side Lighting'].length, 8);
    assert.strictEqual(l1['Extended'].length, 49);
    const l1Total = Object.values(l1).reduce((sum, arr) => sum + arr.length, 0);
    assert.strictEqual(l1Total, 184);
    assert.strictEqual(l1['Extended'].some(k => k.label === 'FN Layer'), false, 'Fn key must be omitted on Fn layer 1');

    // Layer 2: Mac Default (169 total items: Media omits Stop 183; Extended has 32 Mac shortcuts + SwitchProfile + Clear + Mac Fn)
    const l2 = getRemapCategories(2);
    assert.strictEqual(l2['Basic'].length, 104);
    assert.strictEqual(l2['Mouse'].length, 7);
    assert.strictEqual(l2['Media'].length, 6);
    assert.strictEqual(l2['Media'].some(k => k.code1 === 183), false, 'Stop (183) must be filtered out on Mac layer');
    assert.strictEqual(l2['Main Lighting'].length, 9);
    assert.strictEqual(l2['Side Lighting'].length, 8);
    assert.strictEqual(l2['Extended'].length, 35);
    const l2Total = Object.values(l2).reduce((sum, arr) => sum + arr.length, 0);
    assert.strictEqual(l2Total, 169);
    assert.ok(l2['Extended'].some(k => k.label === 'FN Layer' && k.type === 240 && k.code1 === 255 && k.code2 === 3));

    // Layer 3: Mac Fn (168 total items, no Fn key)
    const l3 = getRemapCategories(3);
    assert.strictEqual(l3['Basic'].length, 104);
    assert.strictEqual(l3['Mouse'].length, 7);
    assert.strictEqual(l3['Media'].length, 6);
    assert.strictEqual(l3['Main Lighting'].length, 9);
    assert.strictEqual(l3['Side Lighting'].length, 8);
    assert.strictEqual(l3['Extended'].length, 34);
    const l3Total = Object.values(l3).reduce((sum, arr) => sum + arr.length, 0);
    assert.strictEqual(l3Total, 168);
    assert.strictEqual(l3['Extended'].some(k => k.label === 'FN Layer'), false, 'Fn key must be omitted on Fn layer 3');
  });

  test('packed 24-bit decomposition matches vendor source reference', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const refPath = path.join(__dirname, 'fixtures', 'maicong-g75-palette-reference.json');
    assert.ok(fs.existsSync(refPath), 'maicong-g75-palette-reference.json fixture must exist');
    const ref = JSON.parse(fs.readFileSync(refPath, 'utf8'));

    function decomp(val) {
      let type = (val >> 16) & 0xff;
      let code1 = (val >> 8) & 0xff;
      let code2 = val & 0xff;
      if (code1 === 255) type = 240;
      return [type, code1, code2];
    }

    // Verify basic
    assert.strictEqual(ref.basic.length, G75_PALETTE_SETS.basic104.length);
    for (let i = 0; i < ref.basic.length; i++) {
      const expected = decomp(ref.basic[i]);
      const actual = [G75_PALETTE_SETS.basic104[i].type, G75_PALETTE_SETS.basic104[i].code1, G75_PALETTE_SETS.basic104[i].code2];
      assert.deepStrictEqual(actual, expected, `basic[${i}] decomposition mismatch`);
    }

    // Verify mouse
    assert.strictEqual(ref.mouse.length, G75_PALETTE_SETS.mouse7.length);
    for (let i = 0; i < ref.mouse.length; i++) {
      const expected = decomp(ref.mouse[i]);
      const actual = [G75_PALETTE_SETS.mouse7[i].type, G75_PALETTE_SETS.mouse7[i].code1, G75_PALETTE_SETS.mouse7[i].code2];
      assert.deepStrictEqual(actual, expected, `mouse[${i}] decomposition mismatch`);
    }

    // Verify mainLighting
    assert.strictEqual(ref.mainLighting.length, G75_PALETTE_SETS.mainLighting9.length);
    for (let i = 0; i < ref.mainLighting.length; i++) {
      const expected = decomp(ref.mainLighting[i]);
      const actual = [G75_PALETTE_SETS.mainLighting9[i].type, G75_PALETTE_SETS.mainLighting9[i].code1, G75_PALETTE_SETS.mainLighting9[i].code2];
      assert.deepStrictEqual(actual, expected, `mainLighting[${i}] decomposition mismatch`);
    }

    // Verify sideLighting
    assert.strictEqual(ref.sideLighting.length, G75_PALETTE_SETS.sideLighting8.length);
    for (let i = 0; i < ref.sideLighting.length; i++) {
      const expected = decomp(ref.sideLighting[i]);
      const actual = [G75_PALETTE_SETS.sideLighting8[i].type, G75_PALETTE_SETS.sideLighting8[i].code1, G75_PALETTE_SETS.sideLighting8[i].code2];
      assert.deepStrictEqual(actual, expected, `sideLighting[${i}] decomposition mismatch`);
    }

    // Verify windowsExtra
    assert.strictEqual(ref.windowsExtra.length, G75_PALETTE_SETS.windowsExtra47.length);
    for (let i = 0; i < ref.windowsExtra.length; i++) {
      const expected = decomp(ref.windowsExtra[i]);
      const actual = [G75_PALETTE_SETS.windowsExtra47[i].type, G75_PALETTE_SETS.windowsExtra47[i].code1, G75_PALETTE_SETS.windowsExtra47[i].code2];
      assert.deepStrictEqual(actual, expected, `windowsExtra[${i}] decomposition mismatch`);
    }

    // Verify macExtra
    assert.strictEqual(ref.macExtra.length, G75_PALETTE_SETS.macExtra32.length);
    for (let i = 0; i < ref.macExtra.length; i++) {
      const expected = decomp(ref.macExtra[i]);
      const actual = [G75_PALETTE_SETS.macExtra32[i].type, G75_PALETTE_SETS.macExtra32[i].code1, G75_PALETTE_SETS.macExtra32[i].code2];
      assert.deepStrictEqual(actual, expected, `macExtra[${i}] decomposition mismatch`);
    }
  });

  test('macro keyboard and CB regular selectors strictly exclude nonkeyboard items and chords', () => {
    const { isMacroKeyboardItem } = require('../src/macro-draft.js');

    // Standard keys and single modifiers are allowed in macro keyboard item selector
    assert.strictEqual(isMacroKeyboardItem({ type: 16, code1: 0, code2: 4, code: 4, label: 'A' }), true);
    assert.strictEqual(isMacroKeyboardItem({ type: 16, code1: 1, code2: 0, code: 224, label: 'Left Ctrl' }), true);
    assert.strictEqual(isMacroKeyboardItem({ type: 16, code1: 2, code2: 0, code: 225, label: 'Left Shift' }), true);
    assert.strictEqual(isMacroKeyboardItem({ type: 16, code1: 128, code2: 0, code: 231, label: 'Right GUI / Win' }), true);

    // Chords (code1 > 0 && code2 > 0) are strictly excluded from macro keyboard item selector
    assert.strictEqual(isMacroKeyboardItem({ type: 16, code1: 1, code2: 6, code: 6, label: 'Copy' }), false);
    assert.strictEqual(isMacroKeyboardItem({ type: 16, code1: 8, code2: 21, code: 21, label: 'Run' }), false);

    // Non-keyboard types are strictly excluded
    assert.strictEqual(isMacroKeyboardItem({ type: 32, code1: 1, code2: 0, code: 1, label: 'Mouse Left' }), false);
    assert.strictEqual(isMacroKeyboardItem({ type: 33, code1: 0, code2: 1, code: 1, label: 'Mouse Wheel Up' }), false);
    assert.strictEqual(isMacroKeyboardItem({ type: 48, code1: 226, code2: 0, code: 226, label: 'Mute' }), false);
    assert.strictEqual(isMacroKeyboardItem({ type: 240, code1: 47, code2: 0, code: 47, label: 'Backlight Mode +' }), false);
    assert.strictEqual(isMacroKeyboardItem({ type: 240, code1: 250, code2: 0, code: 250, label: 'Switch Profile' }), false);
    assert.strictEqual(isMacroKeyboardItem({ type: 240, code1: 255, code2: 1, code: 255, label: 'FN Layer' }), false);
    assert.strictEqual(isMacroKeyboardItem({ type: 16, code1: 0, code2: 0, code: 0, label: 'Clear' }), false);
  });

  test('legacy tuple decode/import compatibility and special commands roundtrip safely', () => {
    // Disabled [0, 0, 0]
    const disabledDec = protocol.decodeKeyTuple([0, 0, 0]);
    assert.strictEqual(disabledDec.type, 0);
    assert.strictEqual(disabledDec.label, 'Disabled');

    // Clear [16, 0, 0]
    const clearDec = protocol.decodeKeyTuple([16, 0, 0]);
    assert.strictEqual(clearDec.type, 16);
    assert.strictEqual(clearDec.label, 'Clear');

    // Switch Profile [240, 250, 0]
    const profDec = protocol.decodeKeyTuple([240, 250, 0]);
    assert.strictEqual(profDec.type, 240);
    assert.strictEqual(profDec.label, 'Switch Profile');

    // FN Layer Win [240, 255, 1] and Mac [240, 255, 3]
    const fnWinDec = protocol.decodeKeyTuple([240, 255, 1]);
    assert.strictEqual(fnWinDec.type, 240);
    assert.strictEqual(fnWinDec.label, 'FN Layer');
    const fnMacDec = protocol.decodeKeyTuple([240, 255, 3]);
    assert.strictEqual(fnMacDec.type, 240);
    assert.strictEqual(fnMacDec.label, 'FN Layer');

    // Shortcut chords decode to human readable labels
    const copyDec = protocol.decodeKeyTuple([16, 1, 6]);
    assert.strictEqual(copyDec.label, 'Copy');
    const pasteDec = protocol.decodeKeyTuple([16, 1, 25]);
    assert.strictEqual(pasteDec.label, 'Paste');
    const runDec = protocol.decodeKeyTuple([16, 8, 21]);
    assert.strictEqual(runDec.label, 'Run');

    // Onboard special hardware tuples decode cleanly without crashing
    const resetDec = protocol.decodeKeyTuple([240, 8, 0]);
    assert.strictEqual(resetDec.type, 240);
    const battDec = protocol.decodeKeyTuple([240, 11, 0]);
    assert.strictEqual(battDec.type, 240);
    const pairDec = protocol.decodeKeyTuple([240, 31, 0]);
    assert.strictEqual(pairDec.type, 240);

    // Schema validation enforces strict rejection on malformed writes
    const badType = validators.validateKeymapUpdates([{ slot: 11, type: 99, code1: 0, code2: 4 }]);
    assert.strictEqual(badType.valid, false);
    const badSlot = validators.validateKeymapUpdates([{ slot: 125, type: 16, code1: 0, code2: 4 }]);
    assert.strictEqual(badSlot.valid, false);
    const badCode = validators.validateKeymapUpdates([{ slot: 11, type: 16, code1: 0, code2: 300 }]);
    assert.strictEqual(badCode.valid, false);
  });

  test('mock apply and readback verification for mouse tuples, chords, and advanced bindings', async () => {
    const transport = require('../src/transport.cjs');
    const { MockGlwMemoryDevice } = require('./mock-glw-memory.cjs');
    const baseline = require('./fixtures/readonly-baseline.json');

    const mock = new MockGlwMemoryDevice({ baseline });
    transport.device = mock;
    transport.lastState.connected = true;
    transport.needsReconnect = false;
    mock.on('data', data => transport.handleIncomingData(data));

    // 1. Mouse button apply and readback (Slot 11: Key A)
    const mouseRes = await transport.applyKeymap(0, 0, [{ slot: 11, type: 32, code1: 1, code2: 0 }]);
    assert.strictEqual(mouseRes.success, true);
    const readMouse = await transport.readLayer(0, 0);
    assert.strictEqual(readMouse.success, true);
    const mouseKey = readMouse.keys.find(k => k.index === 11);
    assert.strictEqual(mouseKey.type, 32);
    assert.strictEqual(mouseKey.code1, 1);
    assert.strictEqual(mouseKey.code2, 0);

    // 2. Mouse wheel apply and readback (Slot 13: Left Win)
    const wheelRes = await transport.applyKeymap(0, 0, [{ slot: 13, type: 33, code1: 0, code2: 1 }]);
    assert.strictEqual(wheelRes.success, true);
    const readWheel = await transport.readLayer(0, 0);
    const wheelKey = readWheel.keys.find(k => k.index === 13);
    assert.strictEqual(wheelKey.type, 33);
    assert.strictEqual(wheelKey.code2, 1);

    // 3. Shortcut chord apply and readback (Slot 14: Home)
    const chordRes = await transport.applyKeymap(0, 0, [{ slot: 14, type: 16, code1: 1, code2: 6 }]);
    assert.strictEqual(chordRes.success, true);
    const readChord = await transport.readLayer(0, 0);
    const chordKey = readChord.keys.find(k => k.index === 14);
    assert.strictEqual(chordKey.type, 16);
    assert.strictEqual(chordKey.code1, 1);
    assert.strictEqual(chordKey.code2, 6);

    // 4. Advanced TGL binding validation: rejects Media, Switch Profile, and Fn
    const tglMedia = validators.validateAdvancedBinding({
      profileIndex: 0,
      layer: 0,
      slot: 11,
      kind: 'tgl',
      targetKey: [48, 226, 0]
    });
    assert.strictEqual(tglMedia.valid, false, 'TGL must reject Media target');

    const tglProfile = validators.validateAdvancedBinding({
      profileIndex: 0,
      layer: 0,
      slot: 11,
      kind: 'tgl',
      targetKey: [240, 250, 0]
    });
    assert.strictEqual(tglProfile.valid, false, 'TGL must reject Switch Profile target');

    const tglFn = validators.validateAdvancedBinding({
      profileIndex: 0,
      layer: 0,
      slot: 11,
      kind: 'tgl',
      targetKey: [240, 255, 1]
    });
    assert.strictEqual(tglFn.valid, false, 'TGL must reject Fn target');

    // TGL accepts mouse button as target
    const tglMouse = validators.validateAdvancedBinding({
      profileIndex: 0,
      layer: 0,
      slot: 11,
      kind: 'tgl',
      targetKey: [32, 1, 0]
    });
    assert.strictEqual(tglMouse.valid, true, 'TGL accepts Mouse Button target');

    // 5. Old disabled [0, 0, 0] apply and readback replacement (Slot 11: Key A)
    const disRes = await transport.applyKeymap(0, 0, [{ slot: 11, type: 0, code1: 0, code2: 0 }]);
    assert.strictEqual(disRes.success, true);
    const readDis = await transport.readLayer(0, 0);
    const disKey = readDis.keys.find(k => k.index === 11);
    assert.strictEqual(disKey.type, 0);
    assert.strictEqual(disKey.code1, 0);
    assert.strictEqual(disKey.code2, 0);
    assert.strictEqual(disKey.label, 'Disabled');

    // 6. Vendor clear [16, 0, 0] apply and readback replacement (Slot 11: Key A)
    const clrRes = await transport.applyKeymap(0, 0, [{ slot: 11, type: 16, code1: 0, code2: 0 }]);
    assert.strictEqual(clrRes.success, true);
    const readClr = await transport.readLayer(0, 0);
    const clrKey = readClr.keys.find(k => k.index === 11);
    assert.strictEqual(clrKey.type, 16);
    assert.strictEqual(clrKey.code1, 0);
    assert.strictEqual(clrKey.code2, 0);
    assert.strictEqual(clrKey.label, 'Clear');

    // Cleanup transport
    transport.disconnect();
  });

  test('audit item 5: keyboard layout geometry fits strictly within case bounds without clipping knob', () => {
    const SCALE = 42;
    const PADDING = 14;
    const BORDER = 2;
    const CASE_WIDTH = 822; // outer case width
    const CASE_HEIGHT = 338; // outer case height
    const GRID_WIDTH = 790; // inner layout grid width
    const GRID_HEIGHT = 306; // inner layout grid height
    const MIN_WINDOW_WIDTH = 1080; // app minWidth

    assert.ok(CASE_WIDTH <= MIN_WINDOW_WIDTH, 'Case width must fit comfortably inside min window width');
    assert.strictEqual(GRID_WIDTH, CASE_WIDTH - 2 * (PADDING + BORDER), 'Grid width must match inner case width exactly');
    assert.strictEqual(GRID_HEIGHT, CASE_HEIGHT - 2 * (PADDING + BORDER), 'Grid height must match inner case height exactly');

    let maxRight = 0;
    let maxBottom = 0;

    for (const key of G75_V2_KEYS) {
      const left = Math.round(key.x * SCALE);
      const top = Math.round(key.y * SCALE);
      const width = key.isKnob ? Math.round(key.w * SCALE) : Math.max(16, Math.round((key.w || 1) * SCALE - 4));
      const height = key.isKnob ? Math.round(key.h * SCALE) : Math.max(16, Math.round((key.h || 1) * SCALE - 4));
      const right = left + width;
      const bottom = top + height;

      if (right > maxRight) maxRight = right;
      if (bottom > maxBottom) maxBottom = bottom;

      // Key must fit strictly within layout grid bounds
      assert.ok(left >= 0, `Key ${key.id} left (${left}) must be >= 0`);
      assert.ok(top >= 0, `Key ${key.id} top (${top}) must be >= 0`);
      assert.ok(right <= GRID_WIDTH, `Key ${key.id} right edge (${right}px) exceeds grid width (${GRID_WIDTH}px)`);
      assert.ok(bottom <= GRID_HEIGHT, `Key ${key.id} bottom edge (${bottom}px) exceeds grid height (${GRID_HEIGHT}px)`);

      // Key must fit strictly inside the physical case padding
      const caseRelativeRight = BORDER + PADDING + right;
      const caseRelativeBottom = BORDER + PADDING + bottom;
      assert.ok(caseRelativeRight <= CASE_WIDTH - BORDER, `Key ${key.id} right (${caseRelativeRight}px) overflows case (${CASE_WIDTH}px)`);
      assert.ok(caseRelativeBottom <= CASE_HEIGHT - BORDER, `Key ${key.id} bottom (${caseRelativeBottom}px) overflows case (${CASE_HEIGHT}px)`);
    }

    // Specific check for Rotary Knob
    const knob = G75_V2_KEYS.find(k => k.isKnob);
    assert.notStrictEqual(knob, undefined);
    const knobLeft = Math.round(knob.x * SCALE);
    const knobRight = knobLeft + Math.round(knob.w * SCALE);
    assert.ok(knobRight <= GRID_WIDTH, `Knob right edge (${knobRight}px) must fit within grid (${GRID_WIDTH}px)`);
    assert.ok(maxRight <= GRID_WIDTH, `Rightmost element fits within ${GRID_WIDTH}px`);
    assert.ok(maxBottom <= 300, 'Lowest key row reaches 300px');
  });

  test('bundled CMD7 capture: Fn-F1 on layer 1 is consumer [48,112,0], not Win F1 [16,0,58]', () => {
    assert.deepStrictEqual(getDefaultTuple(1, 8), [48, 112, 0]);
    assert.deepStrictEqual(getDefaultTuple(0, 8), [16, 0, 58]);
  });
});
