# auto_timetable · 智能时间表

**一个 DSH（DeepSeek Harness）插件组项目**：包含两个宿主插件——`dsh-timetable-reminder`（桌面提醒，`reminder-plugin/`）、`dsh-timetable-mobile`（手机连接，`mobile-plugin/`）——以及一个工作台挂载页面 `schedule.html`（周视图），并附可独立运行的桌面/手机入口。**依赖 [dsh-worktable](https://github.com/Aisland-SJL/dsh-worktable) 插件**：工作台窗口容器负责 `schedule.html` 的挂载渲染（`widget-result.json` 产物清单）、静态托管与文件读写接口（`/api/worktable/*`，页面编辑写回 `schedule.json` 即经此通道）。

数据统一存于根目录 `schedule.json`（每周重复 / 一次性 / 自定义间隔三类事件），各模块共用同一份数据。

## 三大功能模块

| 模块 | 入口 | 说明 |
| --- | --- | --- |
| **桌面端提醒** | `reminder_app.py`（独立桌面应用）/ `start_reminder.bat` / `reminder-plugin/`（DSH 插件 `dsh-timetable-reminder`） | 主窗口列出当日日程，开始前 30/10 分钟弹窗提醒；后台常驻，全局快捷键 Ctrl+F5 显隐；插件版另提供 Windows 原生 Toast（亚克力效果）唤醒弹窗，依赖 `reminder-plugin/runtime/helper.py` |
| **手机连接** | `mobile-server.mjs` / `mobile.html` / `sw.js` / `mobile-plugin/`（DSH 插件 `dsh-timetable-mobile`） | 独立手机访问服务（默认端口 3190，可选公网隧道）：扫码打开手机页查看/编辑日程、Web Push 系统级提醒、直连电脑端 DSH AI 对话；插件版随 DSH web 启动/关闭自动拉起与回收 |
| **日程表智能** | `schedule.html` / `schedule.json` / `qrgen.js` / `manifest.webmanifest` / 图标 | 以「周」为单位的日程表交互页面（明暗主题自适应）：单击编辑、双击详情、直接写回 `schedule.json`，并内嵌手机访问二维码面板 |

## 安装与运行

依赖：Node.js ≥ 22（手机连接服务）；Python ≥ 3.10（桌面提醒）；**DSH web + dsh-worktable 插件**（工作台窗口挂载与文件读写通道）。

### 0. 前置：安装 DSH 与 dsh-worktable（本插件组的依赖底座）

1. 安装并启动 DSH：`npm i -g @deepseek-ai/dsh`，然后运行 `dsh web`；
2. 安装 **dsh-worktable**（工作台插件）：在 `~/.dsh/profiles/web/package.json` 的 `dependencies` 加入
   `"dsh-worktable": "https://github.com/Aisland-SJL/dsh-worktable/releases/latest/download/dsh-worktable.tgz"`，
   并在 `dsh.profile.bundles` 数组加入 `"dsh-worktable"`，在该目录执行 `pnpm install`，重启 DSH web；
3. 将本仓库放置到任意目录（本文以 `D:/tools/auto_timetable` 为例）。在工作台打开本项目后，`widget-result.json` 会自动把 `schedule.html` 挂载进「智能时间表」项目的窗口并锁定保存。

### 1. 日程表页面（schedule.html）

浏览器直接打开 `schedule.html`，或作为 HTML 挂载到 DSH 工作台（见 `widget-result.json`）。日程数据直接编辑 `schedule.json`。

### 2. 桌面端提醒

**独立桌面应用**（纯标准库，无第三方依赖）：

```bash
python reminder_app.py        # 或双击 start_reminder.bat（pythonw 后台常驻）
```

**DSH 插件版 `dsh-timetable-reminder`**（Windows 11 原生 Toast / 亚克力效果）：

```bash
cd reminder-plugin
pnpm install                  # 宿主插件桥接依赖（@deepseek-ai/schemastery）
pip install maliang           # Python helper 的 UI 依赖（亚克力弹窗；pywinstyles/win32material 为可选增强，代码未直接依赖）
```

注册进 DSH profile（与 dsh-worktable 同一安装方式）：编辑 `~/.dsh/profiles/web/package.json`——

- `dependencies` 加入 `"dsh-timetable-reminder": "link:D:/tools/auto_timetable/reminder-plugin"`（按实际路径）；
- `dsh.profile.bundles` 加入 `"dsh-timetable-reminder"`；
- 在该目录执行 `pnpm install`，重启 DSH web。

> **bundle 契约（必读）**：profile bundle 必须在自身 `package.json` 声明 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`，且包根目录存在 `cordis.patch.yml`（其 `insert` 的 `id`/`name` 必须与 `src/index.js` 导出的 `name` 一致）。任一缺失，DSH 启动即报错 `profile bundle "dsh-timetable-reminder" declares no dsh.bundle in its package.json`。本插件已内置该契约，改名时需同步三处。

**验证**：重启 DSH web 后系统应出现 `py`/`python` 的 helper 进程；插件默认**无头**（不显示主窗口），按 **Ctrl+F5** 唤出/隐藏，到点自动弹 Toast。验收/测试：`DSH_TTR_TEST_TOAST=1 DSH_TTR_SHOW_ON_START=1 python runtime/helper.py`、无 GUI 协议模式 `python runtime/helper.py --headless`；单测 `pnpm test` 与 `pnpm run test:python`。

### 3. 手机连接

```bash
npm install                   # 安装 web-push（根目录 package.json）
node mobile-server.mjs          # 局域网模式（默认 0.0.0.0:3190）
node mobile-server.mjs --public # 公网隧道（需先在面板设置安全密码）
node mobile-server.mjs --host 127.0.0.1  # 仅绑定本机
```

在 `schedule.html` 工具栏点「手机访问」显示二维码，手机扫码即用。`mobile-plugin/` 为其 DSH 生命周期插件（注册方式同上：`dependencies` 用 `link:` 指向 `mobile-plugin/` + `dsh.profile.bundles` 加 `dsh-timetable-mobile` + `pnpm install`，需同样满足 bundle 契约），安装后随 DSH 自动启停。

### 4. 回归测试

```bash
npm i --prefix .qrtest jsqr
node .qrtest/run-test.js         # 二维码生成器回环测试
node .qrtest/remind-test.js      # 提醒判定逻辑测试
node .qrtest/security-test.js    # 安全加固回归（末项会锁定 127.0.0.1 十分钟）
```

---

# 智能时间表 · 每周日程表（详细说明）

一个以「周」为单位的日程表展示窗口，可渲染外部可编辑的 `schedule.json` 文件。

## 文件说明

| 文件 | 作用 |
| --- | --- |
| `schedule.html` | 日程表交互页面（窗口1 挂载的就是它），明暗主题自动跟随 DSH 系统 |
| `mobile-server.mjs` | 独立手机访问服务（端口 3190 起；托管手机页 + 读写 schedule.json + 状态接口） |
| `mobile.html` | 手机端页面：选日期 → 查看当日日程 → 点击弹出对话框修改并保存 |
| `qrgen.js` | 自包含二维码生成器（字节模式 / 纠错 M / 版本 1-10），供 `schedule.html` 本地渲染二维码 |
| `schedule.json` | 日程数据文件，**用任意编辑器直接改它即可** |
| `.qrtest/run-test.js` | `qrgen.js` 的回环测试（用 jsQR 解码验证，`npm i --prefix .qrtest jsqr` 后 `node .qrtest/run-test.js`） |
| `.qrtest/remind-test.js` | 提醒判定逻辑回环测试（从 `mobile.html` 提取真实代码执行，`node .qrtest/remind-test.js`） |
| `README.md` | 本说明文档 |

## 手机扫码访问（独立实现，与 dsh-pocket 完全分离）

> 本入口**不依赖、不占用、不影响** dsh-pocket 的扫码访问：独立服务、独立端口（默认 **3190**，避开 dsh web 的 3080 与 dsh-pocket 自动占用的 3081–3090）、独立页面、独立读写接口（直接读写 `schedule.json`，不经 worktable / 不经 pocket 代理）。dsh-pocket 那套可照常同时使用。

**启动**：

**方式一（推荐）：随 DSH 自动启停**。已注册插件 `dsh-timetable-mobile`（`mobile-plugin/`，已 link 进 `~/.dsh/profiles/web` 的 bundles）——**DSH web 启动时自动拉起 mobile-server.mjs，DSH 关闭时自动优雅回收**（先关公网隧道再退出，杜绝 cloudflared 孤儿进程；3 秒未退强杀进程树兜底）。若 3190-3199 已有实例（面板拉起/手动启动），插件跳过不重复拉起。重启 DSH web 生效。

**方式二（手动）**，工作区目录下：

```bash
node mobile-server.mjs          # 局域网模式
node mobile-server.mjs --public # 已设安全密码时自动开启独立公网隧道（cloudflared，缓存于 .mobile-srv/，独立于 dsh-pocket）
node mobile-server.mjs --host 127.0.0.1 # 仅绑定本机
```

打开 `schedule.html` 工具栏的 **「手机访问」** 按钮，面板并排显示两个二维码（每 5 秒自动从独立服务的 `/api/status` 刷新地址并本地重绘二维码）。**服务未运行时点按钮会自动拉起**：面板经 dsh-worktable 的终端通道执行 `Start-Process` 分离启动命令（生成的 node 进程独立于页面/终端存活），通常 3 秒内上线并显示二维码；自动拉起连续失败 3 次后不再重试、改为提示手动执行。无需手动开终端：

- **局域网访问**：`http://<电脑局域网IPv4>:3190/` —— 手机与电脑连同一 WiFi 扫码即开
- **公网访问**：点面板中 **「打开公网隧道 / 关闭公网隧道」** 按钮随时开关

**安全密码（仅存本机）**：面板中输入 6-64 位密码点「保存密码」，存储于本机 `.mobile-srv/settings.json`（不进二维码 / URL / 日志）。**修改或清除密码需先输入当前密码**（旧密码验证，防本机恶意页面篡改）。

- 设置后：手机端首次访问需输入密码，验证通过后由服务端种 **HttpOnly + SameSite=Strict Cookie**（30 天），密码不落 localStorage、不进 URL；
- **公网隧道必须先设置安全密码才可开启**；清除密码时会自动关闭公网隧道，避免出现无保护公网入口。

**连接安全加固**（参照 dsh-pocket 的安全实践与 dsh 宿主信任栅栏，详见安全审查）：

- **管理栅栏**：`/api/admin/*` 要求 Host 为 loopback 权威、`sec-fetch-site` 非 cross-site、Origin 主机名为 loopback 或与 Host 同权威——防本机恶意网页与 DNS rebinding（仅源 IP 判定不够）；
- **登录限速**：密码尝试按 IP 限速（60 秒 5 次，超限锁定 10 分钟，返回 429 与剩余秒数）；
- **CORS 收敛**：仅对 loopback / 同源 Origin 回显 CORS 头；`/api/status` 对不可信来源只返回最小状态（不含局域网 IP、公网地址、pinSet）；
- **`?pin=` 已移除**：凭据只经 Cookie 或 `X-TT-Pin` 头传输；
- **`/api/respond` 白名单**：rpcId 必须命中服务端暂存的交互请求，approvalId 以服务端记录为准，受理后即失效；
- **下载加固**：cloudflared 下载仅允许 GitHub 域（含重定向目标）、100MB 上限、120 秒超时；
- **CSP + SSE 上限**：页面下发 CSP（connect-src 'self'）；SSE 连接单 IP ≤3、全局 ≤12；
- **`--host` 参数**：`node mobile-server.mjs --host 127.0.0.1` 可仅绑定本机（默认 0.0.0.0 供局域网访问）。

回归测试：`node .qrtest/security-test.js`（注意：最后一项锁定测试会把 127.0.0.1 锁 10 分钟，测完重启服务即可）。

**手机页功能**：顶部日期选择（默认今天）→ 所选日的日程列表 → 点击任一日程弹出**对话框**查看并修改（名称 / 起止时间 / 地点 / 备注 / 提前提醒分钟数），保存即写回电脑端 `schedule.json`（电脑端点「刷新」可见）。

**开始前提醒（系统级通知，后台/锁屏可送达）**：手机页顶部点 **「🔔 开启系统通知」**——请求通知权限 → 注册 Service Worker（`sw.js`）→ 订阅 Web Push（VAPID 密钥仅存电脑端本机 `.mobile-srv/settings.json`；订阅列表存 `.mobile-srv/push-subscriptions.json`）。**后台不再依赖手机页面存活**：电脑端 `mobile-server` 每 20 秒扫描 `schedule.json`，事件到 `start − remindLead` 即向所有订阅设备推送系统通知（点击通知回到日程页）。Android Chrome 直接可用；**iOS 需 16.4+ 且把页面「添加到主屏幕」**（PWA，已提供 `manifest.webmanifest` 与图标）。未开启系统通知时维持原有页内弹窗兜底（开启后前台提醒同样走系统通知，tag 去重不会弹两次）。

提前量仍是**事件级字段 `remindLead`**（默认 20 分钟，`0` = 不提醒，双端编辑对话框均可改）；服务端与手机端使用同一判定规则（取消的事件不再推、改期后按新时间重新提醒），服务端已推送键存 `.mobile-srv/remind-fired.json`（48h 清理）。计时基准：推送按电脑端本地时钟、页内检查按手机本地时钟（日程为无时区的本地墙上时间）。验证捷径：手机开启系统通知后，电脑端建一条 2 分钟后开始、remindLead=1 的 `once` 日程，锁屏等待推送；页内弹窗验证仍可用 `?remindLead=0.05`。

**对话电脑端 DSH（输入框）**：手机页底部输入框直连电脑端 DSH——消息经本服务在本机转发给一个专属 DSH 会话（工作目录即本日程表目录），DSH 按自然语言指示直接查看/编辑 `schedule.json`，回复后日程列表自动刷新。支持**图片附件**（📷 拍照/相册，最多 4 张、单图约 5MB，手机端自动压缩到最长边 1568px；gif 保持原样）。对话框**限高 46vh、内部滚动**，双端消息原样镜像（电脑端 GUI 在该会话的发言也会出现）；**完整过程**与电脑端对等：💭 思考过程（可折叠）、🔧 工具调用卡片（含**入参**与**输出**，运行中 ⏳ / 成功 ✓ / 失败 ✕）、每一步的中间回复全部随生成实时展示；DSH 发起的**提问 / 工具批准**会渲染为可点选卡片，手机直接作答或批准/拒绝。mux 事件流断线自动重连（指数退避），重连期间由 4 秒轮询兜底补发消息与未答的提问/批准。

**实时通道（参照 dsh-pocket）**：`/api/chat/watch` **优先走 WebSocket**（含协议层 Ping 心跳保活，25s 周期 + 静默断链检测），WS 不可用时自动回落 SSE（EventSource，服务端 15 秒心跳注释行保活）。原因：实测 Cloudflare quick tunnel 会**缓冲无 Content-Length 的 GET SSE 流式响应体**（首帧可延迟 100 秒以上，公网手机端长时间收不到任何数据），WebSocket 帧不被缓冲——dsh-pocket 正是用 WS 透传 `/api/events.mux` 实现公网实时。**公网客户端识别**：cloudflared 把真实客户端 IP 写入 `cf-connecting-ip`（可信，不采信可伪造的 `x-forwarded-for`），流式连接配额（单 IP ≤4、全局 ≤16）与登录限速均按真实 IP 计——否则经隧道时所有公网访客都会挤进 cloudflared 的 127.0.0.1 本机桶，互相挤爆配额/连锁锁定（局域网可用、公网不可用的根因之一）。

> 图片说明：带图消息会自动把会话切换到视觉模型（如 `glm-5v-turbo`）。当前部署若未订阅视觉模型，会立刻返回订阅错误提示（不阻塞纯文本使用）；一旦账号开通即可正常用图。

**独立服务接口**（`mobile-server.mjs` 私有路由，均带 CORS；`/api/admin/*` 仅接受本机 loopback 请求）：

| 路由 | 说明 |
| --- | --- |
| `GET /` | 手机页 `mobile.html` |
| `GET /api/schedule` | 读 `schedule.json`（设密码后需带 `X-TT-Pin` 头 / `?pin=`） |
| `POST /api/schedule` | 写 `schedule.json`（body `{content}`，服务端校验必须为合法日程 JSON，只可写这一个文件） |
| `POST /api/chat` | 对话电脑端 DSH（body `{message, images?:[{mediaType,data(base64),name}]}`；转发至本机 DSH 专属会话，等待并返回助手回复） |
| `POST /api/chat/stream` | 同 `/api/chat`，SSE 流式逐帧返回：`{t:'open'}` → `{t:'partial',text}`（增量文本）→ `{t:'done',reply}` / `{t:'error'}`；手机端气泡边收边渲染（跨 step 间隙不清屏） |
| `GET /api/chat/watch` | **双端同会话完整过程镜像**（参考 dsh-pocket：订阅宿主 `/api/events.mux` 实时事件流）：连接即下发完整过程快照（消息 / 思考 / 工具入参与输出，按 seq 幂等），此后实时推送该会话双端消息、流式增量、思考、工具调用与输出；**优先 WebSocket**（`Upgrade: websocket`，公网隧道首选；含心跳保活），自动回落 SSE（EventSource）；mux 断开时自动退化为 4 秒轮询补漏；手机与电脑端 GUI 共用同一条会话，任一端发言与全部中间步骤都会原样出现在手机对话框 |
| `POST /api/respond` | **手机端答复 DSH 的提问/批准**：`{rpcId, kind:'question', answer:[{id,selected,custom?}]}` 或 `{rpcId, kind:'approval', approvalId, outcome:'allowed-once'\|'rejected'}`，转发至宿主 `POST /api/respond`；对应问题/批准经 watch 流推给手机渲染为可点选卡片 |
| `POST /api/chat/cancel` | 取消当前卡住的轮次（`session.cancel`），解阻塞后可重新发送 |
| `GET /api/chat/log` | 会话消息快照（调试/兜底用） |
| `GET /api/status` | `{port, lanIp, lanUrl, pinSet, public:{running,url,phase}}`，供 PC 端面板生成二维码 |
| `POST /api/admin/pin` | 设置 / 清除安全密码（body `{pin}`，空串清除；仅本机） |
| `POST /api/admin/tunnel` | 开关公网隧道（body `{on:true|false}`；开启前必须已设密码；仅本机） |
| `POST /api/admin/shutdown` | 优雅停机（关隧道后退出；由 DSH 插件 `dsh-timetable-mobile` 在宿主关闭时调用；仅本机） |



## 怎么改日程

方式一（推荐，直接在窗口里改）：

- **单击**时间表中任意一条内容，弹出该事件的编辑器，可修改：**名称、开始/结束时间、重复间隔（类型 + 星期/日期/间隔单位 + 起始日期）、地点、备注**，各字段自动带出当前值；
- 点 **保存** 生效并**自动写回 `schedule.json`**；点 **取消** 或按 **Esc** 放弃修改；校验失败（如名称为空、结束时间早于开始时间）会提示且不落盘；
- 点 **删除此事件**（编辑器右下角红色按钮）并确认后，该事件从数据中移除并写回 `schedule.json`；
- 按周重复的自定义间隔可勾选每周具体哪几天；
- **双击**某条内容可查看它的只读详情（时间 / 重复规则 / 地点 / 备注）。

方式二（外部编辑器）：

1. 用任意文本编辑器打开 `schedule.json`。
2. 增删改 `events` 数组里的条目。
3. 回到窗口点「刷新」，页面会重新读取并渲染。

> 持久化：修改通过工作台 `/api/worktable/write` 接口直接写回 `schedule.json`；若服务端写入失败，会自动存本地备份（下次打开自动恢复并再次尝试写回）。
> 若浏览器环境无法自动读取文件，可点「编辑数据」粘贴 JSON 临时预览；正式数据仍以 `schedule.json` 为准。

## 数据格式

顶层结构：

```json
{
  "meta": { "title": "标题", "weekStart": 1 },
  "events": [ ... ]
}
```

### meta（可选）

| 字段 | 说明 | 默认 |
| --- | --- | --- |
| `title` | 窗口标题 | `每周日程表` |
| `weekStart` | 一周从周几开始：`1` 周一 / `0` 周日 | `1` |
| `timeStart` / `timeEnd` | 固定时间范围（`"07:00"`、`"23:00"`）；不填则按日程自动适配 | 自动适配 |

### 事件通用字段

| 字段 | 说明 |
| --- | --- |
| `id` | 唯一标识（可选，建议填） |
| `title` | 事件名称（必填） |
| `start` / `end` | 当天起止时间，`"HH:MM"`（必填） |
| `location` | 地点（可选） |
| `color` | 十六进制色值，如 `"#4f8ef7"`（可选，缺省按类型配色） |
| `note` | 备注（可选） |
| `remindLead` | 手机端提前提醒分钟数（可选，默认 `20`；`0` = 不提醒） |

### 三种组件类型

`weekday` 取值：`1`=周一 … `7`=周日。

#### 1. 每周重复（如课程）

```json
{ "title": "高等数学", "type": "weekly", "weekday": 1, "start": "08:00", "end": "09:40", "location": "教学楼A-301" }
```

#### 2. 一次性（临时事务）

```json
{ "title": "期中考试", "type": "once", "date": "2026-08-26", "start": "09:00", "end": "11:00" }
```

#### 3. 自定义间隔重复

```json
{
  "title": "健身", "type": "custom",
  "start": "19:00", "end": "20:00",
  "repeat": { "interval": 2, "unit": "day", "start": "2026-08-24" }
}
```

`repeat` 字段：

| 字段 | 说明 |
| --- | --- |
| `interval` | 间隔数量（正整数） |
| `unit` | `day`（天）/ `week`（周）/ `month`（月） |
| `start` | 开始日期 `"YYYY-MM-DD"` |
| `until` | 结束日期（可选） |
| `days` | 仅 `unit:"week"` 时可用：限定每周几重复，如 `[1,3,5]` = 周一/三/五（可选） |

## 明暗主题

页面自动与 DSH 系统的明暗主题保持同步：嵌入工作台时实时读取并监听主界面主题（`data-ds-dark-theme` / 背景亮度），切换 DSH 主题后时间表立即跟着变亮/变暗；若 DSH 未注入亮色设计变量，页面会按实际解析亮度自动补一组亮色 `--dsw-alias-*` 变量兜底；独立打开时则跟随系统偏好（`prefers-color-scheme`），切换带平滑过渡动画（尊重系统「减少动态」设置）。

## 已知限制

- 跨天日程仅支持跨午夜一段（如 23:00–01:00）：当天显示至 24:00，次日 0 点起显示「次日续」段；周日跨午夜的部分延伸到下一周周一显示。不支持持续超过一天以上的事件。
- 按月重复时按「几号」匹配，起始日若大于 28 号，个别月份会自然跳过（如 31 号在小月不出现）。
