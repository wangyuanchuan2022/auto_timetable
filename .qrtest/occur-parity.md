# occur-parity.md — JS occur.js × Python timetable_core.py 对拍记录

## 方法

- 用例来源：`.qrtest/occur-test.mjs` 的 occursOn 表（31 例：weekly 基本/边界/deadline、once、custom×day|week|month×interval×days×until×deadline×跨午夜组合）。
- JS 侧：`node .qrtest/occur-test.mjs --table` 输出用例表 JSON（含每例期望值）。
- Python 侧：同表 JSON 经 stdin 喂给 `timetable_core.occurs_on(ev, date.fromisoformat(day))`，逐例比对 JS 期望值。

命令（工作区根目录）：

```powershell
$env:PYTHONUTF8='1'
node .qrtest/occur-test.mjs --table | py -3 -c "<driver：json.load(stdin) → timetable_core.occurs_on → 与 want 比对>"
```

driver 脚本（内联，无独立文件）：

```python
import sys, json, io
sys.path.insert(0, r'D:\tools\auto_timetable')
from datetime import date
import timetable_core as tc
cases = json.load(io.TextIOWrapper(sys.stdin.buffer, encoding='utf-8'))
res = [(c, tc.occurs_on(c['ev'], date.fromisoformat(c['day']))) for c in cases]
diffs = [(c['name'], g, c['want']) for c, g in res if g != c['want']]
print('parity: %d same, %d diff, total %d' % (len(res) - len(diffs), len(diffs), len(res)))
sys.exit(1 if diffs else 0)
```

## 结果（2026-08-31）

```
parity: 31 same, 0 diff, total 31
```

31 例全部一致，零分歧。覆盖的关键语义点均对齐：

| 语义点 | 双侧一致行为 |
| --- | --- |
| deadline | 到该日（含）为止生效；次日不再发生 |
| weekly weekday 缺省 | 按 1（周一）处理 |
| once | date 精确匹配；type 缺省按 once |
| custom×day | diffDays % interval === 0；早于 start 不发生 |
| custom×week 无 days | 仅起始日的星期几；interval 按周差取模 |
| custom×week days=[1,3,5] | 数组内星期几命中即发生 |
| custom×month | 按「几号」匹配；起始日 31 号在 30 天月自然跳过 |
| until | 含当日（当日仍发生、次日不发生） |
| 跨午夜（end < start） | 在开始日发生（日期级判定不受影响） |

## 维护约定

新增 occursOn 用例只需加进 `.qrtest/occur-test.mjs` 的 `occurTable`（自动进入 `--table` 输出），再用上方命令重跑对拍并更新本文件的「结果」小节。
