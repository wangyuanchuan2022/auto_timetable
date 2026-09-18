// tt-tool-test.mjs — tt.mjs 日程编辑工具回归测试。
// 覆盖：parseDateExpr 全部相对/绝对写法与报错分支、buildEvent 四类型约定字段
// （weekly deadline=学期末 / once=date / custom=until / task 必填）、applyEdit 最小改动
// 与 once/custom 的 deadline 自动同步、run() 端到端（临时 fixture：add/edit/remove/validate、
// 校验闸门拦截、既有问题 WARN 放行、歧义定位）。
// 运行：node .qrtest/tt-tool-test.mjs（进程内调用，无子进程；fixture 写 .qrtest/tmp-tt/）
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TMP = join(HERE, 'tmp-tt');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
process.env.TT_BACKUP_DIR = join(TMP, 'backups'); // 必须在 import tt.mjs 之前设置（模块加载时读取）
const { parseDateExpr, buildEvent, applyEdit, findEvent, describe, run } = await import('../tt.mjs');

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; console.log('  [OK] ' + name); } else { fail++; console.log('  [FAIL] ' + name); } };
const throws = (fn, keyword) => { try { fn(); return false; } catch (e) { return keyword === undefined || String(e.message).includes(keyword); } };
const d = (y, m, dd) => new Date(y, m - 1, dd);

// ---------- 1) parseDateExpr ----------
console.log('1) parseDateExpr：相对日期（基准=参数注入，不读时钟）');
const B = d(2026, 9, 18); // 周五
const P = (expr, base) => parseDateExpr(expr, base).date;
check('今天 -> 2026-09-18', P('今天', B) === '2026-09-18');
check('明日 -> 09-19', P('明日', B) === '2026-09-19');
check('后天 -> 09-20', P('后天', B) === '2026-09-20');
check('大后天 -> 09-21', P('大后天', B) === '2026-09-21');
check('昨天 -> 09-17', P('昨天', B) === '2026-09-17');
check('3天后 -> 09-21', P('3天后', B) === '2026-09-21');
check('3天前 -> 09-15', P('3天前', B) === '2026-09-15');
console.log('   本/下周（周一为一周起点）');
check('本周六 -> 09-19', P('本周六', B) === '2026-09-19');
check('本周日 -> 09-20', P('本周日', B) === '2026-09-20');
check('本周一（周内已过）-> 09-14', P('本周一', B) === '2026-09-14');
check('下周一 -> 09-21', P('下周一', B) === '2026-09-21');
check('下周日 -> 09-27', P('下周日', B) === '2026-09-27');
check('下下周三 -> 09-30', P('下下周三', B) === '2026-09-30');
check('裸周日（下一个含今天）-> 09-20', P('周日', B) === '2026-09-20');
check('裸周三 -> 09-23', P('星期三', B) === '2026-09-23');
check('这周六 = 本周六', P('这周六', B) === P('本周六', B));
check('钉案：2026-09-17（周四）说本周六 = 09-19', P('本周六', d(2026, 9, 17)) === '2026-09-19');
console.log('   绝对日期与口语尾巴');
check('9月20日 -> 2026-09-20', P('9月20日', B) === '2026-09-20');
check('9月20号 -> 同上', P('9月20号', B) === '2026-09-20');
check('1月17日（已过→明年）-> 2027-01-17', P('1月17日', B) === '2027-01-17');
check('2026年9月20日', P('2026年9月20日', B) === '2026-09-20');
check('2026-09-20', P('2026-09-20', B) === '2026-09-20');
check('2026/9/20', P('2026/9/20', B) === '2026-09-20');
check('20260920', P('20260920', B) === '2026-09-20');
check('12月31日前 -> 2026-12-31', P('12月31日前', B) === '2026-12-31');
check('12月31日前完成 -> 同上', P('12月31日前完成', B) === '2026-12-31');
check('9月25日23:59前 -> 09-25（未来日期带时刻尾缀）', P('9月25日23:59前', B) === '2026-09-25');
check('明天晚上 -> 09-19', P('明天晚上', B) === '2026-09-19');
check('2月30日 报错', throws(() => P('2月30日', B)));
check('13月1日 报错', throws(() => P('13月1日', B)));
check('乱串 报错（带支持写法清单）', throws(() => P('下周左右', B), '支持'));
check('周末 报错（要求明确周六/周日）', throws(() => P('周末', B), '歧义'));
check('空串 报错', throws(() => P('  ', B)));
check('how 标注推算基准', parseDateExpr('本周六', B).how.includes('2026-09-18'));

// ---------- 2) buildEvent：四类型与约定字段 ----------
console.log('2) buildEvent：约定字段自动补全（AI 不手填 deadline）');
const FIX = { meta: { title: 't' }, events: [{ id: 'seed-weekly', title: '种子课', type: 'weekly', weekday: 3, start: '08:00', end: '09:35', deadline: '2027-01-17' }] };
const A = (o) => ({ _: ['add', o.type ?? 'weekly'], ...o });
const w = buildEvent(A({ type: 'weekly', title: '线性代数', weekday: '1', start: '8:00', end: '9:35', location: '一教101' }), FIX);
check('weekly deadline 自动=学期末 2027-01-17', w.deadline === '2027-01-17');
check('weekly 时间归一 8:00 -> 08:00', w.start === '08:00' && w.end === '09:35');
check('weekly weekday=1', w.weekday === 1);
const o = buildEvent(A({ type: 'once', title: '考试', date: '下周三', start: '14:00', end: '16:00' }), FIX);
check('once date 接受相对词并落盘为绝对日期', o.date === '2026-09-23');
check('once deadline 自动=其 date', o.deadline === o.date);
const o2 = buildEvent(A({ type: 'once', title: '考试2', date: '明天', start: '09:00', end: '10:00', deadline: '10月1日' }), FIX);
check('once 显式 --deadline 可覆盖', o2.deadline === '2026-10-01');
const c = buildEvent(A({ type: 'custom', title: '锻炼', interval: '3', unit: 'day', 'repeat-start': '今天', until: '2030-07-31', start: '20:30', end: '21:30' }), FIX);
check('custom deadline 自动=repeat.until', c.deadline === '2030-07-31');
check('custom repeat.start 接受相对词', c.repeat.start === '2026-09-18');
check('custom deadline 缺 until 时留空', buildEvent(A({ type: 'custom', title: 'x', interval: '1', unit: 'week', 'repeat-start': '明天', start: '07:00', end: '08:00' }), FIX).deadline === undefined);
const c2 = buildEvent(A({ type: 'custom', title: '跑步', interval: '1', unit: 'week', 'repeat-start': '明天', days: '1,3,5', start: '07:00', end: '08:00' }), FIX);
check('custom days 解析为数组 [1,3,5]', JSON.stringify(c2.repeat.days) === '[1,3,5]');
const t = buildEvent(A({ type: 'task', title: '交报告', deadline: '12月31日前' }), FIX);
check('task deadline 接受中文表达', t.deadline === '2026-12-31');
check('task 无 start/end', t.start === undefined && t.end === undefined);
const t2 = buildEvent(A({ type: 'task', title: '报名', deadline: '9月20日', start: '明天' }), FIX);
check('task 可选 start（开始日期）', t2.start === '2026-09-19');
check('task 缺 deadline 报错', throws(() => buildEvent(A({ type: 'task', title: 'x' }), FIX), '--deadline'));
check('weekly 缺 weekday 报错', throws(() => buildEvent(A({ type: 'weekly', title: 'x', start: '08:00', end: '09:00' }), FIX), 'weekday'));
check('weekly end==start 构造放行（由写盘闸门拦截，见端到端）', !throws(() => buildEvent(A({ type: 'weekly', title: 'x', weekday: '1', start: '08:00', end: '08:00' }), FIX)));
check('重复 id 报错', throws(() => buildEvent(A({ type: 'task', title: 'x', id: 'seed-weekly', deadline: '明天' }), FIX), '已存在'));
check('自动 id 唯一（evt- 前缀）', buildEvent(A({ type: 'task', title: 'x', deadline: '明天' }), FIX).id.startsWith('evt-'));
check('非法颜色报错', throws(() => buildEvent(A({ type: 'once', title: 'x', date: '明天', start: '08:00', end: '09:00', color: 'red' }), FIX), 'color'));

// ---------- 3) applyEdit ----------
console.log('3) applyEdit：最小改动与自动同步');
const clone = (o) => JSON.parse(JSON.stringify(o));
let e1 = clone(FIX.events[0]);
const ch1 = applyEdit(e1, { title: '种子课改' });
check('改 title 产生一条 change', ch1.length === 1 && e1.title === '种子课改');
const ch2 = applyEdit(e1, { 'skip-add': '2026-10-06,2026-09-29,2026-10-06' });
check('skip-add 去重排序', JSON.stringify(e1.skip) === JSON.stringify(['2026-09-29', '2026-10-06']));
applyEdit(e1, { 'skip-del': '2026-09-29' });
check('skip-del 删除单日', JSON.stringify(e1.skip) === JSON.stringify(['2026-10-06']));
applyEdit(e1, { 'skip-del': '2026-10-06' });
check('skip 删空后字段移除', e1.skip === undefined);
applyEdit(e1, { unset: 'location' });
check('unset 移除字段', e1.location === undefined);
check('applyEdit 无变化返回空表（cmdEdit 层才报错）', applyEdit(e1, {}).length === 0);
let once1 = { id: 'o', title: 'o', type: 'once', date: '2026-09-20', start: '08:00', end: '09:00', deadline: '2026-09-20' };
applyEdit(once1, { date: '下周五' });
check('once 改 date 自动同步 deadline', once1.date === '2026-09-25' && once1.deadline === '2026-09-25');
let cus1 = { id: 'c', title: 'c', type: 'custom', start: '20:30', end: '21:30', deadline: '2030-07-31', repeat: { interval: 3, unit: 'day', start: '2026-09-11', until: '2030-07-31' } };
applyEdit(cus1, { until: '11月8日' });
check('custom 改 until 自动同步 deadline（旧值相等时）', cus1.repeat.until === '2026-11-08' && cus1.deadline === '2026-11-08');
let cus2 = clone(cus1); cus2.deadline = '2027-06-01'; // deadline 与 until 不同步的场景
applyEdit(cus2, { until: '12月31日' });
check('custom deadline 被人为改过时不被同步', cus2.deadline === '2027-06-01' && cus2.repeat.until === '2026-12-31');
applyEdit(cus1, { 'repeat-start': '明天' });
check('custom --repeat-start 改 repeat.start 不动时间字段', cus1.repeat.start === '2026-09-19' && cus1.start === '20:30');
let wk1 = clone(FIX.events[0]); wk1.weekPattern = { start: '2026-09-14', odd: true };
applyEdit(wk1, { weekpattern: 'even' });
check('weekly --weekpattern 翻转 odd 保留 start', wk1.weekPattern.odd === false && wk1.weekPattern.start === '2026-09-14');
let wk2 = clone(FIX.events[0]);
check('--wp-start 无 weekPattern 基础时报错', throws(() => applyEdit(wk2, { 'wp-start': '明天' }), '--weekpattern'));
check('--unset until 清 repeat.until', (() => { applyEdit(cus1, { unset: 'until' }); return cus1.repeat.until === undefined; })());
check('--unset 不支持的键报错', throws(() => applyEdit(e1, { unset: 'id' }), '不支持'));

// ---------- 4) run() 端到端（临时 fixture + 隔离备份目录） ----------
console.log('4) run() 端到端：写盘链路、闸门与既有问题 WARN');
const FIXTURE = join(TMP, 'fixture.json');
const fixtures = (events) => writeFileSync(FIXTURE, JSON.stringify({ _说明: '测试', meta: { title: 't' }, events }, null, 2) + '\n');
fixtures([{ id: 'seed-weekly', title: '种子课', type: 'weekly', weekday: 3, start: '08:00', end: '09:35', deadline: '2027-01-17' }]);
let r1 = run(['add', 'once', '--file', FIXTURE, '--title', '乒乓球比赛', '--date', '本周六', '--start', '13:00', '--end', '17:00', '--location', '北体育馆']);
check('add 返回 added 且 date=本周六换算 2026-09-19', r1.added.date === '2026-09-19' && r1.added.deadline === '2026-09-19');
check('add 已写盘（fixture 含新事件）', JSON.parse(readFileSync(FIXTURE, 'utf8')).events.length === 2);
check('add 产生备份文件', existsSync(r1.backup) && readdirSync(process.env.TT_BACKUP_DIR).length >= 1);
let r2 = run(['edit', '乒乓球比赛', '--file', FIXTURE, '--title', '乒乓球友谊赛', '--skip-add', '9月20日']);
check('edit 按标题定位并最小修改', r2.id === r1.added.id && r2.changes.length === 2);
check('edit 后盘上数据一致', JSON.parse(readFileSync(FIXTURE, 'utf8')).events[1].title === '乒乓球友谊赛');
check('edit dry-run 不写盘', (() => { const r = run(['edit', 'seed-weekly', '--file', FIXTURE, '--title', '绝不写入', '--dry-run']); const disk = JSON.parse(readFileSync(FIXTURE, 'utf8')); return r.dryRun === true && disk.events[0].title === '种子课'; })());
check('edit 值未变化报错', throws(() => run(['edit', 'seed-weekly', '--file', FIXTURE, '--title', '种子课'])));
check('end==start 被闸门拦截且不写盘', (() => { const before = readFileSync(FIXTURE, 'utf8'); let threw = false; try { run(['edit', 'seed-weekly', '--file', FIXTURE, '--end', '08:00']); } catch { threw = true; } return threw && readFileSync(FIXTURE, 'utf8') === before; })());
run(['add', 'once', '--file', FIXTURE, '--title', '篮球比赛', '--date', '明天', '--start', '18:00', '--end', '19:00']);
check('歧义命中报错并列出候选（「赛」命中两条）', throws(() => run(['edit', '赛', '--file', FIXTURE, '--title', 'x']), '命中'));
check('找不到事件报错', throws(() => run(['edit', '不存在的课', '--file', FIXTURE, '--title', 'x']), '找不到'));
let r3 = run(['remove', '乒乓球友谊赛', '--file', FIXTURE]);
check('remove 删除目标事件', r3.removed.id === r1.added.id && JSON.parse(readFileSync(FIXTURE, 'utf8')).events.length === 2);
console.log('   校验与既有问题');
fixtures([{ id: 'bad-ev', title: '坏事件', type: 'weekly', weekday: 9, start: '08:00', end: '08:00' }]);
check('validate 列出既有问题', run(['validate', '--file', FIXTURE]).problems.length === 1);
check('add 被他人坏数据不阻塞、记 WARN', (() => { const r = run(['add', 'task', '--file', FIXTURE, '--title', '新任务', '--deadline', '明天']); return r.preExistingProblems?.length === 1 && JSON.parse(readFileSync(FIXTURE, 'utf8')).events.length === 2; })());
check('闸门拒绝写入坏事件', throws(() => run(['add', 'task', '--file', FIXTURE, '--title', '坏任务', '--deadline', '2月30日']), 'deadline'));
fixtures([{ id: 'seed-weekly', title: '种子课', type: 'weekly', weekday: 3, start: '08:00', end: '09:35', deadline: '2027-01-17' }]);
check('resolve-date 多表达逐个换算', (() => { const r = run(['resolve-date', '今天', '下周三']); return r.length === 2 && r[0].date === '2026-09-18' && r[1].weekdayName === '周三'; })());
check('describe 展示 weekly 停课/单双周标记', describe({ id: 'd', title: 'T', type: 'weekly', weekday: 1, start: '08:00', end: '09:35', skip: ['2026-10-05'], weekPattern: { start: '2026-09-14', odd: true } }).includes('[停课×1]') && describe({ id: 'd', title: 'T', type: 'weekly', weekday: 1, start: '08:00', end: '09:35', weekPattern: { start: '2026-09-14', odd: true } }).includes('[单周]'));

// ---------- 5) CLI 子命令路径（today/list/show）与 add 路径错误分支 ----------
console.log('5) today/list/show 与 add 错误分支');
fixtures([{ id: 'seed-weekly', title: '种子课', type: 'weekly', weekday: 3, start: '08:00', end: '09:35', deadline: '2027-01-17' }]);
run(['add', 'once', '--file', FIXTURE, '--id', 'obs-color', '--title', '带色事件', '--date', '明天', '--start', '08:00', '--end', '09:00', '--color', '#4F8EF7', '--skip', '9月20日,9月20日']);
const colored = JSON.parse(readFileSync(FIXTURE, 'utf8')).events.find((e) => e.id === 'obs-color');
check('合法 color 归一小写落盘', colored.color === '#4f8ef7');
check('add --skip 去重排序落盘', JSON.stringify(colored.skip) === JSON.stringify(['2026-09-20']));
const td = run(['today']);
check('today 输出日期/星期结构', /^\d{4}-\d{2}-\d{2}$/.test(td.date) && td.weekday >= 1 && td.weekday <= 7 && !!td.weekdayName);
check('list 全量返回数组', run(['list', '--file', FIXTURE]).length === 2);
check('list --type 过滤', run(['list', '--type', 'once', '--file', FIXTURE]).every((e) => (e.type || 'once') === 'once'));
check('list --type 非法报错', throws(() => run(['list', '--type', 'bogus', '--file', FIXTURE]), '--type'));
check('list --q 过滤命中标题', run(['list', '--q', '种子', '--file', FIXTURE]).length === 1);
const shown = run(['show', 'seed-weekly', '--file', FIXTURE]);
check('show 按 id 命中并带 human 文本', shown.ev.id === 'seed-weekly' && shown.human.includes('seed-weekly'));
check('show 缺参报错', throws(() => run(['show', '--file', FIXTURE]), '用法'));
check('show 找不到报错', throws(() => run(['show', '查无此课', '--file', FIXTURE]), '找不到'));
check('add 缺类型报错（用法提示）', throws(() => run(['add', '--file', FIXTURE, '--title', 'x']), '用法'));
check('add weekly --weekpattern 缺 --wp-start 报错', throws(() => run(['add', 'weekly', '--file', FIXTURE, '--title', 'x', '--weekday', '1', '--start', '08:00', '--end', '09:00', '--weekpattern', 'odd']), '--wp-start'));
check('add weekly --weekpattern 非法值报错', throws(() => run(['add', 'weekly', '--file', FIXTURE, '--title', 'x', '--weekday', '1', '--start', '08:00', '--end', '09:00', '--weekpattern', 'weird', '--wp-start', '明天']), 'odd'));
check('add 成功路径 weekPattern 落盘', (() => { run(['add', 'weekly', '--file', FIXTURE, '--id', 'obs-wp', '--title', '单双周课', '--weekday', '2', '--start', '08:00', '--end', '09:00', '--weekpattern', 'even', '--wp-start', '9月14日']); return JSON.parse(readFileSync(FIXTURE, 'utf8')).events.find((e) => e.id === 'obs-wp').weekPattern.odd === false; })());
check('add custom --days 用于 unit=day 报错', throws(() => run(['add', 'custom', '--file', FIXTURE, '--title', 'x', '--interval', '1', '--unit', 'day', '--repeat-start', '明天', '--days', '1', '--start', '08:00', '--end', '09:00']), '--days'));

rmSync(TMP, { recursive: true, force: true });
console.log(`\ntt.mjs 工具\n  通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
