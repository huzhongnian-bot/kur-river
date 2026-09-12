// 生成 PWA manifest 用的 PNG 占位图标（场记板意象：深色底 + 琥珀板上沿 + 白瓶身）。
// 零依赖：手写最小 PNG 编码（zlib deflate + CRC32），产物提交到仓库，
// 需要重画时 node scripts/generate-icons.mjs 再跑一遍。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(rootDir, 'apps', 'web', 'public', 'icons');
fs.mkdirSync(outDir, { recursive: true });

// --- CRC32（PNG 块校验） ----------------------------------------------------
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, paintPixel) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = paintPixel(x / size, y / size);
      const p = rowStart + 1 + x * 4;
      raw[p] = r;
      raw[p + 1] = g;
      raw[p + 2] = b;
      raw[p + 3] = a;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const DARK = [15, 23, 42, 255]; // #0f172a
const AMBER = [245, 158, 11, 255]; // #f59e0b
const WHITE = [248, 250, 252, 255]; // #f8fafc

// 与 app/icon.svg 同一构图（归一化坐标）
function clapperboard(nx, ny) {
  // 琥珀上沿（微斜）：y ∈ [0.23, 0.36]
  const skew = (0.5 - nx) * 0.03;
  if (ny + skew > 0.23 && ny + skew < 0.36 && nx > 0.17 && nx < 0.83) {
    // 深色斜纹
    const stripe = ((nx * 8) % 1) < 0.42;
    return stripe ? DARK : AMBER;
  }
  // 白瓶身：y ∈ [0.38, 0.77]
  if (ny > 0.38 && ny < 0.77 && nx > 0.17 && nx < 0.83) return WHITE;
  return DARK;
}

for (const size of [192, 512]) {
  const png = encodePng(size, clapperboard);
  const file = path.join(outDir, `icon-${size}.png`);
  fs.writeFileSync(file, png);
  console.log(`written ${file} (${png.length} bytes)`);
}
