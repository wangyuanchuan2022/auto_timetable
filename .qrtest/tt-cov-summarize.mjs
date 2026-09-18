// tt-cov-summarize.mjs — tt.mjs V8 块覆盖汇总（逐字节最内层 range 生效语义）。
// 用法：NODE_V8_COVERAGE=<dir> node .qrtest/tt-tool-test.mjs && node .qrtest/tt-cov-summarize.mjs <covDir>
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? '.qrtest/tmp-cov';
const target = 'tt.mjs';
const src = readFileSync(join(dir, '..', '..', 'tt.mjs'), 'utf8');
const lineStart = [];
{
  let off = 0;
  // V8 range 偏移是 UTF-16 字符偏移（不是 UTF-8 字节）：按 JS 字符串长度累加
  for (const l of src.split('\n')) { lineStart.push(off); off += l.length + 1; }
  lineStart.push(off);
}
const nLines = lineStart.length - 1;
// 按跨度升序：首个包含该字节的 range 即最内层（V8 range 严格嵌套）。
// 多进程报告逐文件独立计算，再按「任一报告覆盖即覆盖」做 OR（互补双跑合并口径）。
const perFileCov = [];
for (const f of readdirSync(dir)) {
  if (!f.endsWith('.json')) continue;
  const j = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  const fileRanges = [];
  for (const e of j.result ?? []) {
    if (!String(e.url).endsWith('/' + target)) continue;
    for (const fn of e.functions ?? []) for (const r of fn.ranges ?? []) fileRanges.push(r);
  }
  if (!fileRanges.length) continue;
  fileRanges.sort((a, b) => (a.endOffset - a.startOffset) - (b.endOffset - b.startOffset));
  const cov = new Array(nLines).fill(-1);
  for (let o = 0; o < src.length; o++) {
    for (const r of fileRanges) {
      if (r.startOffset <= o && o < r.endOffset) {
        const v = r.count > 0 ? 1 : 0;
        const l = lowerBound(lineStart, o);
        if (cov[l] < v) cov[l] = v;
        break;
      }
    }
  }
  perFileCov.push(cov);
}
const merged = new Array(nLines).fill(-1);
for (const cov of perFileCov) for (let l = 0; l < nLines; l++) merged[l] = Math.max(merged[l], cov[l]);
function lowerBound(arr, x) { let lo = 0, hi = arr.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (arr[m] <= x) lo = m; else hi = m - 1; } return lo; }
let c = 0, t = 0; const missed = [];
for (let l = 0; l < nLines; l++) {
  if (merged[l] === -1) continue;
  t++; if (merged[l] === 1) c++; else missed.push(l);
}
console.log(`${target} 行覆盖（逐字节最内层口径）: ${c}/${t} = ${(100 * c / t).toFixed(1)}%`);
console.log(`未覆盖行数: ${missed.length}`);
const text = src.split('\n');
for (const l of missed) console.log(`${l + 1}: ${text[l].trim().slice(0, 100)}`);
