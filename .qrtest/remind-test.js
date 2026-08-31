// 提醒判定逻辑回环测试：leadOf/evKey/reminderCandidates 从页面主脚本原样提取执行
// （主脚本已抽离为外链 mobile-app.js；mobile.html 仅余 <script src> 引用，找不到时回退旧内联）；
// 领域判定（occursOn/leadMinutes 底层）走共享模块 occur.js 单一实现——测试不再自带 occursOn 拷贝
// （历史教训：本文件曾内嵌一份漏了 deadline 截止判定的过期拷贝，与页面行为漂移）。
const fs = require('fs');
const TTOccur = require('../occur.js');
const src = fs.existsSync('mobile-app.js')
  ? fs.readFileSync('mobile-app.js', 'utf8')
  : fs.readFileSync('mobile.html', 'utf8');
const start = src.indexOf('function leadOf');
const end = src.indexOf('function showReminder');
if (start < 0 || end < 0) { console.log('EXTRACT FAILED'); process.exit(1); }
const block = src.slice(start, end);

const fmtDate = TTOccur.fmtDate;
const toMin = TTOccur.parseHHMM;
const isoWeekday = TTOccur.isoWeekday;
const occursOn = TTOccur.occursOn;

const store = {};
const localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
};

const ctx = { data: null, REMIND_OVERRIDE: null, REMIND_DEFAULT: 20, localStorage, fmtDate, toMin, occursOn, TTOccur, parseFloat, isFinite, Date, JSON };
const fn = new Function(...Object.keys(ctx), block + '\nreturn { leadOf, evKey, reminderCandidates };');
// 参数按值拷贝：每次调用重新绑定最新的 ctx 状态
function api() { return fn(...Object.values(ctx)); }

const now = new Date();
const hm = (offsetMin) => { const d = new Date(now.getTime() + offsetMin * 60000); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
const ds = fmtDate(now);
let pass = 0, fail = 0;
function t(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + name + (ok ? '' : ` -> got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
}
const cand = () => api().reminderCandidates(now);

// 1. 默认 20 分钟：+21min 未到点，+19min 到点
ctx.data = { events: [{ id: 'a', title: 'A', type: 'once', date: ds, start: hm(21), end: hm(22) }] };
t('lead default = 20', api().leadOf(ctx.data.events[0]), 20);
t('+21min not yet', cand().length, 0);
ctx.data.events[0].start = hm(19); ctx.data.events[0].end = hm(20);
const c1 = cand();
t('+19min fires', c1.length === 1 && c1[0].ev.id === 'a', true);

// 2. remindLead=0 不提醒
ctx.data = { events: [{ id: 'b', type: 'once', date: ds, start: hm(15), end: hm(16), remindLead: 0 }] };
t('lead 0 never', cand().length, 0);

// 3. remindLead=5：事件在 3 分钟后开始（处于 [start-5, start) 窗口内）→ 触发
ctx.data = { events: [{ id: 'c', type: 'once', date: ds, start: hm(3), end: hm(8), remindLead: 5 }] };
t('lead 5 fires (event +3min)', cand().length, 1);

// 4. 已弹过（fired）不再弹；改期后（start 变）键变、重新可弹
ctx.data = { events: [{ id: 'd', type: 'once', date: ds, start: hm(10), end: hm(11) }] };
const key1 = api().evKey(ctx.data.events[0], now);
store['tt-remind-state'] = JSON.stringify({ fired: { [key1]: Date.now() }, snooze: {} });
t('fired no refire', cand().length, 0);
ctx.data.events[0].start = hm(12); ctx.data.events[0].end = hm(13);
t('rescheduled refires', cand().length, 1);

// 5. 取消（事件删除）→ 不弹
ctx.data = { events: [] };
t('cancelled no fire', cand().length, 0);

// 6. 小睡中不弹，小睡过期可弹
ctx.data = { events: [{ id: 'e', type: 'once', date: ds, start: hm(8), end: hm(9) }] };
const keyE = api().evKey(ctx.data.events[0], now);
store['tt-remind-state'] = JSON.stringify({ fired: {}, snooze: { [keyE]: Date.now() + 60000 } });
t('snoozing no fire', cand().length, 0);
store['tt-remind-state'] = JSON.stringify({ fired: {}, snooze: { [keyE]: Date.now() - 1000 } });
t('snooze expired fires', cand().length, 1);

// 7. 每周事件按当天发生判定
ctx.data = { events: [{ id: 'f', title: 'F每周', type: 'weekly', weekday: isoWeekday(now), start: hm(3), end: hm(4) }] };
t('weekly today fires', cand().length, 1);
ctx.data = { events: [{ id: 'g', title: 'G每周', type: 'weekly', weekday: ((isoWeekday(now) + 1) % 7) + 1, start: hm(3), end: hm(4) }] };
t('weekly other-day no fire', cand().length, 0);

// 8. 已开始的事件（打开页面晚了）不弹
ctx.data = { events: [{ id: 'h', type: 'once', date: ds, start: hm(-30), end: hm(20) }] };
t('already started no fire', cand().length, 0);

// 9. deadline 已过期（昨天截止）→ 即使 weekly 命中今天也不提醒（共享模块 occursOn 判定，防副本漂移回归）
const yesterday = fmtDate(new Date(now.getTime() - 864e5));
ctx.data = { events: [{ id: 'i', title: 'I过期课', type: 'weekly', weekday: isoWeekday(now), start: hm(3), end: hm(4), deadline: yesterday }] };
t('deadline expired no fire', cand().length, 0);

// 10. deadline 当天（含当日截止）→ 仍提醒
ctx.data = { events: [{ id: 'j', title: 'J今日截止', type: 'weekly', weekday: isoWeekday(now), start: hm(3), end: hm(4), deadline: ds }] };
t('deadline today still fires', cand().length, 1);

store['tt-remind-state'] = JSON.stringify({ fired: {}, snooze: {} });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
