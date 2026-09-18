// landscape-week-test.mjs — 手机端横屏周视图回归测试。
// 覆盖：mobile.html 静态结构（#weekGrid 容器 + landscape 媒体查询显隐规则）、
// renderWeek 行为（七列周一..周日、复用 occur.js 判定、skip 生效、任务只在截止日列、
// today 列高亮、空列占位、chip 点击接 openDialog）、真实 schedule.json 冒烟（列内
// chip 数与 TTOccur 独立口径一致；不落任何真实数据到本文件）。
// 运行：node .qrtest/landscape-week-test.mjs
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { loadPage, collect } from './page-harness.mjs';

const require2 = createRequire(import.meta.url);
const TTOccur = require2('../occur.js');

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; console.log('  [OK] ' + name); } else { fail++; console.log('  [FAIL] ' + name); } };

// ---------- 1) mobile.html 静态结构 ----------
console.log('1) mobile.html 静态结构');
const html = readFileSync(new URL('../mobile.html', import.meta.url), 'utf8');
check('pageSched 内存在 #weekGrid 容器', /id="weekGrid"/.test(html));
check('存在 landscape 媒体查询', html.indexOf('@media (orientation: landscape)') !== -1);
const lm = html.match(/@media \(orientation: landscape\) \{[\s\S]*?\n    \}/);
check('横屏下隐藏单日列表 / 通知行 / 日期选择', !!lm && lm[0].indexOf('#list { display: none') !== -1 && lm[0].indexOf('#notifyRow') !== -1 && lm[0].indexOf('input[type="date"]') !== -1);
check('横屏下显示周视图容器', !!lm && lm[0].indexOf('#weekGrid { display: block') !== -1);
check('通知行有 id（横屏隐藏定位用）', /id="notifyRow"/.test(html));
check('周视图有深色模式适配', html.indexOf('.wkChip { background: rgba(255,255,255,.03)') !== -1);

// ---------- 测试事件（相对真实今天所在周构造） ----------
const pad = (n) => String(n).padStart(2, '0');
const fmt = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const today = new Date();
const mon = TTOccur.mondayOf(today);
const ds = (i) => fmt(new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + i));
const todayIdx = (today.getDay() + 6) % 7; // 0=周一
const events = [
  { id: 'w1', title: '周一早课', type: 'weekly', weekday: 1, start: '08:00', end: '09:35', deadline: '2027-01-17', color: '#4f8ef7' },
  { id: 'w3', title: '周三课', type: 'weekly', weekday: 3, start: '10:00', end: '11:35', deadline: '2027-01-17' },
  { id: 'o4', title: '周五考试', type: 'once', date: ds(4), start: '14:00', end: '16:00', deadline: ds(4) },
  { id: 'task5', title: '材料提交', type: 'task', deadline: ds(4) },
  { id: 'skip1', title: '停调课', type: 'weekly', weekday: 1, start: '12:00', end: '13:00', deadline: '2027-01-17', skip: [ds(0)] },
];

console.log('2) renderWeek 行为（合成周事件）');
const page = loadPage(new URL('../mobile.html', import.meta.url), {
  responses: { '/api/schedule': { events } },
});
await page.flush();

const grid = page.byId.weekGrid;
const isWkCol = (el) => el.classList && el.classList.contains('wkCol'); // 精确 token 匹配（wkCols 容器不算列）
const isChip = (el) => el.classList && el.classList.contains('wkChip');
const cols = collect(grid, isWkCol);
check('渲染出 7 列（周一..周日）', cols.length === 7);
check('列头顺序为 周一..周日', cols.map((c) => c.children[0].textContent.slice(0, 2)).join(',') === '周一,周二,周三,周四,周五,周六,周日');
check('列头带日期（如 ' + (mon.getMonth() + 1) + '/' + mon.getDate() + '）', cols[0].children[0].textContent.indexOf(mon.getMonth() + 1 + '/' + mon.getDate()) !== -1);
const chipsOf = (i) => collect(cols[i], isChip);
check('周一列：正常课在、skip 停调课不在', chipsOf(0).length === 1 && chipsOf(0)[0].textContent.indexOf('周一早课') !== -1);
check('周三列：周三课在，chip 带时段文本', chipsOf(2).length === 1 && chipsOf(2)[0].textContent.indexOf('10:00–11:35') !== -1);
check('周五列：考试 + 截止任务两条 chip', chipsOf(4).length === 2);
check('任务 chip 只在截止日列（周五），样式为 wkTask', chipsOf(4).some((c) => c.className.indexOf('wkTask') !== -1) && [0, 1, 2, 3, 5, 6].every((i) => !chipsOf(i).some((c) => c.className.indexOf('wkTask') !== -1)));
check('今日列高亮 today', cols[todayIdx].className.indexOf('today') !== -1 && cols[(todayIdx + 1) % 7].className.indexOf('today') === -1);
check('无日程列显示占位（—）', collect(cols[1], (el) => el.className === 'wkEmpty').length === 1);
check('chip 左色条用事件色', chipsOf(0)[0].style.borderLeftColor === '#4f8ef7');
check('chip 点击已接处理器（源码接线 openDialog；对话框本体与竖屏同一代码路径）',
  typeof chipsOf(0)[0].onclick === 'function' &&
  readFileSync(new URL('../mobile-app.js', import.meta.url), 'utf8').indexOf("c.onclick = function () { openDialog(ev); };") !== -1);
check('数据刷新再渲染不残留（二次 render 幂等）', (() => {
  const before = collect(grid, isChip).length;
  if (page.byId.datePick._ls && page.byId.datePick._ls.change) page.byId.datePick._ls.change();
  const after = collect(grid, isChip).length;
  return before === after && before > 0;
})());

console.log('3) 真实 schedule.json 冒烟（列内 chip 数与 TTOccur 独立口径一致；不落真实数据）');
if (existsSync(new URL('../schedule.json', import.meta.url))) {
  const real = JSON.parse(readFileSync(new URL('../schedule.json', import.meta.url), 'utf8'));
  const page2 = loadPage(new URL('../mobile.html', import.meta.url), {
    responses: { '/api/schedule': real },
  });
  await page2.flush();
  const cols2 = collect(page2.byId.weekGrid, isWkCol);
  check('真实数据：渲染 7 列不异常', cols2.length === 7);
  let mism = 0;
  for (let i = 0; i < 7; i++) {
    const d = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + i);
    const dstr = fmt(d);
    // 独立口径：有时刻的都算 + 仅截止日任务算
    const expect = real.events.filter((ev) => TTOccur.occursOn(ev, d)).filter((ev) => (ev.type || 'once') !== 'task' || ev.deadline === dstr).length;
    const got = collect(cols2[i], isChip).length;
    if (got !== expect) { mism++; console.log(`    [MISMATCH] 第${i + 1}列 期望${expect} 实得${got}`); }
  }
  check('七列 chip 数与独立口径逐列一致', mism === 0);
} else {
  console.log('  [SKIP] schedule.json 不存在（真实数据冒烟跳过）');
}

console.log(`\n横屏周视图\n  通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
