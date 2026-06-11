// Generates public/favicon.ico (16/32/48 PNG-in-ICO) and public/logo192.png
// from the same "J on a blue tile" design as public/favicon.svg.
// No dependencies — raw PNG/ICO encoding via zlib. Run: node scripts/gen-icons.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BLUE = [62, 99, 245]; // --primary #3e63f5

// ---- Shape tests in the 100x100 design space of favicon.svg ----
const inRect = (x, y, x0, y0, x1, y1) => x >= x0 && x <= x1 && y >= y0 && y <= y1;

const inJ = (x, y) => {
  if (inRect(x, y, 30, 20, 74, 32)) return true; // top bar
  if (inRect(x, y, 54, 20, 66, 62)) return true; // stem
  if (inRect(x, y, 24, 50, 36, 62)) return true; // hook tick
  const dx = x - 45, dy = y - 62; // bottom hook (half annulus)
  if (dy >= 0) {
    const d2 = dx * dx + dy * dy;
    if (d2 <= 21 * 21 && d2 >= 9 * 9) return true;
  }
  return false;
};

const inTile = (x, y, r) => {
  if (x < 0 || x > 100 || y < 0 || y > 100) return false;
  const cx = Math.max(r - x, x - (100 - r), 0);
  const cy = Math.max(r - y, y - (100 - r), 0);
  return cx * cx + cy * cy <= r * r;
};

// ---- Rasterize with 4x4 supersampling ----
function render(size, radius) {
  const SS = 4, n = SS * SS;
  const px = Buffer.alloc(size * size * 4);
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      let tile = 0, j = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = ((col + (sx + 0.5) / SS) / size) * 100;
          const y = ((row + (sy + 0.5) / SS) / size) * 100;
          if (inTile(x, y, radius)) {
            tile++;
            if (inJ(x, y)) j++;
          }
        }
      }
      if (tile === 0) continue;
      const a = tile / n, w = j / n;
      const o = (row * size + col) * 4;
      for (let c = 0; c < 3; c++) {
        px[o + c] = Math.round((255 * w + BLUE[c] * (a - w)) / a);
      }
      px[o + 3] = Math.round(a * 255);
    }
  }
  return px;
}

// ---- PNG encoding ----
const crcTable = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
};
function toPNG(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(size * stride);
  for (let y = 0; y < size; y++) {
    rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- ICO container (PNG entries) ----
function toICO(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + images.length * 16;
  for (const { size, buf } of images) {
    const e = Buffer.alloc(16);
    e[0] = size === 256 ? 0 : size;
    e[1] = size === 256 ? 0 : size;
    e.writeUInt16LE(1, 4);  // planes
    e.writeUInt16LE(32, 6); // bpp
    e.writeUInt32LE(buf.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += buf.length;
  }
  return Buffer.concat([header, ...entries, ...images.map(i => i.buf)]);
}

const out = path.join(__dirname, '..', 'public');
const ico = toICO([16, 32, 48].map(s => ({ size: s, buf: toPNG(s, render(s, 22)) })));
fs.writeFileSync(path.join(out, 'favicon.ico'), ico);
fs.writeFileSync(path.join(out, 'logo192.png'), toPNG(192, render(192, 0)));
console.log('written: favicon.ico (16/32/48), logo192.png');
