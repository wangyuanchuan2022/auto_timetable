// qrgen.js 回环测试：用 jsQR 解码自产矩阵，验证编码器正确性
const qrgen = require('../qrgen.js');
const jsQR = require('jsqr');

function matrixToRGBA(matrix, size, scale, margin) {
  const dim = (size + margin * 2) * scale;
  const data = new Uint8ClampedArray(dim * dim * 4);
  data.fill(255); // 白底
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!matrix[y][x]) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const py = (y + margin) * scale + dy, px = (x + margin) * scale + dx;
          const i = (py * dim + px) * 4;
          data[i] = data[i + 1] = data[i + 2] = 0;
        }
      }
    }
  }
  return { data, dim };
}

const samples = [
  'http://192.168.1.100:3081/api/worktable/site/D%3A%5Ctools%5Cauto_timetable/mobile.html',
  'https://random-name-something.trycloudflare.com/api/worktable/site/D%3A%5Ctools%5Cauto_timetable/mobile.html',
  'HELLO',
  'http://172.20.10.3:3081/x',
  'A'.repeat(106),  // v6-M 满容量
  'B'.repeat(122),  // v7
  'C'.repeat(180),  // v9
  'D'.repeat(210),  // v10 边界内
];

let pass = 0, fail = 0;
for (const text of samples) {
  const r = qrgen.encode(text);
  if (!r) { console.log(`FAIL(encode) len=${text.length}`); fail++; continue; }
  const { data, dim } = matrixToRGBA(r.matrix, r.size, 4, 4);
  const decoded = jsQR(data, dim, dim);
  const ok = decoded && decoded.data === text;
  if (ok) { pass++; console.log(`PASS v${r.version} (${text.length} chars)`); }
  else { fail++; console.log(`FAIL v${r.version} (${text.length} chars) -> ${decoded ? JSON.stringify(decoded.data) : 'null'}`); }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
