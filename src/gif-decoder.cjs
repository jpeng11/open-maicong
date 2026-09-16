/**
 * Bounded, offline pure-JavaScript GIF87a / GIF89a decoder.
 * Supports LZW decompression, interlacing, transparency, disposal methods (0..3),
 * and frame duration extraction. Enforces size and decompressed-retention bounds
 * before allocating retained RGBA copies.
 */

const MAX_GIF_BYTES = 5 * 1024 * 1024;
const MAX_DIMENSION = 1000;
const MAX_PIXELS = 1000 * 1000;
const MAX_FRAMES = 200;
const MAX_DECODED_BYTES = 8 * 1024 * 1024;
const DEFAULT_DELAY_MS = 100;
const MIN_LZW_CODE_SIZE = 2;
const MAX_LZW_CODE_SIZE = 8;

class GifBitReader {
  constructor(subBlocks) {
    this.blocks = subBlocks;
    this.blockIndex = 0;
    this.byteIndex = 0;
    this.bitBuffer = 0;
    this.bitsInBuffer = 0;
  }

  readBits(numBits) {
    while (this.bitsInBuffer < numBits) {
      if (this.blockIndex >= this.blocks.length) {
        return -1;
      }
      const block = this.blocks[this.blockIndex];
      if (this.byteIndex >= block.length) {
        this.blockIndex++;
        this.byteIndex = 0;
        continue;
      }
      this.bitBuffer |= block[this.byteIndex++] << this.bitsInBuffer;
      this.bitsInBuffer += 8;
    }
    const mask = (1 << numBits) - 1;
    const value = this.bitBuffer & mask;
    this.bitBuffer >>= numBits;
    this.bitsInBuffer -= numBits;
    return value;
  }
}

function decompressLzw(minCodeSize, subBlocks, expectedPixels) {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  let codeSize = minCodeSize + 1;
  let nextCode = endCode + 1;

  const prefix = new Int32Array(4096).fill(-1);
  const suffix = new Uint8Array(4096);
  const pixelStack = new Uint8Array(4097);

  for (let i = 0; i < clearCode; i++) {
    suffix[i] = i;
  }

  const reader = new GifBitReader(subBlocks);
  const output = new Uint8Array(expectedPixels);
  let outIndex = 0;
  let oldCode = -1;
  let sawEnd = false;

  for (;;) {
    const code = reader.readBits(codeSize);
    if (code === -1) {
      throw new Error('Truncated LZW stream: missing end-of-information code');
    }
    if (code === endCode) {
      sawEnd = true;
      break;
    }
    if (code === clearCode) {
      codeSize = minCodeSize + 1;
      nextCode = endCode + 1;
      oldCode = -1;
      continue;
    }

    if (outIndex >= expectedPixels) {
      throw new Error('LZW stream overflowed the declared image size');
    }

    let stackTop = 0;
    let curr = code;

    if (code >= nextCode) {
      if (code > nextCode || oldCode === -1) {
        throw new Error(`Corrupted LZW stream: code ${code} exceeds table size ${nextCode}`);
      }
      curr = oldCode;
      let firstChar = oldCode;
      while (firstChar >= clearCode) {
        firstChar = prefix[firstChar];
      }
      pixelStack[stackTop++] = suffix[firstChar];
    }

    while (curr >= clearCode) {
      if (stackTop >= pixelStack.length) {
        throw new Error('LZW stack overflow');
      }
      pixelStack[stackTop++] = suffix[curr];
      curr = prefix[curr];
    }
    pixelStack[stackTop++] = suffix[curr];

    while (stackTop > 0) {
      if (outIndex >= expectedPixels) {
        throw new Error('LZW stream overflowed the declared image size');
      }
      output[outIndex++] = pixelStack[--stackTop];
    }

    if (oldCode !== -1 && nextCode < 4096) {
      prefix[nextCode] = oldCode;
      suffix[nextCode] = suffix[curr];
      nextCode++;
      if (nextCode === (1 << codeSize) && codeSize < 12) {
        codeSize++;
      }
    }
    oldCode = code;
  }

  if (!sawEnd) {
    throw new Error('Truncated LZW stream: missing end-of-information code');
  }
  if (outIndex !== expectedPixels) {
    throw new Error(`LZW stream ended after ${outIndex} pixels; expected ${expectedPixels}`);
  }
  return output;
}

function skipSubBlocks(buf, pos) {
  while (pos < buf.length) {
    const subLen = buf[pos++];
    if (subLen === 0) return pos;
    if (pos + subLen > buf.length) {
      throw new Error('Truncated extension sub-block');
    }
    pos += subLen;
  }
  throw new Error('Unexpected end of file while skipping GIF sub-blocks');
}

function paletteColor(palette, index) {
  if (!palette || index < 0) return null;
  const palOffset = index * 3;
  if (palOffset + 2 >= palette.length) return null;
  return [palette[palOffset], palette[palOffset + 1], palette[palOffset + 2]];
}

function fillRect(canvas, screenWidth, rect, rgba) {
  const { left, top, width, height } = rect;
  const [r, g, b, a] = rgba;
  for (let y = top; y < top + height; y++) {
    let idx = (y * screenWidth + left) * 4;
    for (let x = 0; x < width; x++) {
      canvas[idx] = r;
      canvas[idx + 1] = g;
      canvas[idx + 2] = b;
      canvas[idx + 3] = a;
      idx += 4;
    }
  }
}

/**
 * Decodes a GIF file buffer into composite RGBA frames.
 *
 * @param {Buffer|Uint8Array} buf
 * @param {Object} [options]
 * @param {boolean} [options.retainFrames=true] Keep full RGBA copies. Import paths should
 *   set this false and consume frames through onFrame to avoid decompressed retention.
 * @param {function} [options.onFrame] Called with each composited frame before optional retain.
 * @returns {Array<{ width: number, height: number, duration: number, rgba: Uint8ClampedArray }>}
 */
function decodeGif(buf, options = {}) {
  if (!buf || !(buf instanceof Uint8Array || Buffer.isBuffer(buf))) {
    throw new TypeError('GIF buffer must be a Buffer or Uint8Array');
  }
  if (buf.length > MAX_GIF_BYTES) {
    throw new RangeError(`GIF file size (${buf.length} bytes) exceeds maximum allowable 5 MiB limit`);
  }
  if (buf.length < 13) {
    throw new Error('GIF file is too small to contain a valid header');
  }

  const retainFrames = options.retainFrames !== false;
  const onFrame = typeof options.onFrame === 'function' ? options.onFrame : null;
  const maxDecodedBytes = Number.isInteger(options.maxDecodedBytes) && options.maxDecodedBytes > 0
    ? options.maxDecodedBytes
    : MAX_DECODED_BYTES;

  const sig = String.fromCharCode(buf[0], buf[1], buf[2], buf[3], buf[4], buf[5]);
  if (sig !== 'GIF87a' && sig !== 'GIF89a') {
    throw new Error(`Invalid GIF signature: "${sig}". Expected GIF87a or GIF89a`);
  }

  const screenWidth = buf[6] | (buf[7] << 8);
  const screenHeight = buf[8] | (buf[9] << 8);
  if (screenWidth <= 0 || screenHeight <= 0 || screenWidth > MAX_DIMENSION || screenHeight > MAX_DIMENSION) {
    throw new RangeError(`Invalid GIF screen dimensions: ${screenWidth}x${screenHeight}. Max is ${MAX_DIMENSION}x${MAX_DIMENSION}`);
  }
  const screenPixels = screenWidth * screenHeight;
  if (screenPixels > MAX_PIXELS) {
    throw new RangeError(`GIF total pixel area ${screenPixels} exceeds bounded limit of ${MAX_PIXELS}`);
  }

  const frameBytes = screenPixels * 4;
  if (frameBytes > maxDecodedBytes) {
    throw new RangeError(
      `GIF canvas ${screenWidth}x${screenHeight} would retain ${frameBytes} decoded bytes, exceeding the ${maxDecodedBytes}-byte budget`
    );
  }

  const packed = buf[10];
  const gctFlag = Boolean(packed & 0x80);
  const gctSize = 1 << ((packed & 0x07) + 1);
  const bgIndex = buf[11];
  let pos = 13;

  let globalPalette = null;
  if (gctFlag) {
    const bytesNeeded = gctSize * 3;
    if (pos + bytesNeeded > buf.length) {
      throw new Error('Unexpected end of file while reading Global Color Table');
    }
    globalPalette = buf.subarray(pos, pos + bytesNeeded);
    pos += bytesNeeded;
  }

  const bgRgb = paletteColor(globalPalette, bgIndex);
  const backgroundRgba = bgRgb ? [bgRgb[0], bgRgb[1], bgRgb[2], 255] : [0, 0, 0, 0];

  const canvas = new Uint8ClampedArray(frameBytes);
  let previousCanvasSnapshot = null;
  let retainedBytes = frameBytes;
  const frames = [];
  let sawTrailer = false;

  let gce = {
    disposal: 0,
    transparentFlag: false,
    transparentIndex: -1,
    durationMs: DEFAULT_DELAY_MS
  };

  let lastFrameDisposal = 0;
  let lastFrameRect = { left: 0, top: 0, width: 0, height: 0 };

  while (pos < buf.length) {
    const blockType = buf[pos++];
    if (blockType === 0x3B) {
      sawTrailer = true;
      break;
    }

    if (blockType === 0x21) {
      if (pos >= buf.length) {
        throw new Error('Unexpected end of file while reading GIF extension');
      }
      const extLabel = buf[pos++];
      if (extLabel === 0xF9) {
        if (pos >= buf.length) {
          throw new Error('Unexpected end of file while reading Graphic Control Extension');
        }
        const blockSize = buf[pos++];
        if (blockSize !== 4 || pos + 5 > buf.length) {
          throw new Error('Malformed Graphic Control Extension block');
        }
        const gcePacked = buf[pos++];
        const delayUnits = buf[pos++] | (buf[pos++] << 8);
        const transIdx = buf[pos++];
        const terminator = buf[pos++];
        if (terminator !== 0x00) {
          throw new Error('Graphic Control Extension is missing a block terminator');
        }

        const disposal = (gcePacked >> 2) & 0x07;
        const transparentFlag = Boolean(gcePacked & 0x01);
        let durationMs = delayUnits * 10;
        if (durationMs <= 10) {
          durationMs = DEFAULT_DELAY_MS;
        }

        gce = {
          disposal,
          transparentFlag,
          transparentIndex: transparentFlag ? transIdx : -1,
          durationMs
        };
      } else {
        pos = skipSubBlocks(buf, pos);
      }
      continue;
    }

    if (blockType === 0x2C) {
      if (pos + 9 > buf.length) {
        throw new Error('Unexpected end of file while reading Image Descriptor');
      }
      const left = buf[pos++] | (buf[pos++] << 8);
      const top = buf[pos++] | (buf[pos++] << 8);
      const width = buf[pos++] | (buf[pos++] << 8);
      const height = buf[pos++] | (buf[pos++] << 8);
      const imgPacked = buf[pos++];

      if (left + width > screenWidth || top + height > screenHeight || width <= 0 || height <= 0) {
        throw new RangeError(`Image block dimensions (${left}, ${top}, ${width}x${height}) exceed screen bounds (${screenWidth}x${screenHeight})`);
      }

      const lctFlag = Boolean(imgPacked & 0x80);
      const interlaceFlag = Boolean(imgPacked & 0x40);
      const lctSize = 1 << ((imgPacked & 0x07) + 1);

      let framePalette = globalPalette;
      if (lctFlag) {
        const bytesNeeded = lctSize * 3;
        if (pos + bytesNeeded > buf.length) {
          throw new Error('Unexpected end of file while reading Local Color Table');
        }
        framePalette = buf.subarray(pos, pos + bytesNeeded);
        pos += bytesNeeded;
      }

      if (!framePalette) {
        throw new Error('Missing color table for GIF image frame');
      }

      if (pos >= buf.length) {
        throw new Error('Unexpected end of file before LZW minimum code size');
      }
      const minCodeSize = buf[pos++];
      if (minCodeSize < MIN_LZW_CODE_SIZE || minCodeSize > MAX_LZW_CODE_SIZE) {
        throw new Error(`Invalid LZW minimum code size: ${minCodeSize}`);
      }

      const subBlocks = [];
      let sawImageTerm = false;
      while (pos < buf.length) {
        const subLen = buf[pos++];
        if (subLen === 0) {
          sawImageTerm = true;
          break;
        }
        if (pos + subLen > buf.length) {
          throw new Error('Truncated sub-block in LZW stream');
        }
        subBlocks.push(buf.subarray(pos, pos + subLen));
        pos += subLen;
      }
      if (!sawImageTerm) {
        throw new Error('Truncated sub-block in LZW stream');
      }

      if (lastFrameDisposal === 2) {
        fillRect(canvas, screenWidth, lastFrameRect, backgroundRgba);
      } else if (lastFrameDisposal === 3 && previousCanvasSnapshot) {
        canvas.set(previousCanvasSnapshot);
      }

      if (gce.disposal === 3) {
        if (retainedBytes + frameBytes > maxDecodedBytes) {
          throw new RangeError(
            `GIF disposal snapshot would retain ${retainedBytes + frameBytes} decoded bytes, exceeding the ${maxDecodedBytes}-byte budget`
          );
        }
        previousCanvasSnapshot = new Uint8ClampedArray(canvas);
        retainedBytes += frameBytes;
      } else {
        previousCanvasSnapshot = null;
      }

      const expectedPixels = width * height;
      const pixelIndices = decompressLzw(minCodeSize, subBlocks, expectedPixels);

      const passStarts = [0, 4, 2, 1];
      const passSteps = [8, 8, 4, 2];

      let pixelOffset = 0;
      const renderPass = (row) => {
        const canvasRowStart = ((top + row) * screenWidth + left) * 4;
        for (let col = 0; col < width; col++) {
          if (pixelOffset >= pixelIndices.length) {
            throw new Error('GIF image data ended before the frame was complete');
          }
          const colorIndex = pixelIndices[pixelOffset++];
          if (gce.transparentFlag && colorIndex === gce.transparentIndex) {
            continue;
          }
          const rgb = paletteColor(framePalette, colorIndex);
          if (!rgb) {
            throw new Error(`GIF color index ${colorIndex} is outside the color table`);
          }
          const idx = canvasRowStart + col * 4;
          canvas[idx] = rgb[0];
          canvas[idx + 1] = rgb[1];
          canvas[idx + 2] = rgb[2];
          canvas[idx + 3] = 255;
        }
      };

      if (interlaceFlag) {
        for (let p = 0; p < 4; p++) {
          for (let row = passStarts[p]; row < height; row += passSteps[p]) {
            renderPass(row);
          }
        }
      } else {
        for (let row = 0; row < height; row++) {
          renderPass(row);
        }
      }

      const frame = {
        width: screenWidth,
        height: screenHeight,
        duration: gce.durationMs,
        rgba: canvas
      };

      if (onFrame) onFrame(frame);

      if (retainFrames) {
        if (retainedBytes + frameBytes > maxDecodedBytes) {
          throw new RangeError(
            `GIF decoded retention would reach ${retainedBytes + frameBytes} bytes, exceeding the ${maxDecodedBytes}-byte budget`
          );
        }
        frames.push({
          width: screenWidth,
          height: screenHeight,
          duration: gce.durationMs,
          rgba: new Uint8ClampedArray(canvas)
        });
        retainedBytes += frameBytes;
      } else {
        frames.push({
          width: screenWidth,
          height: screenHeight,
          duration: gce.durationMs
        });
      }

      if (frames.length > MAX_FRAMES) {
        throw new RangeError(`GIF exceeds bounded frame limit of ${MAX_FRAMES} frames`);
      }

      lastFrameDisposal = gce.disposal;
      lastFrameRect = { left, top, width, height };

      gce = {
        disposal: 0,
        transparentFlag: false,
        transparentIndex: -1,
        durationMs: DEFAULT_DELAY_MS
      };
      continue;
    }

    throw new Error(`Invalid GIF block type 0x${blockType.toString(16)}`);
  }

  if (!sawTrailer) {
    throw new Error('Truncated GIF stream: missing trailer');
  }

  if (frames.length === 0) {
    throw new Error('GIF does not contain any valid image frames');
  }

  return frames;
}

module.exports = {
  decodeGif,
  MAX_GIF_BYTES,
  MAX_DIMENSION,
  MAX_PIXELS,
  MAX_FRAMES,
  MAX_DECODED_BYTES,
  DEFAULT_DELAY_MS,
  MIN_LZW_CODE_SIZE,
  MAX_LZW_CODE_SIZE
};
