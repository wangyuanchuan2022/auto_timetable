# -*- coding: utf-8 -*-
"""
当日日程提醒 · 桌面应用
- 主窗口：列出当日日程（按开始时间升序），显示开始时间与标题（含地点/类型）
- 提醒：每条日程开始前 30 分钟、10 分钟各弹窗一次；过期时间点自动跳过；每点仅触发一次
- 后台常驻：主窗口隐藏/关闭后提醒照常触发
- 全局快捷键 Ctrl+F5：任意应用前台时可用，切换主窗口显示/隐藏
- 数据：与本目录网页版时间表共用 schedule.json（支持每周重复/一次性/自定义间隔）

启动：python reminder_app.py   （或双击 start_reminder.bat）
退出：主窗口内点「退出」按钮（关闭窗口 = 隐藏，进程继续提醒）
"""
import json
import os
import sys
import queue
import threading
import ctypes
import ctypes.wintypes as wintypes
from datetime import datetime, date, time as dtime, timedelta
import tkinter as tk
from tkinter import font as tkfont

# ---------------- Win32 全局快捷键 ----------------
MOD_CONTROL = 0x0002
VK_F5 = 0x74
WM_HOTKEY = 0x0312
HOTKEY_ID = 1


def hotkey_thread(msg_q: queue.Queue):
    """后台线程：注册 Ctrl+F5，收到热键消息后向主线程队列投递事件。"""
    user32 = ctypes.windll.user32
    ok = user32.RegisterHotKey(None, HOTKEY_ID, MOD_CONTROL, VK_F5)
    if not ok:
        msg_q.put(("hotkey_fail", "Ctrl+F5 注册失败（可能被其他程序占用）"))
        return
    msg = wintypes.MSG()
    try:
        while True:
            ret = user32.GetMessageW(ctypes.byref(msg), None, 0, 0)
            if ret == 0 or ret == -1:  # WM_QUIT 或错误
                break
            if msg.message == WM_HOTKEY and msg.wParam == HOTKEY_ID:
                msg_q.put(("hotkey", None))
    finally:
        user32.UnregisterHotKey(None, HOTKEY_ID)


# ---------------- 日程数据（与网页版 schedule.json 同一格式） ----------------
TYPE_LABEL = {"weekly": "每周重复", "once": "一次性", "custom": "自定义间隔"}


def parse_hhmm(s, default="08:00"):
    try:
        parts = str(s or default).split(":")
        return dtime(int(parts[0]), int(parts[1] if len(parts) > 1 else 0))
    except Exception:
        return dtime(8, 0)


def occurs_on(ev, d: date) -> bool:
    """事件是否发生在日期 d（weekly: 周几 1=周一..7=周日；once: 具体日期；custom: 间隔规则）。"""
    t = ev.get("type", "once")
    ds = d.isoformat()
    if t == "weekly":
        return d.weekday() + 1 == int(ev.get("weekday", 1))
    if t == "once":
        return ev.get("date") == ds
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
            return d.weekday() + 1 == s.weekday() + 1
        if unit == "month":
            months = (d.year - s.year) * 12 + (d.month - s.month)
            return months % interval == 0 and d.day == s.day
    return False


def load_today(data_path):
    """读取数据文件，返回当日事件列表 [(start_dt, key, ev), ...]，按开始时间升序。读取失败返回空表。"""
    today = date.today()
    out = []
    try:
        with open(data_path, "r", encoding="utf-8-sig") as f:
            data = json.load(f)
        for ev in data.get("events", []):
            if not isinstance(ev, dict) or not ev.get("title"):
                continue
            if occurs_on(ev, today):
                st = datetime.combine(today, parse_hhmm(ev.get("start")))
                key = ev.get("id") or (str(ev.get("title")) + "|" + str(ev.get("start")))
                out.append((st, key, ev))
    except Exception:
        return []
    out.sort(key=lambda x: x[0])
    return out


# ---------------- 主应用 ----------------
class App:
    def __init__(self, root: tk.Tk, data_path: str):
        self.root = root
        self.data_path = data_path
        self.started_at = datetime.now()
        self.fired = set()          # 已触发/已跳过的提醒点 {(event_key, offset_min)}
        self.msg_q = queue.Queue()
        self.popups = []

        root.title("当日日程提醒")
        root.geometry("420x440")
        root.minsize(320, 240)

        title_font = tkfont.Font(size=13, weight="bold")
        self.head = tk.Label(root, text="", font=title_font, anchor="w")
        self.head.pack(fill="x", padx=12, pady=(10, 0))
        self.sub = tk.Label(root, text="", fg="#888", anchor="w", justify="left")
        self.sub.pack(fill="x", padx=12)

        self.list_wrap = tk.Frame(root)
        self.list_wrap.pack(fill="both", expand=True, padx=12, pady=8)

        btns = tk.Frame(root)
        btns.pack(fill="x", padx=12, pady=(0, 10))
        tk.Button(btns, text="隐藏窗口（Ctrl+F5）", command=self.hide).pack(side="left")
        tk.Button(btns, text="刷新", command=lambda: self.refresh(True)).pack(side="left", padx=8)
        tk.Button(btns, text="退出程序", fg="#c00", command=self.quit).pack(side="right")

        root.protocol("WM_DELETE_WINDOW", self.hide)  # 关闭 = 隐藏，进程常驻继续提醒

        self.after_setup()
        threading.Thread(target=hotkey_thread, args=(self.msg_q,), daemon=True).start()
        self.refresh(True)

    # ---- 计时 ----
    def after_setup(self):
        self.root.after(80, self.pump_queue)
        now = datetime.now()
        delay_ms = int((60 - now.second + 0.2) * 1000)  # 对齐到下一分钟边界
        self.root.after(delay_ms, self.minute_tick)

    def minute_tick(self):
        try:
            self.check_reminders()
            self.refresh(False)
        finally:
            now = datetime.now()
            self.root.after(int((60 - now.second + 0.2) * 1000), self.minute_tick)

    def pump_queue(self):
        try:
            while True:
                kind, payload = self.msg_q.get_nowait()
                if kind == "hotkey":
                    self.toggle_window()
                elif kind == "hotkey_fail":
                    self.set_sub("（" + payload + "）")
        except queue.Empty:
            pass
        self.root.after(80, self.pump_queue)

    # ---- 提醒 ----
    def check_reminders(self):
        now = datetime.now()
        for st, key, ev in load_today(self.data_path):
            for off in (30, 10):
                point = (key, off)
                if point in self.fired:
                    continue
                rtime = st - timedelta(minutes=off)
                if rtime <= now:
                    self.fired.add(point)
                    if rtime > self.started_at:  # 启动时已过期的提醒点：跳过不弹
                        self.popup(ev, st, off)

    def popup(self, ev, start_dt, off):
        win = tk.Toplevel(self.root)
        win.title("日程提醒")
        win.attributes("-topmost", True)
        frm = tk.Frame(win, padx=18, pady=14)
        frm.pack()
        left = int((start_dt - datetime.now()).total_seconds() // 60)
        tk.Label(frm, text="⏰ " + TYPE_LABEL.get(ev.get("type", "once"), ""), fg="#3964fe").pack(anchor="w")
        tk.Label(frm, text=str(ev.get("title", "")), font=("", 14, "bold"), wraplength=300).pack(anchor="w", pady=4)
        info = "开始时间 %s（还有约 %d 分钟）" % (start_dt.strftime("%H:%M"), max(left, 0))
        if ev.get("location"):
            info += "\n地点：" + str(ev["location"])
        tk.Label(frm, text=info, justify="left", fg="#555").pack(anchor="w")
        b = tk.Frame(frm)
        b.pack(pady=(10, 0))
        tk.Button(b, text="知道了", command=win.destroy).pack(side="left")
        tk.Button(b, text="显示主窗口", command=lambda: (win.destroy(), self.show())).pack(side="left", padx=8)
        win.protocol("WM_DELETE_WINDOW", win.destroy)
        win.after(90_000, win.destroy)  # 90 秒未处理自动关闭
        try:
            win.focus_force()
        except Exception:
            pass
        self.popups = [p for p in self.popups if p.winfo_exists()]
        self.popups.append(win)

    # ---- 列表 ----
    def refresh(self, manual):
        today = date.today()
        self.head.config(text="今日日程 · %s（周%s）" % (today.strftime("%Y-%m-%d"), "一二三四五六日"[today.weekday()]))
        for w in self.list_wrap.winfo_children():
            w.destroy()
        events = load_today(self.data_path)
        if not events:
            tk.Label(self.list_wrap, text="今日暂无日程", fg="#999").pack(pady=30)
        now = datetime.now()
        for st, key, ev in events:
            row = tk.Frame(self.list_wrap)
            row.pack(fill="x", pady=2)
            past = st <= now
            color = "#bbb" if past else "#000"
            tk.Label(row, text=st.strftime("%H:%M"), width=6, anchor="w",
                     font=("", 11, "bold"), fg=("#aaa" if past else "#3964fe")).pack(side="left")
            txt = str(ev.get("title", ""))
            if ev.get("location"):
                txt += " · " + str(ev["location"])
            txt += "  [%s]" % TYPE_LABEL.get(ev.get("type", "once"), ev.get("type"))
            tk.Label(row, text=txt, anchor="w", fg=color).pack(side="left", fill="x", expand=True)
        nxt = self.next_reminder_text(events, now)
        self.set_sub("提醒：开始前 30/10 分钟各一次 · " + nxt + "\n数据：%s（每分钟自动重读，可外部编辑）\nCtrl+F5 显示/隐藏 · 关闭窗口仅隐藏，退出请点「退出程序」" % os.path.basename(self.data_path))

    def next_reminder_text(self, events, now):
        best = None
        for st, key, ev in events:
            for off in (30, 10):
                rtime = st - timedelta(minutes=off)
                if rtime > now and (key, off) not in self.fired:
                    if best is None or rtime < best:
                        best = rtime
        if best is None:
            return "今日无待触发提醒"
        return "下次提醒 %s" % best.strftime("%H:%M")

    def set_sub(self, text):
        self.sub.config(text=text)

    # ---- 窗口切换 ----
    def is_visible(self):
        try:
            return bool(self.root.winfo_viewable())
        except Exception:
            return self.root.state() != "withdrawn"

    def show(self):
        self.root.deiconify()
        self.root.lift()
        try:
            self.root.attributes("-topmost", True)
            self.root.after(200, lambda: self.root.attributes("-topmost", False))
            self.root.focus_force()
        except Exception:
            pass
        self.refresh(False)

    def hide(self):
        self.root.withdraw()

    def toggle_window(self):
        if self.is_visible():
            self.hide()
        else:
            self.show()

    def quit(self):
        try:
            ctypes.windll.user32.PostThreadMessageW(
                ctypes.windll.kernel32.GetCurrentThreadId(), 0x0012, 0, 0)  # 通知热键线程退出（尽力而为）
        except Exception:
            pass
        self.root.destroy()


def main():
    data_path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "schedule.json")
    root = tk.Tk()
    App(root, data_path)
    root.mainloop()


if __name__ == "__main__":
    main()
