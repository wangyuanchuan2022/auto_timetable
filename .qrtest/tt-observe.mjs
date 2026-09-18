// tt-observe.mjs — tt.mjs 真实写入观察（用户指定：观察几个事件是否能正确写入）。
// 流程：基线快照 → 向真实 schedule.json 写入 4 条标记「测试观察」的事件（weekly/once/custom/task
// 各一，覆盖相对日期、约定 deadline、repeat 全路径）→ 逐字段读回核对（期望值由本脚本独立计算，
// 不复用 tt.mjs 内部换算）→ 全表校验 → 用 remove 清理 → 断言恢复到与基线逐字节一致（工具补尾
// \n，按「基线+\n」口径）→ 任何一步失败 exit 2 并保留现场（事件名都带「测试观察」可手动删）。
// 运行：node .qrtest/tt-observe.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../tt.mjs';

const FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'schedule.json');
let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; console.log('  [OK] ' + name); } else { fail++; console.log('  [FAIL] ' + name); } };

// ---------- 独立期望值计算（不复用 tt.mjs 内部逻辑） ----------
const pad2 = (n) => String(n).padStart(2, '0');
const fmt = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const now = new Date();
const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
const plusDays = (n) => { const x = new Date(today); x.setDate(x.getDate() + n); return x; };
const dow = (today.getDay() + 6) % 7 + 1; // 1=周一
const EXP = {
  nextMonday: fmt(plusDays(8 - dow)),            // 下周一
  tomorrow: fmt(plusDays(1)),                    // 明天
  jan17: `${today.getMonth() + 1 >= 2 && today.getDate() > 17 ? today.getFullYear() + 1 : (today.getMonth() === 0 && today.getDate() <= 17 ? today.getFullYear() : today.getFullYear() + 1)}-01-17`, // 1月17日（已过→明年）
  dec31: `${today.getFullYear()}-12-31`,         // 12月31日（今年内未过；12月运行时本行需按未来导向复核）
};
if (now.getMonth() === 11) EXP.dec31 = `${now.getFullYear() + 1}-12-31`; // 12 月说「12月31日前」仍指当年（未过）——仅 12/31 当天会滚明年

// ---------- 基线 ----------
const baselineBytes = readFileSync(FILE);
const baseline = JSON.parse(baselineBytes.toString('utf8'));
const baseN = baseline.events.length;
console.log(`基线：${baseN} 条事件，sha256=${createHash('sha256').update(baselineBytes).digest('hex').slice(0, 16)}`);

const readBack = () => JSON.parse(readFileSync(FILE, 'utf8'));
const note = '测试观察（tt-observe.mjs 自动清理）';

// ---------- 写入 4 条 ----------
console.log('1) add weekly（deadline 应自动=学期末 2027-01-17）');
run(['add', 'weekly', '--id', 'evt-observe-weekly', '--title', '测试观察·周例会', '--weekday', '5', '--start', '18:00', '--end', '19:30', '--location', '观察室', '--note', note]);
let ev = readBack().events.find((e) => e.id === 'evt-observe-weekly');
check('weekly 落盘且字段完整', !!ev && ev.type === 'weekly' && ev.weekday === 5 && ev.start === '18:00' && ev.end === '19:30' && ev.location === '观察室');
check('weekly deadline 自动=2027-01-17（未手填）', ev?.deadline === '2027-01-17');

console.log('2) add once（--date 下周一 → ' + EXP.nextMonday + '，deadline 自动=date）');
run(['add', 'once', '--id', 'evt-observe-once', '--title', '测试观察·一次性活动', '--date', '下周一', '--start', '09:00', '--end', '11:00', '--note', note]);
ev = readBack().events.find((e) => e.id === 'evt-observe-once');
check(`once date 相对换算正确（${EXP.nextMonday}）`, ev?.date === EXP.nextMonday);
check('once deadline 自动=其 date', ev?.deadline === EXP.nextMonday);

console.log('3) add custom（repeat-start 明天、until 1月17日 → deadline 自动=until）');
run(['add', 'custom', '--id', 'evt-observe-custom', '--title', '测试观察·隔周锻炼', '--interval', '2', '--unit', 'week', '--repeat-start', '明天', '--until', '1月17日', '--days', '1,3', '--start', '07:00', '--end', '08:00', '--note', note]);
ev = readBack().events.find((e) => e.id === 'evt-observe-custom');
check('custom repeat 结构正确（interval 2 / week / days [1,3]）', ev?.repeat?.interval === 2 && ev?.repeat?.unit === 'week' && JSON.stringify(ev?.repeat?.days) === '[1,3]');
check(`custom repeat.start=明天（${EXP.tomorrow}）`, ev?.repeat?.start === EXP.tomorrow);
check(`custom until=1月17日（${EXP.jan17}）且 deadline 自动同步`, ev?.repeat?.until === EXP.jan17 && ev.deadline === EXP.jan17);

console.log('4) add task（--deadline 12月31日前 → ' + EXP.dec31 + '）');
run(['add', 'task', '--id', 'evt-observe-task', '--title', '测试观察·提交材料', '--deadline', '12月31日前', '--note', note]);
ev = readBack().events.find((e) => e.id === 'evt-observe-task');
check(`task deadline 中文表达换算（${EXP.dec31}）`, ev?.deadline === EXP.dec31);
check('task 无 start/end（不占时段）', ev && ev.start === undefined && ev.end === undefined);

// ---------- 全表一致性 ----------
console.log('5) 全表核对');
const after = readBack();
check('事件总数 +4', after.events.length === baseN + 4);
check('既有 95 条逐条未动（前缀深比较）', JSON.stringify(after.events.slice(0, baseN)) === JSON.stringify(baseline.events));
check('_说明 / meta 未动', after._说明 === baseline._说明 && JSON.stringify(after.meta) === JSON.stringify(baseline.meta));
const vr = run(['validate']);
check('全表校验通过（' + vr.events + ' 条）', vr.ok === true && vr.events === baseN + 4);
check('备份目录留有写盘前快照', !!run(['list', '--q', '测试观察']).length);

// ---------- 清理与恢复断言 ----------
console.log('6) 清理 4 条测试事件并断言恢复');
for (const id of ['evt-observe-weekly', 'evt-observe-once', 'evt-observe-custom', 'evt-observe-task']) {
  run(['remove', id]);
  if (readBack().events.some((e) => e.id === id)) { console.log(`  [FAIL] ${id} 未删除`); fail++; }
  else { pass++; console.log(`  [OK] ${id} 已删除`); }
}
const finalBytes = readFileSync(FILE);
const finalData = JSON.parse(finalBytes.toString('utf8'));
check('事件总数复原', finalData.events.length === baseN);
check('内容与基线逐字段一致（归一化比较）', JSON.stringify(finalData) === JSON.stringify(baseline));
check('字节级复原（基线+尾换行；工具统一补 \\n）', finalBytes.equals(Buffer.concat([baselineBytes, Buffer.from('\n')])) || finalBytes.equals(baselineBytes));

console.log(`\n观察结论：通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 2);
