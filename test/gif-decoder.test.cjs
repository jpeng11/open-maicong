const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  decodeGif,
  MAX_GIF_BYTES,
  MAX_DIMENSION,
  MAX_DECODED_BYTES
} = require('../src/gif-decoder.cjs');
const { buildSimpleGif } = require('./gif-fixture.cjs');

/** Independent 1x1 GIF89a (black pixel). Not produced by test/gif-fixture.cjs. */
const LITERAL_1X1_BLACK = Buffer.from(
  '47494638396101000100800000000000ffffff21f904000a0000002c00000000010001000002024401003b',
  'hex'
);

describe('GIF Decoder (Bounded Offline Parser)', () => {
  it('accepts an independent literal 1x1 GIF with a complete LZW pixel and end code', () => {
    const frames = decodeGif(LITERAL_1X1_BLACK);
    assert.strictEqual(frames.length, 1);
    assert.strictEqual(frames[0].width, 1);
    assert.strictEqual(frames[0].height, 1);
    assert.strictEqual(frames[0].duration, 100);
    assert.strictEqual(frames[0].rgba[0], 0);
    assert.strictEqual(frames[0].rgba[1], 0);
    assert.strictEqual(frames[0].rgba[2], 0);
    assert.strictEqual(frames[0].rgba[3], 255);
  });

  it('rejects the root LZW clear-then-end mutant that declares 1x1 but emits zero pixels', () => {
    const b = Buffer.from(LITERAL_1X1_BLACK);
    assert.strictEqual(b[27], 0x2C);
    b[39] = 0x2C;
    b[40] = 0x00;
    assert.throws(() => decodeGif(b), /ended after 0 pixels|expected 1/i);
  });

  it('rejects a missing GIF trailer on the independent literal', () => {
    assert.throws(() => decodeGif(LITERAL_1X1_BLACK.subarray(0, -1)), /missing trailer/);
  });

  it('rejects a truncated extension replacing the literal trailer', () => {
    const b = Buffer.concat([LITERAL_1X1_BLACK.subarray(0, -1), Buffer.from([0x21, 0xFE, 0xFF])]);
    assert.throws(() => decodeGif(b), /sub-block|end of file|trailer/i);
  });

  it('rejects a non-zero GCE terminator on the independent literal', () => {
    const b = Buffer.from(LITERAL_1X1_BLACK);
    b[26] = 7;
    assert.throws(() => decodeGif(b), /terminator/);
  });

  it('rejects a literal LZW stream that is missing the end-of-information code', () => {
    // Same 1x1 header; LZW min=2, one data byte 0x04 = clear then pixel 0, no end code.
    const b = Buffer.from(
      '47494638396101000100800000000000ffffff21f904000a0000002c000000000100010000020104003b',
      'hex'
    );
    assert.throws(() => decodeGif(b), /missing end-of-information/i);
  });

  it('rejects a literal LZW stream that overflows a 1x1 descriptor', () => {
    // clear, pixel 0, pixel 0, end packed as 0x04 0x0A.
    const b = Buffer.from(
      '47494638396101000100800000000000ffffff21f904000a0000002c0000000001000100000202040a003b',
      'hex'
    );
    assert.throws(() => decodeGif(b), /overflowed the declared image size/i);
  });

  it('rejects a literal out-of-palette index 2 against a 2-color global table', () => {
    // GCT has black/white (indices 0 and 1). LZW 0x54 0x01 = clear, index 2, end.
    const b = Buffer.from(
      '47494638396101000100800000000000ffffff21f904000a0000002c00000000010001000002025401003b',
      'hex'
    );
    assert.throws(() => decodeGif(b), /outside the color table/);
  });

  it('decodes a single-frame GIF with correct dimensions and palette colors', () => {
    const gif = buildSimpleGif({
      width: 2,
      height: 2,
      palette: [[0, 0, 0], [255, 0, 0], [0, 255, 0], [0, 0, 255]],
      frames: [
        {
          delay: 15,
          pixels: [1, 2, 3, 0]
        }
      ]
    });

    const frames = decodeGif(gif);
    assert.strictEqual(frames.length, 1);
    assert.strictEqual(frames[0].width, 2);
    assert.strictEqual(frames[0].height, 2);
    assert.strictEqual(frames[0].duration, 150);

    const rgba = frames[0].rgba;
    assert.strictEqual(rgba[0], 255);
    assert.strictEqual(rgba[1], 0);
    assert.strictEqual(rgba[2], 0);
    assert.strictEqual(rgba[3], 255);
    assert.strictEqual(rgba[4], 0);
    assert.strictEqual(rgba[5], 255);
    assert.strictEqual(rgba[6], 0);
    assert.strictEqual(rgba[7], 255);
    assert.strictEqual(rgba[8], 0);
    assert.strictEqual(rgba[9], 0);
    assert.strictEqual(rgba[10], 255);
    assert.strictEqual(rgba[11], 255);
    assert.strictEqual(rgba[12], 0);
    assert.strictEqual(rgba[13], 0);
    assert.strictEqual(rgba[14], 0);
    assert.strictEqual(rgba[15], 255);
  });

  it('normalizes very short or zero durations to 100ms', () => {
    const gif = buildSimpleGif({
      width: 1,
      height: 1,
      palette: [[0, 0, 0], [255, 255, 255]],
      frames: [
        { delay: 0, pixels: [1] },
        { delay: 1, pixels: [0] },
        { delay: 8, pixels: [1] }
      ]
    });

    const frames = decodeGif(gif);
    assert.strictEqual(frames.length, 3);
    assert.strictEqual(frames[0].duration, 100, '0 delay should normalize to 100ms');
    assert.strictEqual(frames[1].duration, 100, '10ms delay should normalize to 100ms');
    assert.strictEqual(frames[2].duration, 80, '80ms delay should remain 80ms');
  });

  it('correctly handles transparency with transparent color index', () => {
    const gif = buildSimpleGif({
      width: 2,
      height: 1,
      palette: [[0, 0, 0], [255, 0, 0]],
      frames: [
        {
          delay: 10,
          trans: 0,
          pixels: [0, 1]
        }
      ]
    });

    const frames = decodeGif(gif);
    const rgba = frames[0].rgba;
    assert.strictEqual(rgba[3], 0);
    assert.strictEqual(rgba[4], 255);
    assert.strictEqual(rgba[5], 0);
    assert.strictEqual(rgba[6], 0);
    assert.strictEqual(rgba[7], 255);
  });

  it('correctly executes disposal method 1 (do not dispose / overlay)', () => {
    const gif = buildSimpleGif({
      width: 2,
      height: 1,
      palette: [[0, 0, 0], [255, 0, 0], [0, 255, 0]],
      frames: [
        {
          disposal: 1,
          pixels: [1, 1]
        },
        {
          disposal: 1,
          trans: 0,
          pixels: [0, 2]
        }
      ]
    });

    const frames = decodeGif(gif);
    assert.strictEqual(frames.length, 2);
    assert.strictEqual(frames[0].rgba[0], 255);
    assert.strictEqual(frames[0].rgba[4], 255);
    assert.strictEqual(frames[1].rgba[0], 255, 'Left pixel must remain red');
    assert.strictEqual(frames[1].rgba[1], 0);
    assert.strictEqual(frames[1].rgba[4], 0);
    assert.strictEqual(frames[1].rgba[5], 255, 'Right pixel must be green');
  });

  it('disposal method 2 restores the frame rect to the logical screen background color', () => {
    const gif = buildSimpleGif({
      width: 2,
      height: 1,
      background: 0,
      palette: [[0, 0, 0], [255, 0, 0], [0, 255, 0]],
      frames: [
        {
          disposal: 2,
          pixels: [1, 1]
        },
        {
          disposal: 1,
          trans: 0,
          pixels: [0, 2]
        }
      ]
    });

    const frames = decodeGif(gif);
    assert.strictEqual(frames.length, 2);
    assert.strictEqual(frames[0].rgba[0], 255);
    assert.strictEqual(frames[0].rgba[4], 255);
    assert.strictEqual(frames[1].rgba[0], 0);
    assert.strictEqual(frames[1].rgba[1], 0);
    assert.strictEqual(frames[1].rgba[2], 0);
    assert.strictEqual(frames[1].rgba[3], 255, 'Left pixel must be opaque background, not leftover transparency');
    assert.strictEqual(frames[1].rgba[4], 0);
    assert.strictEqual(frames[1].rgba[5], 255, 'Right pixel must be green');
  });

  it('disposal 2 with a non-black background and a partial rect restores palette background', () => {
    const gif = buildSimpleGif({
      width: 3,
      height: 1,
      background: 3,
      palette: [[0, 0, 0], [255, 0, 0], [0, 255, 0], [0, 0, 255]],
      frames: [
        {
          disposal: 2,
          left: 0,
          top: 0,
          width: 2,
          height: 1,
          pixels: [1, 1]
        },
        {
          disposal: 1,
          trans: 0,
          left: 2,
          top: 0,
          width: 1,
          height: 1,
          pixels: [2]
        }
      ]
    });

    const frames = decodeGif(gif);
    assert.strictEqual(frames.length, 2);
    assert.strictEqual(frames[0].rgba[0], 255);
    assert.strictEqual(frames[0].rgba[4], 255);
    assert.strictEqual(frames[0].rgba[11], 0, 'Uncovered pixel stays transparent until drawn');

    assert.strictEqual(frames[1].rgba[0], 0);
    assert.strictEqual(frames[1].rgba[1], 0);
    assert.strictEqual(frames[1].rgba[2], 255, 'Partial rect must restore to blue background');
    assert.strictEqual(frames[1].rgba[3], 255);
    assert.strictEqual(frames[1].rgba[4], 0);
    assert.strictEqual(frames[1].rgba[5], 0);
    assert.strictEqual(frames[1].rgba[6], 255);
    assert.strictEqual(frames[1].rgba[8], 0);
    assert.strictEqual(frames[1].rgba[9], 255);
    assert.strictEqual(frames[1].rgba[10], 0);
    assert.strictEqual(frames[1].rgba[11], 255);
  });

  it('correctly executes disposal method 3 (restore to previous snapshot)', () => {
    const gif = buildSimpleGif({
      width: 2,
      height: 1,
      palette: [[0, 0, 0], [255, 0, 0], [0, 255, 0], [0, 0, 255]],
      frames: [
        {
          disposal: 1,
          pixels: [3, 3]
        },
        {
          disposal: 3,
          pixels: [1, 1]
        },
        {
          disposal: 1,
          trans: 0,
          pixels: [0, 2]
        }
      ]
    });

    const frames = decodeGif(gif);
    assert.strictEqual(frames.length, 3);
    assert.strictEqual(frames[0].rgba[2], 255);
    assert.strictEqual(frames[1].rgba[0], 255);
    assert.strictEqual(frames[2].rgba[2], 255, 'Left pixel must be restored to blue');
    assert.strictEqual(frames[2].rgba[0], 0);
    assert.strictEqual(frames[2].rgba[4], 0);
    assert.strictEqual(frames[2].rgba[5], 255, 'Right pixel must be green');
  });

  it('rejects files exceeding the bounded 5 MiB size limit', () => {
    const oversize = Buffer.alloc(MAX_GIF_BYTES + 1, 0);
    oversize.write('GIF89a', 0, 'ascii');
    assert.throws(
      () => decodeGif(oversize),
      /exceeds maximum allowable 5 MiB limit/
    );
  });

  it('rejects corrupt signatures or non-GIF inputs', () => {
    assert.throws(() => decodeGif(Buffer.from('PNG\r\n\x1a\n12345678')), /Invalid GIF signature/);
    assert.throws(() => decodeGif(Buffer.from('GIF85a12345678')), /Invalid GIF signature/);
    assert.throws(() => decodeGif(Buffer.alloc(5)), /GIF file is too small/);
    assert.throws(() => decodeGif(null), /must be a Buffer or Uint8Array/);
  });

  it('rejects invalid screen dimensions or zero dimensions', () => {
    const badDim = Buffer.alloc(20, 0);
    badDim.write('GIF89a', 0, 'ascii');
    badDim.writeUInt16LE(0, 6);
    badDim.writeUInt16LE(10, 8);
    assert.throws(() => decodeGif(badDim), /Invalid GIF screen dimensions/);

    const hugeDim = Buffer.alloc(20, 0);
    hugeDim.write('GIF89a', 0, 'ascii');
    hugeDim.writeUInt16LE(MAX_DIMENSION + 1, 6);
    hugeDim.writeUInt16LE(10, 8);
    assert.throws(() => decodeGif(hugeDim), /Invalid GIF screen dimensions/);
  });

  it('rejects truncated LZW streams fail-closed without hanging', () => {
    const valid = buildSimpleGif({
      width: 2,
      height: 2,
      frames: [{ pixels: [1, 1, 1, 1] }]
    });
    const truncated = valid.subarray(0, valid.length - 8);
    assert.throws(() => decodeGif(truncated));
  });

  it('rejects a missing trailer after complete frames', () => {
    const gif = buildSimpleGif({
      width: 1,
      height: 1,
      frames: [{ pixels: [1] }],
      trailer: false
    });
    assert.throws(() => decodeGif(gif), /missing trailer/);
  });

  it('rejects a Graphic Control Extension whose terminator is not 0', () => {
    const gif = buildSimpleGif({
      width: 1,
      height: 1,
      frames: [{ pixels: [1], gceTerm: 0x01 }]
    });
    assert.throws(() => decodeGif(gif), /terminator/);
  });

  it('rejects extension sub-blocks that would advance past EOF', () => {
    const gif = buildSimpleGif({
      width: 1,
      height: 1,
      frames: [{ pixels: [1] }],
      trailer: false
    });
    const truncatedExt = Buffer.concat([
      gif,
      Buffer.from([0x21, 0xFE, 0x30])
    ]);
    assert.throws(() => decodeGif(truncatedExt), /sub-block|end of file|trailer/i);
  });

  it('rejects LZW minimum code sizes outside 2..8', () => {
    const gif = buildSimpleGif({
      width: 1,
      height: 1,
      frames: [{ pixels: [1] }],
      minCodeSize: 9
    });
    assert.throws(() => decodeGif(gif), /minimum code size/);
  });

  it('rejects color indices outside the active palette', () => {
    const gif = buildSimpleGif({
      width: 1,
      height: 1,
      palette: [[0, 0, 0], [255, 0, 0], [0, 255, 0], [0, 0, 255]],
      frames: [{ pixels: [5] }],
      minCodeSize: 3
    });
    assert.throws(() => decodeGif(gif), /outside the color table/);
  });

  it('rejects decoded retention using an injected budget without relying on heapUsed', () => {
    const gif = buildSimpleGif({
      width: 20,
      height: 20,
      palette: [[0, 0, 0], [255, 0, 0]],
      frames: [{ delay: 10, pixels: [1] }]
    });
    assert.throws(
      () => decodeGif(gif, { maxDecodedBytes: 1024 }),
      /decoded retention|decoded bytes|budget/
    );
  });

  it('can stream frames without retaining RGBA copies', () => {
    const gif = buildSimpleGif({
      width: 2,
      height: 1,
      frames: [
        { pixels: [1, 2] },
        { pixels: [2, 1] }
      ]
    });
    const seen = [];
    const frames = decodeGif(gif, {
      retainFrames: false,
      onFrame(frame) {
        seen.push(Array.from(frame.rgba.subarray(0, 8)));
      }
    });
    assert.strictEqual(frames.length, 2);
    assert.equal(frames[0].rgba, undefined);
    assert.strictEqual(seen.length, 2);
    assert.strictEqual(seen[0][0], 255);
  });
});
