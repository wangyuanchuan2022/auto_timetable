# -*- coding: utf-8 -*-
"""纯逻辑单测：occurs_on / parse_hotkey / parse_hhmm / load_day。"""
import json
import sys
import tempfile
import unittest
from datetime import date, time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from helper import occurs_on, parse_hotkey, parse_hhmm, load_day, MOD_CONTROL, MOD_ALT, MOD_SHIFT  # noqa: E402


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
    def _write(self, events):
        f = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8")
        json.dump({"events": events}, f, ensure_ascii=False)
        f.close()
        self.addCleanup(Path(f.name).unlink)
        return f.name

    def test_filter_sort_and_fields(self):
        path = self._write([
            {"id": "b", "title": "下午事", "type": "once", "date": "2026-08-27", "start": "15:00"},
            {"id": "a", "title": "上午事", "type": "once", "date": "2026-08-27", "start": "08:30"},
            {"id": "c", "title": "别的天", "type": "once", "date": "2026-08-28", "start": "09:00"},
            {"id": "d", "title": "无标题丢弃", "type": "once", "date": "2026-08-27", "start": "10:00", "title": ""},
        ])
        out = load_day(path, date(2026, 8, 27))
        self.assertEqual([k for _, k, _ in out], ["a", "b"])
        self.assertEqual(out[0][0].hour, 8)
        self.assertEqual(out[0][0].minute, 30)

    def test_empty_day_and_bad_file(self):
        path = self._write([{"id": "x", "title": "t", "type": "once", "date": "2026-08-26", "start": "09:00"}])
        self.assertEqual(load_day(path, date(2026, 8, 27)), [])  # 当日无日程 → 空表
        self.assertEqual(load_day("Z:/not/exist.json", date(2026, 8, 27)), [])  # 坏文件 → 空表不抛错

    def test_missing_id_fallback_key(self):
        path = self._write([{"title": "无ID", "type": "once", "date": "2026-08-27", "start": "09:00"}])
        out = load_day(path, date(2026, 8, 27))
        self.assertEqual(out[0][1], "无ID|09:00")


if __name__ == "__main__":
    unittest.main()
