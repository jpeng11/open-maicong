const test = require('node:test');
const assert = require('node:assert/strict');
const protocol = require('../src/protocol.cjs');
const validators = require('../src/schema-validators.cjs');

test('G75 Performance Settings Protocol & Validation Unit Tests', async (t) => {
  const baselineHex = '5000aabb01010001066400000100ff0000000000ff0000000364000101ff00006400010600010100ffffffff1111111111111111111111111111111111111111';
  const baselineBuf = Buffer.from(baselineHex, 'hex');

  await t.test('1. Polling rates 4, 3, 2, 1 validation and nibble encoding', () => {
    // Valid rates: 4=1k, 3=2k, 2=4k, 1=8k
    for (const rate of [1, 2, 3, 4]) {
      const v = validators.validateSettingsParams({ reporteRate: rate });
      assert.strictEqual(v.valid, true, `rate ${rate} must be valid`);

      // Set initial buffer byte 4 with high nibble 0xA0
      const testBuf = Buffer.from(baselineBuf);
      testBuf[4] = 0xA5;
      const mutated = protocol.mutateSettings(testBuf, { reporteRate: rate });
      assert.strictEqual(mutated[4] & 0x0F, rate, `byte 4 low nibble must be ${rate}`);
      assert.strictEqual(mutated[4] & 0xF0, 0xA0, 'byte 4 high nibble must be preserved');
    }

    // Invalid rates: 0, 5, 8, 16, 32, negative, non-integers
    for (const invalid of [0, 5, 8, 16, 32, -1, 1.5, '4', null]) {
      const v = validators.validateSettingsParams({ reporteRate: invalid });
      assert.strictEqual(v.valid, false, `rate ${invalid} must be rejected`);
    }
  });

  await t.test('2. Sleep range 1..30 minutes wire units (30s) and nonstandard preservation', () => {
    // 1 minute -> wire 2, 15 minutes -> wire 30, 30 minutes -> wire 60
    const minuteCases = [
      { minutes: 1, wire: 2 },
      { minutes: 5, wire: 10 },
      { minutes: 15, wire: 30 },
      { minutes: 30, wire: 60 }
    ];

    for (const { minutes, wire } of minuteCases) {
      const v = validators.validateSettingsParams({ sleepTime: wire });
      assert.strictEqual(v.valid, true, `wire units ${wire} (${minutes}m) must be valid`);

      const mutated = protocol.mutateSettings(baselineBuf, { sleepTime: wire });
      assert.strictEqual(mutated[35], wire, `byte 35 must equal wire units ${wire}`);
    }

    // Preserving nonstandard raw sleepTime (e.g. 5 = 150s / 2.5 min, 1 = 30 s)
    const rawOdd = 5;
    const mutatedOdd = protocol.mutateSettings(baselineBuf, { sleepTime: rawOdd });
    assert.strictEqual(mutatedOdd[35], 5, 'raw odd sleepTime must be written directly without truncation');

    const mutated30s = protocol.mutateSettings(baselineBuf, { sleepTime: 1 });
    assert.strictEqual(mutated30s[35], 1, 'raw sleepTime 1 (30 s) must not round to 2 (1 min)');

    // SDK setSleepTime pairs a new duration with sleepMode 0
    const mutatedResume = protocol.mutateSettings(baselineBuf, { sleepTime: 8, sleepMode: 0 });
    assert.strictEqual(mutatedResume[35], 8, 'setSleepTime duration writes byte 35');
    assert.strictEqual(mutatedResume[36], 0, 'setSleepTime stages sleepMode 0');

    // Never sleep toggle 1 vs 0
    const mutatedNeverSleep = protocol.mutateSettings(baselineBuf, { sleepMode: 1 });
    assert.strictEqual(mutatedNeverSleep[36], 1, 'sleepMode 1 must write 1 to byte 36');
    assert.strictEqual(mutatedNeverSleep[35], baselineBuf[35], 'sleepMode change must preserve sleepTime');

    const mutatedSleepNormal = protocol.mutateSettings(baselineBuf, { sleepMode: 0 });
    assert.strictEqual(mutatedSleepNormal[36], 0, 'sleepMode 0 must write 0 to byte 36');
  });

  await t.test('3. Key combo mode toggle (7 on, 0 off) and debounce preservation', () => {
    // Initial byte 7: preserve lower 5 bits (0x1F)
    const testBuf = Buffer.from(baselineBuf);
    testBuf[7] = 0x53; // debounce = 2 (0x40 >> 5), low bits = 0x13
    assert.strictEqual((testBuf[7] >> 5) & 7, 2);

    // Toggle off -> write 0
    const mutatedOff = protocol.mutateSettings(testBuf, { debounceLevel: 0 });
    assert.strictEqual((mutatedOff[7] >> 5) & 7, 0, 'debounceLevel 0 must be in high 3 bits');
    assert.strictEqual(mutatedOff[7] & 0x1F, 0x13, 'lower 5 bits of byte 7 must be preserved');

    // Toggle on -> write 7
    const mutatedOn = protocol.mutateSettings(testBuf, { debounceLevel: 7 });
    assert.strictEqual((mutatedOn[7] >> 5) & 7, 7, 'debounceLevel 7 must be in high 3 bits');
    assert.strictEqual(mutatedOn[7] & 0x1F, 0x13, 'lower 5 bits of byte 7 must be preserved');

    // Raw preservation of intermediate debounceLevel (e.g. 3)
    const mutatedRaw3 = protocol.mutateSettings(testBuf, { debounceLevel: 3 });
    assert.strictEqual((mutatedRaw3[7] >> 5) & 7, 3, 'raw debounceLevel 3 preserved');
  });

  await t.test('4. Mac mode encoding and Win Lock bit manipulation', () => {
    // Windows mode (macMode 0), Win Lock enabled (lockWin true)
    const testBuf = Buffer.from(baselineBuf);
    testBuf[1] = 0xF0; // high nibble preserved
    testBuf[6] = 0xFE; // bit 0 = 0

    const winProfile0 = protocol.mutateSettings(testBuf, { macMode: 0, lockWin: true }, 0);
    assert.strictEqual(winProfile0[1] & 0x0F, 0, 'profile 0 win mode has low nibble 0');
    assert.strictEqual(winProfile0[6] & 1, 1, 'lockWin true sets bit 0 of byte 6');

    // Switching to Mac mode (macMode 2), stages lockWin false
    const macProfile0 = protocol.mutateSettings(winProfile0, { macMode: 2, lockWin: false }, 0);
    assert.strictEqual(macProfile0[1] & 0x0F, 2, 'profile 0 mac mode has low nibble 2');
    assert.strictEqual(macProfile0[6] & 1, 0, 'lockWin false clears bit 0 of byte 6');

    // Profile 1 macMode encoding: profileIndex * 4 + (isMac ? 2 : 0)
    const macProfile1 = protocol.mutateSettings(testBuf, { macMode: 2 }, 1);
    assert.strictEqual(macProfile1[1] & 0x0F, 6, 'profile 1 mac mode has low nibble 6 (1*4 + 2)');

    const winProfile1 = protocol.mutateSettings(testBuf, { macMode: 0 }, 1);
    assert.strictEqual(winProfile1[1] & 0x0F, 4, 'profile 1 win mode has low nibble 4 (1*4 + 0)');
  });

  await t.test('5. Unrelated buffer bytes preservation', () => {
    const testBuf = Buffer.from(baselineBuf);
    // Mutate only sleepTime
    const mutated = protocol.mutateSettings(testBuf, { sleepTime: 20 });

    for (let i = 0; i < 64; i++) {
      if (i === 35) {
        assert.strictEqual(mutated[i], 20, 'byte 35 should have new sleepTime');
      } else {
        assert.strictEqual(mutated[i], testBuf[i], `byte ${i} must remain untouched`);
      }
    }
  });

  await t.test('6. Unknown report rates are rejected and omitted mutations preserve the nibble', () => {
    const testBuf = Buffer.from(baselineBuf);
    testBuf[4] = 0xA5; // tickRate 0xA, unknown reporteRate 5

    const rejected = validators.validateSettingsParams({ reporteRate: 5 });
    assert.strictEqual(rejected.valid, false, 'reporteRate 5 must be rejected by the validator');

    const preserved = protocol.mutateSettings(testBuf, { sleepTime: 1, sleepMode: 0, debounceLevel: 0 });
    assert.strictEqual(preserved[4], 0xA5, 'omitting reporteRate must leave the unknown nibble in byte 4');
    assert.strictEqual(preserved[35], 1);
    assert.strictEqual(preserved[36], 0);
    assert.strictEqual((preserved[7] >> 5) & 7, 0);
  });
});
