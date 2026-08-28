// 生成 PWA 图标（纯色圆角方块 + 白点，PNG 无外部依赖）
import zlib from 'node:zlib';
import fs from 'node:fs';

function crc32(buf) {
  let c; const t = [];
  for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  let r = 0xFFFFFFFF;
  for (const b of buf) r = t[(r ^ b) & 0xFF] ^ (r >>> 8);
  return (r ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function makeIcon(size) {
  const W = size, H = size;
  const raw = Buffer.alloc(H * (1 + W * 3));
  const r = size * 0.18; // 圆角半径
  const cx = W / 2, cy = H / 2, dotR = size * 0.22; // 中心白点半径
  for (let y = 0; y < H; y++) {
    raw[y * (1 + W * 3)] = 0; // filter none
    for (let x = 0; x < W; x++) {
      const o = y * (1 + W * 3) + 1 + x * 3;
      // 圆角遮罩
      const inCorner = (xx, yy, qx, qy) => {
        const dx = Math.max(0, Math.abs(xx - qx) - (Math.min(qx, W - 1 - qx) - r));
        const dy = Math.max(0, Math.abs(yy - qy) - (Math.min(qy, H - 1 - qy) - r));
        return dx * dx + dy * dy <= r * r;
      };
      const inside = inCorner(x, y, 0, 0) && inCorner(x, y, W - 1, 0) && inCorner(x, y, 0, H - 1) && inCorner(x, y, W - 1, H - 1);
      const inDot = (x - cx) ** 2 + (y - cy) ** 2 <= dotR * dotR;
      // 背景 #4f6ef7，白点
      raw[o] = inside ? (inDot ? 255 : 79) : 0;
      raw[o + 1] = inside ? (inDot ? 255 : 110) : 0;
      raw[o + 2] = inside ? (inDot ? 255 : 247) : 0;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}
fs.writeFileSync('icon-192.png', makeIcon(192));
fs.writeFileSync('icon-512.png', makeIcon(512));
console.log('icons written: icon-192.png, icon-512.png');
