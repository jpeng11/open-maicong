const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const names = require('../src/profile-names.cjs');
const tokenFixture = require('./fixtures/profile-names-i18n-default-onboard.json');

describe('profile name wire codec', () => {
  test('encodes names as UTF-8 JSON on 255 fill and rejects oversized UTF-8', () => {
    const encoded = names.encodeProfileNames(['AB', 'CD', '', '']);
    assert.equal(encoded.valid, true, encoded.error);
    assert.equal(encoded.buffer.length, 280);
    assert.equal(encoded.buffer[encoded.byteLength], 255);
    const decoded = names.decodeProfileNames(encoded.buffer);
    assert.equal(decoded.valid, true);
    assert.deepEqual(decoded.stored.slice(0, 2), ['AB', 'CD']);

    const huge = '名'.repeat(80);
    const overflow = names.encodeProfileNames([huge, huge, huge, huge]);
    assert.equal(overflow.valid, false);
    assert.match(overflow.error, /does not fit/);
  });

  test('literal stored i18n tokens display as Default Onboard and are not treated as user strings', () => {
    const raw = fs.readFileSync(path.join(__dirname, 'fixtures', 'profile-names-i18n-default-onboard.json'), 'utf8');
    assert.match(raw, /i18n<defaultOnboard>2/);
    assert.doesNotMatch(raw, /Maicong Studio/);
    assert.deepEqual(tokenFixture.stored[0], 'i18n<defaultOnboard>');
    assert.deepEqual(tokenFixture.stored[1], 'i18n<defaultOnboard>2');
    assert.deepEqual(tokenFixture.stored[2], 'i18n<defaultOnboard>3');
    const encoded = names.encodeProfileNames(tokenFixture.stored);
    assert.equal(encoded.valid, true, encoded.error);
    const decoded = names.decodeProfileNames(encoded.buffer);
    assert.equal(decoded.valid, true);
    assert.equal(decoded.empty, false);
    assert.deepEqual(decoded.stored.slice(0, 3), tokenFixture.stored.slice(0, 3));
    assert.deepEqual(decoded.names.slice(0, 3), ['Default Onboard', 'Default Onboard2', 'Default Onboard3']);
    assert.equal(names.translateI18nDisplay('My Board'), 'My Board');
    assert.equal(names.translateI18nDisplay('i18nnotatoken'), 'i18nnotatoken');
    assert.equal(names.isI18nNameToken('i18n<defaultOnboard>2'), true);
    assert.equal(names.isI18nNameToken('Default Onboard2'), false);
    const allocated = names.allocateLocalName('i18n<defaultOnboard>2', [
      { name: 'Default Onboard' },
      { name: 'Default Onboard2' }
    ]);
    assert.equal(allocated.valid, true, allocated.error);
    assert.ok(allocated.name.length >= 2 && allocated.name.length <= 15);
    assert.equal(allocated.name.includes('i18n<'), false);
    assert.equal(allocated.original, 'i18n<defaultOnboard>2');
    const extra = names.extraWithPreservedOriginal({}, allocated);
    assert.equal(extra.storedName, 'i18n<defaultOnboard>2');
    assert.equal(extra.displayName.includes('i18n<'), false);
  });

  test('empty storage translates defaults locally and does not look like hardware names', () => {
    const empty = names.decodeProfileNames(Buffer.alloc(280, 0));
    assert.equal(empty.valid === false || empty.empty === true || empty.malformed, true);
    const fromEmptyArray = names.decodeProfileNames(names.encodeProfileNames(['', '', '', '']).buffer);
    assert.equal(fromEmptyArray.empty, true);
    assert.equal(fromEmptyArray.names[0], 'Default Onboard');
    assert.equal(fromEmptyArray.names[1], 'Default Onboard2');
    assert.equal(fromEmptyArray.names[3], 'Default Onboard4');
  });

  test('feature support merge preserves macro timestamp and browser ownership', () => {
    const encoded = names.mergeFeatureSupport(
      { macroUpdatedAt: 11, profileNameUpdatedAt: 0, browserId: 'abc', browserIdExpiredAt: 99 },
      { profileNameUpdatedAt: 50 }
    );
    assert.equal(encoded.valid, true, encoded.error);
    const decoded = names.decodeFeatureSupport(encoded.buffer);
    assert.equal(decoded.valid, true);
    assert.equal(decoded.support.macroUpdatedAt, 11);
    assert.equal(decoded.support.profileNameUpdatedAt, 50);
    assert.equal(decoded.support.browserId, 'abc');
    assert.equal(decoded.support.browserIdExpiredAt, 99);
  });

  test('name validator is 2..15 and unique among ordinary names', () => {
    assert.equal(names.validateProfileName('A').valid, false);
    assert.equal(names.validateProfileName('AB').valid, true);
    assert.equal(names.validateProfileName('1234567890123456').valid, false);
    const clash = names.validateProfileName('AB', { existing: [{ name: 'AB' }] });
    assert.equal(clash.valid, false);
    assert.equal(names.validateProfileName('名'.repeat(15)).valid, true);
    assert.equal(names.validateProfileName('名'.repeat(16)).valid, false);
  });

  test('vendor default onboard labels stay translated locally; local allocation is 2..15 unique', () => {
    assert.equal(names.defaultOnboardName(0), 'Default Onboard');
    assert.equal(names.defaultOnboardName(1), 'Default Onboard2');
    assert.equal(names.defaultOnboardName(2), 'Default Onboard3');
    assert.equal(names.defaultOnboardName(3), 'Default Onboard4');
    assert.equal(names.defaultOnboardName(0).length, 15);
    assert.equal(names.defaultOnboardName(1).length, 16);
    const onboard = [0, 1, 2, 3].map((i) => ({ name: names.defaultOnboardName(i), key: `onboard:${i}` }));
    for (let slot = 0; slot < 4; slot++) {
      const allocated = names.allocateLocalName(names.defaultOnboardName(slot), onboard);
      assert.equal(allocated.valid, true, allocated.error);
      assert.ok(allocated.name.length >= 2 && allocated.name.length <= 15, allocated.name);
      assert.equal(names.validateProfileName(allocated.name, { existing: onboard }).valid, true, allocated.name);
      if (names.defaultOnboardName(slot).length > 15) {
        assert.equal(allocated.original, names.defaultOnboardName(slot));
        assert.notEqual(allocated.name, allocated.original);
        const extra = names.extraWithPreservedOriginal({}, allocated);
        assert.equal(extra.displayName, names.defaultOnboardName(slot));
      }
    }
  });

  test('duplicate and max-length Unicode names allocate unique 2..15 locals without loosening the validator', () => {
    const fifteen = '名'.repeat(15);
    const sixteen = '名'.repeat(16);
    const first = names.allocateLocalName(fifteen, []);
    assert.equal(first.name, fifteen);
    const dup = names.allocateLocalName(fifteen, [{ name: fifteen }]);
    assert.equal(dup.valid, true, dup.error);
    assert.notEqual(dup.name, fifteen);
    assert.ok(dup.name.length >= 2 && dup.name.length <= 15);
    assert.equal(names.validateProfileName(dup.name, { existing: [{ name: fifteen }] }).valid, true);
    const long = names.allocateLocalName(sixteen, [{ name: fifteen }]);
    assert.equal(long.valid, true, long.error);
    assert.ok(long.name.length <= 15);
    assert.equal(long.original, sixteen);
    assert.equal(names.extraWithPreservedOriginal({}, long).displayName, sixteen);
    assert.equal(names.validateProfileName(sixteen).valid, false);
  });
});
