const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const firmware = require('../src/firmware-protocol.cjs');

function payload(report) {
  assert.equal(report.length, firmware.WRITE_BUFFER_SIZE);
  assert.equal(report[0], firmware.REPORT_ID);
  return report.subarray(1);
}

describe('G75 V2 firmware catalog and pure packet framing', () => {
  test('catalog keeps official target identities, versions, sizes, and hashes separate from headers', () => {
    const keyboard = firmware.OFFICIAL_CATALOG.keyboard;
    const receiver = firmware.OFFICIAL_CATALOG.receiver;

    assert.deepEqual(
      { vid: keyboard.normal.vendorId, normalPid: keyboard.normal.productId, bootPid: keyboard.boot.productId },
      { vid: 0x3837, normalPid: 0x2021, bootPid: 0x2022 }
    );
    assert.deepEqual(
      { vid: receiver.normal.vendorId, normalPid: receiver.normal.productId, bootPid: receiver.boot.productId },
      { vid: 0x3837, normalPid: 0x3033, bootPid: 0x2010 }
    );
    assert.equal(keyboard.package.version, '1.14');
    assert.equal(receiver.package.version, '1.30');
    assert.equal(keyboard.package.size, 264408);
    assert.equal(receiver.package.size, 121032);
    assert.match(keyboard.package.sha256, /^[0-9a-f]{64}$/);
    assert.match(receiver.package.sha256, /^[0-9a-f]{64}$/);
    assert.equal(keyboard.package.versionSource, 'official-catalog');
    assert.equal(receiver.package.versionSource, 'official-catalog');
    assert.equal(keyboard.package.url.startsWith('https://cdn.mchose.com.cn/'), true);
    assert.equal(receiver.package.url.startsWith('https://cdn.mchose.com.cn/'), true);
  });

  test('normal and boot matching is exact and never uses product names', () => {
    const normal = {
      vendorId: 0x3837,
      productId: 0x3033,
      interface: 1,
      usagePage: 1,
      usage: undefined,
      product: 'A similarly named unrelated receiver'
    };
    const boot = {
      vendorId: 0x3837,
      productId: 0x2010,
      usagePage: 0xFF00,
      usage: 1,
      product: 'MCHOSE G75 V2 2.4G'
    };
    assert.equal(firmware.matchesNormalIdentity(normal, 'receiver'), true);
    assert.equal(firmware.matchesBootIdentity(boot, 'receiver'), true);
    assert.equal(firmware.matchesNormalIdentity({ ...normal, productId: 0x9999 }, 'receiver'), false);
    assert.equal(firmware.matchesNormalIdentity({ ...normal, usagePage: 6 }, 'receiver'), false);
    assert.equal(firmware.matchesBootIdentity({ ...boot, usage: 0 }, 'receiver'), false);
    assert.equal(firmware.matchesBootIdentity({ ...boot, productId: 0x3033 }, 'receiver'), false);
  });

  test('enter-boot packet is report ID 0 plus the traced raw payload and zero padding', () => {
    const report = firmware.buildEnterBootPacket();
    const bytes = payload(report);
    assert.deepEqual(Array.from(bytes.subarray(0, firmware.ENTER_BOOT_PAYLOAD.length)), Array.from(firmware.ENTER_BOOT_PAYLOAD));
    assert.ok(bytes.subarray(firmware.ENTER_BOOT_PAYLOAD.length).every(b => b === 0));
  });

  test('erase packet uses boot VID/PID identity and exact seven-byte payload', () => {
    const report = firmware.buildErasePacket({ vendorId: 0x3837, productId: 0x2010 });
    const bytes = payload(report);
    assert.deepEqual(Array.from(bytes.subarray(0, 7)), [0x81, 0x07, 0x37, 0x38, 0x10, 0x20, 0x00]);
    assert.ok(bytes.subarray(7).every(b => b === 0));
    assert.throws(() => firmware.buildErasePacket({ vendorId: 0x3837, productId: 0x3033 }), /boot product ID/i);
    assert.throws(() => firmware.buildErasePacket({ vendorId: 0x1234, productId: 0x2010 }), /vendor ID/i);
  });

  test('write and check chunks encode 32-byte data with little-endian uint32 offsets', () => {
    const data = Buffer.alloc(32, 0xA5);
    const write = payload(firmware.buildWriteChunkPacket(0x12345678, data));
    const check = payload(firmware.buildCheckChunkPacket(0x12345678, data));
    assert.equal(write[0], 0x80);
    assert.equal(check[0], 0x82);
    assert.equal(write[1], 32);
    assert.deepEqual(Array.from(write.subarray(2, 6)), [0x78, 0x56, 0x34, 0x12]);
    assert.deepEqual(Array.from(write.subarray(6, 38)), Array.from(data));
    assert.deepEqual(Array.from(check.subarray(6, 38)), Array.from(data));
    assert.ok(write.subarray(38).every(b => b === 0));
  });

  test('last short chunk is represented without padding in its declared length', () => {
    const data = Buffer.from([1, 2, 3, 4, 5, 6, 7]);
    const bytes = payload(firmware.buildWriteChunkPacket(32, data));
    assert.deepEqual(Array.from(bytes.subarray(0, 6)), [0x80, 7, 32, 0, 0, 0]);
    assert.deepEqual(Array.from(bytes.subarray(6, 13)), Array.from(data));
    assert.ok(bytes.subarray(13).every(b => b === 0));
  });

  test('end and success packets are distinct traced five-byte flag commands', () => {
    assert.deepEqual(Array.from(payload(firmware.buildEndPacket()).subarray(0, 5)), [0x83, 1, 0, 0, 0]);
    assert.deepEqual(Array.from(payload(firmware.buildSuccessPacket()).subarray(0, 5)), [0x84, 1, 0, 0, 0]);
  });
});

describe('G75 V2 firmware catalog version matching', () => {
  test('official 114/130 catalog numbers match GET_INFO 0x0114/0x0130 raw values', () => {
    assert.equal(firmware.catalogVersionMatchesRaw(0x0114, firmware.OFFICIAL_CATALOG.keyboard.package), true);
    assert.equal(firmware.catalogVersionMatchesRaw(0x0130, firmware.OFFICIAL_CATALOG.receiver.package), true);
    assert.equal(firmware.catalogVersionMatchesRaw(0x0115, firmware.OFFICIAL_CATALOG.keyboard.package), false);
    assert.equal(firmware.catalogVersionMatchesRaw(100, { versionNumber: 100, version: 'fixture' }), true);
  });
});

describe('G75 V2 firmware flag responses and package validation', () => {
  test('strict flag matching accepts only [0,0], rejects [0,1], and ignores unrelated flags', () => {
    assert.deepEqual(firmware.decodeFlagResponse(firmware.buildFlagResponse(0)), {
      matched: true, success: true, rejected: false, receiveFlag: 0, reportId: null
    });
    const prefixed = firmware.decodeFlagResponse(firmware.buildFlagResponse(0, true));
    assert.equal(prefixed.matched, true);
    assert.equal(prefixed.success, true);

    const rejected = firmware.decodeFlagResponse(firmware.buildFlagResponse(1));
    assert.equal(rejected.matched, true);
    assert.equal(rejected.success, false);
    assert.equal(rejected.rejected, true);
    assert.equal(rejected.receiveFlag, 1);
    assert.equal(firmware.decodeFlagResponse(Buffer.from([2, 0, 0, 0])).matched, false);
    assert.equal(firmware.decodeFlagResponse(Buffer.from([0])).matched, false);
  });

  test('package validation requires a known manifest and hashes the complete file', () => {
    const fixture = Buffer.from('complete firmware fixture including header');
    const sha256 = crypto.createHash('sha256').update(fixture).digest('hex');
    const catalog = {
      fixture: {
        key: 'fixture',
        id: 'fixture-target',
        kind: 'keyboard',
        normal: { vendorId: 0x3837, productId: 0x2021, interface: 1, usagePage: 1, usage: 0 },
        boot: { vendorId: 0x3837, productId: 0x2022, usagePage: 0xFF00, usage: 1 },
        package: {
          fileName: 'fixture.bin',
          size: fixture.length,
          sha256,
          version: 'fixture-version',
          versionSource: 'fixture'
        }
      }
    };
    const valid = firmware.validateFirmwarePackage(fixture, 'fixture', { catalog });
    assert.equal(valid.valid, true);
    assert.equal(valid.fullFile, true);
    assert.equal(valid.headerPreserved, true);
    assert.equal(valid.size, fixture.length);
    assert.equal(valid.sha256, sha256);
    assert.deepEqual(firmware.packageReview(valid), {
      targetKey: 'fixture',
      targetId: 'fixture-target',
      targetKind: 'keyboard',
      transport: undefined,
      version: 'fixture-version',
      versionNumber: undefined,
      versionSource: 'fixture',
      fileName: 'fixture.bin',
      size: fixture.length,
      sha256,
      fullFile: true,
      headerPreserved: true
    });

    const wrongSize = firmware.validateFirmwarePackage(Buffer.concat([fixture, Buffer.from([0])]), 'fixture', { catalog });
    assert.equal(wrongSize.valid, false);
    assert.match(wrongSize.error, /size mismatch/i);
    const wrongHash = firmware.validateFirmwarePackage(Buffer.from(fixture).fill(0), 'fixture', { catalog });
    assert.equal(wrongHash.valid, false);
    assert.match(wrongHash.error, /SHA-256 mismatch/i);
    const unknown = firmware.validateFirmwarePackage(fixture, 'unknown', { catalog });
    assert.equal(unknown.valid, false);
    assert.match(unknown.error, /known catalog identity/i);
  });

  test('manifest-shaped target references cannot override the configured catalog', () => {
    const forgedReference = {
      ...firmware.OFFICIAL_CATALOG.receiver,
      package: {
        size: 2,
        sha256: firmware.sha256Hex(Buffer.from([1, 2])),
        version: 'forged'
      }
    };
    const result = firmware.validateFirmwarePackage(Buffer.from([1, 2]), forgedReference);
    assert.equal(result.valid, false);
    assert.match(result.error, /size mismatch/i);
    assert.equal(firmware.resolveTarget(forgedReference), firmware.OFFICIAL_CATALOG.receiver);
    assert.equal(firmware.resolveTarget({ normal: {}, boot: {}, package: {} }), null);
  });

  test('same-device continuity requires stable USB location and compatible serial evidence', () => {
    const normal = {
      serialNumber: 'SN1',
      locationId: 123,
      registryEntryId: 111,
      path: 'DevSrvsID:normal'
    };
    const boot = {
      serialNumber: 'SN1',
      locationId: '0x7b',
      registryEntryId: 222,
      path: 'DevSrvsID:boot'
    };
    assert.equal(firmware.sameDeviceIdentity(normal, boot), true);
    assert.equal(firmware.sameDeviceIdentity(normal, { ...boot, serialNumber: 'SN2' }), false);
    assert.equal(firmware.sameDeviceIdentity(normal, { ...boot, locationId: 124 }), false);
    assert.equal(firmware.sameDeviceIdentity({ path: 'same' }, { path: 'same' }), false);
    assert.equal(firmware.sameDeviceIdentity({ serialNumber: 'SN1' }, { serialNumber: 'SN1' }), false);
    assert.equal(firmware.sameDeviceIdentity({ locationId: '123junk' }, { locationId: 123 }), false);
  });

  test('topology number parsing is strict and bounded', () => {
    assert.equal(firmware.parseTopologyNumber('123'), 123);
    assert.equal(firmware.parseTopologyNumber('000123'), 123);
    assert.equal(firmware.parseTopologyNumber('0x7b'), 123);
    assert.equal(firmware.parseTopologyNumber('0x02400000'), 0x02400000);
    assert.equal(firmware.parseTopologyNumber('0X0000007B'), 123);
    assert.equal(firmware.parseTopologyNumber('123junk'), null);
    assert.equal(firmware.parseTopologyNumber('0x7b-nope'), null);
    assert.equal(firmware.parseTopologyNumber('+123'), null);
    assert.equal(firmware.parseTopologyNumber('-1'), null);
    assert.equal(firmware.parseTopologyNumber('1.0'), null);
    assert.equal(firmware.parseTopologyNumber('4294967296'), null);
  });
});
