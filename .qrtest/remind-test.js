// 提醒判定逻辑回环测试：从 mobile.html 提取 leadOf/evKey/reminderCandidates 原样执行
const fs = require('fs');
const src = fs.readFileSync('mobile.html', 'utf8');
const start = src.indexOf('function leadOf');
const end = src.indexOf('function showReminder');
if (start < 0 || end < 0) { console.log('EXTRACT FAILED'); process.exit(1); }
const block = src.slice(start, end);

function pad(n) { return String(n).padStart(2, '0'); }
function fmtDate(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function toMin(hhmm) { var p = String(hhmm || '0:0').split(':'); return (+p[0]) * 60 + (+p[1] || 0); }
function isoWeekday(d) { return (d.getDay() + 6) % 7 + 1; }
function parseDate(s) { var p = String(s).split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); }
function occursOn(ev, day) {
  var ds = fmtDate(day);
  var type = ev.type || 'once';
  if (type === 'weekly') return isoWeekday(day) === (ev.weekday || 1);
  if (type === 'once') return ev.date === ds;
  if (type === 'custom') {
    var r = ev.repeat || {};
    if (!r.start) return false;
    if (ds < r.start) return false;
    if (r.until && ds > r.until) return false;
    var s = parseDate(r.start);
    var diffDays = Math.round((day - s) / 86400000);
    if (diffDays < 0) return false;
    var interval = Math.max(1, parseInt(r.interval, 10) || 1);
    var unit = r.unit || 'day';
    if (unit === 'day') return diffDays % interval === 0;
    if (unit === 'week') {
      var weekDiff = Math.floor(diffDays / 7);
      if (weekDiff % interval !== 0) return false;
      if (Array.isArray(r.days) && r.days.length) return r.days.indexOf(isoWeekday(day)) !== -1;
      return isoWeekday(day) === isoWeekday(s);
    }
    if (unit === 'month') {
      var months = (day.getFullYear() - s.getFullYear()) * 12 + (day.getMonth() - s.getMonth());
      if (months % interval !== 0) return false;
      return day.getDate() === s.getDate();
    }
  }
  return false;
}
const store = {};
const localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
};

const ctx = { data: null, REMIND_OVERRIDE: null, REMIND_DEFAULT: 20, localStorage, fmtDate, toMin, occursOn, parseFloat, isFinite, Date, JSON };
const fn = new Function(...Object.keys(ctx), block + '\nreturn { leadOf, evKey, reminderCandidates };');
// 参数按值拷贝：每次调用重新绑定最新的 ctx 状态
function api() { return fn(...Object.values(ctx)); }

const now = new Date();
const hm = (offsetMin) => { const d = new Date(now.getTime() + offsetMin * 60000); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
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

store['tt-remind-state'] = JSON.stringify({ fired: {}, snooze: {} });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
