// 临时验证脚本：生成纯红 PNG 并通过 /api/chat 发给 DSH 辨色
const zlib = require('zlib');

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
const W = 64, H = 64;
const raw = Buffer.alloc(H * (1 + W * 3));
for (let y = 0; y < H; y++) {
  raw[y * (1 + W * 3)] = 0;
  for (let x = 0; x < W; x++) {
    const o = y * (1 + W * 3) + 1 + x * 3;
    raw[o] = 220; raw[o + 1] = 30; raw[o + 2] = 40;
  }
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
]);
console.log('png bytes:', png.length);

const t0 = Date.now();
fetch('http://127.0.0.1:3190/api/chat', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    message: '我发了一张图片，它主要是什么颜色？只回答颜色名称。',
    images: [{ mediaType: 'image/png', data: png.toString('base64'), name: 'red.png' }],
  }),
}).then(r => r.json()).then(j => {
  console.log(((Date.now() - t0) / 1000).toFixed(1) + 's reply:', j.ok ? j.reply.slice(0, 200) : JSON.stringify(j));
}).catch(e => console.log('FAIL', e.message));
