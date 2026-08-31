# -*- coding: utf-8 -*-
"""dsh-timetable-reminder · Python helper（参考 dsh-dafeiyu runtime/helper.py 的进程模型）

DSH 插件宿主拥有本进程：stdin 按行收 JSON 命令，stdout 按行回 JSON 应答。
stdin 关闭即退出（生命周期信号），用户主动退出时回报 CLOSED（宿主不再重启）。

UI 全部基于 maliang（https://xiaokang2022.github.io/maliang-docs/3.1/）实现：
- 主窗口：ma.Tk + ma.Canvas + ma.Label/ma.Button（Win11 深色卡片）
- 提醒弹窗：ma.Toplevel + 真·亚克力模糊（theme.apply_theme, 需 pywinstyles）
- 亚克力不可用时回退半透明圆角卡片，功能不受影响

功能：
- 主窗口列出当日日程（按开始时间升序），Windows 11 风格
- 按事件级 remindLead 提前 Toast（缺失/非法时默认 30、10 双档；0 明确不提醒）；
  启动时已过期的提醒点跳过
- Toast：右下角滑入、堆叠、悬停暂停、底部进度条（对齐 Windows 原生通知）
- 窗口隐藏/关闭后提醒照常触发；全局快捷键（默认 Ctrl+Alt+T）切换主窗口显隐
- 数据文件每分钟自动重读，支持外部编辑（与网页版共用 schedule.json）；
  领域判定（occurs_on / 提醒档位 / 读取）统一来自仓库根 timetable_core.py 单一实现

--headless：仅运行协议循环（无 GUI），供自动化测试使用。
"""
from __future__ import annotations

import argparse
import ctypes
import ctypes.wintypes as wintypes
import json
import math
import os
import queue
import sys
import threading
import time as _time
from datetime import datetime, date, timedelta

import tkinter as tk

import maliang as ma
from maliang import theme as ma_theme

# 领域判定单一实现：仓库根目录 timetable_core.py（与独立版 reminder_app.py 共享，禁止双源）。
# 部署前提：保留仓库根目录与 reminder-plugin/ 的相对目录结构（link: 安装即满足）。
sys.path.insert(0, os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")))
try:
    from timetable_core import occurs_on, lead_minutes, load_day
except ImportError as _core_err:  # 结构不完整时给出可诊断的退出原因（宿主会记为启动失败）
    print("timetable helper: timetable_core.py 加载失败：%s" % _core_err, file=sys.stderr)
    raise SystemExit(1)

PROTOCOL_VERSION = 1

# ---------------- Windows 11 玻璃质感调色板（与 maliang 深色主题一致） ----------------
C_BG = "#202020"        # 主窗口背景（maliang dark 默认）
C_CARD = "#2B2B2B"      # 卡片 / Toast 背景（maliang LabelStyle dark）
C_BORDER = "#3D3D3D"
C_TEXT = "#F1F1F1"
C_SUB = "#CFCFCF"
C_MUTE = "#9A9A9A"
C_ACCENT = "#4CC2FF"    # Win11 强调色
C_ACCENT_BT = "#0078D4" # 主按钮
C_DANGER = "#FF7A70"
MAGIC = "#010203"       # 透明色（回退模式的圆角实现）
TASKBAR = 56            # 底部任务栏预留

GLASS_ALPHA = 0.92      # 回退模式主窗口半透明度

# ---------------- 版式规范：4px 间距栅格 + 三级字号层级 ----------------
# 间距（逻辑 px，经 sc() 缩放，全部为 4 的倍数）
PAD = 16     # 窗口 / 卡片统一内边距
GAP_S = 8    # 行内小间距 / 卡片间隙
GAP_M = 12   # 组内间距（标题与辅助行等）
GAP_L = 16   # 区块间距（标题区与分隔线、列表与底栏等）
# 字号层级（Segoe UI Variable → Segoe UI 回退；逻辑 pt）
FS_CAPTION = 15   # 辅助文本：标题栏应用名、日期行、卡片元信息、Toast 头部/地点
FS_BODY = 16      # 正文：卡片标题、时间行、按钮、信息行
FS_TIME = 18      # 卡片时间（强调，bold）
FS_TITLE = 22     # 页面主标题（bold）
# ---- 弹窗（Toast/Dialog）专用字号 ----
FS_DLG_CAPTION = 15    # 辅助行：应用名 / 地点
FS_DLG_BODY = 16.5     # 正文：时间行
FS_DLG_TITLE = 16.5    # 弹窗标题（bold）
# 圆角：Microsoft Learn《Geometry in Windows 11》窗口/浮层 8px
DLG_RADIUS = 8
# 回退底色：WinUI Acrylic 关闭透明时的实心填充（深色 ≈ #2B2B2B，不透明）
DLG_FALLBACK_BG = "#2B2B2B"

# ---------------- 高 DPI（防模糊） ----------------
SCALE = 1.0  # 系统缩放系数；声明 DPI 感知后按实际 DPI 放大 UI
FONT = "Segoe UI"  # 在 Tk 创建后升级为 Segoe UI Variable（Windows 11 系统字体，缺失时自动回退）


def pick_font_family(root):
    """优先使用 Windows 11 系统字体 Segoe UI Variable，老系统回退 Segoe UI。"""
    try:
        fams = set(root.tk.call("font", "families"))
        for fam in ("Segoe UI Variable Text", "Segoe UI Variable Display"):
            if fam in fams:
                return fam
        if "Segoe UI" in fams:
            return "Segoe UI"
    except Exception:
        pass
    return "Segoe UI"


def sc(x):
    return int(round(x * SCALE))


def win_move(win, x, y):
    """移动窗口；兼容 maliang 的关键字 geometry()。"""
    try:
        win.geometry(position=(x, y))
    except TypeError:
        try:
            win.geometry("+%d+%d" % (x, y))
        except Exception:
            pass


def win_resize(win, w, h, x=None, y=None):
    """设置窗口尺寸（可选位置）；兼容 maliang / 原生 tk。"""
    try:
        win.geometry(size=(w, h), position=(x, y) if x is not None else None)
    except TypeError:
        try:
            geo = "%dx%d" % (w, h)
            if x is not None:
                geo += "+%d+%d" % (x, y)
            win.geometry(geo)
        except Exception:
            pass


def enable_dpi_awareness():
    """让进程按显示器原生像素渲染。未声明时 Windows 会拉伸位图导致窗口模糊。"""
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)  # PER_MONITOR_DPI_AWARE
    except Exception:
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except Exception:
            pass


def detect_ui_scale():
    try:
        dpi = ctypes.windll.user32.GetDpiForSystem()
        if dpi and dpi > 0:
            return dpi / 96.0
    except Exception:
        pass
    try:
        hdc = ctypes.windll.user32.GetDC(0)
        dpi = ctypes.windll.gdi32.GetDeviceCaps(hdc, 88)  # LOGPIXELSX
        ctypes.windll.user32.ReleaseDC(0, hdc)
        if dpi and dpi > 0:
            return dpi / 96.0
    except Exception:
        pass
    return 1.0

# ---------------- maliang 控件工厂 ----------------

def _cv_bg(cv):
    try:
        return cv["bg"]
    except Exception:
        return C_BG


FONT_SCALE = 1.0  # Ctrl+滚轮 缩放系数（0.7~1.8，作用于所有 mlabel 字号）


def fsc(pt):
    """字号 = 逻辑 pt × DPI 缩放 × 用户缩放（Ctrl+滚轮）。"""
    return max(8, int(round(sc(pt) * FONT_SCALE)))


def zsc(px):
    """布局尺寸随字号基准与用户缩放同步放大（动态取值，供缩放重建）。"""
    k = max(1.0, FS_BODY / 11.0) * max(1.0, FONT_SCALE)
    return int(sc(px) * k)


def mlabel(cv, pos, size=None, text="", fg=C_TEXT, bg=None, ol=None,
           size_text=10, bold=False, anchor="nw", justify="left"):
    """ma.Label：文字标签。bg/ol 传 None 时芯片与画布背景同色（隐形芯片，仅文字可见）。"""
    lbl = ma.Label(cv, pos, size, text=text, family=FONT, fontsize=fsc(size_text),
                   weight="bold" if bold else "normal", anchor=anchor, justify=justify)
    base = bg if bg is not None else _cv_bg(cv)
    lbl.style.set("dark", fg=fg, bg=base, ol=ol if ol is not None else base)
    return lbl


def try_dwm_round_corners(window):
    """Win11 DWMWCP_ROUND：请求系统给窗口圆角（对无边框窗口尽力而为）。"""
    try:
        hwnd = ctypes.windll.user32.GetParent(window.winfo_id())
        val = ctypes.c_int(2)  # DWMWCP_ROUND
        ctypes.windll.dwmapi.DwmSetWindowAttribute(hwnd, 33, ctypes.byref(val), ctypes.sizeof(val))
    except Exception:
        pass


class _ACCENT_POLICY(ctypes.Structure):
    _fields_ = [("AccentState", wintypes.DWORD), ("AccentFlags", wintypes.DWORD),
                ("GradientColor", wintypes.DWORD), ("AnimationId", wintypes.DWORD)]


class _WCA_DATA(ctypes.Structure):
    _fields_ = [("Attribute", wintypes.DWORD), ("Data", ctypes.POINTER(_ACCENT_POLICY)),
                ("SizeOfData", wintypes.ULONG)]


def set_acrylic_blur(hwnd, tint=0xCC202020):
    """手动实现亚克力：SetWindowCompositionAttribute(WCA_ACCENT_POLICY=19,
    ACCENT_ENABLE_ACRYLICBLURBEHIND=4) + DwmExtendFrameIntoClientArea。

    注：pywinstyles 1.8 的 acrylic 分支把 Attribute 误传为 30（应为 19），
    经 maliang.theme.apply_theme 调用时实际不生效，故此处直接 ctypes 实现。
    tint 为 AARRGGBB：CC(80% 不透明) 的 #202020 深色染色，近似 WinUI
    AcrylicBackgroundFillColorDefault（深色）。"""
    pol = _ACCENT_POLICY(4, 0, tint, 0)          # 4 = ACCENT_ENABLE_ACRYLICBLURBEHIND
    data = _WCA_DATA(19, ctypes.pointer(pol), ctypes.sizeof(pol))  # 19 = WCA_ACCENT_POLICY
    ok = ctypes.windll.user32.SetWindowCompositionAttribute(hwnd, ctypes.byref(data))
    if not ok:
        return False
    margins = (ctypes.c_int * 4)(-1, -1, -1, -1)  # 玻璃框架扩展至整个客户区
    ctypes.windll.dwmapi.DwmExtendFrameIntoClientArea(hwnd, ctypes.byref(margins))
    return True


def try_apply_acrylic(window):
    """对窗口应用磨砂玻璃（tkinter/GDI 窗口的可达上限）：

    1. apply_borderless_frame：改造为「有框无边栏」窗口（WS_THICKFRAME 去标题栏）
       → DWM 绘制系统 8px 圆角 + 真实投影 + 深色边框
    2. set_acrylic_blur：ACCENT_ENABLE_ACRYLICBLURBEHIND 亚克力模糊 + 深色染色

    注：Win11 的 DWMWA_SYSTEM_BACKDROP_TYPE（38，Win 键面板同源材质）对 GDI
    窗口无视觉效果——它要求 DirectComposition 内容（像素带 alpha），而 tkinter
    每个像素都不透明，会直接盖住材质，API 却仍返回成功。故不采用。"""
    hwnd = apply_borderless_frame(window)
    if hwnd:
        if set_acrylic_blur(hwnd, tint=0xD9202020):
            window.configure(bg="#000000")
            return True
    try:
        window.update_idletasks()
        window.update()
        hwnd = ctypes.windll.user32.GetParent(window.winfo_id())
        if not hwnd:
            return False
        if not set_acrylic_blur(hwnd, tint=0xD9202020):
            return False
        window.configure(bg="#000000")
        return True
    except Exception:
        return False


# ---- Win11 系统 backdrop（Shell 同源材质） ----
GWL_STYLE = -16
GWL_EXSTYLE = -20
WS_THICKFRAME = 0x00040000
WS_SYSMENU = 0x00080000
WS_CAPTION = 0x00C00000
WS_MINIMIZEBOX = 0x00020000
WS_MAXIMIZEBOX = 0x00010000
WS_EX_TOOLWINDOW = 0x00000080
SWP_NOSIZE = 0x0001
SWP_NOMOVE = 0x0002
SWP_NOZORDER = 0x0004
SWP_NOACTIVATE = 0x0010
SWP_FRAMECHANGED = 0x0020
DWMWA_USE_IMMERSIVE_DARK_MODE = 20
DWMWA_WINDOW_CORNER_PREFERENCE = 33


def _dwm_set(hwnd, attr, value):
    val = ctypes.c_int(value)
    return ctypes.windll.dwmapi.DwmSetWindowAttribute(
        hwnd, attr, ctypes.byref(val), ctypes.sizeof(val)) == 0


def apply_borderless_frame(window):
    """改造为「有框无边栏」窗口：保留 WS_THICKFRAME、去掉 WS_CAPTION。

    - DWM 依 thickframe 绘制系统 8px 圆角（DWMWCP_ROUND）与投影阴影
    - 深色沉浸模式（边框/标题区按深色渲染）
    - WS_EX_TOOLWINDOW：不进任务栏/Alt+Tab（同系统弹窗行为）
    返回 hwnd（失败返回 None）。"""
    try:
        window.overrideredirect(False)
        window.attributes("-topmost", True)
        window.update_idletasks()
        window.update()
        user32 = ctypes.windll.user32
        hwnd = user32.GetParent(window.winfo_id())
        if not hwnd:
            return None
        # 有框无边栏：DWM 需要 thickframe 才绘制圆角/阴影，但不显示标题栏
        style = user32.GetWindowLongW(hwnd, GWL_STYLE)
        style = (style | WS_THICKFRAME | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX) & ~WS_CAPTION
        user32.SetWindowLongW(hwnd, GWL_STYLE, style)
        ex = user32.GetWindowLongW(hwnd, GWL_EXSTYLE)
        user32.SetWindowLongW(hwnd, GWL_EXSTYLE, ex | WS_EX_TOOLWINDOW)
        user32.SetWindowPos(hwnd, 0, 0, 0, 0, 0,
                            SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED)
        window.update()
        _dwm_set(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, 1)
        _dwm_set(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, 2)  # DWMWCP_ROUND（8px）
        return hwnd
    except Exception:
        return None


def round_rect(cv, x1, y1, x2, y2, r, **kw):
    """精确圆角矩形：每角按圆弧采样多边形（非 smooth 样条近似），
    配合 -transparentcolor 抠角，圆角肉眼与系统 8px 一致。"""
    pts = []

    def arc(cx, cy, a0, a1, steps=8):
        for i in range(steps + 1):
            a = math.pi * (a0 + (a1 - a0) * i / steps) / 180.0
            pts.extend((cx + r * math.cos(a), cy + r * math.sin(a)))

    arc(x1 + r, y1 + r, 180, 270)   # 左上
    arc(x2 - r, y1 + r, 270, 360)   # 右上
    arc(x2 - r, y2 - r, 0, 90)      # 右下
    arc(x1 + r, y2 - r, 90, 180)    # 左下
    return cv.create_polygon(pts, **kw)

# ---------------- Win32 全局快捷键 ----------------
MOD_ALT = 0x0001
MOD_CONTROL = 0x0002
MOD_SHIFT = 0x0004
MOD_WIN = 0x0008
WM_HOTKEY = 0x0312
WM_QUIT = 0x0012
HOTKEY_ID = 1

MOD_MAP = {"ctrl": MOD_CONTROL, "control": MOD_CONTROL, "alt": MOD_ALT, "shift": MOD_SHIFT, "win": MOD_WIN}


def parse_hotkey(spec):
    """'ctrl+f5' -> (modifiers, vk)；不合法返回 None。支持 f1-f12 / a-z / 0-9。"""
    try:
        parts = [p.strip().lower() for p in str(spec).split("+") if p.strip()]
        if not parts:
            return None
        mods, key = 0, None
        for p in parts:
            if p in MOD_MAP:
                mods |= MOD_MAP[p]
            elif p.isdigit() and len(p) in (1, 2):
                key = 0x30 + int(p)
            elif len(p) == 1 and "a" <= p <= "z":
                key = 0x41 + (ord(p) - ord("a"))
            elif len(p) in (2, 3) and p[0] == "f" and p[1:].isdigit() and 1 <= int(p[1:]) <= 12:
                key = 0x70 + (int(p[1:]) - 1)
            else:
                return None
        if key is None or mods == 0:
            return None
        return mods, key
    except Exception:
        return None


def hotkey_thread_main(msg_q, spec):
    """注册全局热键并在收到 WM_HOTKEY 时向 UI 队列投递事件；线程用 WM_QUIT 退出。"""
    user32 = ctypes.windll.user32
    parsed = parse_hotkey(spec)
    if not parsed:
        msg_q.put(("hotkey_fail", str(spec)))
        return
    mods, vk = parsed
    if not user32.RegisterHotKey(None, HOTKEY_ID, mods, vk):
        msg_q.put(("hotkey_fail", str(spec)))
        return
    msg = wintypes.MSG()
    try:
        while True:
            ret = user32.GetMessageW(ctypes.byref(msg), None, 0, 0)
            if ret == 0 or ret == -1:
                break
            if msg.message == WM_HOTKEY and msg.wParam == HOTKEY_ID:
                msg_q.put(("hotkey", None))
    finally:
        user32.UnregisterHotKey(None, HOTKEY_ID)


def stop_hotkey_thread(thread):
    try:
        if thread is not None and thread.is_alive():
            ident = thread.ident
            if ident:
                ctypes.windll.user32.PostThreadMessageW(ident, WM_QUIT, 0, 0)
    except Exception:
        pass


# ---------------- stdio 协议 ----------------
def configure_stdio():
    for stream, errors in ((sys.stdin, "strict"), (sys.stdout, "backslashreplace"), (sys.stderr, "backslashreplace")):
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            reconfigure(encoding="utf-8", errors=errors)


def emit(kind, **payload):
    print(json.dumps({"protocolVersion": PROTOCOL_VERSION, "kind": kind,
                      "timestamp": int(datetime.now().timestamp() * 1000), **payload}, ensure_ascii=False), flush=True)


def stdin_thread_main(cmd_q):
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
            if not isinstance(msg, dict) or msg.get("protocolVersion") != PROTOCOL_VERSION:
                emit("error", message="unsupported message")
                continue
            cmd_q.put(msg)
        except Exception as error:
            emit("error", message="bad json: %s" % error)
    cmd_q.put({"kind": "_eof"})


# ---------------- 日程数据（领域判定见仓库根 timetable_core.py 单一实现） ----------------
TYPE_LABEL = {"weekly": "每周重复", "once": "一次性", "custom": "自定义间隔"}


# ---------------- Toast 弹窗（仿 Windows 原生通知，全 maliang 控件） ----------------
class Toast:
    """全部由 ma.Label / ma.Button 绘制（无 tk 子控件），保证亚克力能透出。

    - 亚克力可用：窗口底为黑色（被 DWM 替换为模糊），各控件芯片也设为黑色 → 真·Win11 质感
    - 不可用：回退为透明色抠角 + 半透明圆角卡片
    """
    WIDTH = 372
    DURATION = 30.0  # 自动关闭秒数（悬停时暂停，同 Windows 行为）

    def __init__(self, app, ev, start_dt, off):
        self.app = app
        self.ev = ev
        self.start_dt = start_dt
        self.off = off
        self.paused = False
        self.deadline = _time.monotonic() + self.DURATION
        self.closing = False

        left_min = max(int((start_dt - datetime.now()).total_seconds() // 60), 0)
        has_loc = bool(ev.get("location"))
        width = self.width = zsc(self.WIDTH)
        height = self.height = zsc(144 + (16 if has_loc else 0))

        win = self.win = ma.Toplevel(app.root, size=(width, height),
                                     position=(2000, 2000), focus=False)
        win.attributes("-topmost", True)

        # 系统 backdrop 内部会做 overrideredirect(False)+有框无边栏改造；
        # 仅在材质全部不可用时才走 overrideredirect 抠角回退
        self.acrylic = try_apply_acrylic(win)
        base = "#000000" if self.acrylic else MAGIC  # 控件芯片色：黑=透出材质
        if not self.acrylic:
            win.overrideredirect(True)
            win.attributes("-topmost", True)
            # 磨砂不可用 → WinUI 规范回退：不透明实心填充（非半透明），透明色仅用于抠角
            win.attributes("-transparentcolor", MAGIC)
        else:
            # 透明度：材质模式下窗口 alpha=1.0，层次感由 DWM 材质提供
            try_dwm_round_corners(win)  # 系统圆角（Win11 浮层规范 8px）
            # 窗口完成映射后再补设一次（部分机型首次设置早于映射会被忽略）
            win.after(120, lambda: self.win.winfo_exists() and try_dwm_round_corners(self.win))

        # auto_update=False：阻止 maliang 主题管理器把画布重绘成 #202020，
        # 否则不透明底色会盖住亚克力模糊
        cv = self.cv = ma.Canvas(win, expand="xy", bg=base, highlightthickness=0, bd=0,
                                 auto_update=not self.acrylic)
        if self.acrylic:
            cv.configure(bg="#000000")
        chip = base  # 文字芯片与底同色 → 隐形，仅文字可见

        p = sc(PAD)
        if not self.acrylic:  # 回退模式：自绘圆角卡片（Geometry 规范 8px 圆角）
            round_rect(cv, 1, 1, width - 1, height - 1, sc(DLG_RADIUS),
                       fill=DLG_FALLBACK_BG, outline=C_BORDER)
            chip = DLG_FALLBACK_BG

        # 头部（Caption 层级）：应用名 + 提前量（无按钮，倒计时结束自动收起）
        mlabel(cv, (p, zsc(12)), text="⏱", fg=C_ACCENT, bg=chip, size_text=FS_DLG_CAPTION)
        mlabel(cv, (p + zsc(16), zsc(12)), text="日程提醒 · 提前 %d 分钟" % off,
               fg=C_MUTE, bg=chip, size_text=FS_DLG_CAPTION)

        # 标题（BodyStrong）/ 正文（Body）
        mlabel(cv, (p, zsc(44)), (width - p * 2, zsc(26)),
               text=str(ev.get("title", "")), fg=C_TEXT, bg=chip,
               size_text=FS_DLG_TITLE, bold=True)
        when = "开始 %s · 还有约 %d 分钟" % (start_dt.strftime("%H:%M"), left_min)
        mlabel(cv, (p, zsc(82)), text=when, fg=C_SUB, bg=chip, size_text=FS_DLG_BODY)
        if has_loc:
            mlabel(cv, (p, zsc(108)), text="📍 " + str(ev["location"]),
                   fg=C_MUTE, bg=chip, size_text=FS_DLG_CAPTION)

        # 底部倒计时进度条（canvas 矩形项，芯片太小不适合圆角控件）
        bar_bg_fill = "#333333" if self.acrylic else "#3D3D3D"
        p = sc(PAD)
        self._bar_x0, self._bar_w = p, width - p * 2
        self._bar_y = height - zsc(8)
        self._bar_bg_id = cv.create_rectangle(
            self._bar_x0, self._bar_y, self._bar_x0 + self._bar_w, self._bar_y + zsc(3),
            fill=bar_bg_fill, outline="")
        self._bar_id = cv.create_rectangle(
            self._bar_x0, self._bar_y, self._bar_x0 + self._bar_w, self._bar_y + zsc(3),
            fill=C_ACCENT, outline="")

        # 悬停暂停自动关闭
        for w in (win, cv):
            w.bind("<Enter>", lambda e: self._set_paused(True))
            w.bind("<Leave>", lambda e: self._set_paused(False))

        self._tick_progress()

    # ---- 倒计时进度条 / 自动关闭 ----
    def _tick_progress(self):
        if self.closing or not self.win.winfo_exists():
            return
        if not self.paused:
            remain = self.deadline - _time.monotonic()
            if remain <= 0:
                self.close()
                return
            frac = remain / self.DURATION
            try:
                x2 = self._bar_x0 + max(int(self._bar_w * frac), 1)
                self.cv.coords(self._bar_id, self._bar_x0, self._bar_y,
                               x2, self._bar_y + zsc(3))
            except Exception:
                return
        self.win.after(200, self._tick_progress)

    def _set_paused(self, paused):
        if paused and not self.paused:
            self.remain_on_pause = max(self.deadline - _time.monotonic(), 0.0)
        elif not paused and self.paused:
            self.deadline = _time.monotonic() + getattr(self, "remain_on_pause", 10.0)
        self.paused = paused

    def place(self, x, y):
        win_move(self.win, x, y)

    def close(self):
        if self.closing:
            return
        self.closing = True
        try:
            self.win.destroy()
        except Exception:
            pass
        self.app.on_toast_closed(self)


# ---------------- 应用 ----------------
class App:
    WIN_W = 460
    WIN_H = 560

    def __init__(self, root, cfg):
        self.root = root
        self.cfg = cfg
        self.started_at = datetime.now()
        self.fired = set()
        self.cmd_q = queue.Queue()
        self.ui_q = queue.Queue()
        self.hotkey_thread = None
        self.toasts = []
        self.hotkey_error = None
        self.card_widgets = []   # 当前列表控件（刷新时整体重建）
        self._last_load_err = None  # 数据文件最近一次读取错误（变化时才打 stderr，防刷屏）

        root.title("当日日程提醒")
        win_resize(root, sc(self.WIN_W), sc(self.WIN_H))
        root.minsize(sc(340), sc(300))
        root.overrideredirect(True)  # 无边框：标题栏自绘（maliang 控件），可拖动
        root.configure(bg=C_BG)
        root.attributes("-alpha", GLASS_ALPHA)

        self._build_ui()
        try_dwm_round_corners(root)  # 主窗口也走系统圆角
        root.after(150, lambda: root.winfo_exists() and try_dwm_round_corners(root))
        root.protocol("WM_DELETE_WINDOW", self.hide)  # 关闭 = 隐藏，进程常驻继续提醒

        self.apply_hotkey(self.cfg.get("hotkey", "ctrl+alt+t"))
        threading.Thread(target=stdin_thread_main, args=(self.cmd_q,), daemon=True).start()
        self.root.after(80, self.pump)
        self.refresh(True)
        if self.cfg.get("showOnStart") is False:
            root.after(100, self.hide)
        if os.environ.get("DSH_TTR_TEST_TOAST"):  # 验收用：启动即弹一条测试 Toast
            root.after(800, lambda: self.popup(
                {"title": "测试提醒 · 亚克力 Toast", "type": "once", "location": "会议室 A"},
                datetime.now() + timedelta(minutes=10), 10))

    # ---- 主窗口 UI（maliang 控件；布局按 4px 栅格；可重建供缩放使用） ----
    def _build_ui(self):
        # 清理旧画布（zoom 重建时进入）
        for cv in (getattr(self, "list_cv", None), getattr(self, "top", None)):
            if cv is not None:
                try:
                    cv.destroy()
                except Exception:
                    pass
        self.card_widgets = []

        W = sc(self.WIN_W)
        # 顶部区（固定不滚动）：自绘标题栏 + 标题区 + 信息行（行位随字号基准放大）
        top = self.top = ma.Canvas(self.root, expand="x", bg=C_BG, highlightthickness=0, bd=0)
        top.configure(height=zsc(128))
        top.pack(fill="x")

        mlabel(top, (sc(PAD), zsc(8)), text="⏱ 当日日程提醒",
               fg=C_SUB, size_text=FS_CAPTION)
        top.create_line(sc(PAD), zsc(42), W - sc(PAD), zsc(42), fill=C_BORDER)

        self.head = mlabel(top, (sc(PAD), zsc(52)), text="当日日程",
                           fg=C_TEXT, size_text=FS_TITLE, bold=True)
        self.head_sub = mlabel(top, (sc(PAD), zsc(82)), text="",
                               fg=C_MUTE, size_text=FS_BODY)
        self.sub = mlabel(top, (sc(PAD), zsc(106)), (W - sc(PAD * 2), zsc(16)),
                          text="", fg=C_MUTE, size_text=FS_CAPTION)
        self._enable_drag(top, zsc(36))  # 标题栏区域按住拖动

        # 列表区（无滚动条，滚轮仍可滚动）
        self.list_cv = ma.Canvas(self.root, expand="xy", bg=C_BG,
                                 highlightthickness=0, bd=0)
        self.list_cv.pack(fill="both", expand=True, padx=(sc(PAD - 4), sc(PAD - 4)),
                          pady=(0, sc(4)))
        self.list_cv.bind_all("<MouseWheel>", self._on_wheel)

    def _on_wheel(self, e):
        if e.state & 0x0004:  # Ctrl 按下：缩放字号（同浏览器行为）
            self.zoom(e.delta > 0)
            return
        try:
            self.list_cv.yview_scroll(-1 * (e.delta // 120), "units")
        except Exception:
            pass

    def zoom(self, up):
        """Ctrl+滚轮：全局缩放字号（0.7~1.8），并按新字号重建 UI。"""
        global FONT_SCALE
        new = round(FONT_SCALE * (1.1 if up else 1 / 1.1), 3)
        new = max(0.7, min(1.8, new))
        if new == FONT_SCALE:
            return
        FONT_SCALE = new
        self._build_ui()      # 重建（_build_ui 自带旧画布清理）
        self.refresh(True)

    def _enable_drag(self, canvas, bar_h):
        """按住画布顶部 bar_h 像素区域拖动窗口。"""
        state = {}

        def press(e):
            if e.y <= bar_h:
                state["off"] = (e.x_root - self.root.winfo_x(), e.y_root - self.root.winfo_y())

        def motion(e):
            off = state.get("off")
            if off:
                win_move(self.root, e.x_root - off[0], e.y_root - off[1])

        def release(e):
            state.pop("off", None)

        canvas.bind("<Button-1>", press)
        canvas.bind("<B1-Motion>", motion)
        canvas.bind("<ButtonRelease-1>", release)

    def _clear_list(self):
        for w in self.card_widgets:
            try:
                w.destroy()
            except Exception:
                pass
        self.card_widgets = []

    def _card(self, y, st, ev, past, is_next):
        """一张日程卡片：maliang 圆角芯片 + 时间/标题/元信息（4px 栅格对齐）。"""
        W = sc(self.WIN_W) - sc(PAD)  # 列表区宽（左侧边距由 pack padx 处理）
        h = zsc(64)
        cv = self.list_cv
        c_bg = C_BG if past else C_CARD
        self.card_widgets.append(mlabel(
            cv, (0, y), (W, h), text="", bg=c_bg,
            ol=(C_BG if past else C_BORDER)))
        tcol = C_MUTE if past else (C_ACCENT if is_next else C_TEXT)
        self.card_widgets.append(mlabel(                       # 时间：FS_TIME 层级
            cv, (sc(GAP_M), y + sc(GAP_M)), (zsc(64), zsc(20)),
            text=st.strftime("%H:%M"), fg=(C_MUTE if past else C_ACCENT),
            bg=c_bg, size_text=FS_TIME, bold=True))
        self.card_widgets.append(mlabel(                       # 标题：FS_BODY 层级
            cv, (zsc(76), y + sc(GAP_M)), (W - zsc(88), zsc(20)),
            text=str(ev.get("title", "")), fg=tcol, bg=c_bg, size_text=FS_BODY))
        meta = str(TYPE_LABEL.get(ev.get("type", "once"), ev.get("type") or ""))
        if ev.get("location"):
            meta += " · " + str(ev["location"])
        if is_next:
            meta += " · 下一项"
        self.card_widgets.append(mlabel(                       # 元信息：FS_CAPTION 层级
            cv, (zsc(76), y + sc(GAP_M) + zsc(24)), (W - zsc(88), zsc(18)),
            text=meta, fg=C_MUTE, bg=c_bg, size_text=FS_CAPTION))
        return h

    # ---- Toast 布局管理 ----
    def on_toast_closed(self, toast):
        if toast in self.toasts:
            self.toasts.remove(toast)
        self.layout_toasts()

    def layout_toasts(self):
        sw = self.root.winfo_screenwidth()
        sh = self.root.winfo_screenheight()
        y = sh - sc(TASKBAR) - sc(12)
        for t in reversed(self.toasts):  # 最新的在最上面
            y -= t.height
            t.place(sw - t.width - sc(12), y)
            y -= sc(8)

    def popup(self, ev, start_dt, off):
        t = Toast(self, ev, start_dt, off)
        self.toasts.append(t)
        self.layout_toasts()
        self._slide_in(t)

    def _slide_in(self, t):
        """从屏幕右侧滑入。"""
        sw = self.root.winfo_screenwidth()
        target_x = sw - t.width - sc(12)
        target_y = None
        try:
            target_y = t.win.winfo_y()
        except Exception:
            pass
        if target_y is None or target_y <= 0:
            return

        def step():
            try:
                x = t.win.winfo_x()
            except Exception:
                return
            if t.closing or not t.win.winfo_exists():
                return
            delta = target_x - x
            if abs(delta) <= 2:
                t.place(target_x, target_y)  # 已到达目标附近：贴齐并结束动画
                return
            step_px = int(delta * 0.28)
            if -2 < step_px < 2:  # 保证方向正确的最小步长（原实现恒 +2，向右永不收敛）
                step_px = 2 if delta > 0 else -2
            t.place(x + step_px, target_y)
            t.win.after(10, step)

        t.place(sw + 4, target_y)
        t.win.after(10, step)

    # ---- 命令与热键泵 ----
    def pump(self):
        try:
            while True:
                msg = self.cmd_q.get_nowait()
                self.handle_command(msg)
        except queue.Empty:
            pass
        try:
            while True:
                kind, payload = self.ui_q.get_nowait()
                if kind == "hotkey":
                    self.toggle_window()
                elif kind == "hotkey_fail":
                    self.hotkey_error = payload
                    self.set_sub()
        except queue.Empty:
            pass
        self.root.after(80, self.pump)

    def handle_command(self, msg):
        kind = msg.get("kind")
        if kind == "ping":
            emit("pong")
        elif kind == "config":
            self.apply_config(msg)
        elif kind == "show":
            self.show()
        elif kind == "hide":
            self.hide()
        elif kind in ("shutdown", "_eof"):
            self.quit()
        # hello：仅问候，无需处理

    def apply_config(self, msg):
        cfg = self.cfg
        if msg.get("dataPath"):
            cfg["dataPath"] = msg["dataPath"]
        if msg.get("hotkey") and msg["hotkey"] != cfg.get("hotkey"):
            cfg["hotkey"] = msg["hotkey"]
            self.apply_hotkey(cfg["hotkey"])
        if isinstance(msg.get("leadMinutes"), list) and msg["leadMinutes"]:
            cfg["leadMinutes"] = sorted({int(m) for m in msg["leadMinutes"] if int(m) > 0}, reverse=True)
        if isinstance(msg.get("showOnStart"), bool):
            cfg["showOnStart"] = msg["showOnStart"]
        self.started_at = datetime.now()
        self.fired = set()
        self.refresh(True)

    def apply_hotkey(self, spec):
        stop_hotkey_thread(self.hotkey_thread)
        self.hotkey_error = None
        self.hotkey_thread = threading.Thread(target=hotkey_thread_main, args=(self.ui_q, spec), daemon=True)
        self.hotkey_thread.start()

    # ---- 提醒 ----
    def minute_tick(self):
        try:
            self.check_reminders()
            self.refresh(False)
        finally:
            now = datetime.now()
            self.root.after(int((60 - now.second + 0.2) * 1000), self.minute_tick)

    def check_reminders(self):
        now = datetime.now()
        events, _err = load_day(self.cfg.get("dataPath"), now.date())
        default_leads = self.cfg.get("leadMinutes")
        for st, key, ev in events:
            # 事件级 remindLead（0=不提醒）；缺失/非法回落配置默认档（缺省 30/10）
            for off in (x for x in lead_minutes(ev, default_leads) if x > 0):
                point = (key, off)
                if point in self.fired:
                    continue
                rtime = st - timedelta(minutes=off)
                if rtime <= now:
                    self.fired.add(point)
                    if rtime > self.started_at:  # 启动/配置变化时已过期的提醒点：跳过不弹
                        self.popup(ev, st, off)

    # ---- 列表 ----
    def refresh(self, manual):
        today = date.today()
        self.head.set("当日日程")
        self.head_sub.set("%s · 周%s" % (today.strftime("%Y年%m月%d日"),
                                         "一二三四五六日"[today.weekday()]))
        self._clear_list()
        events, load_err = load_day(self.cfg.get("dataPath"), today)
        if load_err and load_err != self._last_load_err:
            # 数据损坏/不可读：stderr 告警（宿主 helper-process 会记为 warn 日志），且每条只打一次
            self._last_load_err = load_err
            print("timetable helper: %s" % load_err, file=sys.stderr)
        elif not load_err:
            self._last_load_err = None
        now = datetime.now()
        y = sc(4)
        if load_err:
            # 醒目告警条：不再静默当作"今日暂无日程"
            self.card_widgets.append(mlabel(
                self.list_cv, (0, y), (sc(self.WIN_W) - sc(PAD), zsc(40)),
                text="⚠ 日程数据文件损坏或不可读（%s）" % os.path.basename(str(self.cfg.get("dataPath"))),
                fg=C_DANGER, bg=C_BG, size_text=FS_BODY))
            y += zsc(40) + sc(GAP_S)
        if not events and not load_err:
            self.card_widgets.append(mlabel(
                self.list_cv, (0, sc(40)), text="今日暂无日程",
                fg=C_MUTE, bg=C_BG, size_text=11))
        next_key = None
        for st, key, ev in events:
            if st > now:
                next_key = key
                break
        for st, key, ev in events:
            y += self._card(y, st, ev, st <= now, key == next_key) + sc(GAP_S)
        try:
            self.list_cv.configure(scrollregion=self.list_cv.bbox("all") or (0, 0, 0, y))
        except Exception:
            pass
        self.set_sub()

    def next_reminder_text(self, now):
        best = None
        events, _err = load_day(self.cfg.get("dataPath"), now.date())
        default_leads = self.cfg.get("leadMinutes")
        for st, key, ev in events:
            for off in (x for x in lead_minutes(ev, default_leads) if x > 0):
                rtime = st - timedelta(minutes=off)
                if rtime > now and (key, off) not in self.fired:
                    if best is None or rtime < best:
                        best = rtime
        return "今日无待触发提醒" if best is None else "下次提醒 %s" % best.strftime("%H:%M")

    def set_sub(self):
        hk = self.cfg.get("hotkey", "ctrl+alt+t")
        leads = "/".join(str(x) for x in (self.cfg.get("leadMinutes") or [30, 10]))
        text = "提醒：按事件 remindLead 提前（缺省 %s 分钟各一次） · %s    数据：%s（每分钟自动重读）" % (
            leads, self.next_reminder_text(datetime.now()),
            os.path.basename(str(self.cfg.get("dataPath"))))
        if self.hotkey_error:
            text += "\n（热键 %s 注册失败，可能被其他程序占用）" % self.hotkey_error
        self.sub.set(text)

    # ---- 窗口切换 ----
    def is_visible(self):
        try:
            return bool(self.root.winfo_viewable())
        except Exception:
            return self.root.state() != "withdrawn"

    def show(self):
        if self.root.state() == "withdrawn":
            self.root.deiconify()
        self.root.overrideredirect(True)  # 唤出后保持无边框主体样式
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

    # ---- 退出 ----
    def user_quit(self):
        emit("closed")
        self.quit()

    def quit(self):
        for t in list(self.toasts):
            t.closing = True
            try:
                t.win.destroy()
            except Exception:
                pass
        stop_hotkey_thread(self.hotkey_thread)
        self.root.destroy()


# ---------------- headless（无 GUI，仅供测试） ----------------
def run_headless():
    emit("ready", message="headless")
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
            if not isinstance(msg, dict) or msg.get("protocolVersion") != PROTOCOL_VERSION:
                emit("error", message="unsupported message")
                continue
        except Exception as error:
            emit("error", message="bad json: %s" % error)
            continue
        kind = msg.get("kind")
        if kind == "ping":
            emit("pong")
        elif kind == "config":
            hk = msg.get("hotkey")
            if hk and parse_hotkey(hk) is None:
                emit("error", message="bad hotkey: %s" % hk)
        elif kind == "shutdown":
            break
        # hello/show/hide：headless 下无操作
    return 0


def main():
    configure_stdio()
    parser = argparse.ArgumentParser(description="dsh-timetable-reminder helper")
    parser.add_argument("--headless", action="store_true", help="仅运行协议循环（无 GUI，测试用）")
    args = parser.parse_args()
    if args.headless:
        sys.exit(run_headless())

    global SCALE, FONT
    enable_dpi_awareness()  # 必须在创建 Tk 之前：按原生像素渲染，避免高 DPI 下发糊
    try:
        ma_theme.set_color_mode("dark")  # maliang 全局深色主题（Win11 深色一致）
    except Exception:
        pass
    root = ma.Tk(title="当日日程提醒")
    SCALE = detect_ui_scale()
    FONT = pick_font_family(root)  # Segoe UI Variable（Win11）→ Segoe UI 回退
    cfg = {
        "dataPath": os.environ.get("DSH_TTR_DATA", "D:/tools/auto_timetable/schedule.json"),
        "hotkey": os.environ.get("DSH_TTR_HOTKEY", "ctrl+alt+t"),
        "leadMinutes": [30, 10],
        # 无头模式：默认启动即隐藏主窗口，仅弹 Toast；Ctrl+Alt+T 或 Toast「显示主窗口」唤出
        "showOnStart": os.environ.get("DSH_TTR_SHOW_ON_START", "0") == "1",
    }
    app = App(root, cfg)
    # 无头隐藏由 App 内部 after(100) 完成（等首次映射结束后 withdraw）
    root.after(0, lambda: app.minute_tick())
    root.after(150, lambda: emit("ready", message="timetable reminder helper ready"))
    root.mainloop()


if __name__ == "__main__":
    main()
