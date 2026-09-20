const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

// CRC32 implementation for PNG chunks
const crcTable = new Int32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  crcTable[i] = c;
}

function crc32(buf) {
  let crc = -1;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xff];
  }
  return crc ^ -1;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcVal = crc32(Buffer.concat([typeBuf, data]));
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crcVal >>> 0, 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function createPng(width, height, drawPixel) {
  const rowSize = width * 4 + 1;
  const raw = Buffer.alloc(rowSize * height);

  for (let y = 0; y < height; y++) {
    const rowOffset = y * rowSize;
    raw[rowOffset] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = drawPixel(x, y, width, height);
      const pxOffset = rowOffset + 1 + x * 4;
      raw[pxOffset] = r;
      raw[pxOffset + 1] = g;
      raw[pxOffset + 2] = b;
      raw[pxOffset + 3] = a;
    }
  }

  const deflated = zlib.deflateSync(raw, { level: 9 });
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflated),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function drawKeyboardIcon(scale) {
  const size = 16 * scale;
  // Keyboard bounding box
  const left = 1 * scale;
  const right = 15 * scale - 1;
  const top = 3 * scale;
  const bottom = 13 * scale - 1;
  const r = 2 * scale; // corner radius

  return createPng(size, size, (x, y) => {
    // Check if within outer rounded rect
    let inOuter = false;
    if (x >= left && x <= right && y >= top && y <= bottom) {
      const dx = Math.max(0, left + r - x, x - (right - r));
      const dy = Math.max(0, top + r - y, y - (bottom - r));
      if (dx * dx + dy * dy <= r * r) {
        inOuter = true;
      }
    }
    if (!inOuter) return [0, 0, 0, 0];

    // Stroke width = 1 * scale
    const s = 1 * scale;
    const inInner = (x >= left + s && x <= right - s && y >= top + s && y <= bottom - s);
    const innerR = Math.max(1, r - s);
    let insideInner = false;
    if (inInner) {
      const idx = Math.max(0, left + s + innerR - x, x - (right - s - innerR));
      const idy = Math.max(0, top + s + innerR - y, y - (bottom - s - innerR));
      if (idx * idx + idy * idy <= innerR * innerR) {
        insideInner = true;
      }
    }

    // Outer border stroke
    if (!insideInner) {
      return [0, 0, 0, 255];
    }

    // Keys inside
    // Row 1 (top keys): y roughly 5 to 6
    const row1Y = top + 2 * scale;
    const row2Y = top + 4.5 * scale;
    const row3Y = top + 7 * scale;
    const keyH = 1.3 * scale;

    // Check individual keys
    // Row 1: 4 dots/keys
    if (y >= row1Y && y < row1Y + keyH) {
      for (let i = 0; i < 4; i++) {
        const kx = left + (2.5 + i * 2.8) * scale;
        if (x >= kx && x < kx + 1.8 * scale) return [0, 0, 0, 255];
      }
    }

    // Row 2: 4 dots/keys
    if (y >= row2Y && y < row2Y + keyH) {
      for (let i = 0; i < 4; i++) {
        const kx = left + (2.5 + i * 2.8) * scale;
        if (x >= kx && x < kx + 1.8 * scale) return [0, 0, 0, 255];
      }
    }

    // Row 3: spacebar in middle, 2 side keys
    if (y >= row3Y && y < row3Y + keyH) {
      // Left key
      if (x >= left + 2.5 * scale && x < left + 3.8 * scale) return [0, 0, 0, 255];
      // Spacebar
      if (x >= left + 4.6 * scale && x < left + 9.4 * scale) return [0, 0, 0, 255];
      // Right key
      if (x >= left + 10.2 * scale && x < left + 11.5 * scale) return [0, 0, 0, 255];
    }

    return [0, 0, 0, 0];
  });
}

const assetsDir = path.join(__dirname, '..', 'src', 'assets');
if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true });

const png1x = drawKeyboardIcon(1);
const png2x = drawKeyboardIcon(2);

fs.writeFileSync(path.join(assetsDir, 'trayTemplate.png'), png1x);
fs.writeFileSync(path.join(assetsDir, 'trayTemplate@2x.png'), png2x);
console.log('Successfully generated trayTemplate.png (16x16) and trayTemplate@2x.png (32x32).');
