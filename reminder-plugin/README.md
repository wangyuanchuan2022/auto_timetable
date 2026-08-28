# dsh-timetable-reminder

当日日程提醒 DSH 插件：主窗口 + 仿 Windows 原生 Toast 提醒 + 全局快捷键。

## 依赖

- Node 侧：`pnpm install`（宿主桥接，见 `src/`）
- Python helper（`runtime/helper.py`），建议 Python 3.10+：

```bash
pip install maliang pywinstyles win32material
```

- `maliang`：窗口容器与主题管理（`ma.Tk` / `ma.Toplevel` / `theme.apply_theme`）
- `pywinstyles` + `win32material`：Windows 11 亚克力(Acrylic)/云母(Mica) 等原生窗口效果
- 未安装时自动回退纯 tkinter：视觉降级（半透明圆角卡片），功能完整

## 验收 / 调试

```bash
# 启动即弹一条测试 Toast（亚克力效果可直接观察）
DSH_TTR_TEST_TOAST=1 DSH_TTR_SHOW_ON_START=1 python runtime/helper.py

# 无 GUI 协议模式（自动化测试）
python runtime/helper.py --headless
```

## Toast 行为（对齐 Windows 原生通知）

- 右下角滑入、右下角堆叠；悬停暂停倒计时；底部进度条收起提示
- 真·亚克力模糊（DWM ACCENT_ENABLE_ACRYCLICBLURBEHIND），不可用时回退半透明卡片
- `DSH_TTR_DATA` / `DSH_TTR_HOTKEY` / `DSH_TTR_SHOW_ON_START` 环境变量可覆盖默认配置
