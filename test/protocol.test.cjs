const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const protocol = require('../src/protocol.cjs');

const baselinePath = path.join(__dirname, 'fixtures', 'readonly-baseline.json');
const getBaseline = () => JSON.parse(fs.readFileSync(baselinePath, 'utf8'));

describe('GLW Keyboard Protocol Encoder & Decoder (Verified Hardware)', () => {
  test('constants conform to reverse-engineered GLW hardware driver specification', () => {
    assert.strictEqual(protocol.REPORT_ID, 0); // Unnumbered report
    assert.strictEqual(protocol.CHUNK_SIZE, 56);
    assert.strictEqual(protocol.WRITE_BUFFER_SIZE, 65);
    assert.strictEqual(protocol.TOTAL_KEY_AREA_SIZE, 512);
    assert.strictEqual(protocol.USED_KEY_AREA_SIZE, 384);
    assert.strictEqual(protocol.MAX_LAYERS, 4);
    assert.strictEqual(protocol.MAX_MACRO_SLOTS, 16);
    assert.strictEqual(protocol.SHARED_MACRO_SIZE, 8192);

    assert.strictEqual(protocol.COMMANDS.GET_INFO, 3);
    assert.strictEqual(protocol.COMMANDS.GET_BASE, 4);
    assert.strictEqual(protocol.COMMANDS.GET_FUNC_CONFIG, 5);
    assert.strictEqual(protocol.COMMANDS.SET_FUNC_CONFIG, 6);
    assert.strictEqual(protocol.COMMANDS.GET_DEFAULT_KEY_MATRIX, 7);
    assert.strictEqual(protocol.COMMANDS.GET_USER_KEY_MATRIX, 8);
    assert.strictEqual(protocol.COMMANDS.SET_USER_KEY_MATRIX, 9);
    assert.strictEqual(protocol.COMMANDS.GET_KEY_COLOR, 10);
    assert.strictEqual(protocol.COMMANDS.SET_KEY_COLOR, 11);
    assert.strictEqual(protocol.COMMANDS.GET_MACROS, 12);
    assert.strictEqual(protocol.COMMANDS.SET_MACROS, 13);
    assert.strictEqual(protocol.COMMANDS.SET_BASE, 14);
    assert.strictEqual(protocol.COMMANDS.GET_KEY_EXTRAS, 160);
    assert.strictEqual(protocol.COMMANDS.SET_KEY_EXTRAS, 161);
    assert.strictEqual(protocol.COMMANDS.GET_MT_KEYS, 164);
    assert.strictEqual(protocol.COMMANDS.SET_MT_KEYS, 165);
    assert.strictEqual(protocol.COMMANDS.GET_TGL_KEYS, 166);
    assert.strictEqual(protocol.COMMANDS.SET_TGL_KEYS, 167);
    assert.strictEqual(protocol.COMMANDS.FACTORY_RESET, 238);
    assert.strictEqual(protocol.COMMANDS.GET_CUSTOM_PARAM, 241);
    assert.strictEqual(protocol.COMMANDS.SET_CUSTOM_PARAM, 242);
  });

  test('calculateChecksum calculates 8-bit modular sum of descriptor bytes', () => {
    const desc = [56, 0, 0, 0];
    assert.strictEqual(protocol.calculateChecksum(desc), 56);

    const overflow = [200, 100, 0, 0]; // 300 & 0xFF = 44
    assert.strictEqual(protocol.calculateChecksum(overflow), 44);
  });

  test('encodePacket encodes valid read query command 4 base offset 0 size 56', () => {
    const encoded = protocol.encodePacket({
      command: protocol.COMMANDS.GET_BASE,
      offset: 0,
      size: 56
    });

    assert.strictEqual(encoded.length, 65);
    assert.strictEqual(encoded[0], 0);    // Leading 0 reportId
    assert.strictEqual(encoded[1], 0x55); // Magic 0x55 (85)
    assert.strictEqual(encoded[2], 4);    // CMD 4
    assert.strictEqual(encoded[3], 0);    // Subcommand 0
    assert.strictEqual(encoded[4], 56);   // Checksum = 56 + 0 + 0 + 0 = 56
    assert.strictEqual(encoded[5], 56);   // Size 56
    assert.strictEqual(encoded[6], 0);    // OffsetLo
    assert.strictEqual(encoded[7], 0);    // OffsetHi
    assert.strictEqual(encoded[8], 0);    // Reserved
  });

  test('encodePacket rejects invalid command, offset, size, and out of bounds', () => {
    // Non-integer command
    assert.throws(() => protocol.encodePacket({ command: '4', offset: 0, size: 56 }), TypeError);
    assert.throws(() => protocol.encodePacket({ command: 256, offset: 0, size: 56 }), TypeError);

    // Negative offset or out of bounds
    assert.throws(() => protocol.encodePacket({ command: 4, offset: -1, size: 56 }), RangeError);
    assert.throws(() => protocol.encodePacket({ command: 4, offset: 70000, size: 56 }), RangeError);

    // Size > 56
    assert.throws(() => protocol.encodePacket({ command: 4, offset: 0, size: 57 }), RangeError);
    assert.throws(() => protocol.encodePacket({ command: 4, offset: 0, size: -1 }), RangeError);

    // Oversized data relative to requested size
    assert.throws(() => protocol.encodePacket({ command: 4, offset: 0, size: 2, data: [1, 2, 3] }), RangeError);
  });

  test('decodePacket rejects size > 56, nonzero reserved byte, and corrupt checksum', () => {
    // Valid reply
    const validBytes = Buffer.alloc(64, 0);
    validBytes[0] = 0xAA;
    validBytes[1] = 4; // command
    validBytes[2] = 0; // status
    validBytes[4] = 4; // size = 4
    validBytes[5] = 0; // offsetLo
    validBytes[6] = 0; // offsetHi
    validBytes[7] = 0; // reserved = 0
    validBytes[8] = 10;
    validBytes[9] = 20;
    validBytes[10] = 30;
    validBytes[11] = 40;
    validBytes[3] = protocol.calculateChecksum([4, 0, 0, 0, 10, 20, 30, 40]);

    const decoded = protocol.decodePacket(validBytes);
    assert.notStrictEqual(decoded, null);
    assert.strictEqual(decoded.success, true);
    assert.strictEqual(decoded.checksumValid, true);
    assert.strictEqual(decoded.reservedValid, true);

    // 1. Size > 56 rejected
    const oversized = Buffer.from(validBytes);
    oversized[4] = 60;
    assert.strictEqual(protocol.decodePacket(oversized), null);

    // 2. Nonzero reserved byte rejected
    const badReserved = Buffer.from(validBytes);
    badReserved[7] = 1;
    const decBadRes = protocol.decodePacket(badReserved);
    assert.strictEqual(decBadRes.reservedValid, false);
    assert.strictEqual(decBadRes.success, false);

    // 3. Corrupted checksum detected
    const badChecksum = Buffer.from(validBytes);
    badChecksum[3] = (badChecksum[3] + 1) & 0xFF;
    const decBadCheck = protocol.decodePacket(badChecksum);
    assert.strictEqual(decBadCheck.checksumValid, false);
    assert.strictEqual(decBadCheck.success, false);
  });

  test('decodePacket decodes actual hardware baseline files', () => {
    const baseline = getBaseline();

    // Test Base
    const baseBuf = Buffer.from(baseline.base, 'hex');
    const base = protocol.parseBase(baseBuf);
    assert.notStrictEqual(base, null);
    assert.strictEqual(base.activeProfile, 0);
    assert.strictEqual(base.profileCount, 3);
    assert.deepStrictEqual(base.profileOrder, [0, 1, 2, 3]);

    // Test FuncConfig
    const configBuf = Buffer.from(baseline.config, 'hex');
    const config = protocol.parseFuncConfig(configBuf);
    assert.notStrictEqual(config, null);
    assert.strictEqual(config.performance.batteryLevel, 100);
    assert.strictEqual(config.performance.macMode, 2); // Profile 0, Mac mode
    assert.strictEqual(config.performance.sleepTime, 6); // 6 * 30s = 180s
    assert.strictEqual(config.lighting.speed, 4); // 0..4 speed range

    // Test Layers
    const layer0Buf = Buffer.from(baseline.layers[0].slice(0, 768), 'hex');
    const keys0 = protocol.parseKeyMatrix(layer0Buf, 0);
    assert.strictEqual(keys0.length, 128);
    // Esc: slot 0 -> [16, 0, 41]
    assert.strictEqual(keys0[0].code, 41);
    assert.strictEqual(keys0[0].modifierMask, 0);
    // L-Shift: slot 4 -> [16, 2, 0] (code: 225)
    assert.strictEqual(keys0[4].code, 225);
    assert.strictEqual(keys0[4].modifierMask, 2);
    // L-Ctrl: slot 5 -> [16, 1, 0] (code: 224)
    assert.strictEqual(keys0[5].code, 224);
    assert.strictEqual(keys0[5].modifierMask, 1);
    // Knob: slot 37 -> [48, 226, 0] (code: 3809)
    assert.strictEqual(keys0[37].code, 3809);
    // Fn: slot 85 -> [240, 255, 1] (code: 255)
    assert.strictEqual(keys0[85].code, 255);
  });

  test('mutateBase requires complete 56-byte buffer and rejects disabled/unknown profile', () => {
    const validBase = Buffer.alloc(56, 0);
    validBase[0] = 0; // active slot 0
    validBase[1] = 2; // only 2 profiles enabled (0 and 1)
    validBase[2] = 0;
    validBase[3] = 1;
    validBase[4] = 2;
    validBase[5] = 3;

    // Mutate to enabled profile 1 succeeds
    const mutated = protocol.mutateBase(validBase, 1);
    assert.strictEqual(mutated[0], 1); // active slot 1

    // Mutate to disabled profile 2 throws
    assert.throws(() => protocol.mutateBase(validBase, 2), /not enabled/);

    // Incomplete buffer throws
    assert.throws(() => protocol.mutateBase(Buffer.alloc(20, 0), 0), /complete 56-byte/);
  });

  test('mutateLighting and mutateSettings require complete 64-byte buffers', () => {
    assert.throws(() => protocol.mutateLighting(Buffer.alloc(30, 0), {}), /complete 64-byte/);
    assert.throws(() => protocol.mutateSettings(Buffer.alloc(30, 0), {}), /complete 64-byte/);

    const validFunc = Buffer.alloc(64, 0);
    validFunc[1] = 2;
    validFunc[4] = 0x14; // tickRate 1, reporteRate 4 (1kHz)
    validFunc[10] = 0; // raw speed 0 => speed 4

    const mutatedL = protocol.mutateLighting(validFunc, { speed: 2, effect: 5 });
    assert.strictEqual(mutatedL[8], 5);
    assert.strictEqual(mutatedL[10], 2); // 4 - 2 = 2

    const mutatedS = protocol.mutateSettings(validFunc, { reporteRate: 2, sleepTime: 10, sleepMode: 1 });
    assert.strictEqual(mutatedS[4] & 0x0F, 2); // 4kHz
    assert.strictEqual(mutatedS[4] >> 4, 1); // tickRate preserved!
    assert.strictEqual(mutatedS[35], 10);
    assert.strictEqual(mutatedS[36], 1);
  });

  test('encodeKeyTuple and decodeKeyTuple maintain verified GLW tuple format', () => {
    // Normal key (Esc)
    const escTuple = protocol.encodeKeyTuple({ code: 41 });
    assert.deepStrictEqual(escTuple, [16, 0, 41]);
    const escDecoded = protocol.decodeKeyTuple(escTuple);
    assert.strictEqual(escDecoded.code, 41);
    assert.strictEqual(escDecoded.modifierMask, 0);

    // Modifier key (Left Control: code 224 -> mask 1)
    const lctrlTuple = protocol.encodeKeyTuple({ code: 224 });
    assert.deepStrictEqual(lctrlTuple, [16, 1, 0]);
    const lctrlDecoded = protocol.decodeKeyTuple(lctrlTuple);
    assert.strictEqual(lctrlDecoded.code, 224);
    assert.strictEqual(lctrlDecoded.modifierMask, 1);
    assert.strictEqual(lctrlDecoded.isModifier, true);

    // Modifier key (Left Shift: code 225 -> mask 2)
    const lshiftTuple = protocol.encodeKeyTuple({ code: 225 });
    assert.deepStrictEqual(lshiftTuple, [16, 2, 0]);

    // Modifier key (Left Alt: code 226 -> mask 4)
    const laltTuple = protocol.encodeKeyTuple({ code: 226 });
    assert.deepStrictEqual(laltTuple, [16, 4, 0]);

    // Modifier key (Left Win: code 227 -> mask 8)
    const lwinTuple = protocol.encodeKeyTuple({ code: 227 });
    assert.deepStrictEqual(lwinTuple, [16, 8, 0]);

    // Knob
    const knobTuple = protocol.encodeKeyTuple({ code: 3809 });
    assert.deepStrictEqual(knobTuple, [48, 226, 0]);
    const knobDecoded = protocol.decodeKeyTuple(knobTuple);
    assert.strictEqual(knobDecoded.code, 3809);

    // Fn
    const fnTuple = protocol.encodeKeyTuple({ code: 255 });
    assert.deepStrictEqual(fnTuple, [240, 255, 1]);
    const fnDecoded = protocol.decodeKeyTuple(fnTuple);
    assert.strictEqual(fnDecoded.code, 255);
  });

  test('hub mergeCBKey is type-16 modifier mask plus regular HID usage', () => {
    const hot = protocol.encodeKeyTuple({ code: 224 });
    const regular = protocol.encodeKeyTuple({ code: 4 });
    assert.ok(protocol.isHotKeyTuple(hot));
    assert.ok(protocol.isNormalKeyTuple(regular));
    assert.deepStrictEqual(protocol.mergeCBKey(hot, regular), [16, 1, 4]);
    assert.ok(protocol.isCBKeyTuple([16, 1, 4]));
    assert.strictEqual(protocol.isHotKeyTuple(regular), false);
    assert.strictEqual(protocol.isNormalKeyTuple(hot), false);
    assert.throws(() => protocol.mergeCBKey(regular, hot), /CB merge/);
    assert.strictEqual(protocol.isHotKeyTuple([16, 1, 0, 0]), false);
    assert.strictEqual(protocol.isNormalKeyTuple([16, 0, 4, 9]), false);
    assert.strictEqual(protocol.isCBKeyTuple([16, 1, 4, 0]), false);
    assert.strictEqual(protocol.isHotKeyTuple([16, 1]), false);
    assert.strictEqual(protocol.isNormalKeyTuple([16, 0]), false);
    assert.strictEqual(protocol.isCBKeyTuple([16, 1, 4, 0, 0]), false);
    assert.ok(protocol.isHotKeyTuple([16, 3, 0]));
    assert.ok(protocol.isHotKeyTuple([16, 9, 0]));
    assert.ok(protocol.isCBKeyTuple([16, 3, 4]));
    assert.deepStrictEqual(protocol.mergeCBKey([16, 3, 0], regular), [16, 3, 4]);
    assert.throws(() => protocol.mergeCBKey([16, 1, 0, 0], regular), /CB merge/);
  });

  test('per-key RGB serialize and parse roundtrips 128 keys', () => {
    const colors = [
      { index: 0, hex: '#FF0000' },
      { index: 11, hex: '#00FF00' },
      { index: 53, hex: '#0000FF' }
    ];

    const serialized = protocol.serializeKeyColors(colors);
    assert.strictEqual(serialized.length, 384);

    const parsed = protocol.parseKeyColors(serialized);
    assert.strictEqual(parsed.length, 128);
    assert.strictEqual(parsed[0].hex, '#FF0000');
    assert.strictEqual(parsed[11].hex, '#00FF00');
    assert.strictEqual(parsed[53].hex, '#0000FF');
    assert.strictEqual(parsed[1].hex, '#000000');
  });

  test('macro serialization throws on capacity overflow and preserves slots', () => {
    const baseline = getBaseline();
    const macroBuf = Buffer.from(baseline.macros, 'hex');

    // Valid serialization
    const slots = protocol.parseMacroRegion(macroBuf);
    slots[0].actions.push({ action: 'keydown', code: 4, delay: 20 });
    slots[0].actions.push({ action: 'keyup', code: 4, delay: 20 });

    const serialized = protocol.serializeMacroRegion(slots, macroBuf);
    assert.strictEqual(serialized.length, 8192);

    const reparsed = protocol.parseMacroRegion(serialized);
    assert.strictEqual(reparsed[0].actions.length, 2);

    // Overflow test: create 3000 actions (3000 * 4 = 12000 bytes > 8192)
    const giantActions = [];
    for (let i = 0; i < 2500; i++) {
      giantActions.push({ action: 'keydown', code: 4, delay: 20 });
    }
    slots[1].actions = giantActions;

    assert.throws(() => protocol.serializeMacroRegion(slots, macroBuf), RangeError);
  });

  test('duplicate long macros with different playback share offsets and read back intact', () => {
    const baseline = getBaseline();
    const macroBuf = Buffer.from(baseline.macros, 'hex');

    // Create a 1500-action macro body (1500 * 4 = 6000 bytes)
    const longActions = Array.from({ length: 1500 }, (_, i) => ({
      action: i % 2 === 0 ? 'keydown' : 'keyup',
      code: 4 + (i % 20),
      delay: 20
    }));

    // Slots 0, 1, 2 share the same action body, but have different playback modes:
    // Slot 0: type 0 (Repeat While Held)
    // Slot 1: type 1 (Play Once)
    // Slot 2: type 255 (Toggle Repeat)
    const slots = [
      { id: 0, type: 0, actions: longActions },
      { id: 1, type: 1, actions: longActions },
      { id: 2, type: 255, actions: longActions }
    ];

    const serialized = protocol.serializeMacroRegion(slots, macroBuf);
    assert.strictEqual(serialized.length, 8192);

    // Verify offsets for slots 0, 1, 2 are all identical and point to 68
    const off0 = serialized[0] | (serialized[1] << 8);
    const off1 = serialized[2] | (serialized[3] << 8);
    const off2 = serialized[4] | (serialized[5] << 8);
    assert.strictEqual(off0, 68);
    assert.strictEqual(off1, 68);
    assert.strictEqual(off2, 68);

    // Verify playback types are preserved independently in header (bytes 34, 35, 36)
    assert.strictEqual(serialized[34], 0);
    assert.strictEqual(serialized[35], 1);
    assert.strictEqual(serialized[36], 255);

    // Readback parses all slots correctly with independent action arrays
    const parsed = protocol.parseMacroRegion(serialized);
    assert.strictEqual(parsed[0].actions.length, 1500);
    assert.strictEqual(parsed[1].actions.length, 1500);
    assert.strictEqual(parsed[2].actions.length, 1500);
    assert.strictEqual(parsed[0].type, 0);
    assert.strictEqual(parsed[1].type, 1);
    assert.strictEqual(parsed[2].type, 255);
  });

  test('shared-offset read/modify leaves other slots intact', () => {
    const baseline = getBaseline();
    const macroBuf = Buffer.from(baseline.macros, 'hex');

    const sharedActions = [
      { action: 'keydown', code: 4, delay: 50 },
      { action: 'keyup', code: 4, delay: 20 }
    ];

    // Initialize slots 0 and 1 sharing the body
    const initialBuf = protocol.serializeMacroRegion([
      { id: 0, type: 0, actions: sharedActions },
      { id: 1, type: 1, actions: sharedActions }
    ], macroBuf);

    // Read back
    const parsed = protocol.parseMacroRegion(initialBuf);
    assert.strictEqual(parsed[0].offset, parsed[1].offset);

    // Modify ONLY slot 0
    parsed[0].actions = [
      { action: 'keydown', code: 5, delay: 80 },
      { action: 'keyup', code: 5, delay: 20 },
      { action: 'keydown', code: 6, delay: 100 }
    ];

    // Reserialize with initialBuf
    const modifiedBuf = protocol.serializeMacroRegion(parsed, initialBuf);
    const reparsed = protocol.parseMacroRegion(modifiedBuf);

    // Slot 1 retains original actions completely intact
    assert.strictEqual(reparsed[1].actions.length, 2);
    assert.strictEqual(reparsed[1].actions[0].code, 4);
    assert.strictEqual(reparsed[1].actions[0].delay, 50);
    assert.strictEqual(reparsed[1].actions[1].code, 4);
    assert.strictEqual(reparsed[1].type, 1);

    // Slot 0 has the modified actions
    assert.strictEqual(reparsed[0].actions.length, 3);
    assert.strictEqual(reparsed[0].actions[0].code, 5);
    assert.strictEqual(reparsed[0].actions[2].code, 6);
  });

  test('exact bank boundaries: 2031 unique actions accepted at 8192 bytes, 2032 rejected with RangeError', () => {
    const baseline = getBaseline();
    const macroBuf = Buffer.from(baseline.macros, 'hex');

    // 2031 actions: 68 + 2031 * 4 = 8192 bytes (exact boundary)
    const exactActions = Array.from({ length: 2031 }, (_, i) => ({
      action: 'keydown',
      code: 4 + (i % 20),
      delay: 5
    }));

    const exactBuf = protocol.serializeMacroRegion([{ id: 0, type: 0, actions: exactActions }], macroBuf);
    assert.strictEqual(exactBuf.length, 8192);
    const parsedExact = protocol.parseMacroRegion(exactBuf);
    assert.strictEqual(parsedExact[0].actions.length, 2031);

    // 2032 actions: 68 + 2032 * 4 = 8196 bytes (exceeds 8192)
    const overflowActions = Array.from({ length: 2032 }, (_, i) => ({
      action: 'keydown',
      code: 4 + (i % 20),
      delay: 5
    }));
    assert.throws(() => {
      protocol.serializeMacroRegion([{ id: 0, type: 0, actions: overflowActions }], macroBuf);
    }, RangeError);
  });

  test('original reserved bytes 50..63 and untouched tail beyond written bodies are preserved during serializeMacroRegion', () => {
    const baseline = getBaseline();
    const macroBuf = Buffer.from(baseline.macros, 'hex');

    // Write distinctive test bytes into reserved area bytes 50..63
    for (let b = 50; b <= 63; b++) {
      macroBuf[b] = 0xA0 + (b - 50);
    }

    // Write distinctive test sentinels into tail bytes beyond written bodies
    for (let b = 100; b < 8192; b++) {
      macroBuf[b] = (b * 17) & 0xFF;
    }

    // Serialize a small macro with 2 actions (offset 68..75). currentActionOffset is 76.
    const serialized = protocol.serializeMacroRegion([
      { id: 0, type: 0, actions: [
        { action: 'keydown', code: 4, delay: 20 },
        { action: 'keyup', code: 4, delay: 5 }
      ] }
    ], macroBuf);

    // Verify header reserved bytes 50..63 are preserved
    for (let b = 50; b <= 63; b++) {
      assert.strictEqual(serialized[b], 0xA0 + (b - 50), `reserved byte ${b} must be preserved`);
    }

    // Verify written actions at 68..75
    assert.strictEqual(serialized[0], 68);
    assert.strictEqual(serialized[1], 0);

    // Verify untouched tail bytes from 100 to 8191 are preserved (not zeroed out)
    for (let b = 100; b < 8192; b++) {
      assert.strictEqual(serialized[b], (b * 17) & 0xFF, `tail byte ${b} must not be zeroed`);
    }
  });

  test('parseMacroRegion throws when macro region is unterminated', () => {
    const baseline = getBaseline();
    const corruptMacroBuf = Buffer.from(baseline.macros, 'hex');

    // Overwrite slot 0 with non-terminating actions filling all bytes up to 8192
    for (let off = 64; off < 8192; off += 4) {
      corruptMacroBuf[off] = 20;
      corruptMacroBuf[off + 1] = 0;
      corruptMacroBuf[off + 2] = 66; // keydown, kind 2 (HID), no isEnd flag
      corruptMacroBuf[off + 3] = 4;
    }

    assert.throws(() => protocol.parseMacroRegion(corruptMacroBuf), /unterminated/i);
  });

  test('parseDeviceInfo accurately parses firmware version, build date, and receiver from hardware reply', () => {
    // CMD 3 response payload from verified attached hardware
    const infoPayload = Buffer.from(
      '14013001ffff2c4a616e20313220323032362c32303a34313a3437322e344720446f6e676c65000000000000000000000000000000000000',
      'hex'
    );
    const parsed = protocol.parseDeviceInfo(infoPayload);
    assert.notStrictEqual(parsed, null);
    assert.strictEqual(parsed.firmwareVersion, '1.14');
    assert.strictEqual(parsed.rfFirmwareVersion, '1.30');
    assert.strictEqual(parsed.buildDate, 'Jan 12 2026,20:41:47');
    assert.strictEqual(parsed.dongleInfo, '2.4G Dongle');
  });

  test('decodePacket accepts GET_INFO CMD 3 echoed-checksum exception for matching expected request', () => {
    // Verified capture: Query size 56 returned aa03003826000000... (checksum 0x38 = 56, actual size 0x26 = 38)
    const info56Hex = 'aa0300382600000014013001ffff2c4a616e20313220323032362c32303a34313a3437322e344720446f6e676c65000000000000000000000000000000000000';
    // Without matching expectedRequest, strict checksum fails
    const rawPacket56 = protocol.decodePacket(Buffer.from(info56Hex, 'hex'));
    assert.strictEqual(rawPacket56.checksumValid, false);

    // With matching expected checksum (0x38 = 56), it succeeds
    const packet56 = protocol.decodePacket(Buffer.from(info56Hex, 'hex'), { expectedChecksum: 0x38 });
    assert.notStrictEqual(packet56, null);
    assert.strictEqual(packet56.command, 3);
    assert.strictEqual(packet56.status, 0);
    assert.strictEqual(packet56.checksumValid, true);
    assert.strictEqual(packet56.success, true);
    assert.strictEqual(packet56.size, 38);

    // Mismatched expected checksum (request 56 receiving 38-echo 0x26) MUST NOT be accepted
    const mismatchedPacket = protocol.decodePacket(Buffer.from(info56Hex, 'hex'), { expectedChecksum: 0x26 });
    assert.strictEqual(mismatchedPacket.checksumValid, false);

    // Verified capture: Query size 38 returned aa03002626000000... (checksum 0x26 = 38, actual size 0x26 = 38)
    const info38Hex = 'aa0300262600000014013001ffff2c4a616e20313220323032362c32303a34313a3437322e344720446f6e676c65000000000000000000000000000000000000';
    const packet38 = protocol.decodePacket(Buffer.from(info38Hex, 'hex'), { expectedChecksum: 0x26 });
    assert.notStrictEqual(packet38, null);
    assert.strictEqual(packet38.command, 3);
    assert.strictEqual(packet38.status, 0);
    assert.strictEqual(packet38.checksumValid, true);
    assert.strictEqual(packet38.success, true);
    assert.strictEqual(packet38.size, 38);
  });

  test('verified GLW MACRO key tuple uses type 112 and playback type in code2', () => {
    assert.strictEqual(protocol.KEY_TYPES.MACRO, 112);

    // Encode macro slot 0 with playback type 1 (play once)
    const encodedOnce = protocol.encodeKeyTuple({ type: 112, slot: 0, playbackType: 1 });
    assert.deepStrictEqual(encodedOnce, [112, 0, 1]);

    // Encode macro slot 2 with playback type 0 (repeat while held)
    const encodedHeld = protocol.encodeKeyTuple({ type: 112, slot: 2, playbackType: 0 });
    assert.deepStrictEqual(encodedHeld, [112, 2, 0]);

    // Encode macro slot 5 with playback type 255 (toggle repeat)
    const encodedToggle = protocol.encodeKeyTuple({ type: 112, slot: 5, playbackType: 255 });
    assert.deepStrictEqual(encodedToggle, [112, 5, 255]);

    // Decode macro tuple
    const decoded = protocol.decodeKeyTuple([112, 0, 1]);
    assert.strictEqual(decoded.type, 112);
    assert.strictEqual(decoded.slot, 0);
    assert.strictEqual(decoded.playbackType, 1);
    assert.strictEqual(decoded.label, 'M1');
    assert.strictEqual(decoded.isMacro, true);
  });

  test('shared schema validators reject unknown keys, nonintegers, and out-of-range inputs', () => {
    const { validators } = protocol;

    // Reject unknown lighting key
    const badLight = validators.validateLightingParams({ effect: 1, unknownField: 42 });
    assert.strictEqual(badLight.valid, false);
    assert.match(badLight.error, /unknown lighting parameter/i);

    // Reject invalid lighting effect (only 0..22 supported)
    const badEffect = validators.validateLightingParams({ effect: 25 });
    assert.strictEqual(badEffect.valid, false);
    assert.match(badEffect.error, /invalid lighting effect/i);

    // Reject non-integer speed
    const floatSpeed = validators.validateLightingParams({ speed: 2.5 });
    assert.strictEqual(floatSpeed.valid, false);
    assert.match(floatSpeed.error, /invalid speed/i);

    // Reject invalid hex
    const badHex = validators.validateLightingParams({ hexColor: 'not-hex' });
    assert.strictEqual(badHex.valid, false);
    assert.match(badHex.error, /invalid hexColor/i);

    // Reject non-integer settings
    const badSleep = validators.validateSettingsParams({ sleepTime: '10' });
    assert.strictEqual(badSleep.valid, false);
    assert.match(badSleep.error, /invalid sleepTime/i);

    // Reject non-physical key slot in keymap
    const badKeySlot = validators.validateKeymapUpdates([{ slot: 7, type: 16, code1: 0, code2: 4 }]);
    assert.strictEqual(badKeySlot.valid, false);
    assert.match(badKeySlot.error, /non-physical slot/i);

    // Reject reserved LED slot in key colors
    const badLedSlot = validators.validateKeyColors({ 120: '#FF0000' });
    assert.strictEqual(badLedSlot.valid, false);
    assert.match(badLedSlot.error, /restricted to the 83 valid physical lighting zones/i);
  });

  test('audit item 2 regressions: strictly reject all 7 verified invalid inputs', () => {
    const { validators } = protocol;

    // 1. validateProfileSchema({layers:{'0junk':null}})
    const r1 = validators.validateProfileSchema({ layers: { '0junk': null } });
    assert.strictEqual(r1.valid, false, 'validateProfileSchema({layers:{"0junk":null}}) must be rejected');

    // 2. validateProfileSchema({unexpected:'not a backup'})
    const r2 = validators.validateProfileSchema({ unexpected: 'not a backup' });
    assert.strictEqual(r2.valid, false, 'validateProfileSchema({unexpected:"not a backup"}) must be rejected');

    // 3. validateLightingParams({calibrationRgb:'bad',colorIndex:NaN})
    const r3 = validators.validateLightingParams({ calibrationRgb: 'bad', colorIndex: NaN });
    assert.strictEqual(r3.valid, false, 'validateLightingParams({calibrationRgb:"bad",colorIndex:NaN}) must be rejected');

    // 4. validateSettingsParams({lockAltTab:'bad',reportRate24G:999})
    const r4 = validators.validateSettingsParams({ lockAltTab: 'bad', reportRate24G: 999 });
    assert.strictEqual(r4.valid, false, 'validateSettingsParams({lockAltTab:"bad",reportRate24G:999}) must be rejected');

    // 5. validateKeymapUpdates([{slot:11,type:16}])
    const r5 = validators.validateKeymapUpdates([{ slot: 11, type: 16 }]);
    assert.strictEqual(r5.valid, false, 'validateKeymapUpdates([{slot:11,type:16}]) missing code1/code2 must be rejected');

    // 6. validateKeyColors({'11junk':'#FF0000'})
    const r6 = validators.validateKeyColors({ '11junk': '#FF0000' });
    assert.strictEqual(r6.valid, false, 'validateKeyColors({"11junk":"#FF0000"}) must be rejected');

    // 7. validateMacroSlots([{id:0,type:2,actions:[{action:'keydown'}]}])
    const r7 = validators.validateMacroSlots([{ id: 0, type: 2, actions: [{ action: 'keydown' }] }]);
    assert.strictEqual(r7.valid, false, 'validateMacroSlots([{id:0,type:2,actions:[{action:"keydown"}]}]) must be rejected');
  });

  test('audit item 7: media consumer tuples and Fn layer decoding', () => {
    // Media & Audio consumer keys [48, code1, 0]
    const mediaCases = [
      { tuple: [48, 233, 0], expectedLabel: 'Volume Up', code1: 233 },
      { tuple: [48, 234, 0], expectedLabel: 'Volume Down', code1: 234 },
      { tuple: [48, 226, 0], expectedLabel: 'Mute', code1: 226 },
      { tuple: [48, 205, 0], expectedLabel: 'Play / Pause', code1: 205 },
      { tuple: [48, 181, 0], expectedLabel: 'Next Track', code1: 181 },
      { tuple: [48, 182, 0], expectedLabel: 'Prev Track', code1: 182 },
      { tuple: [48, 111, 0], expectedLabel: 'Brightness Up', code1: 111 },
      { tuple: [48, 112, 0], expectedLabel: 'Brightness Down', code1: 112 }
    ];

    for (const mc of mediaCases) {
      const dec = protocol.decodeKeyTuple(mc.tuple);
      assert.strictEqual(dec.type, 48);
      assert.strictEqual(dec.code1, mc.code1);
      assert.strictEqual(dec.code2, 0);
      assert.strictEqual(dec.label, mc.expectedLabel);
      assert.strictEqual(dec.isMedia, true);
    }

    // Known full-tuple consumer usages (code2 > 0)
    assert.strictEqual(protocol.decodeKeyTuple([48, 146, 1]).label, 'Calculator');
    assert.strictEqual(protocol.decodeKeyTuple([48, 148, 1]).label, 'My computer');
    assert.strictEqual(protocol.decodeKeyTuple([48, 138, 1]).label, 'Mail');
    assert.strictEqual(protocol.decodeKeyTuple([48, 35, 2]).label, 'Browser homepage');
    assert.strictEqual(protocol.decodeKeyTuple([48, 39, 2]).label, 'Refresh (web page)');
    assert.strictEqual(protocol.decodeKeyTuple([48, 33, 2]).label, 'Search (Web)');
    assert.strictEqual(protocol.decodeKeyTuple([48, 42, 2]).label, 'Favorites');

    // Unknown highbyte must NOT fall back to unrelated lowbyte label
    const wrongCalc0 = protocol.decodeKeyTuple([48, 146, 0]);
    assert.notStrictEqual(wrongCalc0.label, 'Calculator');
    assert.strictEqual(wrongCalc0.label, 'Media 146');

    const wrongCalc99 = protocol.decodeKeyTuple([48, 146, 99]);
    assert.notStrictEqual(wrongCalc99.label, 'Calculator');
    assert.strictEqual(wrongCalc99.label, 'Media [48, 146, 99]');

    const wrongHome0 = protocol.decodeKeyTuple([48, 35, 0]);
    assert.notStrictEqual(wrongHome0.label, 'Browser homepage');
    assert.notStrictEqual(wrongHome0.label, 'Homepage');
    assert.strictEqual(wrongHome0.label, 'Media 35');

    const wrongHome99 = protocol.decodeKeyTuple([48, 35, 99]);
    assert.notStrictEqual(wrongHome99.label, 'Browser homepage');
    assert.strictEqual(wrongHome99.label, 'Media [48, 35, 99]');

    const wrongMute = protocol.decodeKeyTuple([48, 226, 99]);
    assert.notStrictEqual(wrongMute.label, 'Mute');
    assert.strictEqual(wrongMute.label, 'Media [48, 226, 99]');

    // Fn layer key: Win [240, 255, 1] vs Mac [240, 255, 3]
    const fnWinDec = protocol.decodeKeyTuple([240, 255, 1]);
    assert.strictEqual(fnWinDec.type, 240);
    assert.strictEqual(fnWinDec.code1, 255);
    assert.strictEqual(fnWinDec.code2, 1);

    const fnMacDec = protocol.decodeKeyTuple([240, 255, 3]);
    assert.strictEqual(fnMacDec.type, 240);
    assert.strictEqual(fnMacDec.code1, 255);
    assert.strictEqual(fnMacDec.code2, 3);

    // Disabled / clear key [0, 0, 0]
    const clearDec = protocol.decodeKeyTuple([0, 0, 0]);
    assert.strictEqual(clearDec.type, 0);
    assert.strictEqual(clearDec.code1, 0);
    assert.strictEqual(clearDec.code2, 0);
  });

  test('audit item 8: parseInfo with missing or short payload returns null / Unknown, not invented fallbacks', () => {
    // Payload with only 4 bytes (firmware versions only, no build string)
    const shortPayload = Buffer.from([0x14, 0x01, 0x30, 0x01]);
    const info = protocol.parseInfo(shortPayload);
    assert.notStrictEqual(info, null);
    assert.strictEqual(info.firmwareVersion, '1.14');
    assert.strictEqual(info.rfFirmwareVersion, '1.30');
    // Must NOT have invented 'Jan 12 2026, 20:41:47' or '2.4G Dongle'
    assert.strictEqual(info.buildDate, null);
    assert.strictEqual(info.dongleInfo, null);

    // Payload with empty string after byte 6
    const emptyStrPayload = Buffer.from([0x14, 0x01, 0x30, 0x01, 0xFF, 0xFF, 0x00, 0x00]);
    const info2 = protocol.parseInfo(emptyStrPayload);
    assert.strictEqual(info2.buildDate, null);
    assert.strictEqual(info2.dongleInfo, null);
  });

  test('strict advanced validators reject arrays, unknown keys, wrong types, and malformed tuples', () => {
    const { validators } = protocol;

    const asArray = validators.validateAdvancedProfile([]);
    assert.strictEqual(asArray.valid, false);
    assert.match(asArray.error, /plain object/i);

    const mtNumber = validators.validateAdvancedProfile({ mt: 5 });
    assert.strictEqual(mtNumber.valid, false);
    assert.match(mtNumber.error, /512-hex string or array/i);

    const bogus = validators.validateAdvancedProfile({ bogus: true });
    assert.strictEqual(bogus.valid, false);
    assert.match(bogus.error, /unknown key/i);

    const negative = validators.validateAdvancedProfile({
      mt: [{ index: 0, tapKey: [16, 0, -1], holdKey: [16, 0, 4] }]
    });
    assert.strictEqual(negative.valid, false);

    const nanTuple = validators.validateAdvancedProfile({
      mt: [{ index: 0, tapKey: [16, 0, Number.NaN], holdKey: [16, 0, 4] }]
    });
    assert.strictEqual(nanTuple.valid, false);

    const missingByte = validators.validateAdvancedProfile({
      mt: [{ index: 0, tapKey: [16, 0], holdKey: [16, 0, 4] }]
    });
    assert.strictEqual(missingByte.valid, false);

    const twoByteNegative = validators.validateAdvancedProfile({
      mt: [{ index: 0, tapKey: [16, -1], holdKey: [16, 0, 4] }]
    });
    assert.strictEqual(twoByteNegative.valid, false);

    const recursive = validators.validateAdvancedProfile({
      mt: [{ index: 0, tapKey: [146, 1, 15], holdKey: [16, 0, 4] }]
    });
    assert.strictEqual(recursive.valid, false);
    assert.match(recursive.error, /recursive|ordinary/i);

    const profileWithArrayAdvanced = validators.validateProfileSchema({
      model: 'MCHOSE G75 V2',
      protocol: 'GLW',
      version: '2.0.0',
      lighting: { effect: 0 },
      settings: { macMode: 2 },
      layers: { 0: {}, 1: {}, 2: {}, 3: {} },
      perKeyRgb: {},
      macros: [],
      advanced: []
    });
    assert.strictEqual(profileWithArrayAdvanced.valid, false);
  });

  test('serializeMtTable / serializeTglTable preserve reserved bytes and reject missing tuple bytes', () => {
    const mt = Buffer.alloc(256, 0);
    mt.fill(0xAB, 192, 256);
    const serialized = protocol.serializeMtTable([
      { index: 0, rawTap: [16, 0, 4], rawHold: [16, 2, 0] }
    ], mt);
    assert.strictEqual(serialized.length, 256);
    assert.deepStrictEqual(Array.from(serialized.subarray(0, 6)), [16, 0, 4, 16, 2, 0]);
    assert.ok(serialized.subarray(192, 256).every((b) => b === 0xAB));

    assert.throws(() => protocol.serializeMtTable([{ index: 0, rawTap: [16, 0], rawHold: [16, 0, 4] }], mt), TypeError);

    const tgl = Buffer.alloc(128, 0);
    tgl.fill(0xCD, 96, 128);
    const tglSer = protocol.serializeTglTable([{ index: 1, rawTarget: [16, 0, 41] }], tgl);
    assert.deepStrictEqual(Array.from(tglSer.subarray(3, 6)), [16, 0, 41]);
    assert.ok(tglSer.subarray(96, 128).every((b) => b === 0xCD));
  });

  test('enableProfileCount preserves order and marker bytes while enabling the fourth profile', () => {
    const baseline = getBaseline();
    const base = Buffer.from(baseline.base, 'hex');
    const parsed = protocol.parseBase(base);
    assert.strictEqual(parsed.profileCount, 3);
    const enabled = protocol.enableProfileCount(base, 4);
    assert.strictEqual(enabled[1], 4);
    assert.strictEqual(enabled[0], parsed.profileOrder.indexOf(parsed.activeProfile));
    assert.deepStrictEqual(Array.from(enabled.subarray(2, 6)), parsed.profileOrder);
    assert.deepStrictEqual(Array.from(enabled.subarray(6, 56)), Array.from(base.subarray(6, 56)));
  });

  test('mutateKeyExtrasPriority only changes the high nibble of byte 1', () => {
    const extras = Buffer.from(require('./fixtures/advanced-baseline.json').keyExtras, 'hex');
    const original = Buffer.from(extras);
    const mutated = protocol.mutateKeyExtrasPriority(extras, 11, 1);
    assert.strictEqual(mutated[11 * 8 + 1], 0x10);
    assert.strictEqual(mutated[11 * 8], original[11 * 8]);
    for (let i = 2; i < 8; i++) {
      assert.strictEqual(mutated[11 * 8 + i], original[11 * 8 + i]);
    }
    assert.strictEqual(mutated[0], original[0]);
  });
});

