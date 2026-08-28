# -*- coding: utf-8 -*-
"""headless 协议集成测试：以子进程方式运行 helper --headless，走完整 stdin/stdout JSONL 往返。"""
import json
import subprocess
import sys
import unittest
from pathlib import Path

HELPER = str(Path(__file__).resolve().parents[1] / "helper.py")


def talk(lines, extra_env=None):
    """喂入若干行，返回 (stdout 行列表, 退出码)。lines 结束后关闭 stdin。"""
    payload = "".join(json.dumps(x, ensure_ascii=False) + "\n" if isinstance(x, dict) else x + "\n" for x in lines)
    import os
    env = dict(os.environ)
    if extra_env:
        env.update(extra_env)
    p = subprocess.run(
        [sys.executable, HELPER, "--headless"],
        input=payload, capture_output=True, text=True, encoding="utf-8", timeout=20, env=env,
    )
    out = [json.loads(l) for l in p.stdout.splitlines() if l.strip()]
    return out, p.returncode, p.stderr


class HeadlessProtocolTests(unittest.TestCase):
    def test_ready_ping_config_shutdown(self):
        out, code, err = talk([
            {"protocolVersion": 1, "kind": "ping"},
            {"protocolVersion": 1, "kind": "hello"},
            {"protocolVersion": 1, "kind": "config", "dataPath": "D:/x/schedule.json",
             "hotkey": "ctrl+alt+t", "leadMinutes": [30, 10], "showOnStart": True},
            {"protocolVersion": 1, "kind": "ping"},
            {"protocolVersion": 1, "kind": "shutdown"},
        ])
        self.assertEqual(code, 0, err)
        kinds = [r["kind"] for r in out]
        self.assertEqual(kinds[0], "ready")
        self.assertEqual(kinds.count("pong"), 2)
        self.assertNotIn("error", kinds)
        for r in out:
            self.assertEqual(r["protocolVersion"], 1)
            self.assertIn("timestamp", r)

    def test_eof_exits_cleanly(self):
        out, code, err = talk([{"protocolVersion": 1, "kind": "ping"}])  # 无 shutdown，stdin 关闭
        self.assertEqual(code, 0, err)
        kinds = [r["kind"] for r in out]
        self.assertEqual(kinds[0], "ready")
        self.assertEqual(kinds.count("pong"), 1)

    def test_bad_json_and_bad_version_report_error(self):
        out, code, err = talk([
            "not-json-at-all",
            {"protocolVersion": 9, "kind": "ping"},
            {"protocolVersion": 1, "kind": "shutdown"},
        ])
        self.assertEqual(code, 0, err)
        errors = [r for r in out if r["kind"] == "error"]
        self.assertEqual(len(errors), 2)

    def test_bad_hotkey_in_config_reported(self):
        out, code, err = talk([
            {"protocolVersion": 1, "kind": "config", "hotkey": "f5"},
            {"protocolVersion": 1, "kind": "shutdown"},
        ])
        self.assertEqual(code, 0, err)
        self.assertEqual(out[-1]["kind"], "error")
        self.assertIn("hotkey", out[-1]["message"])

    def test_chinese_payload_roundtrip(self):
        out, code, err = talk([
            {"protocolVersion": 1, "kind": "config", "dataPath": "D:/日程/表.json"},
            {"protocolVersion": 1, "kind": "shutdown"},
        ])
        self.assertEqual(code, 0, err)
        self.assertNotIn("error", [r["kind"] for r in out])  # 中文路径不产生错误


if __name__ == "__main__":
    unittest.main()
