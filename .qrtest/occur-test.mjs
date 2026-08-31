// occur-test.mjs — 共享领域模块 occur.js 表驱动全量测试（≥25 例）
// 用法：node .qrtest/occur-test.mjs           → 跑断言
//      node .qrtest/occur-test.mjs --table    → 输出 occursOn 用例表 JSON（供 Python timetable_core 对拍）
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const TTOccur = require('../occur.js');

const D = (s) => { const p = String(s).split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); };

// —— occursOn 用例表：{ ev, day, want } ——
const occurTable = [
  // weekly 基本/边界
  { name: 'weekly 周一事件在周一发生', ev: { type: 'weekly', weekday: 1, start: '08:00', end: '09:00' }, day: '2026-09-14', want: true },
  { name: 'weekly 周一事件在周二不发生', ev: { type: 'weekly', weekday: 1, start: '08:00', end: '09:00' }, day: '2026-09-15', want: false },
  { name: 'weekly 边界 weekday=7 周日', ev: { type: 'weekly', weekday: 7, start: '08:00', end: '09:00' }, day: '2026-09-13', want: true },
  { name: 'weekly weekday 缺省按周一', ev: { type: 'weekly', start: '08:00', end: '09:00' }, day: '2026-09-14', want: true },
  { name: 'weekly deadline 当天仍发生（含当日）', ev: { type: 'weekly', weekday: 1, start: '08:00', end: '09:00', deadline: '2026-09-14' }, day: '2026-09-14', want: true },
  { name: 'weekly deadline 次日不再发生', ev: { type: 'weekly', weekday: 1, start: '08:00', end: '09:00', deadline: '2026-09-14' }, day: '2026-09-21', want: false },
  // once
  { name: 'once 当日发生', ev: { type: 'once', date: '2026-08-28', start: '09:00', end: '11:00' }, day: '2026-08-28', want: true },
  { name: 'once 其他日不发生', ev: { type: 'once', date: '2026-08-28', start: '09:00', end: '11:00' }, day: '2026-08-29', want: false },
  { name: 'once type 缺省按 once 处理', ev: { date: '2026-08-28', start: '09:00', end: '11:00' }, day: '2026-08-28', want: true },
  { name: 'once deadline 早于 date → 当日不发生', ev: { type: 'once', date: '2026-08-28', start: '09:00', end: '11:00', deadline: '2026-08-27' }, day: '2026-08-28', want: false },
  // custom × day
  { name: 'custom day 起始日发生', ev: { type: 'custom', start: '19:00', end: '20:00', repeat: { interval: 2, unit: 'day', start: '2026-08-24' } }, day: '2026-08-24', want: true },
  { name: 'custom day interval=2 第 1 天不发生', ev: { type: 'custom', start: '19:00', end: '20:00', repeat: { interval: 2, unit: 'day', start: '2026-08-24' } }, day: '2026-08-25', want: false },
  { name: 'custom day interval=2 第 2 天发生', ev: { type: 'custom', start: '19:00', end: '20:00', repeat: { interval: 2, unit: 'day', start: '2026-08-24' } }, day: '2026-08-26', want: true },
  { name: 'custom 早于 repeat.start 不发生', ev: { type: 'custom', start: '19:00', end: '20:00', repeat: { interval: 1, unit: 'day', start: '2026-08-24' } }, day: '2026-08-23', want: false },
  { name: 'custom until 当日发生（含当日）', ev: { type: 'custom', start: '19:00', end: '20:00', repeat: { interval: 1, unit: 'day', start: '2026-08-24', until: '2026-08-26' } }, day: '2026-08-26', want: true },
  { name: 'custom until 次日不发生', ev: { type: 'custom', start: '19:00', end: '20:00', repeat: { interval: 1, unit: 'day', start: '2026-08-24', until: '2026-08-26' } }, day: '2026-08-27', want: false },
  // custom × week
  { name: 'custom week 无 days：起始周几当日发生', ev: { type: 'custom', start: '19:00', end: '20:00', repeat: { interval: 1, unit: 'week', start: '2026-08-24' } }, day: '2026-08-24', want: true }, // 08-24=周一
  { name: 'custom week 无 days：次周同一天发生', ev: { type: 'custom', start: '19:00', end: '20:00', repeat: { interval: 1, unit: 'week', start: '2026-08-24' } }, day: '2026-08-31', want: true },
  { name: 'custom week 无 days：不同周几不发生', ev: { type: 'custom', start: '19:00', end: '20:00', repeat: { interval: 1, unit: 'week', start: '2026-08-24' } }, day: '2026-08-25', want: false },
  { name: 'custom week days=[1,3,5]：周一发生', ev: { type: 'custom', start: '19:00', end: '20:00', repeat: { interval: 1, unit: 'week', days: [1, 3, 5], start: '2026-08-24' } }, day: '2026-08-24', want: true },
  { name: 'custom week days=[1,3,5]：周二不发生', ev: { type: 'custom', start: '19:00', end: '20:00', repeat: { interval: 1, unit: 'week', days: [1, 3, 5], start: '2026-08-24' } }, day: '2026-08-25', want: false },
  { name: 'custom week interval=2：第 2 周不发生', ev: { type: 'custom', start: '19:00', end: '20:00', repeat: { interval: 2, unit: 'week', days: [1], start: '2026-08-24' } }, day: '2026-08-31', want: false },
  { name: 'custom week interval=2：第 4 周发生', ev: { type: 'custom', start: '19:00', end: '20:00', repeat: { interval: 2, unit: 'week', days: [1], start: '2026-08-24' } }, day: '2026-09-21', want: true },
  // custom × month
  { name: 'custom month 同几号发生', ev: { type: 'custom', start: '19:00', end: '20:00', repeat: { interval: 1, unit: 'month', start: '2026-08-24' } }, day: '2026-09-24', want: true },
  { name: 'custom month 不同日不发生', ev: { type: 'custom', start: '19:00', end: '20:00', repeat: { interval: 1, unit: 'month', start: '2026-08-24' } }, day: '2026-09-25', want: false },
  { name: 'custom month interval=2：第 2 个月不发生', ev: { type: 'custom', start: '19:00', end: '20:00', repeat: { interval: 2, unit: 'month', start: '2026-08-24' } }, day: '2026-09-24', want: false },
  { name: 'custom month interval=2：第 4 个月发生', ev: { type: 'custom', start: '19:00', end: '20:00', repeat: { interval: 2, unit: 'month', start: '2026-08-24' } }, day: '2026-10-24', want: true },
  { name: 'custom month 起始 31 号在 9 月（30 天）自然跳过', ev: { type: 'custom', start: '19:00', end: '20:00', repeat: { interval: 1, unit: 'month', start: '2026-08-31' } }, day: '2026-09-30', want: false },
  // 跨午夜（end < start）与 deadline 组合
  { name: '跨午夜事件（23:00–01:00）在开始日发生', ev: { type: 'weekly', weekday: 1, start: '23:00', end: '01:00' }, day: '2026-09-14', want: true },
  { name: 'custom + deadline 截止组合：截止前发生', ev: { type: 'custom', start: '19:00', end: '20:00', deadline: '2026-08-30', repeat: { interval: 2, unit: 'day', start: '2026-08-24' } }, day: '2026-08-28', want: true },
  { name: 'custom + deadline 截止组合：截止后不发生', ev: { type: 'custom', start: '19:00', end: '20:00', deadline: '2026-08-27', repeat: { interval: 2, unit: 'day', start: '2026-08-24' } }, day: '2026-08-28', want: false },
];

// —— leadMinutes / parseHHMM 用例表 ——
const leadTable = [
  { name: 'lead 缺失 → 默认 20', ev: {}, def: undefined, want: 20 },
  { name: 'lead 缺失 → 自定义 def 30', ev: {}, def: 30, want: 30 },
  { name: 'lead 显式 0 保留为 0（不提醒）', ev: { remindLead: 0 }, def: undefined, want: 0 },
  { name: 'lead=5 保留', ev: { remindLead: 5 }, def: 20, want: 5 },
  { name: 'lead 数字字符串 "10" → 10', ev: { remindLead: '10' }, def: 20, want: 10 },
  { name: 'lead 负数 → 默认', ev: { remindLead: -3 }, def: 20, want: 20 },
  { name: 'lead 非数字 → 默认', ev: { remindLead: 'abc' }, def: 20, want: 20 },
  { name: 'lead NaN → 默认', ev: { remindLead: NaN }, def: 20, want: 20 },
  { name: 'lead bool → 默认', ev: { remindLead: true }, def: 20, want: 20 },
];

const parseTable = [
  { name: 'parseHHMM 08:05 → 485', got: TTOccur.parseHHMM('08:05'), want: 485 },
  { name: 'parseHHMM 0:0 → 0', got: TTOccur.parseHHMM('0:0'), want: 0 },
  { name: 'parseHHMM 空/缺省 → 0', got: TTOccur.parseHHMM(undefined), want: 0 },
];

// —— validateEvent / validateSchedule 用例 ——
const goodEvent = { id: 'e1', title: '高数', type: 'weekly', weekday: 1, start: '08:00', end: '09:40', deadline: '2027-01-17' };
const validateCases = [
  { name: '合法 weekly 通过', ev: goodEvent, wantErr: 0 },
  { name: 'custom 缺 repeat 报错（历史踩坑：不渲染）', ev: { type: 'custom', title: '锻炼', start: '19:00', end: '20:00' }, wantErr: 1 },
  { name: 'title 缺空报错', ev: { type: 'once', date: '2026-08-28', start: '09:00', end: '10:00', title: '  ' }, wantErr: 1 },
  { name: 'once 缺 date 报错', ev: { type: 'once', title: '考试', start: '09:00', end: '10:00' }, wantErr: 1 },
  { name: 'once 非真实日历日期报错（2-30）', ev: { type: 'once', title: '考试', date: '2026-02-30', start: '09:00', end: '10:00' }, wantErr: 1 },
  { name: 'type 非法报错', ev: { type: 'daily', title: 'X', start: '09:00', end: '10:00' }, wantErr: 1 },
  { name: 'start 格式非法报错（25:00）', ev: { type: 'once', title: 'X', date: '2026-08-28', start: '25:00', end: '10:00' }, wantErr: 1 },
  { name: 'end == start 报错', ev: { type: 'once', title: 'X', date: '2026-08-28', start: '09:00', end: '09:00' }, wantErr: 1 },
  { name: 'end < start（跨午夜一段）合法', ev: { type: 'once', title: '夜班', date: '2026-08-28', start: '23:00', end: '01:00' }, wantErr: 0 },
  { name: 'weekly weekday 越界报错（8）', ev: { type: 'weekly', title: 'X', weekday: 8, start: '08:00', end: '09:00' }, wantErr: 1 },
  { name: 'custom repeat.interval=0 报错', ev: { type: 'custom', title: 'X', start: '19:00', end: '20:00', repeat: { interval: 0, unit: 'day', start: '2026-08-24' } }, wantErr: 1 },
  { name: 'custom repeat.unit 非法报错', ev: { type: 'custom', title: 'X', start: '19:00', end: '20:00', repeat: { interval: 1, unit: 'year', start: '2026-08-24' } }, wantErr: 1 },
  { name: 'deadline 格式非法报错', ev: { type: 'weekly', title: 'X', weekday: 1, start: '08:00', end: '09:00', deadline: '2027/01/17' }, wantErr: 1 },
  { name: 'remindLead 负数报错', ev: { type: 'weekly', title: 'X', weekday: 1, start: '08:00', end: '09:00', remindLead: -5 }, wantErr: 1 },
];

// —— 对拍模式：输出 occursOn 用例表 JSON（day 转 ISO 串；Python 侧 timetable_core.occurs_on 同表跑） ——
if (process.argv.includes('--table')) {
  console.log(JSON.stringify(occurTable.map((c) => ({ name: c.name, ev: c.ev, day: c.day, want: c.want }))));
  process.exit(0);
}

let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (ok ? '' : ` -> got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
}

console.log('1) occursOn 表驱动（' + occurTable.length + ' 例）');
for (const c of occurTable) t(c.name, TTOccur.occursOn(c.ev, D(c.day)), c.want);

console.log('2) leadMinutes 表驱动（' + leadTable.length + ' 例）');
for (const c of leadTable) t(c.name, TTOccur.leadMinutes(c.ev, c.def), c.want);

console.log('3) parseHHMM（' + parseTable.length + ' 例）');
for (const c of parseTable) t(c.name, c.got, c.want);

console.log('4) validateEvent（' + validateCases.length + ' 例）');
for (const c of validateCases) {
  const errs = TTOccur.validateEvent(c.ev);
  t(c.name + (errs.length && c.wantErr ? '（' + errs[0] + '）' : ''), errs.length > 0 ? 'ERR' : 'OK', c.wantErr > 0 ? 'ERR' : 'OK');
}

console.log('5) validateSchedule');
t('合法数据 0 问题', TTOccur.validateSchedule({ meta: {}, events: [goodEvent] }).length, 0);
t('坏事件 1 问题（带索引）', (() => {
  const p = TTOccur.validateSchedule({ events: [goodEvent, { type: 'custom', title: '坏', start: '19:00', end: '20:00' }] });
  return p.length === 1 && p[0].index === 1 && p[0].errors.length >= 1;
})(), true);
t('events 非数组报错', TTOccur.validateSchedule({ events: 'x' }).length >= 1, true);
t('顶层非对象报错', TTOccur.validateSchedule(null).length >= 1, true);

const total = pass + fail;
console.log(`\noccur.js + 用例表\n  通过 ${pass} / 失败 ${fail}（共 ${total}）`);
process.exit(fail ? 1 : 0);
