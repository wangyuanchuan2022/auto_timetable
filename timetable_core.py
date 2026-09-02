# -*- coding: utf-8 -*-
"""timetable_core — 智能工作表领域判定核心（Python 侧单一实现）。

供两个桌面端入口共享，禁止再各自拷贝（历史教训：occurs_on 曾在
reminder_app.py 与 reminder-plugin/runtime/helper.py 各存一份且已现漂移）：

- reminder_app.py（独立桌面版，本模块同目录，直接 import）
- reminder-plugin/runtime/helper.py（DSH 插件版，经 sys.path 注入仓库根后 import）

数据契约与 schedule.json / mobile-server.mjs / 网页端一致：
- weekly: weekday 1=周一..7=周日；可选 weekPattern{start, odd} 单双周
- once:   date = "YYYY-MM-DD"
- custom: repeat{interval, unit(day|week|month), start, days[], until}
- task:   长周期必完成任务（无起止时刻）：deadline = 必须完成日（必填）；
          occurs_on 仅在截止当日为真（时刻提醒不涉及——load_day 跳过 task）
- deadline: 到该日（含）为止生效；task 型含义为「任务必须完成日」
- skip: ["YYYY-MM-DD", ...] 例外日期（停课/调休），该日不发生
- remindLead: 提醒提前分钟数（>=0；0 = 不提醒；缺失/非法回落默认双档）

纯标准库、无 UI 依赖。
"""
import json
from datetime import date, datetime, time as dtime, timedelta

# 事件未带有效 remindLead 时的默认提醒双档（分钟，大在前）
DEFAULT_LEADS = (30, 10)


def _week_monday(d):
    """d 所在教学周的周一（教学周按周一起算）。"""
    return d - timedelta(days=d.weekday())


def _week_pattern_ok(ev, d):
    """单双周（weekPattern，仅 weekly）：以 start 所在周为第 1 教学周，
    odd=true 仅单数周发生、false 仅双数周发生；start 非法/缺失视为无模式；早于基准周不发生。"""
    wp = ev.get("weekPattern") or {}
    if not isinstance(wp, dict):
        return True
    st = wp.get("start")
    if not st:
        return True
    try:
        base = _week_monday(date.fromisoformat(st))
    except Exception:
        return True
    diff = (d - base).days // 7
    if diff < 0:
        return False
    week_no = diff + 1
    return (week_no % 2 == 1) == bool(wp.get("odd"))


def parse_hhmm(s, default="08:00"):
    """解析 "HH:MM" 为 time；非法/缺失回落 08:00（与网页端容错一致）。"""
    try:
        parts = str(s or default).split(":")
        return dtime(int(parts[0]), int(parts[1] if len(parts) > 1 else 0))
    except Exception:
        return dtime(8, 0)


def occurs_on(ev, d):
    """事件是否发生在日期 d。weekday 语义：1=周一..7=周日（与网页版一致）。

    判定顺序：deadline 截止 → skip 例外日期 → 原类型判定（weekly 另过 weekPattern 单双周）。
    """
    t = ev.get("type", "once")
    ds = d.isoformat()
    dl = ev.get("deadline")
    if dl and ds > dl:
        return False  # 截止日期：到该日（含）为止生效
    sk = ev.get("skip")
    if isinstance(sk, list) and ds in sk:
        return False  # 例外日期（停课/调休）：该日不发生
    if t == "weekly":
        if d.weekday() + 1 != int(ev.get("weekday", 1)):
            return False
        return _week_pattern_ok(ev, d)  # 单双周（未配置恒真）
    if t == "once":
        return ev.get("date") == ds
    if t == "task":
        return ds == (dl or "")  # 任务：仅在截止当日「发生」（时刻提醒不涉及，load_day 跳过）
    if t == "custom":
        r = ev.get("repeat") or {}
        rs = r.get("start")
        if not rs or ds < rs:
            return False
        if r.get("until") and ds > r["until"]:
            return False
        try:
            sy, sm, sd = (int(x) for x in rs.split("-"))
            s = date(sy, sm, sd)
        except Exception:
            return False
        diff = (d - s).days
        if diff < 0:
            return False
        interval = max(1, int(r.get("interval", 1) or 1))
        unit = r.get("unit", "day")
        if unit == "day":
            return diff % interval == 0
        if unit == "week":
            if (diff // 7) % interval != 0:
                return False
            days = r.get("days")
            if isinstance(days, list) and days:
                return d.weekday() + 1 in days
            return d.weekday() == s.weekday()  # 未指定 days：仅起始日的星期几
        if unit == "month":
            months = (d.year - s.year) * 12 + (d.month - s.month)
            return months % interval == 0 and d.day == s.day
    return False


def lead_minutes(ev, default=None):
    """事件的提醒提前分钟数列表（降序去重）。

    - remindLead 为数字（含数字字符串）且 >= 0 → 单档 [remindLead]；
      0 表示不提醒，由调用方按 >0 过滤后自然得到空档。
    - 缺失 / 非法（非数字、负数、NaN、bool）→ default（缺省 DEFAULT_LEADS 双档）。
    与服务端 mobile-server.mjs / 手机端 mobile.html 的 leadOf 语义对齐。
    """
    base = sorted({float(x) for x in (default or DEFAULT_LEADS)}, reverse=True)
    raw = ev.get("remindLead") if isinstance(ev, dict) else None
    if isinstance(raw, bool):
        return list(base)
    try:
        v = float(raw)
    except (TypeError, ValueError):
        return list(base)
    if v != v or v < 0 or v in (float("inf"), float("-inf")):
        return list(base)
    return [v]


def event_key(ev, d):
    """提醒去重键：id|日期|开始时间（对齐服务端 mobile-server.mjs 的 fired key）。

    含日期与 start → 事件改期后键变化，已触发记录不再误伤新时间点（改期重弹生效）。
    """
    return "%s|%s|%s" % (ev.get("id") or ev.get("title"), d.isoformat(), ev.get("start"))


def load_day(data_path, d):
    """读取数据文件，返回 (当日事件列表, 错误消息)。

    列表元素 (start_dt, key, ev) 按开始时间升序；key 见 event_key。
    err 为 None 表示读取成功（含"当日无日程"）；文件不可读 / JSON 损坏 /
    顶层结构非法时返回 ([], 错误消息)——调用方据此向用户显示损坏告警，
    不再静默当作"今日暂无日程"。
    """
    out = []
    try:
        with open(data_path, "r", encoding="utf-8-sig") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            raise ValueError("顶层不是 JSON 对象")
        events = data.get("events", [])
        if not isinstance(events, list):
            raise ValueError("events 不是数组")
        for ev in events:
            if not isinstance(ev, dict) or not ev.get("title"):
                continue
            if ev.get("type") == "task":
                continue  # 任务无起止时刻，不参与时刻提醒（侧栏展示由页面负责）
            try:
                hit = occurs_on(ev, d)
            except Exception:
                continue  # 单条事件字段非法：仅跳过该条，不遮蔽其余事件
            if hit:
                st = datetime.combine(d, parse_hhmm(ev.get("start")))
                out.append((st, event_key(ev, d), ev))
    except OSError as e:
        return [], "日程数据文件不可读：%s（%s）" % (data_path, e)
    except ValueError as e:
        return [], "日程数据文件损坏或格式非法：%s（%s）" % (data_path, e)
    out.sort(key=lambda x: x[0])
    return out, None
