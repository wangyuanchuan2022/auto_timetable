# -*- coding: utf-8 -*-
"""测试 Toast 保活启动器：stdin=PIPE 由本进程持有 45 秒不关闭，
绕过 DSH pwsh 执行器 stdin 立即 EOF 导致 helper 0.5s 内 quit 的问题
（_eof → quit 在 after(800) 测试弹窗触发前就退出 = 测试路径静默失效）。
用法：python .qrtest/toast-keepalive.py
"""
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
helper = os.path.join(HERE, "reminder-plugin", "runtime", "helper.py")
env = dict(os.environ, DSH_TTR_TEST_TOAST="1")
p = subprocess.Popen([sys.executable, helper], stdin=subprocess.PIPE, env=env)
print("toast fired, holding stdin open 45s ...", flush=True)
time.sleep(45)
p.terminate()
print("done", flush=True)
