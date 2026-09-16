const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');

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
    raw[rowOffset] = 0; // Filter: None
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
  ihdr[8] = 8; // 8-bit
  ihdr[9] = 6; // RGBA
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

function renderAppIcon(size) {
  const radius = size * 0.22; // macOS squirqle corner radius

  return createPng(size, size, (x, y, w, h) => {
    const nx = (x / w) * 2 - 1; // [-1, 1]
    const ny = (y / h) * 2 - 1; // [-1, 1]

    // macOS icon squircle distance approximation: |x|^5 + |y|^5 <= 1
    const distSquircle = Math.pow(Math.abs(nx * 1.15), 4.5) + Math.pow(Math.abs(ny * 1.15), 4.5);
    if (distSquircle > 1.0) {
      return [0, 0, 0, 0]; // Transparent outside
    }

    // Border highlight
    const isBorder = distSquircle > 0.92;
    if (isBorder) {
      return [24, 185, 129, 220]; // Emerald highlight rim
    }

    // Inner background gradient (top-left lighter slate to dark obsidian)
    const grad = 0.5 + 0.5 * (nx * -0.3 + ny * 0.4);
    const bgR = Math.round(18 - grad * 6);
    const bgG = Math.round(24 - grad * 7);
    const bgB = Math.round(22 - grad * 6);

    // Center Keycap shape: rounded rectangle from [-0.55, 0.55]
    const kx = Math.abs(nx);
    const ky = Math.abs(ny);
    const inKeyBase = (kx < 0.62 && ky < 0.62);

    if (inKeyBase) {
      // Keycap top surface (stepped)
      const inKeyTop = (kx < 0.48 && ky < 0.48);
      if (inKeyTop) {
        // Letter M on the keycap (not a medical plus)
        const inMLeft = (nx > -0.28 && nx < -0.18 && ny > -0.22 && ny < 0.22);
        const inMRight = (nx > 0.18 && nx < 0.28 && ny > -0.22 && ny < 0.22);
        const inMMidL = (Math.abs(ny + nx * 0.7 + 0.02) < 0.07 && nx > -0.22 && nx < 0 && ny < 0.05);
        const inMMidR = (Math.abs(ny - nx * 0.7 + 0.02) < 0.07 && nx < 0.22 && nx > 0 && ny < 0.05);
        if (inMLeft || inMRight || inMMidL || inMMidR) {
          return [16, 215, 145, 255];
        }

        // Keycap top face
        const topShade = 38 + Math.round((0.5 - ny * 0.5) * 16);
        return [topShade, topShade + 6, topShade + 4, 255];
      }

      // Keycap bevel sides
      const bevelShade = 24 + Math.round((ny + 0.5) * 8);
      return [bevelShade, bevelShade + 4, bevelShade + 3, 255];
    }

    return [bgR, bgG, bgB, 255];
  });
}

function build() {
  const buildDir = path.join(__dirname, '..', 'build');
  const iconsetDir = path.join(buildDir, 'AppIcon.iconset');

  if (!fs.existsSync(buildDir)) fs.mkdirSync(buildDir, { recursive: true });
  if (!fs.existsSync(iconsetDir)) fs.mkdirSync(iconsetDir, { recursive: true });

  console.log('[Icon] Generating multi-resolution icon assets…');

  const sizes = [
    { name: 'icon_16x16.png', size: 16 },
    { name: 'icon_16x16@2x.png', size: 32 },
    { name: 'icon_32x32.png', size: 32 },
    { name: 'icon_32x32@2x.png', size: 64 },
    { name: 'icon_128x128.png', size: 128 },
    { name: 'icon_128x128@2x.png', size: 256 },
    { name: 'icon_256x256.png', size: 256 },
    { name: 'icon_256x256@2x.png', size: 512 },
    { name: 'icon_512x512.png', size: 512 },
    { name: 'icon_512x512@2x.png', size: 1024 }
  ];

  for (const item of sizes) {
    const png = renderAppIcon(item.size);
    fs.writeFileSync(path.join(iconsetDir, item.name), png);
  }

  // Also write main build/icon.png (512x512)
  const masterPng = renderAppIcon(512);
  const iconPngPath = path.join(buildDir, 'icon.png');
  fs.writeFileSync(iconPngPath, masterPng);
  console.log('[Icon] Wrote master PNG:', iconPngPath);

  // Compile to native macOS .icns using iconutil
  const icnsPath = path.join(buildDir, 'icon.icns');
  try {
    execFileSync('/usr/bin/iconutil', ['-c', 'icns', iconsetDir, '-o', icnsPath]);
    console.log('[Icon] Compiled native Apple ICNS:', icnsPath);
  } catch (err) {
    console.warn('[Icon] iconutil compilation warning:', err.message);
  }
}

build();
