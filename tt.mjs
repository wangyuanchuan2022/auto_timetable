#!/usr/bin/env node
// tt.mjs — 智能时间表日程编辑工具（AI 专用 CLI，日期计算全本地化）。
//
// 背景：AI 直接手改 schedule.json 曾多次算错日期（学期末 deadline、repeat.until、
// 相对日期「本周六」跨天漂移）。本工具把一切日期换算、约定字段补全、结构校验、
// 备份与原子写全部收进本地代码，AI 只传语义参数（标题/时间/中文日期说法）：
//   - 日期换算：resolve-date / 各日期参数都接受 今天/明天/本周六/下周三/9月20日/12月31日前 等表达；
//   - 约定字段：weekly 的 deadline 自动=学期末（TERM_END）、once 自动=其 date、
//     custom 自动=repeat.until、task 必填 deadline——AI 不许手算手填；
//   - 校验同源：直接 import occur.js 的 validateEvent/validateSchedule（与服务端/页面同一份实现）；
//   - 写盘安全：整表校验 → 备份到 .mobile-srv/schedule-backups/（保留 30 份）→
//     同目录临时文件 rename 原子覆盖（与 mobile-server atomicWriteFile 同模式）。
// 纪律来源：TTPROMPT.md「文件操作/日期纪律」——AI 禁止直接手改 schedule.json。
//
// 用法：node tt.mjs <子命令> [参数]（node tt.mjs help 看全表）

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, copyFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import TTOccur from './occur.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FILE = join(HERE, 'schedule.json');
const BACKUP_DIR = process.env.TT_BACKUP_DIR || join(HERE, '.mobile-srv', 'schedule-backups'); // TT_BACKUP_DIR 供测试隔离
const BACKUP_KEEP = 30;
const TERM_END = '2027-01-17'; // 学期末（2026-2027 秋季学期约定值；weekly 默认 deadline）
const WD = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const WD_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 };
const HHMM_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

// ---------- 日期核心（全部本地计算，AI 不参与换算） ----------

function pad2(n) { return String(n).padStart(2, '0'); }
function fmtD(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
function isoWd(d) { return (d.getDay() + 6) % 7 + 1; } // 1=周一 … 7=周日（与 occur.js 一致）
function startOfToday() { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); }
function addDays(d, n) { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() + n); return x; }
function realDate(y, m, dd) { const d = new Date(y, m - 1, dd); return (d.getFullYear() === y && d.getMonth() === m - 1 && d.getDate() === dd) ? d : null; }
function fromISO(s) { const p = s.split('-').map(Number); return realDate(p[0], p[1], p[2]); }

/**
 * 解析一个日期表达 → { date: 'YYYY-MM-DD', wd, how }。
 * 支持写法（基图为 base，缺省=今天；输出标注推算基准，跨天回合重跑即自动重算）：
 *   今天/明天/后天/大后天/昨天 · N天后/N天前
 *   本周X/这周X（本周一~周日历内，可为过去）· 下周X/下下周X · 周X/星期X/礼拜X（下一个，含今天）
 *   9月20日/9月20号（缺年=今年，已过则取明年）· 2026年9月20日
 *   2026-09-20 · 2026/9/20 · 20260920
 *   口语尾巴（之前/以前/前/为止/前完成… 与 上午/下午/晚上…）自动剥离：
 *   「12月31日前」「12月31日前完成」→ 2026-12-31（deadline 语义=该日当天含）。
 * 解析不了/非真实日期（如 2月30日）→ 抛错并给出支持写法清单。
 */
export function parseDateExpr(raw, base = startOfToday()) {
  const fail = () => new Error(
    `无法解析日期表达「${raw}」。支持：今天/明天/后天/大后天/昨天、N天后/N天前、本周六/这周日/下周一/下下周三、周六/星期三（下一个）、` +
    `9月20日/9月20号、2026年9月20日、2026-09-20、2026/9/20、20260920、12月31日前（口语尾巴自动剥离）`);
  let s = String(raw ?? '').trim().replace(/\s+/g, '');
  if (!s) throw fail();
  s = s.replace(/(凌晨|早上|上午|中午|下午|晚上)$/, '');
  const day = (d, how) => ({ date: fmtD(d), wd: isoWd(d), how });
  let m;
  // N天后/N天前 必须在口语尾缀剥离之前匹配（否则「前」被当作完成语吃掉）
  if ((m = s.match(/^(\d{1,3})天(?:之后|后)$/))) return day(addDays(base, +m[1]), `${m[1]}天后`);
  if ((m = s.match(/^(\d{1,3})天(?:之?前)$/))) return day(addDays(base, -m[1]), `${m[1]}天前`);
  s = s.replace(/(?:之前|以前|为止|前)(?:完成|提交|交|截止)?$/, '');
  s = s.replace(/\d{1,2}[:：]\d{2}(:\d{2})?$/, ''); // 时刻尾缀：12月31日23:59(前) → 12月31日
  s = s.replace(/\d{1,2}点\d{1,2}分?$/, '');
  s = s.replace(/\d{1,2}点$/, '');
  if (!s) throw fail();
  if ((m = s.match(/^(今天|今日)$/))) return day(base, '今天');
  if ((m = s.match(/^(明天|明日)$/))) return day(addDays(base, 1), '明天');
  if (s === '后天') return day(addDays(base, 2), '后天');
  if (s === '大后天') return day(addDays(base, 3), '大后天');
  if ((m = s.match(/^(昨天|昨日)$/))) return day(addDays(base, -1), '昨天');
  // 本周X / 下周X / 下下周X / 裸周X（星期词可选：本周六=前缀+六；周六=词+六）（周一为一周起点；本周允许指向本周内已过去的日期）
  if ((m = s.match(/^(本周|这周|下周|下下周)?(?:星期|周|礼拜)?([一二三四五六日天])$/))) {
    const target = WD_NUM[m[2]];
    const dow = isoWd(base);
    let k = 0, label = '本周';
    if (m[1] === '下周') { k = 1; label = '下周'; }
    else if (m[1] === '下下周') { k = 2; label = '下下周'; }
    const offset = m[1] === undefined ? ((target - dow + 7) % 7) : (target - dow + 7 * k);
    return day(addDays(base, offset), `${label}${WD[target]}（基准 ${fmtD(base)} ${WD[dow]}）`);
  }
  if (/^周末$/.test(s)) throw new Error('「周末」有歧义（周六或周日），请明确写 周六/周日');
  // 带年月日
  if ((m = s.match(/^(?:(\d{4})年)?(\d{1,2})月(\d{1,2})[日号]$/))) {
    let y = m[1] ? +m[1] : base.getFullYear();
    let d = realDate(y, +m[2], +m[3]);
    if (!d && !m[1]) { y += 1; d = realDate(y, +m[2], +m[3]); } // 缺年且今年无此日（2/29 等）→ 明年
    if (!d) throw fail();
    if (!m[1] && d < base) { y += 1; d = realDate(y, +m[2], +m[3]); } // 缺年且已过 → 明年（未来导向）
    return day(d, m[1] ? '带年月日' : `月日缺年→按未来取 ${y} 年`);
  }
  if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/))) {
    const d = realDate(+m[1], +m[2], +m[3]);
    if (!d) throw fail();
    return day(d, '完整日期');
  }
  if ((m = s.match(/^(\d{4})(\d{2})(\d{2})$/))) {
    const d = realDate(+m[1], +m[2], +m[3]);
    if (!d) throw fail();
    return day(d, '完整日期');
  }
  throw fail();
}

/** 日期参数统一入口：接受绝对日期或中文表达，返回 'YYYY-MM-DD'。 */
function dateArg(raw, flag) {
  try { return parseDateExpr(raw).date; } catch (e) { throw new Error(`--${flag}: ${e.message}`); }
}

function hhmmArg(raw, flag) {
  const s = String(raw ?? '').trim();
  if (!HHMM_RE.test(s)) throw new Error(`--${flag} 必须是 HH:MM（24 小时制），收到「${raw}」`);
  const [h, mi] = s.split(':').map(Number);
  return `${pad2(h)}:${pad2(mi)}`;
}

function colorArg(raw, flag) {
  const s = String(raw ?? '').trim();
  if (!COLOR_RE.test(s)) throw new Error(`--${flag} 必须是 #rrggbb 六位十六进制，收到「${raw}」`);
  return s.toLowerCase();
}

function intArg(raw, flag, min, max) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || (max !== undefined && n > max)) {
    throw new Error(`--${flag} 必须是 ${min}${max !== undefined ? '-' + max : ' 以上的'}整数，收到「${raw}」`);
  }
  return n;
}

// ---------- 文件读写（备份 + 原子写，与 mobile-server 同模式） ----------

function loadSchedule(file) {
  if (!existsSync(file)) throw new Error(`日程文件不存在：${file}`);
  const txt = readFileSync(file, 'utf8');
  let data;
  try { data = JSON.parse(txt); } catch (e) { throw new Error(`schedule.json 不是合法 JSON（${e.message}）——拒绝操作，请先修复文件`); }
  if (!data || typeof data !== 'object' || !Array.isArray(data.events)) throw new Error('schedule.json 缺少 events 数组——结构异常，拒绝操作');
  return data;
}

function backupSchedule(file) {
  mkdirSync(BACKUP_DIR, { recursive: true });
  const n = new Date();
  const name = `schedule-${n.getFullYear()}${pad2(n.getMonth() + 1)}${pad2(n.getDate())}-${pad2(n.getHours())}${pad2(n.getMinutes())}${pad2(n.getSeconds())}.json`;
  copyFileSync(file, join(BACKUP_DIR, name));
  const olds = readdirSync(BACKUP_DIR).filter((f) => f.startsWith('schedule-') && f.endsWith('.json')).sort();
  while (olds.length > BACKUP_KEEP) unlinkSync(join(BACKUP_DIR, olds.shift()));
  return join(BACKUP_DIR, name);
}

function atomicWrite(file, data) {
  const tmp = join(dirname(file), `.tmp-tt-${process.pid}-${Date.now()}`);
  writeFileSync(tmp, data, 'utf8');
  renameSync(tmp, file);
}

function saveSchedule(file, data) {
  const bak = backupSchedule(file);
  atomicWrite(file, JSON.stringify(data, null, 2) + '\n');
  return bak;
}

// ---------- 校验闸门（复用 occur.js，无第二份实现） ----------

/**
 * 写盘前闸门：改动事件自身必须零错误；整表校验发现的问题若全部属于
 * 未触碰的既有事件则降级为警告（fail-loud 且不被历史脏数据卡死）。
 */
function gate(file, data, touchedIdx) {
  const problems = TTOccur.validateSchedule(data);
  const mine = problems.filter((p) => p.index !== undefined && touchedIdx.includes(p.index));
  if (mine.length) {
    throw new Error('目标事件校验未通过，未写入：\n' + mine.map((p) => `  [${p.index}] ${p.id ?? ''} ${p.title ?? ''}\n${p.errors.map((e) => '    - ' + e).join('\n')}`).join('\n'));
  }
  const others = problems.filter((p) => p.index === undefined || !touchedIdx.includes(p.index));
  return { bak: saveSchedule(file, data), others };
}

// ---------- 事件定位 ----------

function findEvent(data, q) {
  const evs = data.events;
  const byId = evs.filter((e) => e.id === q);
  if (byId.length === 1) return { ev: byId[0], idx: evs.indexOf(byId[0]), how: 'id 精确匹配' };
  const key = String(q).trim().toLowerCase();
  const hits = evs.filter((e) => String(e.title ?? '').toLowerCase().includes(key) || String(e.id ?? '').toLowerCase().includes(key));
  if (hits.length === 1) return { ev: hits[0], idx: evs.indexOf(hits[0]), how: '标题/id 子串匹配' };
  if (hits.length === 0) throw new Error(`找不到事件「${q}」。先跑 node tt.mjs list 查看全部 id 与标题`);
  throw new Error(`「${q}」命中 ${hits.length} 条事件，请用 id 精确指定：\n` + hits.map((e) => `  - ${e.id}  ${e.title}`).join('\n'));
}

function genId(data) {
  const n = new Date();
  const base = `evt-${n.getFullYear()}${pad2(n.getMonth() + 1)}${pad2(n.getDate())}-${pad2(n.getHours())}${pad2(n.getMinutes())}${pad2(n.getSeconds())}`;
  let id = base, i = 2;
  while (data.events.some((e) => e.id === id)) id = `${base}-${i++}`;
  return id;
}

// ---------- 事件构造（add） ----------

function commonFields(a) {
  const f = {};
  if (a.location !== undefined) f.location = String(a.location);
  if (a.color !== undefined) f.color = colorArg(a.color, 'color');
  if (a.note !== undefined) f.note = String(a.note);
  if (a.remindLead !== undefined) f.remindLead = intArg(a.remindLead, 'remindLead', 0);
  return f;
}

function skipArg(a) {
  if (a.skip === undefined) return undefined;
  const dates = String(a.skip).split(',').map((s) => dateArg(s.trim(), 'skip')).filter(Boolean);
  return [...new Set(dates)].sort();
}

function buildEvent(a, data) {
  const type = a._[1];
  const id = a.id !== undefined ? String(a.id) : genId(data);
  if (data.events.some((e) => e.id === id)) throw new Error(`id「${id}」已存在，请换一个`);
  const title = String(a.title ?? '').trim();
  if (!title) throw new Error('--title 必填');
  let ev;
  if (type === 'weekly') {
    ev = { id, title, type, weekday: intArg(a.weekday, 'weekday（1=周一 … 7=周日）', 1, 7), start: hhmmArg(a.start, 'start'), end: hhmmArg(a.end, 'end'), deadline: a.deadline !== undefined ? dateArg(a.deadline, 'deadline') : TERM_END };
    Object.assign(ev, commonFields(a));
    if (a.weekpattern !== undefined) {
      if (a['wp-start'] === undefined) throw new Error('--weekpattern 需要同时给 --wp-start（第 1 教学周的周一日期）');
      if (a.weekpattern !== 'odd' && a.weekpattern !== 'even') throw new Error('--weekpattern 只能是 odd（单周）或 even（双周）');
      ev.weekPattern = { start: dateArg(a['wp-start'], 'wp-start'), odd: a.weekpattern === 'odd' };
    }
  } else if (type === 'once') {
    if (a.date === undefined) throw new Error('once 事件必须给 --date');
    const date = dateArg(a.date, 'date');
    ev = { id, title, type, date, start: hhmmArg(a.start, 'start'), end: hhmmArg(a.end, 'end'), deadline: a.deadline !== undefined ? dateArg(a.deadline, 'deadline') : date };
    Object.assign(ev, commonFields(a));
  } else if (type === 'custom') {
    if (a['repeat-start'] === undefined) throw new Error('custom 事件必须给 --repeat-start（重复起始日，可用中文表达）');
    const repeat = { interval: intArg(a.interval, 'interval（正整数）', 1), unit: a.unit, start: dateArg(a['repeat-start'], 'repeat-start') };
    if (!['day', 'week', 'month'].includes(repeat.unit)) throw new Error('--unit 必须是 day/week/month');
    if (a.until !== undefined) repeat.until = dateArg(a.until, 'until');
    if (a.days !== undefined) {
      if (repeat.unit !== 'week') throw new Error('--days 仅在 --unit week 时可用');
      repeat.days = String(a.days).split(',').map((x) => intArg(x.trim(), 'days（1-7）', 1, 7));
    }
    ev = { id, title, type, start: hhmmArg(a.start, 'start'), end: hhmmArg(a.end, 'end'), deadline: a.deadline !== undefined ? dateArg(a.deadline, 'deadline') : repeat.until, repeat };
    Object.assign(ev, commonFields(a));
  } else if (type === 'task') {
    if (a.deadline === undefined) throw new Error('task 事件必须给 --deadline（必须完成日，可用中文表达如「12月31日前」）');
    ev = { id, title, type, deadline: dateArg(a.deadline, 'deadline') };
    if (a.start !== undefined) ev.start = dateArg(a.start, 'start');
    Object.assign(ev, commonFields(a));
  } else {
    throw new Error('用法：node tt.mjs add weekly|once|custom|task --title "…"（详见 node tt.mjs help）');
  }
  const skip = skipArg(a);
  if (skip) ev.skip = skip;
  return ev;
}

// ---------- 事件修改（edit，最小改动） ----------

const UNSETTABLE = new Set(['location', 'note', 'color', 'remindLead', 'weekPattern', 'skip', 'start', 'until', 'deadline', 'weekpattern', 'wp-start']);

function applyEdit(ev, a) {
  const changes = [];
  const set = (key, val, label, old) => { if (old !== val) { changes.push(`${label}: ${JSON.stringify(old) ?? '（无）'} -> ${JSON.stringify(val)}`); ev[key] = val; } };
  const dateField = (flag) => { if (a[flag] !== undefined) set(flag, dateArg(a[flag], flag), flag, ev[flag]); };
  if (a.title !== undefined) set('title', String(a.title), 'title', ev.title);
  if (a.location !== undefined) set('location', String(a.location), 'location', ev.location);
  if (a.color !== undefined) set('color', colorArg(a.color, 'color'), 'color', ev.color);
  if (a.note !== undefined) set('note', String(a.note), 'note', ev.note);
  if (a.remindLead !== undefined) set('remindLead', intArg(a.remindLead, 'remindLead', 0), 'remindLead', ev.remindLead);
  if (a.start !== undefined && ev.type !== 'task') set('start', hhmmArg(a.start, 'start'), 'start', ev.start);
  if (a.end !== undefined && ev.type !== 'task') set('end', hhmmArg(a.end, 'end'), 'end', ev.end);
  if (a.weekday !== undefined) set('weekday', intArg(a.weekday, 'weekday', 1, 7), 'weekday', ev.weekday);
  if (a.date !== undefined && ev.type === 'once') { const d = dateArg(a.date, 'date'); set('date', d, 'date', ev.date); set('deadline', d, 'deadline(once 自动同步)', ev.deadline); }
  dateField('deadline');
  if (ev.type === 'custom') {
    if (a.interval !== undefined) { const v = intArg(a.interval, 'interval', 1); changes.push(`repeat.interval: ${ev.repeat?.interval} -> ${v}`); ev.repeat.interval = v; }
    if (a.unit !== undefined) { if (!['day', 'week', 'month'].includes(a.unit)) throw new Error('--unit 必须是 day/week/month'); changes.push(`repeat.unit: ${ev.repeat?.unit} -> ${a.unit}`); ev.repeat.unit = a.unit; }
    if (a['repeat-start'] !== undefined) { const rs = dateArg(a['repeat-start'], 'repeat-start'); if (ev.repeat.start !== rs) { changes.push(`repeat.start: ${ev.repeat.start} -> ${rs}`); ev.repeat.start = rs; } }
    if (a.until !== undefined) { const u = dateArg(a.until, 'until'); if (ev.repeat.until !== u) { const oldUntil = ev.repeat.until; changes.push(`repeat.until: ${oldUntil ?? '（无）'} -> ${u}`); ev.repeat.until = u; if (ev.deadline === undefined || ev.deadline === oldUntil) set('deadline', u, 'deadline(custom 自动同步)', ev.deadline); } }
    if (a.days !== undefined) { const d = String(a.days).split(',').map((x) => intArg(x.trim(), 'days', 1, 7)); changes.push(`repeat.days: ${JSON.stringify(ev.repeat?.days)} -> ${JSON.stringify(d)}`); ev.repeat.days = d; }
  }
  if (a.weekpattern !== undefined || a['wp-start'] !== undefined) {
    if (ev.type !== 'weekly') throw new Error('weekPattern 仅适用于 weekly 事件');
    const odd = a.weekpattern !== undefined ? (a.weekpattern === 'odd' ? true : a.weekpattern === 'even' ? false : null) : ev.weekPattern?.odd;
    if (odd === null) throw new Error('--weekpattern 只能是 odd/even');
    if (odd === undefined) throw new Error('--wp-start 需要同时给 --weekpattern odd|even（事件当前无单双周配置）');
    const start = a['wp-start'] !== undefined ? dateArg(a['wp-start'], 'wp-start') : ev.weekPattern?.start;
    if (!start) throw new Error('--weekpattern 需要 --wp-start（或事件已有 weekPattern.start）');
    const next = { start, odd };
    if (JSON.stringify(ev.weekPattern) !== JSON.stringify(next)) { changes.push(`weekPattern: ${JSON.stringify(ev.weekPattern)} -> ${JSON.stringify(next)}`); ev.weekPattern = next; }
  }
  if (a['skip-add'] !== undefined) {
    const add = String(a['skip-add']).split(',').map((s) => dateArg(s.trim(), 'skip-add'));
    const next = [...new Set([...(ev.skip ?? []), ...add])].sort();
    if (JSON.stringify(ev.skip) !== JSON.stringify(next)) { changes.push(`skip: ${JSON.stringify(ev.skip) ?? '（无）'} -> ${JSON.stringify(next)}`); ev.skip = next; }
  }
  if (a['skip-del'] !== undefined) {
    const del = new Set(String(a['skip-del']).split(',').map((s) => dateArg(s.trim(), 'skip-del')));
    const next = (ev.skip ?? []).filter((d) => !del.has(d));
    if (JSON.stringify(ev.skip) !== JSON.stringify(next)) { changes.push(`skip: ${JSON.stringify(ev.skip)} -> ${JSON.stringify(next)}`); if (next.length) ev.skip = next; else delete ev.skip; }
  }
  if (a.unset !== undefined) {
    for (const keyRaw of String(a.unset).split(',')) {
      const key = keyRaw.trim();
      if (!UNSETTABLE.has(key)) throw new Error(`--unset 不支持「${key}」（可用：${[...UNSETTABLE].join(',')}）`);
      if (key === 'weekpattern') { if (ev.weekPattern) { changes.push('weekPattern: 已移除'); delete ev.weekPattern; } continue; }
      if (key === 'until') { if (ev.repeat?.until) { changes.push('repeat.until: 已移除'); delete ev.repeat.until; } continue; }
      if (ev[key] !== undefined) { changes.push(`${key}: 已移除`); delete ev[key]; }
    }
  }
  return changes;
}

// ---------- 展示 ----------

function describe(ev) {
  const t = ev.type || 'once';
  const when = t === 'weekly' ? `每周${WD[ev.weekday] ?? '?'}` : t === 'once' ? ev.date : t === 'task' ? `截止 ${ev.deadline}` : `每${ev.repeat?.interval}${ { day: '天', week: '周', month: '月' }[ev.repeat?.unit] ?? '?'}（${ev.repeat?.start}${ev.repeat?.until ? '~' + ev.repeat.until : ''}）`;
  const time = (ev.start && ev.end) ? ` ${ev.start}-${ev.end}` : '';
  const skip = Array.isArray(ev.skip) && ev.skip.length ? ` [停课×${ev.skip.length}]` : '';
  const wp = ev.weekPattern ? ` [${ev.weekPattern.odd ? '单' : '双'}周]` : '';
  return `${ev.id}  ${when}${time}${wp}${skip}  ${ev.title}${ev.location ? ' @' + ev.location : ''}`;
}

// ---------- 子命令 ----------

const HELP = `tt.mjs — 日程编辑工具（日期换算/字段补全/校验/备份全部本地完成，AI 禁止手改 schedule.json）

查询：
  node tt.mjs today                     今天日期与星期（相对日期的换算基准）
  node tt.mjs resolve-date <表达...>     日期说法 -> YYYY-MM-DD（今天/明天/本周六/下周三/9月20日/12月31日前…）
  node tt.mjs list [--type weekly|once|custom|task] [--q 关键字] [--json]
  node tt.mjs show <id或标题> [--json]
修改（写盘前自动：整表校验 + 备份到 .mobile-srv/schedule-backups/ + 原子写）：
  node tt.mjs add weekly  --title "线性代数" --weekday 1 --start 08:00 --end 09:35 [--location] [--color #rrggbb] [--note] [--skip 日期,日期] [--weekpattern odd|even --wp-start 日期] [--deadline] [--remindLead 分]
  node tt.mjs add once    --title "考试" --date <日期> --start 14:00 --end 16:00 [...同上可选]
  node tt.mjs add custom  --title "锻炼" --interval 3 --unit day --repeat-start <日期> [--until <日期>] [--days 1,3,5] --start 20:30 --end 21:30
  node tt.mjs add task    --title "提交报告" --deadline "12月31日前" [--start <日期>]
  node tt.mjs edit <id> [--title] [--location] [--color] [--note] [--remindLead] [--start HH:MM] [--end HH:MM] [--weekday 1-7] [--date] [--deadline] [--repeat-start] [--interval] [--unit] [--until] [--days 1,3,5] [--weekpattern odd|even] [--wp-start] [--skip-add 日期,日期] [--skip-del 日期,日期] [--unset location,note,color,remindLead,weekPattern,skip,until]
  node tt.mjs remove <id>
其他：
  node tt.mjs validate [--json]          全量校验
  通用：--dry-run（只演算不写盘）--json（机器可读输出）--file <路径>（默认 schedule.json）
约定（不要手填，工具自动补全）：weekly 的 deadline=学期末（${TERM_END}）；once 的 deadline=其 date；custom 的 deadline=repeat.until；task 必填 deadline。`;

function cmdToday(a, file) {
  const n = startOfToday();
  const out = { date: fmtD(n), weekday: isoWd(n), weekdayName: WD[isoWd(n)], note: '所有相对日期换算以此为准' };
  return out;
}

function cmdResolve(a) {
  const exprs = a._.slice(1);
  if (!exprs.length) throw new Error('用法：node tt.mjs resolve-date "本周六" ["明天" …]');
  const base = startOfToday();
  return exprs.map((e) => { const r = parseDateExpr(e, base); return { expr: e, date: r.date, weekday: r.wd, weekdayName: WD[r.wd], basedOn: `${fmtD(base)} ${WD[isoWd(base)]}`, rule: r.how }; });
}

function cmdList(a, file, data) {
  let evs = data.events;
  if (a.type !== undefined) { if (!['weekly', 'once', 'custom', 'task'].includes(a.type)) throw new Error('--type 只能是 weekly/once/custom/task'); evs = evs.filter((e) => (e.type || 'once') === a.type); }
  if (a.q !== undefined) { const k = String(a.q).toLowerCase(); evs = evs.filter((e) => [e.id, e.title, e.location, e.note].some((v) => String(v ?? '').toLowerCase().includes(k))); }
  return evs;
}

function cmdShow(a, file, data) {
  const q = a._[1];
  if (!q) throw new Error('用法：node tt.mjs show <id或标题>');
  const { ev, how } = findEvent(data, q);
  return { ev, how, human: `${ev.id}（${how}）\n` + JSON.stringify(ev, null, 2) };
}

function cmdAdd(a, file, data) {
  const ev = buildEvent(a, data);
  data.events.push(ev);
  return finishWrite(a, file, data, [data.events.length - 1], { added: ev }, `已新增：${describe(ev)}`);
}

function cmdEdit(a, file, data) {
  const q = a._[1];
  if (!q) throw new Error('用法：node tt.mjs edit <id> --字段 值');
  const { ev, idx, how } = findEvent(data, q);
  const changes = applyEdit(ev, a);
  if (!changes.length) throw new Error('没有任何字段变化（检查参数是否与现值相同）');
  return finishWrite(a, file, data, [idx], { id: ev.id, changes }, `已修改（${how}）：\n` + changes.map((c) => '  ' + c).join('\n') + `\n结果：${describe(ev)}`);
}

function cmdRemove(a, file, data) {
  const q = a._[1];
  if (!q) throw new Error('用法：node tt.mjs remove <id>（需先经用户确认）');
  const { ev, idx, how } = findEvent(data, q);
  data.events.splice(idx, 1);
  return finishWrite(a, file, data, [], { removed: ev }, `已删除（${how}）：${describe(ev)}`);
}

function finishWrite(a, file, data, touchedIdx, payload, human) {
  if (a['dry-run']) return { dryRun: true, ...payload, human: '--- DRY RUN：以下变更未写入 ---\n' + human };
  const { bak, others } = gate(file, data, touchedIdx);
  return { ...payload, backup: bak, preExistingProblems: others.length ? others : undefined, human: human + `\n已写入（备份：${bak}）` + (others.length ? `\n[WARN] 文件中另有 ${others.length} 处既有事件的结构问题（非本次改动引入，未拦截写入）：\n` + others.map((p) => `  [${p.index}] ${p.id ?? ''} ${p.errors.join('；')}`).join('\n') : '') };
}

function cmdValidate(a, file, data) {
  const problems = TTOccur.validateSchedule(data);
  return { ok: problems.length === 0, events: data.events.length, problems, human: problems.length ? problems.map((p) => `[${p.index}] ${p.id ?? ''} ${p.title ?? ''}: ${p.errors.join('；')}`).join('\n') : `[OK] 全部 ${data.events.length} 条事件校验通过` };
}

// ---------- 入口 ----------

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) {
      const k = t.slice(2);
      const nxt = argv[i + 1];
      if (nxt === undefined || nxt.startsWith('--')) a[k] = true;
      else { a[k] = nxt; i++; }
    } else a._.push(t);
  }
  return a;
}

function run(argv) {
  const a = parseArgs(argv);
  const cmd = a._[0] ?? 'help';
  if (cmd === 'help' || a.help) return { human: HELP };
  const file = a.file !== undefined ? String(a.file) : DEFAULT_FILE;
  let out;
  if (cmd === 'today') out = cmdToday(a, file);
  else if (cmd === 'resolve-date') out = cmdResolve(a);
  else {
    const data = loadSchedule(file);
    if (cmd === 'list') out = cmdList(a, file, data);
    else if (cmd === 'show') out = cmdShow(a, file, data);
    else if (cmd === 'add') out = cmdAdd(a, file, data);
    else if (cmd === 'edit') out = cmdEdit(a, file, data);
    else if (cmd === 'remove') out = cmdRemove(a, file, data);
    else if (cmd === 'validate') out = cmdValidate(a, file, data);
    else throw new Error(`未知子命令「${cmd}」。可用：help/today/resolve-date/list/show/add/edit/remove/validate`);
  }
  return out;
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  try {
    const out = run(process.argv.slice(2));
    if (a.json) {
      console.log(JSON.stringify(out, null, 2));
    } else if (cmd2(a) === 'list' && Array.isArray(out)) {
      console.log(out.map(describe).join('\n') || '（无匹配事件）');
    } else {
      console.log(out.human ?? JSON.stringify(out));
    }
  } catch (e) {
    const msg = `[FAIL] ${e?.message ?? e}`;
    if (a.json) console.log(JSON.stringify({ ok: false, error: String(e?.message ?? e) }, null, 2));
    else console.log(msg);
    process.exit(2);
  }
}

function cmd2(a) { return a._[0]; }

// 供 .qrtest/tt-tool-test.mjs 复用（进程内跑 run()，不经子进程）；parseDateExpr 在定义处已导出
export { buildEvent, applyEdit, findEvent, describe, run, parseArgs };

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
