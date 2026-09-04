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


def _wait_ready(replies, timeout=6.0):
    """轮询等待 helper 发出 ready（GUI 冷启动含 tkinter/maliang 导入与建窗，
    耗时波动大——固定 sleep 在负载高时会偶发超预算）。"""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if any(r.get("kind") == "ready" for r in replies):
            return True
        time.sleep(0.1)
    return any(r.get("kind") == "ready" for r in replies)


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
            self.assertTrue(_wait_ready(replies))  # 等窗口起来 + ready
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
        self.assertTrue(_wait_ready(replies))  # GUI 冷启动耗时有波动，轮询等 ready
        p.stdin.close()  # 宿主关闭 stdin → helper 应退出
        rc = p.wait(timeout=8)
        if p.poll() is None:
            p.kill()
        self.assertEqual(rc, 0)
        self.assertIn("ready", [r.get("kind") for r in replies])


if __name__ == "__main__":
    unittest.main()
