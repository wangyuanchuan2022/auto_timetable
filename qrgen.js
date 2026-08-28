/*
 * qrgen.js — 自包含 QR Code 生成器（字节模式 / 纠错等级 M / 版本 1-10）
 *
 * 供电脑端 schedule.html 渲染「公网访问 / 局域网访问」两个二维码使用。
 * 不依赖任何第三方库，也不修改 dsh-pocket 插件；只是参照其「本地生成二维码」
 * 的思路（dsh-pocket 在服务端用 qrcode npm 包生成，这里在浏览器端自行生成）。
 *
 * 对外接口：
 *   qrgen.encode(text)        → { version, size, matrix }  matrix[y][x]：true=黑
 *   qrgen.isEncodable(text)   → boolean（长度是否放得下）
 *
 * 亦可在 Node 中 require 使用（用于测试）。
 */
(function (factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); // Node（测试）
  else window.qrgen = factory(); // 浏览器
})(function () {
  'use strict';

  // ---------- 纠错等级 M 的参数表（版本 1-10） ----------
  // 数据来自 ISO/IEC 18004（与 qrcode npm 包 error-correction-code.js 的 M 列一致）：
  //   totalCodewords：该版本总码字数
  //   ecTotal：纠错码字总数；blocks：分块数（每块纠错码字数 = ecTotal / blocks）
  var TABLE = [
    /* v1 */ { total: 26, ecTotal: 10, blocks: 1 },
    /* v2 */ { total: 44, ecTotal: 16, blocks: 1 },
    /* v3 */ { total: 70, ecTotal: 26, blocks: 1 },
    /* v4 */ { total: 100, ecTotal: 36, blocks: 2 },
    /* v5 */ { total: 134, ecTotal: 48, blocks: 2 },
    /* v6 */ { total: 172, ecTotal: 64, blocks: 4 },
    /* v7 */ { total: 196, ecTotal: 72, blocks: 4 },
    /* v8 */ { total: 242, ecTotal: 88, blocks: 4 },
    /* v9 */ { total: 292, ecTotal: 110, blocks: 5 },
    /* v10 */ { total: 346, ecTotal: 130, blocks: 5 }
  ];
  var MAX_VERSION = TABLE.length;

  // 每版本对齐图形中心坐标（v1 无对齐图形）
  var ALIGN_POS = {
    2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
    7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50]
  };

  // 字节模式的字符计数指示位宽：v1-9 为 8 位，v10+ 为 16 位
  function countBits(version) { return version <= 9 ? 8 : 16; }

  // ---------- GF(256)，本原多项式 0x11D ----------
  var EXP = new Array(512), LOG = new Array(256);
  (function initGF() {
    var x = 1;
    for (var i = 0; i < 255; i++) {
      EXP[i] = x; LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (var j = 255; j < 512; j++) EXP[j] = EXP[j - 255];
  })();
  function gmul(a, b) { return (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]]; }

  // RS 生成多项式（系数高位在前、首项为 1）：(x - α^0)(x - α^1)…(x - α^(deg-1))
  function rsGenerator(deg) {
    var poly = [1];
    for (var i = 0; i < deg; i++) {
      var next = new Array(poly.length + 1).fill(0);
      for (var j = 0; j < poly.length; j++) {
        next[j] ^= poly[j];                     // × x
        next[j + 1] ^= gmul(poly[j], EXP[i]);   // × α^i
      }
      poly = next;
    }
    return poly;
  }
  // 求 RS 余数（纠错码字）
  function rsRemainder(data, deg) {
    var gen = rsGenerator(deg);
    var rem = new Array(deg).fill(0);
    for (var i = 0; i < data.length; i++) {
      var factor = data[i] ^ rem.shift();
      rem.push(0);
      if (factor !== 0) {
        for (var j = 0; j < deg; j++) rem[j] ^= gmul(gen[j + 1], factor);
      }
    }
    return rem;
  }

  // ---------- 数据位流 ----------
  function utf8Bytes(text) {
    if (typeof TextEncoder !== 'undefined') return Array.prototype.slice.call(new TextEncoder().encode(text));
    // 兜底（老环境）
    var out = [];
    for (var i = 0; i < text.length; i++) {
      var c = text.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) { out.push(0xc0 | (c >> 6), 0x80 | (c & 63)); }
      else { out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)); }
    }
    return out;
  }

  function pickVersion(byteLen) {
    for (var v = 1; v <= MAX_VERSION; v++) {
      var dataCodewords = TABLE[v - 1].total - TABLE[v - 1].ecTotal;
      var usableBits = dataCodewords * 8 - 4 - countBits(v);
      if (byteLen <= Math.floor(usableBits / 8)) return v;
    }
    return 0;
  }

  /** 生成最终码字序列（数据 + 纠错，已交错） */
  function makeCodewords(bytes, version) {
    var t = TABLE[version - 1];
    var dataLen = t.total - t.ecTotal;
    var ecPerBlock = t.ecTotal / t.blocks;

    // 位流：模式 0100 + 计数 + 数据 + 终止符 + 补齐
    var bits = [];
    function pushBits(value, n) { for (var i = n - 1; i >= 0; i--) bits.push((value >>> i) & 1); }
    pushBits(4, 4);                       // 字节模式
    pushBits(bytes.length, countBits(version));
    for (var i = 0; i < bytes.length; i++) pushBits(bytes[i], 8);
    var capacityBits = dataLen * 8;
    pushBits(0, Math.min(4, capacityBits - bits.length)); // 终止符
    while (bits.length % 8 !== 0) bits.push(0);           // 补到字节边界
    var data = [];
    for (var b = 0; b < bits.length; b += 8) {
      var v = 0;
      for (var k = 0; k < 8; k++) v = (v << 1) | bits[b + k];
      data.push(v);
    }
    for (var pad = 0xec; data.length < dataLen; pad ^= 0xec ^ 0x11) data.push(pad); // 0xEC,0x11 交替

    // 分块（短块在前：dataLen % blocks 个块各多 1 字节）
    var shortLen = Math.floor(dataLen / t.blocks);
    var longCount = dataLen % t.blocks;
    var dataBlocks = [], ecBlocks = [], pos = 0;
    for (var bi = 0; bi < t.blocks; bi++) {
      var len = shortLen + (bi >= t.blocks - longCount ? 1 : 0);
      var block = data.slice(pos, pos + len); pos += len;
      dataBlocks.push(block);
      ecBlocks.push(rsRemainder(block, ecPerBlock));
    }

    // 交错：先数据后纠错
    var out = [];
    var maxLen = shortLen + (longCount ? 1 : 0);
    for (var d = 0; d < maxLen; d++) {
      for (var b2 = 0; b2 < t.blocks; b2++) if (d < dataBlocks[b2].length) out.push(dataBlocks[b2][d]);
    }
    for (var e = 0; e < ecPerBlock; e++) {
      for (var b3 = 0; b3 < t.blocks; b3++) out.push(ecBlocks[b3][e]);
    }
    return out;
  }

  // ---------- 矩阵 ----------
  function getBit(x, i) { return ((x >>> i) & 1) !== 0; }

  function buildMatrix(codewords, version) {
    var size = 17 + 4 * version;
    var m = [], fn = [];
    for (var y = 0; y < size; y++) { m.push(new Array(size).fill(false)); fn.push(new Array(size).fill(false)); }
    function set(x, y, dark) { m[y][x] = dark; fn[y][x] = true; }

    // 三个定位图形 + 分隔带
    function finder(cx, cy) {
      for (var dy = -4; dy <= 4; dy++) {
        for (var dx = -4; dx <= 4; dx++) {
          var dist = Math.max(Math.abs(dx), Math.abs(dy));
          if (cx + dx >= 0 && cx + dx < size && cy + dy >= 0 && cy + dy < size) {
            set(cx + dx, cy + dy, dist !== 2 && dist !== 4);
          }
        }
      }
    }
    finder(3, 3); finder(size - 4, 3); finder(3, size - 4);

    // 校正图形
    var pos = ALIGN_POS[version];
    if (pos) {
      for (var ai = 0; ai < pos.length; ai++) {
        for (var aj = 0; aj < pos.length; aj++) {
          var isCorner = (ai === 0 && aj === 0) || (ai === 0 && aj === pos.length - 1) || (ai === pos.length - 1 && aj === 0);
          if (isCorner) continue; // 与定位图形重叠
          var cxx = pos[aj], cyy = pos[ai];
          for (var ddy = -2; ddy <= 2; ddy++) {
            for (var ddx = -2; ddx <= 2; ddx++) {
              set(cxx + ddx, cyy + ddy, Math.max(Math.abs(ddx), Math.abs(ddy)) !== 1);
            }
          }
        }
      }
    }

    // 时序图形
    for (var t = 8; t < size - 8; t++) { set(t, 6, t % 2 === 0); set(6, t, t % 2 === 0); }

    // 格式信息（两份）+ 固定暗模块；在指定矩阵上按掩码 mask 重画
    function drawFormat(mtx, mask) {
      function mark(x, y, dark) { mtx[y][x] = dark; fn[y][x] = true; }
      var data = (0 /* M */ << 3) | mask; // 纠错等级 M 的格式位为 00
      var rem = data;
      for (var i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      var bits = ((data << 10) | rem) ^ 0x5412;
      for (var f = 0; f <= 5; f++) mark(8, f, getBit(bits, f));
      mark(8, 7, getBit(bits, 6));
      mark(8, 8, getBit(bits, 7));
      mark(7, 8, getBit(bits, 8));
      for (var g = 9; g < 15; g++) mark(14 - g, 8, getBit(bits, g));
      for (var h = 0; h < 8; h++) mark(size - 1 - h, 8, getBit(bits, h));
      for (var k = 8; k < 15; k++) mark(8, size - 15 + k, getBit(bits, k));
      mark(8, size - 8, true); // 固定暗模块
    }
    drawFormat(m, 0); // 先以掩码 0 占位标记功能区，数据填充后再按最佳掩码重画

    // 版本信息（v≥7）
    if (version >= 7) {
      var remv = version;
      for (var vi = 0; vi < 12; vi++) remv = (remv << 1) ^ ((remv >>> 11) * 0x1f25);
      var vbits = (version << 12) | remv;
      for (var w = 0; w < 18; w++) {
        var color = getBit(vbits, w);
        var a = size - 11 + (w % 3), b2 = Math.floor(w / 3);
        set(a, b2, color); set(b2, a, color);
      }
    }

    // 数据填充：右起两列一组的蛇形走位（跳过第 6 列）
    var totalBits = codewords.length * 8, bitIdx = 0;
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var vert = 0; vert < size; vert++) {
        for (var jj = 0; jj < 2; jj++) {
          var x = right - jj;
          var upward = ((right + 1) & 2) === 0;
          var y = upward ? size - 1 - vert : vert;
          if (!fn[y][x] && bitIdx < totalBits) {
            m[y][x] = getBit(codewords[bitIdx >>> 3], 7 - (bitIdx & 7));
            bitIdx++;
          }
        }
      }
    }

    // 8 种掩码逐一尝试，取惩罚分最低者
    var maskFns = [
      function (x, y) { return (x + y) % 2 === 0; },
      function (x, y) { return y % 2 === 0; },
      function (x, y) { return x % 3 === 0; },
      function (x, y) { return (x + y) % 3 === 0; },
      function (x, y) { return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; },
      function (x, y) { return (x * y) % 2 + (x * y) % 3 === 0; },
      function (x, y) { return ((x * y) % 2 + (x * y) % 3) % 2 === 0; },
      function (x, y) { return ((x + y) % 2 + (x * y) % 3) % 2 === 0; }
    ];
    var bestMask = 0, bestScore = Infinity, bestMatrix = null;
    for (var mi = 0; mi < 8; mi++) {
      var cand = m.map(function (row) { return row.slice(); });
      for (var yy = 0; yy < size; yy++) {
        for (var xx = 0; xx < size; xx++) {
          if (!fn[yy][xx] && maskFns[mi](xx, yy)) cand[yy][xx] = !cand[yy][xx];
        }
      }
      drawFormat(cand, mi); // 该掩码对应的格式信息
      var score = penalty(cand, size);
      if (score < bestScore) { bestScore = score; bestMask = mi; bestMatrix = cand; }
    }
    return bestMatrix;
  }

  // ---------- 惩罚分（ISO 18004 评定规则） ----------
  function penalty(m, size) {
    var score = 0, x, y;

    // 规则1：行/列连续同色 ≥5
    for (y = 0; y < size; y++) {
      var runColor = m[y][0], runLen = 1;
      for (x = 1; x < size; x++) {
        if (m[y][x] === runColor) { runLen++; if (runLen === 5) score += 3; else if (runLen > 5) score += 1; }
        else { runColor = m[y][x]; runLen = 1; }
      }
    }
    for (x = 0; x < size; x++) {
      var rc = m[0][x], rl = 1;
      for (y = 1; y < size; y++) {
        if (m[y][x] === rc) { rl++; if (rl === 5) score += 3; else if (rl > 5) score += 1; }
        else { rc = m[y][x]; rl = 1; }
      }
    }

    // 规则2：2×2 同色块
    for (y = 0; y < size - 1; y++) {
      for (x = 0; x < size - 1; x++) {
        var c0 = m[y][x];
        if (m[y][x + 1] === c0 && m[y + 1][x] === c0 && m[y + 1][x + 1] === c0) score += 3;
      }
    }

    // 规则3：类定位图形 1:1:3:1:1（前后各 4 个浅色）
    // 滑动 11 位窗口匹配 00001011101 或 10111010000
    function historyVal(row) { // 行 → 0/1 串
      var s = '';
      for (var i = 0; i < row.length; i++) s += row[i] ? '1' : '0';
      return s;
    }
    var PAT1 = '00001011101', PAT2 = '10111010000';
    for (y = 0; y < size; y++) {
      var s1 = historyVal(m[y]);
      for (var p = 0; p + 11 <= size; p++) {
        var w1 = s1.substr(p, 11);
        if (w1 === PAT1 || w1 === PAT2) score += 40;
      }
    }
    for (x = 0; x < size; x++) {
      var col = [];
      for (y = 0; y < size; y++) col.push(m[y][x]);
      var s2 = historyVal(col);
      for (var p2 = 0; p2 + 11 <= size; p2++) {
        var w2 = s2.substr(p2, 11);
        if (w2 === PAT1 || w2 === PAT2) score += 40;
      }
    }

    // 规则4：明暗比例失衡
    var dark = 0;
    for (y = 0; y < size; y++) for (x = 0; x < size; x++) if (m[y][x]) dark++;
    var percent = (dark * 100) / (size * size);
    score += Math.floor(Math.abs(percent - 50) / 5) * 10;
    return score;
  }

  // ---------- 对外接口 ----------
  function encode(text) {
    var bytes = utf8Bytes(String(text));
    var version = pickVersion(bytes.length);
    if (!version) return null;
    var codewords = makeCodewords(bytes, version);
    var matrix = buildMatrix(codewords, version);
    return { version: version, size: 17 + 4 * version, matrix: matrix };
  }
  function isEncodable(text) {
    return pickVersion(utf8Bytes(String(text)).length) !== 0;
  }

  return { encode: encode, isEncodable: isEncodable };
});
