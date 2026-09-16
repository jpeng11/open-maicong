/**
 * Minimal GIF89a fixture builder for decoder, library, and mock UI tests.
 * Does not use vendor code.
 */

function simpleLzwCompress(minCodeSize, pixels) {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;

  let codeSize = minCodeSize + 1;
  let nextCode = endCode + 1;
  let bitBuffer = 0;
  let bitsInBuffer = 0;
  const output = [];

  function writeBits(val, numBits) {
    bitBuffer |= (val << bitsInBuffer);
    bitsInBuffer += numBits;
    while (bitsInBuffer >= 8) {
      output.push(bitBuffer & 0xFF);
      bitBuffer >>= 8;
      bitsInBuffer -= 8;
    }
  }

  function flushBits() {
    if (bitsInBuffer > 0) {
      output.push(bitBuffer & 0xFF);
      bitBuffer = 0;
      bitsInBuffer = 0;
    }
  }

  writeBits(clearCode, codeSize);

  const dict = new Map();
  function resetDict() {
    dict.clear();
    for (let i = 0; i < clearCode; i++) {
      dict.set(String(i), i);
    }
    codeSize = minCodeSize + 1;
    nextCode = endCode + 1;
  }
  resetDict();

  let prefix = '';
  for (let i = 0; i < pixels.length; i++) {
    const k = String(pixels[i]);
    const pk = prefix ? prefix + ',' + k : k;
    if (dict.has(pk)) {
      prefix = pk;
    } else {
      writeBits(dict.get(prefix), codeSize);
      if (nextCode < 4096) {
        dict.set(pk, nextCode++);
        if (nextCode === (1 << codeSize) + 1 && codeSize < 12) {
          codeSize++;
        }
      } else {
        writeBits(clearCode, codeSize);
        resetDict();
      }
      prefix = k;
    }
  }

  if (prefix) {
    writeBits(dict.get(prefix), codeSize);
  }
  writeBits(endCode, codeSize);
  flushBits();

  return Buffer.from(output);
}

function buildSimpleGif({
  width = 2,
  height = 2,
  palette = [[0, 0, 0], [255, 0, 0], [0, 255, 0], [0, 0, 255]],
  background = 0,
  frames = [],
  trailer = true,
  minCodeSize: minCodeSizeOverride
} = {}) {
  const parts = [];
  parts.push(Buffer.from('GIF89a', 'ascii'));

  const gctExponent = Math.max(0, Math.ceil(Math.log2(Math.max(2, palette.length))) - 1);
  const packedGct = 0x80 | (gctExponent & 0x07);
  const screenDesc = Buffer.alloc(7);
  screenDesc.writeUInt16LE(width, 0);
  screenDesc.writeUInt16LE(height, 2);
  screenDesc[4] = packedGct;
  screenDesc[5] = background;
  screenDesc[6] = 0;
  parts.push(screenDesc);

  const gctSize = 1 << (gctExponent + 1);
  const gctBuf = Buffer.alloc(gctSize * 3, 0);
  for (let i = 0; i < palette.length; i++) {
    gctBuf[i * 3] = palette[i][0];
    gctBuf[i * 3 + 1] = palette[i][1];
    gctBuf[i * 3 + 2] = palette[i][2];
  }
  parts.push(gctBuf);

  for (const frame of frames) {
    if (frame.gce !== false) {
      const gceBuf = Buffer.alloc(8);
      gceBuf[0] = 0x21;
      gceBuf[1] = 0xF9;
      gceBuf[2] = 0x04;
      const disposal = (frame.disposal || 0) & 0x07;
      const transFlag = frame.trans !== undefined ? 1 : 0;
      gceBuf[3] = (disposal << 2) | transFlag;
      gceBuf.writeUInt16LE(frame.delay == null ? 10 : frame.delay, 4);
      gceBuf[6] = frame.trans !== undefined ? frame.trans : 0;
      gceBuf[7] = frame.gceTerm == null ? 0x00 : frame.gceTerm;
      parts.push(gceBuf);
    }

    const imgDesc = Buffer.alloc(10);
    imgDesc[0] = 0x2C;
    imgDesc.writeUInt16LE(frame.left || 0, 1);
    imgDesc.writeUInt16LE(frame.top || 0, 3);
    imgDesc.writeUInt16LE(frame.width || width, 5);
    imgDesc.writeUInt16LE(frame.height || height, 7);
    imgDesc[9] = 0x00;
    parts.push(imgDesc);

    const minCodeSize = minCodeSizeOverride != null
      ? minCodeSizeOverride
      : Math.max(2, gctExponent + 1);
    const pixelIndices = frame.pixels || new Array((frame.width || width) * (frame.height || height)).fill(0);
    const compressed = simpleLzwCompress(Math.max(2, Math.min(8, minCodeSize)), pixelIndices);
    parts.push(Buffer.from([minCodeSize]));

    let offset = 0;
    while (offset < compressed.length) {
      const chunkLen = Math.min(255, compressed.length - offset);
      const subBlock = Buffer.alloc(chunkLen + 1);
      subBlock[0] = chunkLen;
      compressed.copy(subBlock, 1, offset, offset + chunkLen);
      parts.push(subBlock);
      offset += chunkLen;
    }
    if (frame.omitImageTerm) {
      continue;
    }
    parts.push(Buffer.from([0x00]));
  }

  if (trailer) parts.push(Buffer.from([0x3B]));
  return Buffer.concat(parts);
}

module.exports = {
  buildSimpleGif,
  simpleLzwCompress
};
