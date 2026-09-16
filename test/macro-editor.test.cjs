const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const draft = require('../src/macro-draft.js');
const validators = require('../src/schema-validators.cjs');
const macroMetaModule = require('../src/macro-metadata.cjs');

describe('Macro editor draft helpers (hub tC / t_ semantics)', () => {
  test('clampMacroDelay uses FL=5 .. 65535 and NaN fallback 50', () => {
    assert.strictEqual(draft.clampMacroDelay(5), 5);
    assert.strictEqual(draft.clampMacroDelay(4), 5);
    assert.strictEqual(draft.clampMacroDelay(80), 80);
    assert.strictEqual(draft.clampMacroDelay(65536), 65535);
    assert.strictEqual(draft.clampMacroDelay('nope'), 50);
  });

  test('trailing intervals stamp the previous action: 100/230/570 → 130, 340', () => {
    const acts = [];
    let last = null;
    last = draft.applyTrailingRecordedEvent(acts, {
      action: 'keydown', code: 4, now: 100, lastEventTime: last, enableDefaultDelay: false
    }).lastEventTime;
    last = draft.applyTrailingRecordedEvent(acts, {
      action: 'keyup', code: 4, now: 230, lastEventTime: last, enableDefaultDelay: false
    }).lastEventTime;
    draft.applyTrailingRecordedEvent(acts, {
      action: 'keydown', code: 5, now: 570, lastEventTime: last, enableDefaultDelay: false
    });
    assert.strictEqual(acts.length, 3);
    assert.strictEqual(acts[0].delay, 130);
    assert.strictEqual(acts[1].delay, 340);
    assert.strictEqual(acts[2].delay, 0);
  });

  test('standard delay stamps previous action with clamped default, not elapsed', () => {
    const acts = [];
    let last = 0;
    last = draft.applyTrailingRecordedEvent(acts, {
      action: 'keydown', code: 4, now: 100, lastEventTime: last, enableDefaultDelay: true, defaultDelay: 80
    }).lastEventTime;
    draft.applyTrailingRecordedEvent(acts, {
      action: 'keyup', code: 4, now: 900, lastEventTime: last, enableDefaultDelay: true, defaultDelay: 80
    });
    assert.strictEqual(acts[0].delay, 80);
    assert.strictEqual(acts[1].delay, 0);
  });

  test('focus is required for every event including untrusted synthetic events', () => {
    const btn = { tagName: 'BUTTON', parentElement: null, getAttribute: () => null };
    assert.strictEqual(draft.shouldIgnoreRecordEvent({ repeat: false, target: null }, { recording: true, focused: true }), false);
    assert.strictEqual(draft.shouldIgnoreRecordEvent({ repeat: true, target: null }, { recording: true, focused: true }), true);
    assert.strictEqual(draft.shouldIgnoreRecordEvent({ repeat: false, target: null, isTrusted: false }, { recording: true, focused: false }), true);
    assert.strictEqual(draft.shouldIgnoreRecordEvent({ repeat: false, target: null, isTrusted: true }, { recording: true, focused: false }), true);
    assert.strictEqual(draft.shouldIgnoreRecordEvent({ repeat: false, target: btn }, { recording: true, focused: true }), true);
  });

  test('mouse DOM buttons map 0/2/1/4/3 → 1/2/4/16/8', () => {
    assert.strictEqual(draft.mouseCodeFromDomButton(0), 1);
    assert.strictEqual(draft.mouseCodeFromDomButton(2), 2);
    assert.strictEqual(draft.mouseCodeFromDomButton(1), 4);
    assert.strictEqual(draft.mouseCodeFromDomButton(4), 16);
    assert.strictEqual(draft.mouseCodeFromDomButton(3), 8);
    assert.strictEqual(draft.mouseLabel(1), 'Left Button');
    assert.strictEqual(draft.mouseLabel(8), 'Back Button');
  });

  test('media and Fn items are not macro keyboard palette entries', () => {
    assert.strictEqual(draft.isMacroKeyboardItem({ code: 4, label: 'A' }), true);
    assert.strictEqual(draft.isMacroKeyboardItem({ code: 224, label: 'Left Ctrl' }), true);
    assert.strictEqual(draft.isMacroKeyboardItem({ type: 48, code: 226, label: 'Mute' }), false);
    assert.strictEqual(draft.isMacroKeyboardItem({ code: 255, label: 'FN Layer' }), false);
    assert.strictEqual(draft.isMacroKeyboardItem({ type: 0, code: 0, label: 'Clear' }), false);
  });

  test('down recording reserves a matching release; flush fails closed if full', () => {
    assert.strictEqual(draft.maxActionCount(), 2031);
    const slots = draft.emptySlots();
    slots[0].actions = Array.from({ length: 2029 }, () => ({ action: 'keydown', code: 4, delay: 5 }));
    assert.strictEqual(draft.canRecordDown(slots, 0), true);
    slots[0].actions.push({ action: 'keydown', code: 4, delay: 5 });
    assert.strictEqual(draft.canRecordDown(slots, 1), false);
    assert.strictEqual(draft.canFlushHeld(slots, 1), true);
    slots[0].actions.push({ action: 'keydown', code: 5, delay: 5 });
    assert.strictEqual(draft.canFlushHeld(slots, 1), false);
  });

  test('clipboard deep copies do not alias source objects', () => {
    const src = [{ action: 'keydown', code: 4, delay: 20 }];
    const copy = draft.deepCopyActions(src);
    src[0].code = 9;
    assert.strictEqual(copy[0].code, 4);
  });

  test('hardwareMacroSlots strips editor-only keys from IPC payloads', () => {
    const hw = draft.hardwareMacroSlots([{
      id: 0,
      name: 'Hello',
      type: 255,
      defaultDelay: 80,
      enableDefaultDelay: true,
      actions: [{ action: 'keydown', code: 4, delay: 5, extra: true }]
    }]);
    assert.deepStrictEqual(Object.keys(hw[0]).sort(), ['actions', 'id', 'name', 'type']);
    assert.deepStrictEqual(Object.keys(hw[0].actions[0]).sort(), ['action', 'code', 'delay']);
  });

  test('malformed metadata storage falls back without keeping action arrays', () => {
    const bad = draft.parseStoredMetadata('not-json');
    assert.strictEqual(bad.recovered, true);
    assert.strictEqual(bad.meta.slots.length, 16);
    assert.strictEqual(bad.meta.slots[0].defaultDelay, 50);
    assert.strictEqual(bad.meta.slots[0].enableDefaultDelay, true);

    const stuffed = draft.parseStoredMetadata({
      version: 9,
      slots: [{ name: 12, actions: [{ action: 'keydown', code: 4, delay: 1 }], defaultDelay: 3 }]
    });
    assert.strictEqual(stuffed.meta.slots[0].name, '');
    assert.strictEqual(stuffed.meta.slots[0].defaultDelay, 5);
    assert.strictEqual(stuffed.meta.slots[0].actions, undefined);

    const literal = draft.parseStoredMetadata({
      version: 1,
      slots: [{ name: '<script>x</script>', defaultDelay: 80, enableDefaultDelay: false }]
    });
    assert.strictEqual(literal.meta.slots[0].name, '<script>x</script>');
    assert.strictEqual(literal.meta.slots[0].defaultDelay, 80);
    assert.strictEqual(literal.meta.slots[0].enableDefaultDelay, false);
  });

  test('profile schema accepts optional macroMetadata and rejects action arrays in it', () => {
    const mm = validators.validateMacroMetadata({
      version: 1,
      slots: [{ name: 'A', defaultDelay: 50, enableDefaultDelay: true }]
    });
    assert.strictEqual(mm.valid, true);
    const bad = validators.validateMacroMetadata({
      slots: [{ name: 'A', actions: [{ action: 'keydown', code: 4, delay: 5 }] }]
    });
    assert.strictEqual(bad.valid, false);
  });

  test('flushHeldInputs emits keyup and mouseup for still-held inputs', () => {
    const extras = draft.flushHeldInputs({ 'k:4': true, 'm:1': true });
    assert.deepStrictEqual(extras.map((a) => [a.action, a.code]), [['keyup', 4], ['mouseup', 1]]);
  });
});

describe('Review item 1: Canonical metadata schema consistent persistence/export/import', () => {
  test('validateMacroMetadata accepts canonical { version: 1, slots: [...] } up to 16 slots', () => {
    const valid = validators.validateMacroMetadata({
      version: 1,
      slots: Array.from({ length: 16 }, (_, i) => ({
        name: `Slot ${i + 1}`,
        defaultDelay: 50,
        enableDefaultDelay: true
      }))
    });
    assert.strictEqual(valid.valid, true);
  });

  test('validateMacroMetadata rejects top-level array', () => {
    const res = validators.validateMacroMetadata([
      { name: 'Slot 1', defaultDelay: 50, enableDefaultDelay: true }
    ]);
    assert.strictEqual(res.valid, false);
    assert.match(res.error, /object|array/i);
  });

  test('validateMacroMetadata rejects version !== 1 and unknown root keys', () => {
    const res1 = validators.validateMacroMetadata({
      version: 2,
      slots: []
    });
    assert.strictEqual(res1.valid, false);
    assert.match(res1.error, /version/i);

    const res2 = validators.validateMacroMetadata({
      version: 1,
      slots: [],
      extraKey: 'forbidden'
    });
    assert.strictEqual(res2.valid, false);
    assert.match(res2.error, /unknown key/i);
  });

  test('validateMacroMetadata rejects slot id fields', () => {
    const res = validators.validateMacroMetadata({
      version: 1,
      slots: [{ id: 0, name: 'Slot 1', defaultDelay: 50, enableDefaultDelay: true }]
    });
    assert.strictEqual(res.valid, false);
    assert.match(res.error, /id/i);
  });

  test('validateMacroMetadata rejects hardware fields and unknown properties in slot', () => {
    const res1 = validators.validateMacroMetadata({
      version: 1,
      slots: [{ name: 'Slot 1', actions: [], defaultDelay: 50, enableDefaultDelay: true }]
    });
    assert.strictEqual(res1.valid, false);
    assert.match(res1.error, /actions/i);

    const res2 = validators.validateMacroMetadata({
      version: 1,
      slots: [{ name: 'Slot 1', type: 1, defaultDelay: 50, enableDefaultDelay: true }]
    });
    assert.strictEqual(res2.valid, false);
    assert.match(res2.error, /unknown key/i);

    const res3 = validators.validateMacroMetadata({
      version: 1,
      slots: [{ name: 'Slot 1', defaultDelay: 50, enableDefaultDelay: true, customFoo: 'bar' }]
    });
    assert.strictEqual(res3.valid, false);
    assert.match(res3.error, /unknown key/i);
  });

  test('validateMacroMetadata rejects more than 16 slots', () => {
    const res = validators.validateMacroMetadata({
      version: 1,
      slots: Array.from({ length: 17 }, () => ({ name: '', defaultDelay: 50, enableDefaultDelay: true }))
    });
    assert.strictEqual(res.valid, false);
    assert.match(res.error, /16/i);
  });

  test('overlayExportMacros produces canonical { macros, macroMetadata } without id fields', () => {
    const slots = Array.from({ length: 16 }, (_, i) => ({
      id: i,
      name: `M${i}`,
      type: 0,
      actions: [{ action: 'keydown', code: 4, delay: 50 }],
      defaultDelay: 60,
      enableDefaultDelay: false
    }));
    const exported = macroMetaModule.overlayExportMacros(slots);
    assert.strictEqual(exported.macros.length, 16);
    assert.strictEqual(exported.macroMetadata.version, 1);
    assert.strictEqual(exported.macroMetadata.slots.length, 16);
    for (const slot of exported.macroMetadata.slots) {
      assert.strictEqual(slot.id, undefined);
      assert.strictEqual(slot.actions, undefined);
      assert.strictEqual(slot.type, undefined);
      assert.strictEqual(typeof slot.name, 'string');
      assert.strictEqual(typeof slot.defaultDelay, 'number');
      assert.strictEqual(typeof slot.enableDefaultDelay, 'boolean');
    }
    const val = validators.validateMacroMetadata(exported.macroMetadata);
    assert.strictEqual(val.valid, true);
  });

  test('validateProfileSchema supports backward compatibility for profiles without macroMetadata', () => {
    const profile = {
      model: 'MCHOSE G75 V2',
      protocol: 'GLW',
      version: '2.0.0',
      lighting: { effect: 0, brightness: 50, speed: 2, direction: 0, hexColor: '#ff0000' },
      settings: { macMode: 2, sleepTime: 10, sleepMode: 0, debounceLevel: 2, lockWin: false },
      layers: { 0: {}, 1: {}, 2: {}, 3: {} },
      perKeyRgb: {},
      macros: Array.from({ length: 16 }, (_, i) => ({ id: i, name: `Macro ${i + 1}`, type: 0, actions: [] }))
    };
    const checkNoMeta = validators.validateProfileSchema(profile);
    assert.strictEqual(checkNoMeta.valid, true, checkNoMeta.error);

    profile.macroMetadata = {
      version: 1,
      slots: Array.from({ length: 16 }, (_, i) => ({ name: `Slot ${i}`, defaultDelay: 50, enableDefaultDelay: true }))
    };
    const checkWithMeta = validators.validateProfileSchema(profile);
    assert.strictEqual(checkWithMeta.valid, true, checkWithMeta.error);

    profile.macroMetadata = [{ name: 'Slot 0' }];
    const checkBadMeta = validators.validateProfileSchema(profile);
    assert.strictEqual(checkBadMeta.valid, false);
    assert.match(checkBadMeta.error, /canonical object/i);
  });
});

describe('Review item 2: Atomic local save with visible errors', () => {
  test('saveMacroMetadata atomically writes and replaces file in isolated temp dir', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'macro-atomic-test-'));
    const metaFile = path.join(tmpDir, 'macro-metadata.json');
    try {
      const initialMeta = {
        version: 1,
        slots: Array.from({ length: 16 }, (_, i) => ({
          name: `Initial ${i}`,
          defaultDelay: 80,
          enableDefaultDelay: true
        }))
      };
      macroMetaModule.saveMacroMetadata(initialMeta, metaFile);
      assert.ok(fs.existsSync(metaFile));
      const read1 = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      assert.strictEqual(read1.version, 1);
      assert.strictEqual(read1.slots[0].name, 'Initial 0');
      assert.strictEqual(read1.slots[0].defaultDelay, 80);

      const updatedMeta = {
        version: 1,
        slots: Array.from({ length: 16 }, (_, i) => ({
          name: `Updated ${i}`,
          defaultDelay: 120,
          enableDefaultDelay: false
        }))
      };
      macroMetaModule.saveMacroMetadata(updatedMeta, metaFile);
      const read2 = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      assert.strictEqual(read2.slots[0].name, 'Updated 0');
      assert.strictEqual(read2.slots[0].defaultDelay, 120);
      assert.strictEqual(read2.slots[0].enableDefaultDelay, false);

      const files = fs.readdirSync(tmpDir);
      assert.deepStrictEqual(files, ['macro-metadata.json']);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('saveMacroMetadata write failure does not truncate or corrupt existing file', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'macro-fail-test-'));
    const metaFile = path.join(tmpDir, 'macro-metadata.json');
    try {
      const originalMeta = {
        version: 1,
        slots: Array.from({ length: 16 }, (_, i) => ({
          name: `Safe ${i}`,
          defaultDelay: 50,
          enableDefaultDelay: true
        }))
      };
      macroMetaModule.saveMacroMetadata(originalMeta, metaFile);
      const originalContent = fs.readFileSync(metaFile, 'utf8');

      const badPath = path.join(metaFile, 'sub', 'macro-metadata.json');
      assert.throws(() => {
        macroMetaModule.saveMacroMetadata(originalMeta, badPath);
      });

      assert.strictEqual(fs.readFileSync(metaFile, 'utf8'), originalContent);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('Review item 3: Replace Selected action key/button', () => {
  test('replaceActionAtIndex replaces key and preserves surrounding order and delays', () => {
    const actions = [
      { action: 'keydown', code: 4, delay: 50 },
      { action: 'keyup', code: 4, delay: 100 },
      { action: 'keydown', code: 5, delay: 150 }
    ];

    const res1 = draft.replaceActionAtIndex(actions, 1, { actionType: 'keypress', code: 6 });
    assert.ok(res1);
    assert.strictEqual(actions.length, 3);
    assert.strictEqual(actions[0].code, 4);
    assert.strictEqual(actions[0].delay, 50);
    assert.strictEqual(actions[1].action, 'keyup');
    assert.strictEqual(actions[1].code, 6);
    assert.strictEqual(actions[1].delay, 100);
    assert.strictEqual(actions[2].code, 5);
    assert.strictEqual(actions[2].delay, 150);

    const res2 = draft.replaceActionAtIndex(actions, 0, { actionType: 'mousedown', code: 1 });
    assert.ok(res2);
    assert.strictEqual(actions[0].action, 'mousedown');
    assert.strictEqual(actions[0].code, 1);
    assert.strictEqual(actions[0].delay, 50);
  });

  test('replaceActionAtIndex rejects invalid keys and buttons without modifying actions', () => {
    const actions = [
      { action: 'keydown', code: 4, delay: 50 }
    ];

    assert.strictEqual(draft.replaceActionAtIndex(actions, 5, { actionType: 'keydown', code: 4 }), null);
    assert.strictEqual(draft.replaceActionAtIndex(actions, -1, { actionType: 'keydown', code: 4 }), null);

    assert.strictEqual(draft.replaceActionAtIndex(actions, 0, { actionType: 'keydown', code: 255 }), null);
    assert.strictEqual(draft.replaceActionAtIndex(actions, 0, { actionType: 'keydown', code: 999 }), null);
    assert.strictEqual(actions[0].code, 4);

    assert.strictEqual(draft.replaceActionAtIndex(actions, 0, { actionType: 'mousedown', code: 99 }), null);
    assert.strictEqual(actions[0].code, 4);
  });
});

describe('Review item 4: Complete keyboard capture mapping', () => {
  test('DOM_KEY_TO_HID includes all vendor 2233 module 94222 mapped keys', () => {
    assert.strictEqual(draft.DOM_KEY_TO_HID.ContextMenu, 101);
    assert.strictEqual(draft.DOM_KEY_TO_HID.Apps, 101);
    assert.strictEqual(draft.DOM_KEY_TO_HID.Help, 117);
    assert.strictEqual(draft.DOM_KEY_TO_HID.IntlRo, 135);
    assert.strictEqual(draft.DOM_KEY_TO_HID.IntlYen, 137);

    for (let f = 13; f <= 24; f++) {
      assert.strictEqual(draft.DOM_KEY_TO_HID[`F${f}`], 104 + (f - 13));
    }

    assert.strictEqual(draft.DOM_KEY_TO_HID.OSLeft, 227);
    assert.strictEqual(draft.DOM_KEY_TO_HID.OSRight, 231);
    assert.strictEqual(draft.DOM_KEY_TO_HID.MetaLeft, 227);
    assert.strictEqual(draft.DOM_KEY_TO_HID.MetaRight, 231);

    assert.strictEqual(draft.DOM_KEY_TO_HID.NumpadEqual, 103);
    assert.strictEqual(draft.DOM_KEY_TO_HID.NumpadComma, 54);
  });

  test('media entries are macroDisabled and excluded from macro keyboard capture/palette', () => {
    assert.strictEqual(draft.DOM_KEY_TO_HID.AudioVolumeUp, undefined);
    assert.strictEqual(draft.DOM_KEY_TO_HID.AudioVolumeDown, undefined);
    assert.strictEqual(draft.DOM_KEY_TO_HID.AudioVolumeMute, undefined);
    assert.strictEqual(draft.DOM_KEY_TO_HID.MediaPlayPause, undefined);

    assert.strictEqual(draft.isMacroKeyboardItem({ type: 48, code: 226 }), false);
    assert.strictEqual(draft.isMacroKeyboardItem({ type: 48, code: 233 }), false);

    assert.strictEqual(draft.isMacroKeyboardItem({ code: 255 }), false);

    assert.strictEqual(draft.isMacroKeyboardItem({ code: 101 }), true);
    assert.strictEqual(draft.isMacroKeyboardItem({ code: 117 }), true);
    assert.strictEqual(draft.isMacroKeyboardItem({ code: 135 }), true);
    assert.strictEqual(draft.isMacroKeyboardItem({ code: 137 }), true);
    assert.strictEqual(draft.isMacroKeyboardItem({ code: 104 }), true);
    assert.strictEqual(draft.isMacroKeyboardItem({ code: 115 }), true);
  });
});

describe('Review item 5: Validated action selection builder and consistent keypress pair behavior', () => {
  test('buildMacroActionsFromSelection creates valid keyboard actions (keydown / keyup)', () => {
    const down = draft.buildMacroActionsFromSelection({ actionType: 'keydown', code: 4, delay: 50 });
    assert.strictEqual(down.valid, true);
    assert.deepStrictEqual(down.actions, [{ action: 'keydown', code: 4, delay: 50 }]);

    const up = draft.buildMacroActionsFromSelection({ actionType: 'keyup', code: 5, delay: 20 });
    assert.strictEqual(up.valid, true);
    assert.deepStrictEqual(up.actions, [{ action: 'keyup', code: 5, delay: 20 }]);
  });

  test('buildMacroActionsFromSelection creates keypress pair with first delay and MIN_DELAY release', () => {
    const press = draft.buildMacroActionsFromSelection({ actionType: 'keypress', code: 4, delay: 80 });
    assert.strictEqual(press.valid, true);
    assert.strictEqual(press.actions.length, 2);
    assert.deepStrictEqual(press.actions, [
      { action: 'keydown', code: 4, delay: 80 },
      { action: 'keyup', code: 4, delay: draft.MIN_DELAY }
    ]);
  });

  test('buildMacroActionsFromSelection creates valid mouse actions (mousedown / mouseup)', () => {
    const mDown = draft.buildMacroActionsFromSelection({ actionType: 'mousedown', code: 2, delay: 35 });
    assert.strictEqual(mDown.valid, true);
    assert.deepStrictEqual(mDown.actions, [{ action: 'mousedown', code: 2, delay: 35 }]);

    const mUp = draft.buildMacroActionsFromSelection({ actionType: 'mouseup', code: 16, delay: 40 });
    assert.strictEqual(mUp.valid, true);
    assert.deepStrictEqual(mUp.actions, [{ action: 'mouseup', code: 16, delay: 40 }]);
  });

  test('buildMacroActionsFromSelection rejects mouse code for keyboard type and vice versa', () => {
    // Code 2 is Right Mouse Button; should NOT be accepted as keyboard keydown/keypress
    const badKey = draft.buildMacroActionsFromSelection({ actionType: 'keydown', code: 2 });
    assert.strictEqual(badKey.valid, false);
    assert.match(badKey.error, /keyboard key/i);

    const badPress = draft.buildMacroActionsFromSelection({ actionType: 'keypress', code: 2 });
    assert.strictEqual(badPress.valid, false);
    assert.match(badPress.error, /keyboard key/i);

    // Code 30 is Digit1; should NOT be accepted as mouse button
    const badMouse = draft.buildMacroActionsFromSelection({ actionType: 'mousedown', code: 30 });
    assert.strictEqual(badMouse.valid, false);
    assert.match(badMouse.error, /mouse button/i);

    // Invalid action type
    const badType = draft.buildMacroActionsFromSelection({ actionType: 'invalid', code: 4 });
    assert.strictEqual(badType.valid, false);
    assert.match(badType.error, /action type/i);
  });
});

describe('Review item 6: Inserting mouse action preserves kind, code, and neighboring order', () => {
  test('inserting a mouse action preserves expected kind, code, and neighboring actions', () => {
    const actions = [
      { action: 'keydown', code: 4, delay: 50 },
      { action: 'keyup', code: 4, delay: 100 },
      { action: 'keydown', code: 5, delay: 150 }
    ];

    // Build mouse action: mousedown with Right Button (code 2)
    const built = draft.buildMacroActionsFromSelection({ actionType: 'mousedown', code: 2, delay: 60 });
    assert.strictEqual(built.valid, true);

    // Insert after index 0 (at index 1)
    const at = 1;
    const candidate = actions.slice();
    candidate.splice(at, 0, ...built.actions);

    assert.strictEqual(candidate.length, 4);
    assert.strictEqual(candidate[0].action, 'keydown');
    assert.strictEqual(candidate[0].code, 4);
    assert.strictEqual(candidate[0].delay, 50);

    assert.strictEqual(candidate[1].action, 'mousedown');
    assert.strictEqual(candidate[1].code, 2);
    assert.strictEqual(candidate[1].delay, 60);

    assert.strictEqual(candidate[2].action, 'keyup');
    assert.strictEqual(candidate[2].code, 4);
    assert.strictEqual(candidate[2].delay, 100);

    assert.strictEqual(candidate[3].action, 'keydown');
    assert.strictEqual(candidate[3].code, 5);
    assert.strictEqual(candidate[3].delay, 150);
  });

  test('inserting keypress pair inserts down + up in sequence preserving neighboring actions', () => {
    const actions = [
      { action: 'keydown', code: 4, delay: 50 },
      { action: 'keyup', code: 4, delay: 100 }
    ];

    const built = draft.buildMacroActionsFromSelection({ actionType: 'keypress', code: 6, delay: 75 });
    assert.strictEqual(built.valid, true);
    assert.strictEqual(built.actions.length, 2);

    // Insert after index 0 (at index 1)
    const candidate = actions.slice();
    candidate.splice(1, 0, ...built.actions);

    assert.strictEqual(candidate.length, 4);
    assert.strictEqual(candidate[0].code, 4);
    assert.strictEqual(candidate[1].action, 'keydown');
    assert.strictEqual(candidate[1].code, 6);
    assert.strictEqual(candidate[1].delay, 75);
    assert.strictEqual(candidate[2].action, 'keyup');
    assert.strictEqual(candidate[2].code, 6);
    assert.strictEqual(candidate[2].delay, draft.MIN_DELAY);
    assert.strictEqual(candidate[3].code, 4);
  });
});

describe('Review item 7: Vendor-identical action-body deduplication and delay 0..4 wire normalization', () => {
  test('delay 0..4 wire normalization deduplicates identical actions', () => {
    const act0 = [{ action: 'keydown', code: 4, delay: 0 }];
    const act2 = [{ action: 'keydown', code: 4, delay: 2 }];
    const act4 = [{ action: 'keydown', code: 4, delay: 4 }];
    const act5 = [{ action: 'keydown', code: 4, delay: 5 }];

    const key0 = draft.getNormalizedBodyKey(act0);
    const key2 = draft.getNormalizedBodyKey(act2);
    const key4 = draft.getNormalizedBodyKey(act4);
    const key5 = draft.getNormalizedBodyKey(act5);

    assert.strictEqual(key0, key4, 'delay 0 and delay 4 must produce identical normalized wire key');
    assert.strictEqual(key2, key4, 'delay 2 and delay 4 must produce identical normalized wire key');
    assert.notStrictEqual(key0, key5, 'delay 5 must produce different key');

    // Two slots with delay 0 vs delay 4 share storage
    const slots = draft.emptySlots();
    slots[0].actions = act0;
    slots[1].actions = act4;
    // 68 bytes base + 1 action * 4 = 72 bytes total
    assert.strictEqual(draft.calculateMacroBankBytes(slots), 72);
  });

  test('multiple slots sharing identical long macros calculate storage only once', () => {
    const slots = draft.emptySlots();
    const longMacro = Array.from({ length: 1500 }, (_, i) => ({
      action: i % 2 === 0 ? 'keydown' : 'keyup',
      code: 4 + (i % 20),
      delay: 20
    }));

    // Assign same 1500-action macro to slots 0, 1, 2, 3
    slots[0].actions = draft.deepCopyActions(longMacro);
    slots[1].actions = draft.deepCopyActions(longMacro);
    slots[2].actions = draft.deepCopyActions(longMacro);
    slots[3].actions = draft.deepCopyActions(longMacro);

    // Dedup size: 68 + 1500 * 4 = 6068 bytes
    const bytes = draft.calculateMacroBankBytes(slots);
    assert.strictEqual(bytes, 68 + 1500 * 4);
    assert.ok(bytes <= draft.SHARED_MACRO_SIZE);

    // Schema validator accepts it
    const val = validators.validateMacroSlots(slots);
    assert.strictEqual(val.valid, true);
  });
});

describe('Review item 8: Prospective bank-state check rejects divergence on all edits', () => {
  test('divergence overflow rejected on Add, Insert, Paste, Replace, Delete, Reorder, delay edit', () => {
    // Setup two duplicate slots sharing 1500 actions (6068 bytes, fits in 8192)
    const slots = draft.emptySlots();
    const longMacro = Array.from({ length: 1500 }, (_, i) => ({
      action: i % 2 === 0 ? 'keydown' : 'keyup',
      code: 4 + (i % 20),
      delay: 20
    }));
    slots[0].actions = draft.deepCopyActions(longMacro);
    slots[1].actions = draft.deepCopyActions(longMacro);
    assert.strictEqual(draft.calculateMacroBankBytes(slots), 6068);

    // 1. Add action to slot 0: diverges slot 0 (1501) and slot 1 (1500) -> 3001 unique actions = 12072 bytes > 8192
    const addCandidate = slots[0].actions.concat([{ action: 'keydown', code: 25, delay: 20 }]);
    assert.strictEqual(draft.canMutateSlot(slots, 0, addCandidate), false);

    // 2. Insert action into slot 0: diverges -> overflow
    const insertCandidate = slots[0].actions.slice();
    insertCandidate.splice(1, 0, { action: 'mousedown', code: 2, delay: 20 });
    assert.strictEqual(draft.canMutateSlot(slots, 0, insertCandidate), false);

    // 3. Paste into slot 0: diverges -> overflow
    const pasteCandidate = slots[0].actions.concat(draft.deepCopyActions(slots[0].actions.slice(0, 5)));
    assert.strictEqual(draft.canMutateSlot(slots, 0, pasteCandidate), false);

    // 4. Replace action in slot 0: diverges -> overflow
    const replaceCandidate = draft.deepCopyActions(slots[0].actions);
    draft.replaceActionAtIndex(replaceCandidate, 0, { actionType: 'keydown', code: 9 });
    assert.strictEqual(draft.canMutateSlot(slots, 0, replaceCandidate), false);

    // 5. Delete action from slot 0: 1499 actions in slot 0 + 1500 in slot 1 = 2999 unique actions = 12064 bytes > 8192
    const deleteCandidate = slots[0].actions.slice(1);
    assert.strictEqual(draft.canMutateSlot(slots, 0, deleteCandidate), false);

    // 6. Reorder in slot 0: swapping actions 0 and 1 diverges slot 0 -> overflow
    const reorderCandidate = slots[0].actions.slice();
    const [swapped] = reorderCandidate.splice(0, 1);
    reorderCandidate.splice(1, 0, swapped);
    assert.strictEqual(draft.canMutateSlot(slots, 0, reorderCandidate), false);

    // 7. Delay edit in slot 0: changing delay from 20 to 50 diverges slot 0 -> overflow
    const delayCandidate = draft.deepCopyActions(slots[0].actions);
    delayCandidate[0].delay = 50;
    assert.strictEqual(draft.canMutateSlot(slots, 0, delayCandidate), false);

    // When slots have small size (e.g. 10 actions each), edits are accepted
    const smallSlots = draft.emptySlots();
    const smallMacro = Array.from({ length: 10 }, (_, i) => ({ action: 'keydown', code: 4, delay: 20 }));
    smallSlots[0].actions = draft.deepCopyActions(smallMacro);
    smallSlots[1].actions = draft.deepCopyActions(smallMacro);
    const smallAddCandidate = smallSlots[0].actions.concat([{ action: 'keydown', code: 5, delay: 20 }]);
    assert.strictEqual(draft.canMutateSlot(smallSlots, 0, smallAddCandidate), true);
  });
});

describe('Review item 9: Recording preflight reserves releases on duplicate shared slots', () => {
  test('canRecordDown reserves matching release and held releases on shared slots', () => {
    const slots = draft.emptySlots();
    // 2029 actions in slot 0
    slots[0].actions = Array.from({ length: 2029 }, () => ({ action: 'keydown', code: 4, delay: 5 }));
    // 2029 actions: 0 held -> down + matching release = 2031 actions = 8192 bytes (fits)
    assert.strictEqual(draft.canRecordDown(slots, 0, 0), true);
    // with 1 held key -> down + matching release + 1 held release = 2032 actions > 2031 (fails)
    assert.strictEqual(draft.canRecordDown(slots, 1, 0), false);

    // On shared duplicate long slots: recording in slot 0 causes divergence from slot 1
    const sharedSlots = draft.emptySlots();
    const longMacro = Array.from({ length: 1500 }, () => ({ action: 'keydown', code: 4, delay: 5 }));
    sharedSlots[0].actions = draft.deepCopyActions(longMacro);
    sharedSlots[1].actions = draft.deepCopyActions(longMacro);
    // Recording down in slot 0 will diverge slot 0 and require 1500 + 1502 actions > 2031 actions!
    assert.strictEqual(draft.canRecordDown(sharedSlots, 0, 0), false);
  });
});

describe('Review corrections: Non-dummy reservations, candidate checks & atomic commits', () => {
  test('adversarial body matching old fake sentinels must not admit overflow', () => {
    const slots = draft.emptySlots();

    // Slot 1 has an imported macro containing actions matching the old fake dummy sentinels
    // (code 250 delay 65530, code 232 delay 65500, etc.)
    const importedWithSentinels = [
      { action: 'keydown', code: 250, delay: 65530 },
      { action: 'keyup', code: 232, delay: 65500 }
    ];
    // Fill slot 1 up to 1000 actions
    while (importedWithSentinels.length < 1000) {
      importedWithSentinels.push({ action: 'keydown', code: 4, delay: 20 });
    }
    slots[1].actions = importedWithSentinels;

    // Slot 0 has 1031 actions. Total bank actions = 1000 + 1031 = 2031 actions (exact bank maximum: 8192 bytes).
    slots[0].actions = Array.from({ length: 1031 }, () => ({ action: 'keydown', code: 5, delay: 20 }));
    assert.strictEqual(draft.calculateMacroBankBytes(slots), 8192);

    // If slot 0 attempts to mutate with 1 reserved release (would require 1032 actions in slot 0),
    // it must NOT collide with slot 1 or alias to admit 2032 actions.
    const candidate0 = slots[0].actions.slice();
    assert.strictEqual(draft.canMutateSlot(slots, 0, candidate0, 1), false);

    // Even if slot 0 candidate actions literally end with the old fake sentinel actions:
    const candidateMatchingSentinel = slots[0].actions.slice();
    candidateMatchingSentinel.push({ action: 'keydown', code: 250, delay: 65530 });
    // Candidate + 1 reserved release = 1031 + 1 + 1 = 1033 actions -> must strictly reject
    assert.strictEqual(draft.canMutateSlot(slots, 0, candidateMatchingSentinel, 1), false);
  });

  test('many held inputs no invalid arithmetic or delay wrapping', () => {
    const slots = draft.emptySlots();
    slots[0].actions = Array.from({ length: 10 }, () => ({ action: 'keydown', code: 4, delay: 20 }));

    // 100 held inputs: 10 + 100 = 110 actions fits comfortably.
    // In old code, i=36 produced delay 65500+36 = 65536 > 65535 wrapping uint16.
    // In new code, no dummy actions or delay arithmetic are generated.
    assert.strictEqual(draft.canMutateSlot(slots, 0, slots[0].actions, 100), true);

    // 200 held inputs on a macro with 1900 actions: 1900 + 200 = 2100 actions > 2031 max.
    // Must return false without throwing RangeError, NaN, or arithmetic overflow.
    const bigSlot = draft.emptySlots();
    bigSlot[0].actions = Array.from({ length: 1900 }, () => ({ action: 'keydown', code: 4, delay: 20 }));
    assert.strictEqual(draft.canMutateSlot(bigSlot, 0, bigSlot[0].actions, 200), false);

    // canRecordDown with 100 held inputs
    assert.strictEqual(draft.canRecordDown(slots, 100, 0), true);
    assert.strictEqual(draft.canRecordDown(bigSlot, 200, 0), false);

    // canFlushHeld with 100 held inputs
    assert.strictEqual(draft.canFlushHeld(slots, 100, 0), true);
    assert.strictEqual(draft.canFlushHeld(bigSlot, 200, 0), false);
  });

  test('rejected record leaves draft untouched (zero draft mutation)', () => {
    const slots = draft.emptySlots();
    // 2030 actions: room for exactly 1 more action in the bank (max 2031)
    const initialActions = Array.from({ length: 2030 }, (_, i) => ({
      action: 'keydown',
      code: 4 + (i % 20),
      delay: 20
    }));
    slots[0].actions = draft.deepCopyActions(initialActions);

    // Simulate record event candidate for down: needs room for down + 1 matching release (2 actions)
    // 2030 + 2 = 2032 > 2031 -> rejected!
    const candidate = draft.deepCopyActions(slots[0].actions);
    draft.applyTrailingRecordedEvent(candidate, {
      action: 'keydown',
      code: 20,
      now: 10000,
      lastEventTime: 5000,
      enableDefaultDelay: false,
      defaultDelay: 50
    });

    const canFit = draft.canMutateSlot(slots, 0, candidate, 1);
    assert.strictEqual(canFit, false);

    // Verify draft slots[0].actions was NOT mutated
    assert.strictEqual(slots[0].actions.length, 2030);
    assert.strictEqual(slots[0].actions[2029].delay, 20); // trailing delay untouched!
    assert.deepStrictEqual(slots[0].actions, initialActions);
  });

  test('rejected flush leaves draft untouched (zero draft mutation)', () => {
    const slots = draft.emptySlots();
    // 2030 actions: room for 1 more action
    const initialActions = Array.from({ length: 2030 }, (_, i) => ({
      action: 'keydown',
      code: 4 + (i % 20),
      delay: 25
    }));
    slots[0].actions = draft.deepCopyActions(initialActions);

    // 2 held inputs (e.g. key 4 and mouse 1)
    const pressed = { 'k:4': true, 'm:1': true };
    const extras = draft.flushHeldInputs(pressed);
    assert.strictEqual(extras.length, 2);

    // Prospective candidate: update trailing delay of last action and append extras
    const candidate = draft.deepCopyActions(slots[0].actions);
    if (candidate.length > 0) {
      candidate[candidate.length - 1].delay = draft.recordedDelay({
        enableDefaultDelay: false,
        defaultDelay: 50,
        now: 10000,
        lastEventTime: 5000
      });
    }
    for (let i = 0; i < extras.length; i++) {
      candidate.push({
        action: extras[i].action,
        code: extras[i].code,
        delay: extras[i].delay || 0
      });
    }

    // 2030 + 2 = 2032 > 2031 -> must reject
    const canFit = draft.canMutateSlot(slots, 0, candidate, 0);
    assert.strictEqual(canFit, false);

    // Verify original draft actions completely untouched
    assert.strictEqual(slots[0].actions.length, 2030);
    assert.strictEqual(slots[0].actions[2029].delay, 25); // untouched, NOT mutated to 5000!
    assert.deepStrictEqual(slots[0].actions, initialActions);
    assert.strictEqual(draft.heldCount(pressed), 2); // pressed map untouched
  });

  test('normal release reserved fits and applies candidate', () => {
    const slots = draft.emptySlots();
    slots[0].actions = [
      { action: 'keydown', code: 4, delay: 20 }
    ];

    // Down event for code 5 with 0 held keys -> needs room for down + 1 release = 2 actions
    const candidate = draft.deepCopyActions(slots[0].actions);
    draft.applyTrailingRecordedEvent(candidate, {
      action: 'keydown',
      code: 5,
      now: 1000,
      lastEventTime: 500,
      enableDefaultDelay: false,
      defaultDelay: 50
    });

    const canFit = draft.canMutateSlot(slots, 0, candidate, 1);
    assert.strictEqual(canFit, true);

    // Apply candidate atomically
    slots[0].actions = candidate;
    assert.strictEqual(slots[0].actions.length, 2);
    assert.strictEqual(slots[0].actions[0].delay, 500);
    assert.strictEqual(slots[0].actions[1].action, 'keydown');
    assert.strictEqual(slots[0].actions[1].code, 5);
  });
});

