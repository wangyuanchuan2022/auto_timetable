// landscape-week-test.mjs — 手机端横屏周视图（时间网格）回归测试。
// 覆盖：mobile.html 静态结构（#weekGrid + landscape 显隐规则 + 时间网格样式）、
// renderWeek 行为（七列周一..周日、按时间定位的块、跨午夜拆段/次日续、重叠分列、
// skip 生效、任务截止日红横幅、今日列高亮与当前时刻线、块点击接 openDialog、
// 重渲染幂等）、真实 schedule.json 冒烟（逐列块数与独立拆段口径一致；不落数据）。
// 运行：node .qrtest/landscape-week-test.mjs
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { loadPage, collect } from './page-harness.mjs';

const require2 = createRequire(import.meta.url);
const TTOccur = require2('../occur.js');

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; console.log('  [OK] ' + name); } else { fail++; console.log('  [FAIL] ' + name); } };
const toMin = (hhmm) => { const p = String(hhmm).split(':'); return (+p[0]) * 60 + (+p[1] || 0); };

// ---------- 1) mobile.html 静态结构 ----------
console.log('1) mobile.html 静态结构');
const html = readFileSync(new URL('../mobile.html', import.meta.url), 'utf8');
check('pageSched 内存在 #weekGrid 容器', /id="weekGrid"/.test(html));
check('存在 landscape 媒体查询', html.indexOf('@media (orientation: landscape)') !== -1);
const lm = html.match(/@media \(orientation: landscape\) \{[\s\S]*?\n    \}/);
check('横屏下隐藏单日列表 / 通知行 / 日期选择', !!lm && lm[0].indexOf('#list { display: none') !== -1 && lm[0].indexOf('#notifyRow') !== -1 && lm[0].indexOf('input[type="date"]') !== -1);
check('横屏下显示周视图容器且时间网格可滚动', !!lm && lm[0].indexOf('#weekGrid { display: block') !== -1 && lm[0].indexOf('.wkBody { max-height') !== -1);
check('通知行有 id（横屏隐藏定位用）', /id="notifyRow"/.test(html));
check('时间网格样式齐备（时间轴/块/横幅/时刻线）', ['.wkGutter', '.wkHour', '.wkDayGrid', '.wkBlock', '.wkDue', '.wkNow'].every((c) => html.indexOf(c) !== -1));
check('周视图有深色模式适配', html.indexOf('.wkBlock { border-color: #262b36; }') !== -1);
check('网格线 36px 与 PX_PER_HOUR 同步（防止只改一边）', html.indexOf('transparent 1px 36px') !== -1 && readFileSync(new URL('../mobile-app.js', import.meta.url), 'utf8').indexOf('PX_PER_HOUR = 36') !== -1);

// ---------- 2) renderWeek 行为（合成周事件，含跨午夜与重叠） ----------
const pad = (n) => String(n).padStart(2, '0');
const fmt = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const today = new Date();
const mon = TTOccur.mondayOf(today);
const ds = (i) => fmt(new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + i));
const todayIdx = (today.getDay() + 6) % 7; // 0=周一
const events = [
  { id: 'w1', title: '周一早课', type: 'weekly', weekday: 1, start: '08:00', end: '09:35', deadline: '2027-01-17', color: '#4f8ef7' },
  { id: 'w3', title: '周三课', type: 'weekly', weekday: 3, start: '10:00', end: '11:35', deadline: '2027-01-17' },
  { id: 'ov', title: '周三重叠会', type: 'weekly', weekday: 3, start: '10:30', end: '11:30', deadline: '2027-01-17' },
  { id: 'o4', title: '周五考试', type: 'once', date: ds(4), start: '14:00', end: '16:00', deadline: ds(4) },
  { id: 'cm', title: '跨午夜课', type: 'weekly', weekday: 1, start: '23:00', end: '01:00', deadline: '2027-01-17' },
  { id: 'task5', title: '材料提交', type: 'task', deadline: ds(4) },
  { id: 'skip1', title: '停调课', type: 'weekly', weekday: 1, start: '12:00', end: '13:00', deadline: '2027-01-17', skip: [ds(0)] },
];
// 独立推算时间范围（同桌面 auto 规则，不复用页面实现）
const segsOf = (i) => { // 第 i 列的可见段 {s,e}（不含任务）
  const d = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + i);
  const out = [];
  for (const ev of events) {
    if ((ev.type || 'once') === 'task' || !TTOccur.occursOn(ev, d)) continue;
    const s = toMin(ev.start), e = toMin(ev.end);
    if (e <= s) { out.push([s, 1440]); if (i < 6) out.push([0, e]); }
    else out.push([s, e]);
  }
  return out;
};
let mn = Infinity, mx = -Infinity;
for (let i = 0; i < 7; i++) for (const [s, e] of segsOf(i)) { if (s < mn) mn = s; if (e > mx) mx = e; }
mn = Math.max(0, mn - 60); mx = Math.min(1440, mx + 60);
const R_START = Math.floor(mn / 15) * 15, R_END = Math.ceil(mx / 15) * 15;
const PPM = 36 / 60;

console.log('2) renderWeek 行为（合成周事件）');
const page = loadPage(new URL('../mobile.html', import.meta.url), {
  responses: { '/api/schedule': { events } },
});
await page.flush();
const grid = page.byId.weekGrid;
const isWkDay = (el) => el.classList && el.classList.contains('wkDay');
const isGrid = (el) => el.classList && el.classList.contains('wkDayGrid');
const isBlock = (el) => el.classList && el.classList.contains('wkBlock');
const head = collect(grid, isWkDay);
const cols = collect(grid, isGrid);
check('表头 7 列（周一..周日）', head.length === 7 && head.map((c) => c.textContent.slice(0, 2)).join(',') === '周一,周二,周三,周四,周五,周六,周日');
check('列头带日期且今日列高亮', head[0].textContent.indexOf(mon.getMonth() + 1 + '/' + mon.getDate()) !== -1 && head[todayIdx].className.indexOf('today') !== -1);
check('时间网格 7 列 + 时间轴列', cols.length === 7 && !!collect(grid, (el) => el.classList && el.classList.contains('wkGutter')).length);
check('跨午夜：周一列 23:00 段 + 周二列 0:00 续段（标题带（续））', (() => {
  const cm = collect(cols[0], isBlock).filter((b) => b.textContent.indexOf('跨午夜课') !== -1);
  const cont = collect(cols[1], isBlock).filter((b) => b.textContent.indexOf('跨午夜课（续）') !== -1);
  return cm.length === 1 && cont.length === 1;
})());
const blocksOf = (i) => collect(cols[i], isBlock);
check('周一列：早课 + 跨午夜段，skip 停调课不在', blocksOf(0).length === 2 && blocksOf(0).every((b) => b.textContent.indexOf('停调课') === -1));
check('周三列：重叠两块并各占 50% 宽（分列）', (() => {
  const bs = blocksOf(2);
  if (bs.length !== 2) return false;
  const a = bs.find((b) => b.textContent.indexOf('周三课') !== -1), b2 = bs.find((b) => b.textContent.indexOf('重叠会') !== -1);
  return a && b2 && a.style.width === '50%' && b2.style.width === '50%' && a.style.left === '0%' && b2.style.left === '50%';
})());
check('周五列：考试 1 块 + 截止红横幅', blocksOf(4).length === 1 && collect(cols[4], (el) => el.classList && el.classList.contains('wkDue')).length === 1);
check('截止横幅只在截止日列', [0, 1, 2, 3, 5, 6].every((i) => collect(cols[i], (el) => el.classList && el.classList.contains('wkDue')).length === 0));
check('块按时间定位（top/height 与独立推算一致，±1px）', (() => {
  const cases = [
    [0, '周一早课', 480, 575], [2, '周三课', 600, 695], [4, '周五考试', 840, 960], [0, '跨午夜课', 1380, 1440],
  ];
  for (const [ci, title, s, e] of cases) {
    const b = blocksOf(ci).find((x) => x.textContent.indexOf(title) !== -1);
    if (!b) return false;
    const top = parseFloat(b.style.top), h = parseFloat(b.style.height);
    if (Math.abs(top - (s - R_START) * PPM) > 1 || Math.abs(h - Math.max(8, (e - s) * PPM - 2)) > 1) return false;
  }
  return true;
})());
check('时间轴刻度与动态范围（' + Math.floor(R_START / 60) + ':00–' + Math.ceil(R_END / 60) + ':00）', (() => {
  const hours = collect(grid, (el) => el.classList && el.classList.contains('wkHour'));
  return hours.length === Math.floor((R_END - R_START) / 60) && hours[0].textContent === pad(Math.ceil(R_START / 60)) + ':00';
})());
check('今日列当前时刻线 + 时间轴红点', (() => {
  const nowMin = today.getHours() * 60 + today.getMinutes();
  const has = (i, cls) => collect(cols[i], (el) => el.classList && el.classList.contains(cls)).length;
  const want = nowMin >= R_START && nowMin <= R_END ? 1 : 0;
  return has(todayIdx, 'wkNow') === want && [0, 1, 2, 3, 4, 5, 6].every((i) => i === todayIdx || has(i, 'wkNow') === 0) && collect(grid, (el) => el.classList && el.classList.contains('wkNowDot')).length === want;
})());
check('截止任务不泄漏为时间块（无时刻语义，只进当日横幅）', (() => {
  // task5 截止 ds(4)：若预扫描未排 task，会以 0 高度续段块泄进周一列
  return collect(cols[0], isBlock).every((b) => b.textContent.indexOf('材料提交') === -1) &&
    collect(cols[4], (el) => el.classList && el.classList.contains('wkDue')).length === 1;
})());
check('块/横幅点击已接处理器（源码接线 openDialog(ref)）',
  typeof blocksOf(0)[0].onclick === 'function' &&
  readFileSync(new URL('../mobile-app.js', import.meta.url), 'utf8').indexOf('openDialog(ref)') !== -1);
check('数据刷新再渲染不残留（二次 render 幂等）', (() => {
  const before = collect(grid, isBlock).length;
  if (page.byId.datePick._ls && page.byId.datePick._ls.change) page.byId.datePick._ls.change();
  const after = collect(grid, isBlock).length;
  return before === after && before > 0;
})());

console.log('3) 真实 schedule.json 冒烟（逐列块数与独立拆段口径一致；不落数据）');
if (existsSync(new URL('../schedule.json', import.meta.url))) {
  const real = JSON.parse(readFileSync(new URL('../schedule.json', import.meta.url), 'utf8'));
  const page2 = loadPage(new URL('../mobile.html', import.meta.url), {
    responses: { '/api/schedule': real },
  });
  await page2.flush();
  const cols2 = collect(page2.byId.weekGrid, isGrid);
  check('真实数据：渲染 7 列不异常', cols2.length === 7);
  // 独立口径：timed 事件按跨午夜拆段计数 + 当日截止任务横幅
  let mism = 0;
  for (let i = 0; i < 7; i++) {
    const d = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + i);
    const dstr = fmt(d);
    let expect = 0;
    for (const ev of real.events) {
      if ((ev.type || 'once') === 'task') continue;
      if (!TTOccur.occursOn(ev, d)) continue;
      expect++; // 当天主段
      const e = toMin(ev.end), s = toMin(ev.start);
      if (e <= s && i < 6) { /* 跨午夜续段计入次日列，不在本列 */ }
    }
    // 次日续段（来自前一天跨午夜）
    const prev = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + i - 1);
    for (const ev of real.events) {
      if ((ev.type || 'once') === 'task') continue;
      if (TTOccur.occursOn(ev, prev) && toMin(ev.end) <= toMin(ev.start) && toMin(ev.end) > 0) expect++;
    }
    const banners = real.events.filter((ev) => (ev.type || 'once') === 'task' && ev.deadline === dstr).length;
    const got = collect(cols2[i], isBlock).length;
    const gotDue = collect(cols2[i], (el) => el.classList && el.classList.contains('wkDue')).length;
    if (got !== expect || gotDue !== banners) { mism++; console.log(`    [MISMATCH] 第${i + 1}列 块期望${expect}实得${got} 横幅期望${banners}实得${gotDue}`); }
  }
  check('七列块数/横幅数与独立口径逐列一致', mism === 0);
} else {
  console.log('  [SKIP] schedule.json 不存在（真实数据冒烟跳过）');
}

console.log(`\n横屏周视图\n  通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
