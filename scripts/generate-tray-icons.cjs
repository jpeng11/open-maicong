'use strict';

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

/**
 * Renders the App Icon converted into a monochrome vector template for the macOS menu bar.
 * Uses 4x4 sub-pixel supersampling for anti-aliasing.
 *
 * @param {number} size 16 for standard, 32 for @2x Retina
 */
function renderTrayTemplatePng(size) {
  const scale = size / 16;
  const SUB = 4;

  return createPng(size, size, (x, y, w, h) => {
    let totalSamples = 0;
    for (let sy = 0; sy < SUB; sy++) {
      for (let sx = 0; sx < SUB; sx++) {
        const px = (x + (sx + 0.5) / SUB) / scale;
        const py = (y + (sy + 0.5) / SUB) / scale;

        // Normalized [-1, 1] relative to icon center
        const nx = (px / 8) - 1;
        const ny = (py / 8) - 1;

        // macOS Squircle outer rim (same formula as renderAppIcon)
        const dSq = Math.pow(Math.abs(nx * 1.15), 4.5) + Math.pow(Math.abs(ny * 1.15), 4.5);
        const inSquircleRim = (dSq <= 0.98 && dSq >= 0.68);

        // Center glyph matching app icon (scaled for optimal menu bar legibility)
        const mx = nx / 0.9;
        const my = ny / 0.9;

        const inMLeft = (mx >= -0.42 && mx <= -0.20 && my >= -0.42 && my <= 0.42);
        const inMRight = (mx >= 0.20 && mx <= 0.42 && my >= -0.42 && my <= 0.42);
        const inMMidL = (Math.abs(my + mx * 0.9 + 0.04) < 0.14 && mx >= -0.32 && mx <= 0 && my <= 0.10);
        const inMMidR = (Math.abs(my - mx * 0.9 + 0.04) < 0.14 && mx <= 0.32 && mx >= 0 && my <= 0.10);

        if (inSquircleRim || inMLeft || inMRight || inMMidL || inMMidR) {
          totalSamples++;
        }
      }
    }

    const alpha = Math.round((totalSamples / (SUB * SUB)) * 255);
    return [0, 0, 0, alpha]; // Template image: pure black with alpha channel
  });
}

/**
 * Pure SVG vector representation of the status bar icon.
 */
function generateTraySvg() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">
  <!-- Open Maicong Status Bar Vector Template (Vector conversion of App Icon) -->
  <path fill-rule="evenodd" fill="currentColor" d="
    M 4.8 1.4
    C 2.2 1.4, 1.4 2.2, 1.4 4.8
    L 1.4 11.2
    C 1.4 13.8, 2.2 14.6, 4.8 14.6
    L 11.2 14.6
    C 13.8 14.6, 14.6 13.8, 14.6 11.2
    L 14.6 4.8
    C 14.6 2.2, 13.8 1.4, 11.2 1.4
    Z
    M 5.0 2.6
    C 3.0 2.6, 2.6 3.0, 2.6 5.0
    L 2.6 11.0
    C 2.6 13.0, 3.0 13.4, 5.0 13.4
    L 11.0 13.4
    C 13.0 13.4, 13.4 13.0, 13.4 11.0
    L 13.4 5.0
    C 13.4 3.0, 13.0 2.6, 11.0 2.6
    Z
  "/>
  <rect x="5.2" y="5.2" width="1.4" height="5.6" rx="0.3" fill="currentColor"/>
  <rect x="9.4" y="5.2" width="1.4" height="5.6" rx="0.3" fill="currentColor"/>
  <polygon points="6.2,8.4 8.0,6.5 9.8,8.4 8.0,7.3" fill="currentColor"/>
</svg>
`.trim();
}

function build() {
  const assetsDir = path.join(__dirname, '..', 'src', 'assets');
  if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true });

  console.log('[Tray] Generating vector template status bar assets from app icon…');

  const png1x = renderTrayTemplatePng(16);
  const png2x = renderTrayTemplatePng(32);
  const svg = generateTraySvg();

  fs.writeFileSync(path.join(assetsDir, 'trayTemplate.png'), png1x);
  fs.writeFileSync(path.join(assetsDir, 'trayTemplate@2x.png'), png2x);
  fs.writeFileSync(path.join(assetsDir, 'trayTemplate.svg'), svg);

  console.log('[Tray] Wrote trayTemplate.png (16x16)');
  console.log('[Tray] Wrote trayTemplate@2x.png (32x32)');
  console.log('[Tray] Wrote trayTemplate.svg (Vector SVG)');
}

build();
