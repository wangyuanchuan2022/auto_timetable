/* occur.js — 智能工作表领域判定核心（JS 侧单一实现）。
 *
 * 供 mobile-server.mjs / mobile.html / schedule.html / 测试共用，禁止再各自拷贝
 * （历史教训：occursOn 曾在 3 个 JS 端各存一份且已现漂移，其中一份漏了 deadline 截止）。
 *
 * 语义与 Python 侧 timetable_core.py 对齐（.qrtest/occur-test.mjs 表驱动 + 对拍）：
 * - weekly: weekday 1=周一..7=周日；可选 weekPattern{start, odd} 单双周（start 所在周为第 1 教学周）
 * - once:   date = "YYYY-MM-DD"
 * - custom: repeat{interval(>=1), unit(day|week|month), start, days[](仅 week), until}
 *           week 未指定 days → 仅起始日的星期几；month 按「几号」匹配（起始日 > 28 时小月自然跳过）
 * - deadline: 到该日（含）为止生效；type=task 时含义为「任务必须完成日」（必填）
 * - task:     长周期必完成任务（无起止时刻，不进时段网格）：deadline = 必须完成日（必填）；
 *             可选 start = 开始日期（YYYY-MM-DD）：从该日起进入进行中并持续到截止日，
 *             未设 start 时一直可见到截止日。occursOn 在 [start, deadline] 区间逐日为真
 *             （供单日视图/手机端持续展示）；侧栏集中渲染与截止日横幅由页面负责；
 *             时刻提醒不涉及 task（调用方按类型跳过）
 * - skip: ["YYYY-MM-DD", ...] 例外日期（停课/调休），该事件在这些日期不发生（先于类型判定）
 * - remindLead: 提醒提前分钟数（>=0；0 = 不提醒；缺失/非法回落默认，由 leadMinutes(ev, def) 提供）
 * - isPurgeable/archiveFor: 过期归档判定与归档纯函数（服务端 purgeExpired 接入走共享模块）
 *
 * 双环境（UMD 风格小包装，无依赖）：
 * - Node：require / ESM default import（package.json 无 type，.js 按 CJS 加载，module.exports 生效）
 * - 浏览器 / vm 沙箱：全局 window.TTOccur（页面 <script src="occur.js"> 直引）
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api; // Node
  if (root && typeof root === 'object') root.TTOccur = api;               // 浏览器全局 / vm 沙箱全局
  try { if (typeof window !== 'undefined') window.TTOccur = api; } catch (e) {}
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- 基础工具 ----------
  function pad2(n) { return String(n).padStart(2, '0'); }
  function fmtDate(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function parseDate(s) { var p = String(s).split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); }
  function isoWeekday(d) { return (d.getDay() + 6) % 7 + 1; } // 周一=1 … 周日=7
  /** 解析 "HH:MM" 为当日分钟数；非法/缺失回落 0（与各端 toMin 容错一致）。 */
  function parseHHMM(hhmm) {
    var p = String(hhmm || '0:0').split(':');
    return (+p[0]) * 60 + (+p[1] || 0);
  }
  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  var HHMM_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;
  /** 严格日期串校验：YYYY-MM-DD 且为真实日历日期。 */
  function isDateStr(s) {
    if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
    var p = s.split('-').map(Number);
    var d = new Date(p[0], p[1] - 1, p[2]);
    return d.getFullYear() === p[0] && d.getMonth() === p[1] - 1 && d.getDate() === p[2];
  }
  /** d 所在教学周的周一（教学周按周一起算）。 */
  function mondayOf(d) {
    var x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
    return x;
  }

  // ---------- 单双周（weekPattern，仅 weekly）：以 start 所在周为第 1 教学周 ----------
  // odd=true → 仅单数教学周（1,3,5,…）发生；odd=false → 仅双数教学周（2,4,6,…）发生。
  // start 非法/缺失视为无模式；早于基准周不发生。
  function weekPatternOk(ev, day) {
    var wp = ev && ev.weekPattern;
    if (!wp || typeof wp !== 'object' || !isDateStr(wp.start)) return true;
    var base = mondayOf(parseDate(wp.start));
    var diff = Math.floor((new Date(day.getFullYear(), day.getMonth(), day.getDate()) - base) / 86400000 / 7);
    if (diff < 0) return false; // 早于基准周（termStart 之前）
    var weekNo = diff + 1;
    return (weekNo % 2 === 1) === !!wp.odd;
  }

  // ---------- 事件是否发生在日期 day（Date，本地墙上时间） ----------
  function occursOn(ev, day) {
    var ds = fmtDate(day);
    if (ev.deadline && ds > ev.deadline) return false; // 截止日期：到该日（含）为止生效
    if (Array.isArray(ev.skip) && ev.skip.indexOf(ds) !== -1) return false; // 例外日期：停课/调休，该日不发生
    var type = ev.type || 'once';
    if (type === 'weekly') {
      if (isoWeekday(day) !== (parseInt(ev.weekday, 10) || 1)) return false;
      return weekPatternOk(ev, day); // 单双周（未配置 = 恒真）
    }
    if (type === 'once') return ev.date === ds;
    if (type === 'task') {
      if (ev.start && ds < ev.start) return false; // 开始日期（可选）：未开始不发生
      return !!ev.deadline; // 从开始（或无 start 即一直）持续到截止日；缺 deadline = 永不（无截止依据）
    }
    if (type === 'custom') {
      var r = ev.repeat || {};
      if (!r.start || ds < r.start) return false;
      if (r.until && ds > r.until) return false; // until 含当日
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
        return isoWeekday(day) === isoWeekday(s); // 未指定 days：仅起始日的星期几
      }
      if (unit === 'month') {
        var months = (day.getFullYear() - s.getFullYear()) * 12 + (day.getMonth() - s.getMonth());
        if (months % interval !== 0) return false;
        return day.getDate() === s.getDate(); // 按「几号」匹配
      }
    }
    return false;
  }

  // ---------- 提醒提前分钟数 ----------
  /** remindLead 为数字（含数字字符串）且 >= 0 → 原值（显式 0 = 不提醒，由调用方按 >0 过滤）；
   *  缺失 / 非法（非数字、负数、NaN、bool）→ def（缺省 20）。 */
  function leadMinutes(ev, def) {
    var raw = (ev && typeof ev === 'object') ? ev.remindLead : undefined;
    if (typeof raw === 'boolean') return def === undefined ? 20 : def;
    var v = parseFloat(raw);
    if (isFinite(v) && v >= 0) return v;
    return def === undefined ? 20 : def;
  }

  // ---------- 事件结构校验（P1-2：拦截 custom 缺 repeat 等结构性损坏） ----------
  /** 返回错误列表（空数组 = 通过）。end < start 视为跨午夜一段，合法；end == start 非法。 */
  function validateEvent(ev) {
    if (!ev || typeof ev !== 'object' || Array.isArray(ev)) return ['事件必须是对象'];
    var errs = [];
    var type = ev.type;
    if (type !== 'weekly' && type !== 'once' && type !== 'custom' && type !== 'task') {
      errs.push('type 必须是 weekly/once/custom/task');
    }
    if (!ev.title || !String(ev.title).trim()) errs.push('title 不能为空');
    if (type === 'task') {
      // 任务（长周期必完成）：无起止时刻，deadline = 必须完成日（必填）；可选 start = 开始日期
      if (!isDateStr(ev.deadline)) errs.push('task 事件需要有效 deadline（YYYY-MM-DD，必须完成日）');
      if (ev.start !== undefined && ev.start !== null && ev.start !== '') {
        if (!isDateStr(ev.start)) errs.push('task 开始日期格式非法（YYYY-MM-DD）');
        else if (isDateStr(ev.deadline) && ev.start > ev.deadline) errs.push('task 开始日期不能晚于截止日期');
      }
    } else {
      if (!HHMM_RE.test(String(ev.start || ''))) errs.push('start 必须是 HH:MM（00:00–23:59）');
      if (!HHMM_RE.test(String(ev.end || ''))) errs.push('end 必须是 HH:MM（00:00–23:59）');
      if (HHMM_RE.test(String(ev.start || '')) && HHMM_RE.test(String(ev.end || ''))) {
        if (parseHHMM(ev.end) === parseHHMM(ev.start)) errs.push('end 不能等于 start（跨天日程请 end < start，如 23:00–01:00）');
      }
    }
    var wd = parseInt(ev.weekday, 10);
    if (type === 'weekly' && !(wd >= 1 && wd <= 7)) errs.push('weekly 事件需要 weekday（1=周一 … 7=周日）');
    if (type === 'once' && !isDateStr(ev.date)) errs.push('once 事件需要有效 date（YYYY-MM-DD，须为真实日期）');
    if (type === 'custom') {
      var r = ev.repeat;
      if (!r || typeof r !== 'object' || Array.isArray(r)) {
        errs.push('custom 事件必须带 repeat 对象（缺 repeat 将不被渲染/提醒）');
      } else {
        var iv = parseInt(r.interval, 10);
        if (!(iv >= 1)) errs.push('repeat.interval 必须是 >= 1 的整数');
        if (r.unit !== 'day' && r.unit !== 'week' && r.unit !== 'month') errs.push('repeat.unit 必须是 day/week/month');
        if (!isDateStr(r.start)) errs.push('repeat.start 必须是有效日期（YYYY-MM-DD）');
        if (r.until !== undefined && r.until !== null && r.until !== '' && !isDateStr(r.until)) errs.push('repeat.until 必须是有效日期');
        if (r.unit === 'week' && r.days !== undefined && r.days !== null) {
          if (!Array.isArray(r.days)) errs.push('repeat.days 必须是数组（1-7）');
          else {
            for (var i = 0; i < r.days.length; i++) {
              var d = parseInt(r.days[i], 10);
              if (!(d >= 1 && d <= 7)) { errs.push('repeat.days 取值必须是 1-7'); break; }
            }
          }
        }
      }
    }
    if (ev.deadline !== undefined && ev.deadline !== null && ev.deadline !== '' && !isDateStr(ev.deadline)) {
      errs.push('deadline 必须是有效日期（YYYY-MM-DD）');
    }
    if (ev.remindLead !== undefined && ev.remindLead !== null && ev.remindLead !== '') {
      if (typeof ev.remindLead === 'boolean' || !isFinite(parseFloat(ev.remindLead)) || parseFloat(ev.remindLead) < 0) {
        errs.push('remindLead 必须是 >= 0 的数字（0 = 不提醒）');
      }
    }
    // 例外日期（stop 课/调休）：必须是合法日期数组
    if (ev.skip !== undefined && ev.skip !== null) {
      if (!Array.isArray(ev.skip)) errs.push('skip 必须是日期数组（YYYY-MM-DD）');
      else {
        for (var si = 0; si < ev.skip.length; si++) {
          if (!isDateStr(ev.skip[si])) { errs.push('skip 数组元素必须是有效日期（YYYY-MM-DD）'); break; }
        }
      }
    }
    // 单双周（仅 weekly）
    if (ev.weekPattern !== undefined && ev.weekPattern !== null) {
      var wp = ev.weekPattern;
      if (type !== 'weekly') errs.push('weekPattern 仅适用于 weekly 事件');
      if (!wp || typeof wp !== 'object' || Array.isArray(wp)) errs.push('weekPattern 必须是对象 { start, odd }');
      else {
        if (!isDateStr(wp.start)) errs.push('weekPattern.start 必须是有效日期（YYYY-MM-DD）');
        if (wp.odd !== undefined && typeof wp.odd !== 'boolean') errs.push('weekPattern.odd 必须是 true/false');
      }
    }
    return errs;
  }

  /** 顶层校验：返回问题列表（空 = 通过）。每项 { index?, id?, title?, errors: [...] }。 */
  function validateSchedule(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return [{ errors: ['顶层必须是 JSON 对象'] }];
    }
    var problems = [];
    if (!Array.isArray(data.events)) {
      problems.push({ errors: ['缺少 events 数组'] });
      return problems;
    }
    data.events.forEach(function (ev, i) {
      var errs = validateEvent(ev);
      if (errs.length) {
        problems.push({ index: i, id: ev && ev.id, title: ev && ev.title, errors: errs });
      }
    });
    return problems;
  }

  // ---------- 过期归档（P2-3）：purge 判定与归档纯函数 ----------
  /** 是否可归档：截止日期（deadline / once 的 date / custom 的 repeat.until）早于 cutoff（严格小于）。 */
  function isPurgeable(ev, cutoff) {
    var dl = (typeof ev.deadline === 'string' && DATE_RE.test(ev.deadline)) ? ev.deadline : null;
    if (!dl && (ev.type || 'once') === 'once') dl = (typeof ev.date === 'string' && DATE_RE.test(ev.date)) ? ev.date : null;
    if (!dl && ev.type === 'custom' && ev.repeat && typeof ev.repeat.until === 'string') dl = ev.repeat.until;
    return !!dl && dl < cutoff;
  }

  /**
   * 归档纯函数：把 data.events 中过期的（isPurgeable）移入 data.archive（附 archivedAt 时间戳），
   * 返回新 data（不修改入参）；无可归档项时原样返回。archive 节点不渲染、不提醒（调用方只遍历 events）。
   * nowMs 可注入（测试用）；缺省取当前时间。
   */
  function archiveFor(data, cutoff, nowMs) {
    if (!data || typeof data !== 'object' || !Array.isArray(data.events)) return data;
    var ts = new Date(nowMs === undefined ? Date.now() : nowMs).toISOString();
    var kept = [], moved = [];
    for (var i = 0; i < data.events.length; i++) {
      var ev = data.events[i];
      if (isPurgeable(ev, cutoff)) moved.push(Object.assign({}, ev, { archivedAt: ts }));
      else kept.push(ev);
    }
    if (!moved.length) return data;
    var out = Object.assign({}, data);
    out.events = kept;
    out.archive = (Array.isArray(data.archive) ? data.archive.slice() : []).concat(moved);
    return out;
  }

  return {
    occursOn: occursOn,
    leadMinutes: leadMinutes,
    parseHHMM: parseHHMM,
    fmtDate: fmtDate,
    isoWeekday: isoWeekday,
    isDateStr: isDateStr,
    mondayOf: mondayOf,
    weekPatternOk: weekPatternOk,
    validateEvent: validateEvent,
    validateSchedule: validateSchedule,
    isPurgeable: isPurgeable,
    archiveFor: archiveFor,
  };
});
