/**
 * Production-only packaging check: electron-builder ships src/** only.
 * Copying layout-g75v2.cjs into a tempdir must not silently fall back to
 * Win-layer KEY_BY_SLOT.defaultTuple when ../test/fixtures is absent.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

describe('packaged immutable default layers', () => {
  test('layout module alone (no test/fixtures, no src/data) fail-closes instead of [16,0,58]', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maicong-layout-'));
    try {
      fs.copyFileSync(
        path.join(__dirname, '..', 'src', 'layout-g75v2.cjs'),
        path.join(tmp, 'layout-g75v2.cjs')
      );
      assert.strictEqual(fs.existsSync(path.join(tmp, 'data', 'default-layers.json')), false);
      assert.strictEqual(
        fs.existsSync(path.join(tmp, '..', 'test', 'fixtures', 'default-layers.json')),
        false
      );
      const isolated = require(path.join(tmp, 'layout-g75v2.cjs'));
      let result;
      let threw = false;
      try {
        result = isolated.getDefaultTuple(1, 8);
      } catch (err) {
        threw = true;
        assert.match(String(err.message), /unavailable|missing|capture/i);
      }
      assert.ok(threw, 'must throw when bundled CMD7 capture is absent');
      assert.notDeepStrictEqual(result, [16, 0, 58]);
      assert.notDeepStrictEqual(result, [16, 0, 0]);
      assert.notDeepStrictEqual(result, [48, 112, 0]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('layout plus src/data capture: Fn-F1 on layer 1 is [48,112,0]', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maicong-layout-data-'));
    try {
      fs.copyFileSync(
        path.join(__dirname, '..', 'src', 'layout-g75v2.cjs'),
        path.join(tmp, 'layout-g75v2.cjs')
      );
      fs.mkdirSync(path.join(tmp, 'data'));
      fs.copyFileSync(
        path.join(__dirname, '..', 'src', 'data', 'default-layers.json'),
        path.join(tmp, 'data', 'default-layers.json')
      );
      const bundled = require(path.join(tmp, 'layout-g75v2.cjs'));
      assert.deepStrictEqual(bundled.getDefaultTuple(1, 8), [48, 112, 0]);
      assert.deepStrictEqual(bundled.getDefaultTuple(0, 8), [16, 0, 58]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
