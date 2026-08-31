# -*- coding: utf-8 -*-
"""纯逻辑单测：occurs_on / parse_hotkey / parse_hhmm / lead_minutes / load_day。

occurs_on / parse_hhmm / lead_minutes / load_day 的单一实现在仓库根
timetable_core.py（helper.py 与 reminder_app.py 均从其 import，本测试直测核心模块）。
"""
import json
import sys
import tempfile
import unittest
from datetime import date, time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))   # runtime/（helper）
sys.path.insert(0, str(Path(__file__).resolve().parents[3]))   # 仓库根（timetable_core）

from helper import parse_hotkey, MOD_CONTROL, MOD_ALT, MOD_SHIFT  # noqa: E402
from timetable_core import (  # noqa: E402
    occurs_on, parse_hhmm, lead_minutes, load_day, event_key, DEFAULT_LEADS,
)


class OccursOnTests(unittest.TestCase):
    def test_weekly(self):
        ev = {"type": "weekly", "weekday": 1}  # 每周一
        self.assertTrue(occurs_on(ev, date(2026, 8, 24)))    # 周一
        self.assertFalse(occurs_on(ev, date(2026, 8, 25)))   # 周二
        self.assertTrue(occurs_on({"type": "weekly", "weekday": 7}, date(2026, 8, 30)))  # 周日

    def test_once(self):
        ev = {"type": "once", "date": "2026-08-27"}
        self.assertTrue(occurs_on(ev, date(2026, 8, 27)))
        self.assertFalse(occurs_on(ev, date(2026, 8, 26)))

    def test_custom_day_interval(self):
        ev = {"type": "custom", "repeat": {"interval": 2, "unit": "day", "start": "2026-08-24"}}
        for d, want in ((24, True), (25, False), (26, True), (27, False), (28, True), (30, True)):
            self.assertEqual(occurs_on(ev, date(2026, 8, d)), want, "8月%d日" % d)

    def test_custom_before_start_and_until(self):
        ev = {"type": "custom", "repeat": {"interval": 1, "unit": "day", "start": "2026-08-24", "until": "2026-08-26"}}
        self.assertFalse(occurs_on(ev, date(2026, 8, 23)))
        self.assertTrue(occurs_on(ev, date(2026, 8, 25)))
        self.assertFalse(occurs_on(ev, date(2026, 8, 27)))

    def test_custom_week_with_days(self):
        ev = {"type": "custom", "repeat": {"interval": 1, "unit": "week", "start": "2026-08-24", "days": [1, 3, 5]}}
        self.assertTrue(occurs_on(ev, date(2026, 8, 24)))   # 周一
        self.assertFalse(occurs_on(ev, date(2026, 8, 25)))  # 周二
        self.assertTrue(occurs_on(ev, date(2026, 8, 26)))   # 周三
        self.assertTrue(occurs_on(ev, date(2026, 8, 28)))   # 周五
        self.assertFalse(occurs_on(ev, date(2026, 8, 29)))  # 周六

    def test_custom_week_without_days_matches_start_weekday_only(self):
        # 回归：未指定 days 时仅匹配起始日所在星期几（此前误实现为整周任意天）
        ev = {"type": "custom", "repeat": {"interval": 1, "unit": "week", "start": "2026-08-24"}}  # 周一起始
        self.assertTrue(occurs_on(ev, date(2026, 8, 24)))   # 周一
        self.assertFalse(occurs_on(ev, date(2026, 8, 25)))  # 周二
        self.assertTrue(occurs_on(ev, date(2026, 8, 31)))   # 下周一
        ev2 = {"type": "custom", "repeat": {"interval": 2, "unit": "week", "start": "2026-08-24"}}
        self.assertFalse(occurs_on(ev2, date(2026, 8, 31)))  # 隔周：第二个周一不触发
        self.assertTrue(occurs_on(ev2, date(2026, 9, 7)))    # 第三周周一触发

    def test_custom_month(self):
        ev = {"type": "custom", "repeat": {"interval": 1, "unit": "month", "start": "2026-08-15"}}
        self.assertTrue(occurs_on(ev, date(2026, 8, 15)))
        self.assertFalse(occurs_on(ev, date(2026, 8, 16)))
        self.assertTrue(occurs_on(ev, date(2026, 9, 15)))

    def test_bad_data(self):
        self.assertFalse(occurs_on({"type": "custom", "repeat": {"start": "bad"}}, date(2026, 8, 24)))
        self.assertFalse(occurs_on({"type": "unknown"}, date(2026, 8, 24)))

    def test_deadline_cutoff(self):
        # deadline 到该日（含）为止生效
        ev = {"type": "weekly", "weekday": 1, "deadline": "2026-08-24"}
        self.assertTrue(occurs_on(ev, date(2026, 8, 24)))
        self.assertFalse(occurs_on(ev, date(2026, 8, 31)))

    def test_skip_dates(self):
        # 例外日期（停课/调休）：deadline → skip → 类型判定
        ev = {"type": "weekly", "weekday": 1, "skip": ["2026-08-31"]}  # 每周一，9/1 前的周一为 8/31
        self.assertFalse(occurs_on(ev, date(2026, 8, 31)))  # skip 命中 → 不发生
        self.assertTrue(occurs_on(ev, date(2026, 9, 7)))    # skip 未命中 → 正常发生
        once = {"type": "once", "date": "2026-08-28", "skip": ["2026-08-28"]}
        self.assertFalse(occurs_on(once, date(2026, 8, 28)))  # once 同样生效
        skip_not_str = {"type": "weekly", "weekday": 1, "skip": "2026-08-31"}  # 非列表忽略
        self.assertTrue(occurs_on(skip_not_str, date(2026, 8, 31)))

    def test_week_pattern_odd_weeks(self):
        # 单双周：start 所在周为第 1 教学周；odd=true 仅单数周（1,3,5…）发生
        ev = {"type": "weekly", "weekday": 1, "weekPattern": {"start": "2026-09-14", "odd": True}}
        self.assertTrue(occurs_on(ev, date(2026, 9, 14)))   # 第 1 周（start 所在周的周一）
        self.assertFalse(occurs_on(ev, date(2026, 9, 21)))  # 第 2 周
        self.assertTrue(occurs_on(ev, date(2026, 9, 28)))   # 第 3 周（跨 3 周验证交替）

    def test_week_pattern_even_weeks_and_edge(self):
        ev = {"type": "weekly", "weekday": 1, "weekPattern": {"start": "2026-09-14", "odd": False}}
        self.assertFalse(occurs_on(ev, date(2026, 9, 14)))  # 第 1 周
        self.assertTrue(occurs_on(ev, date(2026, 9, 21)))   # 第 2 周
        # 基准周取 start 所在周（start 为周三 9/16 → 该周周一 9/14 属第 1 周）
        ev2 = {"type": "weekly", "weekday": 1, "weekPattern": {"start": "2026-09-16", "odd": True}}
        self.assertTrue(occurs_on(ev2, date(2026, 9, 14)))
        # 早于基准周不发生
        self.assertFalse(occurs_on(ev, date(2026, 9, 7)))
        # 非法 start 视为无模式
        ev3 = {"type": "weekly", "weekday": 1, "weekPattern": {"start": "bad", "odd": True}}
        self.assertTrue(occurs_on(ev3, date(2026, 9, 21)))
        # 仅作用 weekly：custom 忽略 weekPattern
        ev4 = {"type": "custom", "weekPattern": {"start": "2026-08-24", "odd": False},
               "repeat": {"interval": 1, "unit": "day", "start": "2026-08-24"}}
        self.assertTrue(occurs_on(ev4, date(2026, 8, 24)))

    def test_skip_plus_week_pattern_combo(self):
        # 单双周允许但 skip 拦截；skip 未命中且周允许 → 发生
        ev = {"type": "weekly", "weekday": 1,
              "weekPattern": {"start": "2026-09-14", "odd": True}, "skip": ["2026-09-28"]}
        self.assertFalse(occurs_on(ev, date(2026, 9, 28)))  # 第 3 周本应发生，skip 拦截
        self.assertTrue(occurs_on(ev, date(2026, 9, 14)))   # 第 1 周且未 skip


class LeadMinutesTests(unittest.TestCase):
    """事件级 remindLead 档位（与 mobile-server / mobile.html 的 leadOf 语义对齐）。"""

    def test_explicit_zero_means_no_reminder(self):
        # 回归：0 = 明确不提醒 → 单档 [0]，调用方按 >0 过滤后为空（不得回落默认双档）
        self.assertEqual(lead_minutes({"remindLead": 0}), [0.0])

    def test_explicit_positive_single_lead(self):
        self.assertEqual(lead_minutes({"remindLead": 5}), [5.0])
        self.assertEqual(lead_minutes({"remindLead": "15"}), [15.0])  # 数字字符串同服务端 parseFloat

    def test_missing_or_invalid_falls_back_to_default(self):
        self.assertEqual(lead_minutes({}), list(DEFAULT_LEADS))
        self.assertEqual(lead_minutes({"remindLead": "abc"}), list(DEFAULT_LEADS))
        self.assertEqual(lead_minutes({"remindLead": -3}), list(DEFAULT_LEADS))
        self.assertEqual(lead_minutes({"remindLead": True}), list(DEFAULT_LEADS))  # bool 不当数字

    def test_default_override(self):
        # helper.py 的可配置默认档（config leadMinutes）作为回落值
        self.assertEqual(lead_minutes({}, [15]), [15.0])
        self.assertEqual(lead_minutes({"remindLead": 7}, [30, 10]), [7.0])  # 事件级优先


class HotkeyTests(unittest.TestCase):
    def test_valid(self):
        self.assertEqual(parse_hotkey("ctrl+f5"), (MOD_CONTROL, 0x74))
        self.assertEqual(parse_hotkey("Ctrl+F5"), (MOD_CONTROL, 0x74))
        self.assertEqual(parse_hotkey("ctrl+alt+t"), (MOD_CONTROL | MOD_ALT, 0x54))
        self.assertEqual(parse_hotkey("ctrl+shift+1"), (MOD_CONTROL | MOD_SHIFT, 0x31))
        self.assertEqual(parse_hotkey("ctrl+f12"), (MOD_CONTROL, 0x7B))

    def test_invalid(self):
        self.assertIsNone(parse_hotkey("f5"))            # 无修饰键
        self.assertIsNone(parse_hotkey("ctrl+xyz"))
        self.assertIsNone(parse_hotkey(""))
        self.assertIsNone(parse_hotkey("ctrl+f13"))
        self.assertIsNone(parse_hotkey("ctrl"))


class ParseTimeTests(unittest.TestCase):
    def test_parse_hhmm(self):
        self.assertEqual(parse_hhmm("08:00"), time(8, 0))
        self.assertEqual(parse_hhmm("09:40"), time(9, 40))
        self.assertEqual(parse_hhmm("23:59"), time(23, 59))
        self.assertEqual(parse_hhmm(None), time(8, 0))  # 默认
        self.assertEqual(parse_hhmm("bad"), time(8, 0))  # 容错


class LoadDayTests(unittest.TestCase):
    def _write(self, text):
        f = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8")
        f.write(text)
        f.close()
        self.addCleanup(Path(f.name).unlink)
        return f.name

    def _write_events(self, events):
        return self._write(json.dumps({"events": events}, ensure_ascii=False))

    def test_filter_sort_and_fields(self):
        path = self._write_events([
            {"id": "b", "title": "下午事", "type": "once", "date": "2026-08-27", "start": "15:00"},
            {"id": "a", "title": "上午事", "type": "once", "date": "2026-08-27", "start": "08:30"},
            {"id": "c", "title": "别的天", "type": "once", "date": "2026-08-28", "start": "09:00"},
            {"id": "d", "title": "", "type": "once", "date": "2026-08-27", "start": "10:00"},
        ])
        out, err = load_day(path, date(2026, 8, 27))
        self.assertIsNone(err)
        # 键格式：id|日期|start（对齐服务端 mobile-server.mjs 的 fired key）
        self.assertEqual([k for _, k, _ in out], ["a|2026-08-27|08:30", "b|2026-08-27|15:00"])
        self.assertEqual(out[0][0].hour, 8)
        self.assertEqual(out[0][0].minute, 30)

    def test_empty_day_and_bad_file(self):
        path = self._write_events([{"id": "x", "title": "t", "type": "once", "date": "2026-08-26", "start": "09:00"}])
        out, err = load_day(path, date(2026, 8, 27))
        self.assertEqual(out, [])  # 当日无日程 → 空表
        self.assertIsNone(err)     # 但不是错误
        out2, err2 = load_day("Z:/not/exist.json", date(2026, 8, 27))
        self.assertEqual(out2, [])  # 坏文件 → 空表不抛错
        self.assertTrue(err2)       # 且返回错误消息（供 UI 显示损坏告警）

    def test_missing_id_fallback_key(self):
        path = self._write_events([{"title": "无ID", "type": "once", "date": "2026-08-27", "start": "09:00"}])
        out, err = load_day(path, date(2026, 8, 27))
        self.assertIsNone(err)
        self.assertEqual(out[0][1], "无ID|2026-08-27|09:00")

    def test_corrupt_json_and_bad_structure_report_error(self):
        corrupt = self._write('{"events": [')  # JSON 截断
        _, err = load_day(corrupt, date(2026, 8, 27))
        self.assertIn("损坏", err)
        notobj = self._write('[1, 2]')  # 顶层非对象
        _, err2 = load_day(notobj, date(2026, 8, 27))
        self.assertTrue(err2)
        badevents = self._write('{"events": {"a": 1}}')  # events 非数组
        _, err3 = load_day(badevents, date(2026, 8, 27))
        self.assertTrue(err3)

    def test_key_changes_on_reschedule(self):
        # 回归：改期（start 变）后键变化 → 已触发记录不再误伤新时间点（改期重弹生效）
        d = date(2026, 8, 27)
        k1 = event_key({"id": "e1", "title": "课", "start": "08:00"}, d)
        k2 = event_key({"id": "e1", "title": "课", "start": "10:00"}, d)
        self.assertNotEqual(k1, k2)
        # 跨日也换键（日期入键）
        self.assertNotEqual(
            event_key({"id": "e1", "title": "课", "start": "08:00"}, d),
            event_key({"id": "e1", "title": "课", "start": "08:00"}, date(2026, 8, 28)))

    def test_single_bad_event_skipped_not_fatal(self):
        # 单条事件字段非法（weekday 非数字）→ 仅跳过该条，其余照常且不报 err
        path = self._write_events([
            {"id": "bad", "title": "坏数据", "type": "weekly", "weekday": "x", "start": "08:00"},
            {"id": "ok", "title": "正常", "type": "once", "date": "2026-08-27", "start": "09:00"},
        ])
        out, err = load_day(path, date(2026, 8, 27))
        self.assertIsNone(err)
        self.assertEqual([k for _, k, _ in out], ["ok|2026-08-27|09:00"])


if __name__ == "__main__":
    unittest.main()
