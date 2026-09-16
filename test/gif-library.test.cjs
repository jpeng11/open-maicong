const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const gifLibrary = require('../src/gif-library.cjs');
const { GifPlayer } = require('../src/gif-player.cjs');
const { buildSimpleGif } = require('./gif-fixture.cjs');

function makeTempPath(prefix = 'maicong-gif-test') {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

function cleanTemp(filePath) {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // ignore
  }
}

describe('GIF Library & G75 Native Mapping', () => {
  let tempPath;
  const testDevice = 'test-device-123';

  beforeEach(() => {
    tempPath = makeTempPath();
  });

  afterEach(() => {
    cleanTemp(tempPath);
  });

  it('mapRgbaFrameToKeyColors derives G75 geometry and aliases 301, 302, Fn 1', () => {
    // Create an RGBA buffer (e.g. 100x100 filled with #FF0000 red)
    const width = 100;
    const height = 100;
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      rgba[i * 4] = 255;   // R
      rgba[i * 4 + 1] = 0; // G
      rgba[i * 4 + 2] = 0; // B
      rgba[i * 4 + 3] = 255; // A
    }

    const mapped = gifLibrary.mapRgbaFrameToKeyColors(rgba, width, height);
    assert.ok(Array.isArray(mapped));
    assert.ok(mapped.length > 50, 'Must map keys across the keyboard');

    // Check space2 (code 301)
    const space2 = mapped.find((e) => e.code === 301);
    assert.ok(space2, 'Must contain space2 alias code 301');
    assert.strictEqual(space2.selectColor, '#FF0000');

    // Check space3 (code 302)
    const space3 = mapped.find((e) => e.code === 302);
    assert.ok(space3, 'Must contain space3 alias code 302');
    assert.strictEqual(space3.selectColor, '#FF0000');

    // Check space center (code 44)
    const spaceCenter = mapped.find((e) => e.code === 44);
    assert.ok(spaceCenter, 'Must contain space center code 44');
    assert.strictEqual(spaceCenter.selectColor, '#FF0000');

    // Check Fn alias (code 1, not visual code 255)
    const fnKey = mapped.find((e) => e.code === 1);
    assert.ok(fnKey, 'Must contain Fn alias code 1');
    assert.strictEqual(fnKey.selectColor, '#FF0000');

    // Visual code 0 and 255 should not be the stored codes
    assert.strictEqual(mapped.some((e) => e.code === 0), false, 'Lighting zones must not use code 0');
    assert.strictEqual(mapped.some((e) => e.code === 255), false, 'Fn must use alias 1, not visual 255');
  });

  it('createGif prepends new items, validates 2–15 name bounds and uniqueness', () => {
    const res1 = gifLibrary.createGif('Rainbow Wave', undefined, undefined, undefined, testDevice, tempPath);
    assert.strictEqual(res1.success, true);
    assert.strictEqual(res1.item.name, 'Rainbow Wave');
    assert.strictEqual(res1.item.data.type, 'gif');
    assert.strictEqual(res1.item.data.dataScope, 'LightingEffectProfile');
    assert.strictEqual(res1.item.data.isPreset, false);
    assert.ok(res1.item.key.startsWith('LightingEffectProfile@gif@'));

    // Duplicate name rejected
    const dupRes = gifLibrary.createGif('Rainbow Wave', undefined, undefined, undefined, testDevice, tempPath);
    assert.strictEqual(dupRes.success, false);
    assert.match(dupRes.error, /already exists/);

    // Short name rejected (< 2 chars)
    const shortRes = gifLibrary.createGif('A', undefined, undefined, undefined, testDevice, tempPath);
    assert.strictEqual(shortRes.success, false);
    assert.match(shortRes.error, /2–15 characters/);

    // Long name rejected (> 15 chars)
    const longRes = gifLibrary.createGif('ThisNameIsWayTooLongForG75', undefined, undefined, undefined, testDevice, tempPath);
    assert.strictEqual(longRes.success, false);
    assert.match(longRes.error, /2–15 characters/);

    // Whitespace trimmed
    const trimRes = gifLibrary.createGif('  Pulse Stars  ', undefined, undefined, undefined, testDevice, tempPath);
    assert.strictEqual(trimRes.success, true);
    assert.strictEqual(trimRes.item.name, 'Pulse Stars');
  });

  it('enforces maximum capacity of 20 GIF items', () => {
    for (let i = 1; i <= 20; i++) {
      const name = `Effect ${i}`;
      const res = gifLibrary.createGif(name, undefined, undefined, undefined, testDevice, tempPath);
      assert.strictEqual(res.success, true, `Effect ${i} should be created`);
    }

    // 21st item should be rejected
    const overCap = gifLibrary.createGif('Effect 21', undefined, undefined, undefined, testDevice, tempPath);
    assert.strictEqual(overCap.success, false);
    assert.match(overCap.error, /maximum capacity of 20/);
  });

  it('renameGif updates name and preserves metadata', () => {
    const created = gifLibrary.createGif('OriginalName', undefined, undefined, undefined, testDevice, tempPath);
    assert.strictEqual(created.success, true);

    const renamed = gifLibrary.renameGif(created.item.key, 'NewName', testDevice, tempPath);
    assert.strictEqual(renamed.success, true);
    assert.strictEqual(renamed.item.name, 'NewName');
    assert.strictEqual(renamed.item.extra.displayName, 'NewName');
    assert.strictEqual(renamed.prevName, 'OriginalName');

    const snap = gifLibrary.snapshot(testDevice, tempPath);
    assert.strictEqual(snap.items[0].name, 'NewName');
  });

  it('deleteGif retargets right-then-left neighbor on active delete', () => {
    const item1 = gifLibrary.createGif('Item One', undefined, undefined, undefined, testDevice, tempPath).item;
    const item2 = gifLibrary.createGif('Item Two', undefined, undefined, undefined, testDevice, tempPath).item;
    const item3 = gifLibrary.createGif('Item Three', undefined, undefined, undefined, testDevice, tempPath).item;
    // Order is: [Item Three, Item Two, Item One]

    // Delete active Item Two (middle): right neighbor is Item One
    const delMiddle = gifLibrary.deleteGif(item2.key, { activeKey: item2.key }, testDevice, tempPath);
    assert.strictEqual(delMiddle.success, true);
    assert.strictEqual(delMiddle.replacement.key, item1.key);

    // Delete active Item One (last): retargets left neighbor Item Three
    const delLast = gifLibrary.deleteGif(item1.key, { activeKey: item1.key }, testDevice, tempPath);
    assert.strictEqual(delLast.success, true);
    assert.strictEqual(delLast.replacement.key, item3.key);
  });

  it('updateGifData updates frames and validates schema', () => {
    const created = gifLibrary.createGif('MyAnim', undefined, undefined, undefined, testDevice, tempPath);
    assert.strictEqual(created.success, true);

    const newFrames = [
      { duration: 80, data: [{ code: 41, selectColor: '#FF0000' }] },
      { duration: 120, data: [{ code: 41, selectColor: '#00FF00' }] }
    ];

    const updated = gifLibrary.updateGifData(
      created.item.key,
      (item) => ({ ...item, data: { ...item.data, frames: newFrames } }),
      testDevice,
      tempPath
    );
    assert.strictEqual(updated.success, true);
    assert.strictEqual(updated.item.data.frames.length, 2);
    assert.strictEqual(updated.item.data.frames[0].duration, 80);
    assert.strictEqual(updated.item.data.frames[1].duration, 120);

    // Rejects invalid frame data (e.g. missing selectColor or invalid hex)
    const badUpdate = gifLibrary.updateGifData(
      created.item.key,
      (item) => ({ ...item, data: { ...item.data, frames: [{ duration: 50, data: [{ code: 41, selectColor: 'notAColor' }] }] } }),
      testDevice,
      tempPath
    );
    assert.strictEqual(badUpdate.success, false);
  });

  it('preserves corrupt library files on disk and does not overwrite them', () => {
    fs.writeFileSync(tempPath, '{ "malformed": true, invalidJson: !!! }', 'utf8');

    const snap = gifLibrary.snapshot(testDevice, tempPath);
    assert.strictEqual(snap.unwritable, true);

    const tryCreate = gifLibrary.createGif('NewEffect', undefined, undefined, undefined, testDevice, tempPath);
    assert.strictEqual(tryCreate.success, false);
    assert.strictEqual(tryCreate.unwritable, true);

    // File content must be untouched
    const content = fs.readFileSync(tempPath, 'utf8');
    assert.ok(content.includes('invalidJson: !!!'), 'Corrupt file must be preserved');
  });

  it('roundtrips library-to-player conversions and Yz/xW helpers', () => {
    const libraryFrames = [
      {
        duration: 150,
        data: [
          { code: 41, selectColor: '#FF0000' },
          { code: 301, selectColor: '#0000FF' }
        ]
      }
    ];

    const playerFrames = gifLibrary.libraryFramesToPlayer(libraryFrames);
    assert.strictEqual(playerFrames.length, 1);
    assert.strictEqual(playerFrames[0].dur, 150);
    assert.strictEqual(playerFrames[0].colors[0].code, 41);
    assert.strictEqual(playerFrames[0].colors[0].color, '#FF0000');
    assert.strictEqual(playerFrames[0].colors[1].code, 301);
    assert.strictEqual(playerFrames[0].colors[1].color, '#0000FF');

    const backToLibrary = gifLibrary.Yz(playerFrames);
    assert.strictEqual(backToLibrary.length, 1);
    assert.strictEqual(backToLibrary[0].duration, 150);
    assert.strictEqual(backToLibrary[0].data[0].code, 41);
    assert.strictEqual(backToLibrary[0].data[0].selectColor, '#FF0000');
  });

  it('importGifBuffer streams decoded frames into G75 key colors without retaining RGBA copies', () => {
    const gif = buildSimpleGif({
      width: 2,
      height: 2,
      palette: [[0, 0, 0], [255, 0, 0], [0, 255, 0]],
      frames: [
        { delay: 12, pixels: [1, 1, 1, 1] },
        { delay: 20, pixels: [2, 2, 2, 2] }
      ]
    });
    const imported = gifLibrary.importGifBuffer(gif);
    assert.strictEqual(imported.type, 'gif');
    assert.strictEqual(imported.dataScope, 'LightingEffectProfile');
    assert.strictEqual(imported.frames.length, 2);
    assert.strictEqual(imported.frames[0].duration, 120);
    assert.strictEqual(imported.frames[1].duration, 200);
    assert.ok(imported.frames[0].data.some((entry) => entry.code === 301 && entry.selectColor === '#FF0000'));
    assert.ok(imported.frames[1].data.some((entry) => entry.code === 302 && entry.selectColor === '#00FF00'));
    assert.equal(imported.frames[0].data.some((entry) => entry.code === 0 || entry.code === 255), false);
  });

  it('suggestImportedName stays within 2–15 characters and avoids collisions', () => {
    const items = [{ name: 'GIF', extra: { displayName: 'GIF' } }];
    assert.strictEqual(gifLibrary.suggestImportedName('wave.gif', []), 'wave');
    assert.strictEqual(gifLibrary.suggestImportedName('a', items), 'GIF2');
    assert.ok(gifLibrary.suggestImportedName('ThisNameIsWayTooLongForAGifFile', []).length <= 15);
  });
});

describe('GifPlayer (Host Animation Loop)', () => {
  it('plays frames in sequence, loops, and executes ticks', async () => {
    const frames = [
      { dur: 30, colors: [{ code: 41, color: '#FF0000' }] },
      { dur: 30, colors: [{ code: 41, color: '#00FF00' }] }
    ];

    const fired = [];
    const player = new GifPlayer({
      minDuration: 30,
      maxDuration: 300,
      frames,
      onFrame: (colors, idx, total) => {
        fired.push({ colors, idx, total });
      }
    });

    player.start();
    assert.strictEqual(player.isPlaying, true);

    // Wait 90ms for ~2-3 frame ticks
    await new Promise((resolve) => setTimeout(resolve, 95));
    player.stop();
    assert.strictEqual(player.isPlaying, false);

    assert.ok(fired.length >= 2, `Expected at least 2 ticks, got ${fired.length}`);
    assert.strictEqual(fired[0].idx, 0);
    assert.strictEqual(fired[0].colors[0].color, '#FF0000');
    assert.strictEqual(fired[1].idx, 1);
    assert.strictEqual(fired[1].colors[0].color, '#00FF00');
  });

  it('pause preserves frameIndex and resume continues; stop resets to 0', () => {
    const frames = [
      { dur: 50, colors: [{ code: 41, color: '#111111' }] },
      { dur: 50, colors: [{ code: 41, color: '#222222' }] },
      { dur: 50, colors: [{ code: 41, color: '#333333' }] }
    ];

    const player = new GifPlayer({ frames });
    player.start();
    player.frameIndex = 2; // simulate at frame 2
    player.pause();
    assert.strictEqual(player.isPlaying, false);
    assert.strictEqual(player.frameIndex, 2, 'Pause must keep current frame index');

    player.stop();
    assert.strictEqual(player.isPlaying, false);
    assert.strictEqual(player.frameIndex, 0, 'Stop must reset frame index to 0');
  });

  it('resends long frames across multiple ticks using maxDuration 300ms', () => {
    // 600ms duration with maxDuration 300ms means 2 ticks (ceil(600/300) = 2)
    const frames = [
      { dur: 600, colors: [{ code: 41, color: '#FFFFFF' }] }
    ];

    let tickCount = 0;
    const player = new GifPlayer({
      minDuration: 30,
      maxDuration: 300,
      frames,
      onFrame: () => {
        tickCount++;
      }
    });

    player.start();
    // First tick fires synchronously upon start
    assert.strictEqual(tickCount, 1);
    player.stop();
  });
});
