# -*- coding: utf-8 -*-
"""GUI 模式冒烟测试：真实拉起 tkinter 窗口，验证 ready/show/hide/shutdown 全链路。
（会短暂弹出窗口；仅验证协议与生命周期，不做像素断言。）"""
import json
import subprocess
import sys
import threading
import time
import unittest
from pathlib import Path

HELPER = str(Path(__file__).resolve().parents[1] / "helper.py")


class GuiSmokeTests(unittest.TestCase):
    def test_gui_lifecycle(self):
        p = subprocess.Popen(
            [sys.executable, HELPER],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding="utf-8",
        )
        replies = []

        def reader():
            for line in p.stdout:
                line = line.strip()
                if line:
                    try:
                        replies.append(json.loads(line))
                    except Exception:
                        replies.append({"kind": "raw", "line": line})

        threading.Thread(target=reader, daemon=True).start()

        def send(obj):
            p.stdin.write(json.dumps(obj) + "\n")
            p.stdin.flush()

        try:
            time.sleep(1.2)  # 等窗口起来 + ready
            send({"protocolVersion": 1, "kind": "ping"})
            time.sleep(0.4)
            send({"protocolVersion": 1, "kind": "hide"})
            time.sleep(0.3)
            send({"protocolVersion": 1, "kind": "show"})
            time.sleep(0.4)
            send({"protocolVersion": 1, "kind": "shutdown"})
            rc = p.wait(timeout=8)
        finally:
            if p.poll() is None:
                p.kill()

        kinds = [r.get("kind") for r in replies]
        self.assertEqual(rc, 0, replies)
        self.assertIn("ready", kinds)
        self.assertGreaterEqual(kinds.count("pong"), 1)
        self.assertNotIn("error", kinds)

    def test_gui_eof_exits(self):
        p = subprocess.Popen(
            [sys.executable, HELPER],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding="utf-8",
        )
        replies = []

        def reader():
            for line in p.stdout:
                if line.strip():
                    try:
                        replies.append(json.loads(line))
                    except Exception:
                        pass

        threading.Thread(target=reader, daemon=True).start()
        time.sleep(1.2)
        p.stdin.close()  # 宿主关闭 stdin → helper 应退出
        rc = p.wait(timeout=8)
        if p.poll() is None:
            p.kill()
        self.assertEqual(rc, 0)
        self.assertIn("ready", [r.get("kind") for r in replies])


if __name__ == "__main__":
    unittest.main()
