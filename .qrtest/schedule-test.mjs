// schedule-test.mjs — schedule.html 回归测试（F-1：补齐评审报告指出的第一大盲区 E1）。
// 用法：node .qrtest/schedule-test.mjs（在仓库根执行）
// 覆盖：saveEdit 类型切换字段清理/必填校验、deadline 推导（once=当日、custom=repeat.until）、
//       新建模式（btnNew/双击空白格、id 生成与撞号）、occursOn 单一实现引用（无本地拷贝）、
//       坏事件跳过（custom 缺 repeat 不渲染 + 黄条计数 + 不写文件）、
//       weekPattern 单双周 / skip 例外日期 / termStart 教学周徽标、备份冲突面板。
import { readFileSync } from 'node:fs';
import { loadPage, PAGE_PATH } from './schedule-harness.mjs';

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' | ' + extra : '')); }
};
const section = (name) => console.log('\n' + name);

// —— 测试用日期基准（全部相对"今天"构造，任何一天跑都成立） ——
const pad2 = (n) => String(n).padStart(2, '0');
const fmtDate = (d) => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
const isoWeekday = (d) => (d.getDay() + 6) % 7 + 1; // 周一=1 … 周日=7
const NOW = new Date();
const TODAY = fmtDate(NOW);
const WD = isoWeekday(NOW); // 今天是周几
const MONDAY = fmtDate((() => { const x = new Date(NOW); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; })()); // 本周周一
// 「当天必渲染」的 weekly 事件（weekday=今天的周几）
const weeklyToday = (id, title, extra) => Object.assign({ id, title, type: 'weekly', weekday: WD, start: '19:00', end: '20:00' }, extra || {});

// ========== 1) saveEdit：类型切换字段清理 + 必填校验 ==========
section('1) saveEdit 类型切换（核心历史回归区）');
{
  const h = loadPage({ schedule: { meta: {}, events: [
    Object.assign(weeklyToday('x1', '切换测试'), { date: '2026-09-02', repeat: { interval: 2, unit: 'day', start: '2026-09-01' } }), // 带残留 junk 字段
  ] } });
  await h.flush(); await h.flush();
  const el = h.eventsOnGrid().find((e) => e.textContent.indexOf('切换测试') > -1);
  check('weekly 事件（带 junk 字段）正常渲染', !!el);
  el.ondblclick();
  check('双击事件打开编辑器', h.byId.editorPanel.style.display === 'block');
  check('weekly：重复星期显示、日期/间隔隐藏（edSyncVisibility）',
    h.byId.ewWrap.style.display === '' && h.byId.edWrap.style.display === 'none' && h.byId.eiWrap.style.display === 'none');

  const writes0 = h.writes.length;
  h.byId.eName.value = '';
  h.byId.btnSaveEdit.onclick();
  check('必填：名称为空拒绝保存（编辑器保持打开）',
    h.byId.edMsg.textContent.indexOf('名称不能为空') > -1 && h.byId.editorPanel.style.display === 'block' && h.writes.length === writes0);

  h.byId.eName.value = '切换测试'; h.byId.eStart.value = '09:00'; h.byId.eEnd.value = '09:00';
  h.byId.btnSaveEdit.onclick();
  check('必填：结束=开始拒绝保存', h.byId.edMsg.textContent.indexOf('不能等于') > -1 && h.writes.length === writes0);

  h.byId.eEnd.value = '10:00'; h.byId.eType.value = 'once'; h.byId.eDate.value = '';
  h.byId.btnSaveEdit.onclick();
  check('必填：once 缺日期拒绝保存', h.byId.edMsg.textContent.indexOf('一次性事件的日期') > -1 && h.writes.length === writes0);

  h.byId.eDate.value = '2026-12-25'; h.byId.eDeadline.value = '';
  h.byId.btnSaveEdit.onclick(); await h.flush(); await h.flush();
  const ev = h.getSchedule().events.find((e) => e.id === 'x1');
  check('weekly→once：date 写入、weekday/repeat/残留 date 全部清理',
    ev.type === 'once' && ev.date === '2026-12-25' && !('weekday' in ev) && !('repeat' in ev));
  check('deadline 推导：once 留空 = 事件当日', ev.deadline === '2026-12-25');
  check('保存经 /api/worktable/write 写回 schedule.json',
    h.writes.length === writes0 + 1 && h.writes[h.writes.length - 1].path === 'schedule.json');
}
{
  const h = loadPage({ schedule: { meta: {}, events: [Object.assign(weeklyToday('x2', '间隔测试'), { date: '2026-09-02' })] } });
  await h.flush(); await h.flush();
  h.eventsOnGrid().find((e) => e.textContent.indexOf('间隔测试') > -1).ondblclick();
  h.byId.eType.value = 'custom'; h.byId.eType.onchange();
  check('切到 custom：间隔/单位/起始日期显示', h.byId.eiWrap.style.display === '' && h.byId.euWrap.style.display === '' && h.byId.ersWrap.style.display === '');
  h.byId.eUnit.value = 'week'; h.byId.eUnit.onchange();
  check('unit=week：星期勾选区显示', h.byId.edaysWrap.style.display === '');
  h.byId.eInterval.value = '1'; h.byId.eRStart.value = '';
  h.byId.btnSaveEdit.onclick();
  check('必填：custom 缺重复起始日期拒绝保存', h.byId.edMsg.textContent.indexOf('重复起始日期') > -1 && h.writes.length === 0);
  h.byId.eRStart.value = MONDAY;
  h.byId.btnSaveEdit.onclick();
  check('必填：按周重复未勾选任何星期拒绝保存', h.byId.edMsg.textContent.indexOf('至少勾选一个星期') > -1 && h.writes.length === 0);
  h.checkDays([1, 3]);
  h.byId.btnSaveEdit.onclick(); await h.flush(); await h.flush();
  const ev = h.getSchedule().events.find((e) => e.id === 'x2');
  check('weekly→custom(week)：repeat={interval,unit,days,start} 且 junk date/weekday 清理',
    ev.type === 'custom' && ev.repeat.unit === 'week' && ev.repeat.interval === 1 && ev.repeat.start === MONDAY
    && JSON.stringify(ev.repeat.days) === '[1,3]' && !('date' in ev) && !('weekday' in ev));
  check('custom 无 until：deadline 留空即清除', !('deadline' in ev));
}
{
  // custom 带_until 渲染于今天 → 编辑保留 until，deadline 缺省对齐 until（项目写入约定）
  const h = loadPage({ schedule: { meta: {}, events: [
    { id: 'x3', title: '对齐测试', type: 'custom', start: '10:00', end: '11:00', weekday: 5, date: '2026-01-01',
      repeat: { interval: 1, unit: 'week', days: [WD], start: MONDAY, until: '2026-12-31' } },
  ] } });
  await h.flush(); await h.flush();
  h.eventsOnGrid().find((e) => e.textContent.indexOf('对齐测试') > -1).ondblclick();
  h.byId.eInterval.value = '5'; h.byId.eDeadline.value = '';
  h.byId.btnSaveEdit.onclick(); await h.flush(); await h.flush();
  const ev = h.getSchedule().events.find((e) => e.id === 'x3');
  check('custom 编辑保留 repeat.until 且 interval 更新', ev.repeat.until === '2026-12-31' && ev.repeat.interval === 5);
  check('deadline 推导：custom 留空 = repeat.until', ev.deadline === '2026-12-31');
  check('junk weekday/date 清理', !('weekday' in ev) && !('date' in ev));
}
{
  // custom→weekly：repeat/date/deadline 全清
  const h = loadPage({ schedule: { meta: {}, events: [
    { id: 'x4', title: '回收测试', type: 'custom', start: '10:00', end: '11:00',
      repeat: { interval: 1, unit: 'week', days: [WD], start: MONDAY, until: '2026-12-31' } },
  ] } });
  await h.flush(); await h.flush();
  h.eventsOnGrid().find((e) => e.textContent.indexOf('回收测试') > -1).ondblclick();
  h.byId.eType.value = 'weekly'; h.byId.eWeekday.value = '4'; h.byId.eDeadline.value = '';
  h.byId.btnSaveEdit.onclick(); await h.flush(); await h.flush();
  const ev = h.getSchedule().events.find((e) => e.id === 'x4');
  check('custom→weekly：weekday 写入、repeat/date/deadline 清理',
    ev.type === 'weekly' && ev.weekday === 4 && !('repeat' in ev) && !('date' in ev) && !('deadline' in ev));
}

// ========== 2) 新建模式（btnNew + id 生成/撞号） ==========
section('2) 新建模式：必填校验 + id 生成');
{
  const h = loadPage({ schedule: { meta: {}, events: [] } });
  await h.flush(); await h.flush();
  h.byId.btnNew.onclick();
  check('btnNew：编辑器打开、标题为新建、删除按钮隐藏',
    h.byId.editorPanel.style.display === 'block' && h.byId.edHead.textContent.indexOf('新建') > -1 && h.byId.btnDeleteEdit.style.display === 'none');
  h.byId.eName.value = '';
  h.byId.btnSaveEdit.onclick();
  check('新建必填：空名称不入列、不写文件', h.getSchedule().events.length === 0 && h.writes.length === 0);
  h.byId.eName.value = 'Study English'; h.byId.eType.value = 'once'; h.byId.eDate.value = TODAY;
  h.byId.eStart.value = '09:00'; h.byId.eEnd.value = '10:00'; h.byId.eLead.value = '15';
  h.byId.btnSaveEdit.onclick(); await h.flush(); await h.flush();
  const ev1 = h.getSchedule().events[0];
  check('新建保存：push 入列 + evt-<slug>-<MMDD> id', h.getSchedule().events.length === 1 && /^evt-study-english-/.test(ev1.id));
  check('新建保存：remindLead 写入、once deadline=当日', ev1.remindLead === 15 && ev1.deadline === TODAY);
  h.byId.btnNew.onclick();
  h.byId.eName.value = 'Study English'; h.byId.eType.value = 'once'; h.byId.eDate.value = TODAY;
  h.byId.eStart.value = '11:00'; h.byId.eEnd.value = '12:00';
  h.byId.btnSaveEdit.onclick(); await h.flush(); await h.flush();
  const ev2 = h.getSchedule().events[1];
  check('同日同名新建：id 撞号自动加后缀 -2', !!ev2 && /evt-study-english-\d+-2$/.test(ev2.id));
  check('两次新建均写回文件', h.writes.length === 2);
}

// ========== 3) 双击空白格新建（预填时段） ==========
section('3) 双击空白格新建');
{
  const h = loadPage({ schedule: { meta: {}, events: [] } });
  await h.flush(); await h.flush();
  const bodyRow = h.grid.children.find((e) => e.classList.contains('tt-bodyrow'));
  const todayCell = bodyRow.children[WD]; // children[0]=gutter，之后 7 列（周一起）
  todayCell.ondblclick({ target: {} }); // getBoundingClientRect 缺失走兜底：mins=本列 rStart（空表自动 480）
  check('双击空白格：以 once 新建、日期=该列日期', h.byId.editorPanel.style.display === 'block' && h.byId.eType.value === 'once' && h.byId.eDate.value === TODAY);
  check('双击空白格：start 30 分钟对齐预填（空表 08:00–09:00）', h.byId.eStart.value === '08:00' && h.byId.eEnd.value === '09:00');
  h.byId.btnCancelEdit.onclick();
  check('取消新建：不入列、不写文件', h.getSchedule().events.length === 0 && h.writes.length === 0);
}

// ========== 4) occursOn 单一实现引用（无本地拷贝） ==========
section('4) occursOn 单一实现引用');
{
  const src = readFileSync(PAGE_PATH, 'utf8');
  check('页面无 function occursOn 本地定义、经 TTOccur 引用共享模块',
    !/function\s+occursOn\s*\(/.test(src) && src.indexOf('TTOccur.occursOn') > -1);
  const h = loadPage({ schedule: { meta: {}, events: [
    Object.assign(weeklyToday('s1', '停课日'), { skip: [TODAY] }),
    weeklyToday('s2', '正常课'),
  ] } });
  await h.flush(); await h.flush();
  const titles = h.eventsOnGrid().map((e) => e.textContent);
  check('skip 例外日期当日不渲染（occur.js 语义真跑通）',
    titles.some((t) => t.indexOf('正常课') > -1) && !titles.some((t) => t.indexOf('停课日') > -1));
}

// ========== 5) 坏事件跳过渲染（P1-2 渲染前校验） ==========
section('5) 坏事件跳过 + 黄条提示');
{
  const h = loadPage({ schedule: { meta: {}, events: [
    weeklyToday('g1', '好事件'),
    { id: 'b1', title: '缺repeat', type: 'custom', start: '10:00', end: '11:00' }, // 历史线上事故原样
    { id: 'b2', title: '', type: 'weekly', weekday: 1, start: '08:00', end: '09:00' }, // 缺 title
  ] } });
  await h.flush(); await h.flush();
  check('黄条显示且计数 2 条', h.byId.badEventsPanel.style.display === 'block' && h.byId.badEventsText.textContent.indexOf('2 条') > -1);
  const titles = h.eventsOnGrid().map((e) => e.textContent);
  check('好事件正常渲染', titles.some((t) => t.indexOf('好事件') > -1));
  check('custom 缺 repeat 不渲染（历史回归点被拦截）', !titles.some((t) => t.indexOf('缺repeat') > -1));
  check('渲染期校验不写数据文件', h.writes.length === 0);
  check('console.warn 记录跳过明细（2 条）', h.warns.length === 2);
}

// ========== 6) weekPattern 单双周 / termStart 教学周 ==========
section('6) weekPattern 单双周 / termStart 徽标');
{
  const h = loadPage({ schedule: { meta: { termStart: MONDAY }, events: [
    Object.assign(weeklyToday('w1', '单周课'), { weekPattern: { start: MONDAY, odd: true } }),
  ] } });
  await h.flush(); await h.flush();
  check('termStart 徽标：第 1 教学周', h.byId.termBadge.style.display === '' && h.byId.termBadge.textContent === '第 1 教学周');
  check('odd 单周：第 1 周渲染', h.eventsOnGrid().some((e) => e.textContent.indexOf('单周课') > -1));
  h.byId.btnNext.onclick();
  check('odd 单周：第 2 周不渲染', !h.eventsOnGrid().some((e) => e.textContent.indexOf('单周课') > -1));
  h.byId.btnPrev.onclick(); h.byId.btnPrev.onclick(); // 回第 1 周再回开学前一周
  check('开学前一周不渲染（diff<0）', !h.eventsOnGrid().some((e) => e.textContent.indexOf('单周课') > -1));
  h.byId.btnToday.onclick();
  check('回到本周恢复渲染', h.eventsOnGrid().some((e) => e.textContent.indexOf('单周课') > -1));
}
{
  const h = loadPage({ schedule: { meta: { termStart: MONDAY }, events: [
    Object.assign(weeklyToday('w2', '双周课'), { weekPattern: { start: MONDAY, odd: false } }),
  ] } });
  await h.flush(); await h.flush();
  check('odd 双周：第 1 周不渲染', !h.eventsOnGrid().some((e) => e.textContent.indexOf('双周课') > -1));
  h.byId.btnNext.onclick();
  check('odd 双周：第 2 周渲染', h.eventsOnGrid().some((e) => e.textContent.indexOf('双周课') > -1));
}
{
  const h = loadPage({ schedule: { meta: {}, events: [weeklyToday('w3', '无学期')] } });
  await h.flush(); await h.flush();
  check('未配置 termStart：徽标隐藏', h.byId.termBadge.style.display === 'none');
}

// ========== 7) 备份冲突面板（写回失败 → 本地备份） ==========
section('7) 备份冲突面板');
{
  const h = loadPage({ schedule: { meta: {}, events: [weeklyToday('f1', '文件版')] },
    backup: { meta: {}, events: [weeklyToday('f1', '备份版')] } });
  await h.flush(); await h.flush();
  check('备份与文件不同：冲突面板弹出', h.byId.backupPanel.style.display === 'block');
  const titles = h.eventsOnGrid().map((e) => e.textContent);
  check('冲突期先渲染文件版', titles.some((t) => t.indexOf('文件版') > -1) && !titles.some((t) => t.indexOf('备份版') > -1));
  h.byId.btnKeepFile.onclick();
  check('保留文件：面板收起、备份清除、不写文件',
    h.byId.backupPanel.style.display === 'none' && !('tt-schedule-backup' in h.store) && h.writes.length === 0);
}
{
  const h = loadPage({ schedule: { meta: {}, events: [weeklyToday('f2', '文件版2')] },
    backup: { meta: {}, events: [weeklyToday('f2', '备份版2')] } });
  await h.flush(); await h.flush();
  h.byId.btnUseBackup.onclick(); await h.flush(); await h.flush();
  const written = h.writes.length === 1 ? JSON.parse(h.writes[0].content) : null;
  check('使用备份：写回文件且渲染备份版',
    !!written && written.events[0].title === '备份版2' && h.eventsOnGrid().some((e) => e.textContent.indexOf('备份版2') > -1));
}

console.log(`\nschedule.html\n  通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
