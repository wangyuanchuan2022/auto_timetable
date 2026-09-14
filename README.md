# auto_timetable · 智能工作表

**一个 DSH（DeepSeek Harness）插件组项目**：包含两个宿主插件——`dsh-timetable-reminder`（桌面提醒，`reminder-plugin/`）、`dsh-timetable-mobile`（手机连接，`mobile-plugin/`）——以及一个工作台挂载页面 `schedule.html`（周视图），并附可独立运行的桌面/手机入口。**依赖 [dsh-worktable](https://github.com/Aisland-SJL/dsh-worktable) 插件**：工作台窗口容器负责 `schedule.html` 的挂载渲染（`widget-result.json` 产物清单）、静态托管与文件读写接口（`/api/worktable/*`，页面编辑写回 `schedule.json` 即经此通道）。

数据统一存于根目录 `schedule.json`（每周重复 / 一次性 / 自定义间隔 / 长周期任务四类事件），各模块共用同一份数据。

## 三大功能模块

| 模块 | 入口 | 说明 |
| --- | --- | --- |
| **桌面端提醒** | `reminder-plugin/`（DSH 插件 `dsh-timetable-reminder`，`runtime/helper.py`） | DSH 宿主托管的桌面日程窗口（UI 基于**跨平台库 maliang**，Windows/macOS/Linux 同源可跑）：列出当日日程，按事件 `remindLead` 提前弹卡片 Toast（`0` = 不提醒；留空回落默认 30/10 分钟双档）；后台常驻，全局快捷键 Ctrl+Alt+T 显隐（**仅 Windows**，其他平台由宿主 show/hide 命令控制） |
| **手机连接** | `mobile-server.mjs` / `mobile.html` / `sw.js` / `mobile-plugin/`（DSH 插件 `dsh-timetable-mobile`）/ `android-app/`（安卓 APK） | 独立手机访问服务（默认端口 3190）：功能入口仅 **Cloudflare 隧道 HTTPS + 安全密码**（直连端口 3190 已全量收口——对所有来源只显示隧道地址引导页）：扫码打开手机页查看/编辑日程、Web Push 系统级提醒、直连电脑端 DSH AI 对话；**安卓 APP**（原生 WebView 壳）打包全部移动端功能：扫码配对隧道地址、原生精确闹钟课前弹窗提醒（不依赖谷歌服务）；插件版随 DSH web 启动/关闭自动拉起与回收，崩溃自动守护重启 |
| **日程表智能** | `schedule.html` / `schedule.json` / `qrgen.js` / `manifest.webmanifest` / 图标 | 以「周」为单位的日程表交互页面（明暗主题自适应）：单击详情、双击编辑，「＋ 新建」/双击空白格新建事件，直接写回 `schedule.json`，并内嵌手机访问二维码面板；支持事件级**例外日期（`skip` 停课/调休）与单双周（`weekPattern`）**、`termStart` **教学周徽标**、**历史归档查看/恢复**、**导入 JSON / 导出 JSON 备份 / 导出 ICS 日历**（未来 8 周展开，可直接订阅到系统日历）；支持**长周期截止任务（`task` 型）**——集中在周视图右侧「截止任务」侧栏（按截止日排序、按紧急度分级配色），截止当日网格列顶部以红色横幅醒目标出 |

> **手机端编辑**同样支持完整字段：名称/起止时间/地点/备注/提前提醒/截止日期，以及**例外日期与单双周**；对话框内可**两段式删除**事件。任务（`task` 型）在手机端于截止当日出现在当日列表（红字「截止」标），对话框编辑时隐藏起止时间、必填截止日期。

## 安装与运行

依赖：Node.js ≥ 22（手机连接服务）；Python ≥ 3.10（桌面提醒）；**DSH web + dsh-worktable 插件**（工作台窗口挂载与文件读写通道）。

### 0. 前置：安装 DSH 与 dsh-worktable（本插件组的依赖底座）

1. 安装并启动 DSH：`npm i -g @deepseek-ai/dsh`，然后运行 `dsh web`；
2. 安装 **dsh-worktable**（工作台插件）：在 `~/.dsh/profiles/web/package.json` 的 `dependencies` 加入
   `"dsh-worktable": "https://github.com/Aisland-SJL/dsh-worktable/releases/latest/download/dsh-worktable.tgz"`，
   并在 `dsh.profile.bundles` 数组加入 `"dsh-worktable"`，在该目录执行 `pnpm install`，重启 DSH web；
3. 将本仓库放置到任意目录（本文以 `D:/tools/auto_timetable` 为例）。在工作台打开本项目后，`widget-result.json` 会自动把 `schedule.html` 挂载进「智能工作表」项目的窗口并锁定保存。

### 1. 日程表页面（schedule.html）

浏览器直接打开 `schedule.html`，或作为 HTML 挂载到 DSH 工作台（见 `widget-result.json`）。日程数据直接编辑 `schedule.json`。

### 2. 桌面端提醒

**DSH 插件 `dsh-timetable-reminder`**（桌面日程窗口 + 卡片 Toast；UI 全部基于跨平台库 maliang，界面层不调用任何操作系统私有接口）：

```bash
cd reminder-plugin
pnpm install                  # 宿主插件桥接依赖（@deepseek-ai/schemastery）
pip install maliang           # Python helper 的 UI 依赖（>=3.1）
```

注册进 DSH profile（与 dsh-worktable 同一安装方式）：编辑 `~/.dsh/profiles/web/package.json`——

- `dependencies` 加入 `"dsh-timetable-reminder": "link:D:/tools/auto_timetable/reminder-plugin"`（按实际路径）；
- `dsh.profile.bundles` 加入 `"dsh-timetable-reminder"`；
- 在该目录执行 `pnpm install`，重启 DSH web。

> **bundle 契约（必读）**：profile bundle 必须在自身 `package.json` 声明 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`，且包根目录存在 `cordis.patch.yml`（其 `insert` 的 `id`/`name` 必须与 `src/index.js` 导出的 `name` 一致）。任一缺失，DSH 启动即报错 `profile bundle "dsh-timetable-reminder" declares no dsh.bundle in its package.json`。本插件已内置该契约，改名时需同步三处。

**验证**：重启 DSH web 后系统应出现 `py`/`python` 的 helper 进程；插件默认**无头**（不显示主窗口），按 **Ctrl+Alt+T** 唤出/隐藏，到点自动弹 Toast。验收/测试：`DSH_TTR_TEST_TOAST=1 DSH_TTR_SHOW_ON_START=1 python runtime/helper.py`、无 GUI 协议模式 `python runtime/helper.py --headless`；单测 `pnpm test` 与 `pnpm run test:python`。

### 3. 手机连接

```bash
npm install                      # 安装 web-push（根目录 package.json）
node mobile-server.mjs           # 监听 0.0.0.0:3190（本机网卡 IP 直连，凭安全密码防护）
node mobile-server.mjs --host 127.0.0.1  # 仅绑定本机
```

在 `schedule.html` 工具栏点「手机访问」显示二维码，手机扫码即用。`mobile-plugin/` 为其 DSH 生命周期插件（注册方式同上：`dependencies` 用 `link:` 指向 `mobile-plugin/` + `dsh.profile.bundles` 加 `dsh-timetable-mobile` + `pnpm install`，需同样满足 bundle 契约），安装后随 DSH 自动启停。

### 3.1 安卓 APP（android-app/）

原生 Kotlin WebView 壳，把移动端页面装成 APK，并补上浏览器给不了的两件事：

- **扫码配对**：APP 内「扫码连接」直接扫 `schedule.html` 面板上的「公网访问」二维码（zxing-embedded，不依赖谷歌服务）；电脑重启后隧道地址变化时重新扫码即可；
- **课前弹窗提醒**：APP 周期拉取服务端 `GET /api/plan`（提醒时刻由服务端 occur.js 单一实现算好），逐条交给系统 **AlarmManager 精确闹钟**，到点弹高优先级横幅通知——不依赖 FCM/谷歌服务，国内 ROM 锁屏/后台可收；PC 关机期间已排闹钟照常响。
- **离线兜底（v1.3）**：连不上电脑端时（隧道换址 / 服务器重启 / 断网），不再困在错误屏——主框架加载失败自动切内置离线页，按**上次成功同步的课表**继续展示（今天为中心可翻 ±7 天，进行中/今日截止红边标注），顶部横幅提供「重新连接 / 重新扫码 / 手动输入地址」；页面层同理：加载成功后把课表交给壳落盘缓存，API 断连时按缓存渲染并显示离线横幅，重连成功自动恢复。离线页领域判定同样走 occur.js 单一实现（构建期从仓库根同步，assets 无手改副本）。

其余功能（课表查看/编辑、DSH AI 对话、图片附件、模型切换）即 WebView 里的移动页本身，与浏览器完全同源。鉴权复用页面登录种下的 30 天会话 Cookie，无需二次输密码。

构建：用 Android Studio 打开 `android-app/` 直接 Build，或按 `android-app/BUILD.md` 命令行构建（SDK/Gradle 大文件下载在用户终端完成）。

### 4. 回归测试

```bash
npm i --prefix .qrtest jsqr
node .qrtest/run-test.js              # 二维码生成器回环测试
node .qrtest/remind-test.js           # 提醒判定逻辑测试
node .qrtest/security-test.js         # 安全加固回归（末项会锁定 127.0.0.1 十分钟）
# —— 手机端对话功能（跑 mobile.html 里真实的内联脚本，见「实现内幕 · 测试架」）——
node .qrtest/dup-fix-test.mjs mobile.html         # 消息不重复（原位采纳）回归
node .qrtest/md-render-test.mjs mobile.html       # markdown 渲染 + XSS 安全语义
node .qrtest/new-chat-test.mjs mobile.html        # 新建对话（清屏/重连/旧流帧隔离）
node .qrtest/live-refresh-test.mjs mobile.html    # 实时链路自愈（sid 换绑/撞号/日程节流刷新）
node .qrtest/chat-setup-test.mjs                  # 系统设定注入/剥离（含日程修改规范内容）
node .qrtest/page-tabs-test.mjs                   # 手机页分页/输入/思考块/注入剥离/离线兜底
node .qrtest/offline-page-test.mjs                # APP 离线兜底页（缓存渲染/桥按钮/日期窗口钳制）
```

---

# 智能工作表 · 每周日程表（详细说明）

一个以「周」为单位的日程表展示窗口，可渲染外部可编辑的 `schedule.json` 文件。

## 文件说明

| 文件 | 作用 |
| --- | --- |
| `schedule.html` | 日程表交互页面（窗口1 挂载的就是它），明暗主题自动跟随 DSH 系统 |
| `mobile-server.mjs` | 独立手机访问服务（端口 3190 起；托管手机页 + 读写 schedule.json + 状态接口） |
| `mobile.html` | 手机端页面：选日期 → 查看当日日程 → 点击弹出对话框修改并保存；底部为 DSH AI 对话区 |
| `chat-setup.mjs` | 对话系统设定（schedule.json 修改规范）与注入/剥离工具，`mobile-server.mjs` 引用；提示词正文统一维护于 `TTPROMPT.md` |
| `TTPROMPT.md` | **注入提示词的唯一权威来源**（当前含手机端对话系统设定）：`chat-setup.mjs` 运行时按「## 手机端对话系统设定」章节锚定加载（mtime 缓存），直接编辑其中代码块即生效，无需改代码/重启；文件暂坏时沿用上一次成功内容并告警，从未成功则显式报错——代码内无提示词副本 |
| `qrgen.js` | 自包含二维码生成器（字节模式 / 纠错 M / 版本 1-10），供 `schedule.html` 本地渲染二维码 |
| `schedule.json` | 日程数据文件，**用任意编辑器直接改它即可** |
| `android-app/` | 安卓 APK 工程（原生 WebView 壳：扫码配对 + 精确闹钟课前提醒），构建说明见 `android-app/BUILD.md` |
| `.qrtest/run-test.js` | `qrgen.js` 的回环测试（用 jsQR 解码验证，`npm i --prefix .qrtest jsqr` 后 `node .qrtest/run-test.js`） |
| `.qrtest/remind-test.js` | 提醒判定逻辑回环测试（从 `mobile.html` 提取真实代码执行，`node .qrtest/remind-test.js`） |
| `README.md` | 本说明文档 |

## 手机扫码访问（独立实现，与 dsh-pocket 完全分离）

> 本入口**不依赖、不占用、不影响** dsh-pocket 的扫码访问：独立服务、独立端口（默认 **3190**，避开 dsh web 的 3080 与 dsh-pocket 自动占用的 3081–3090）、独立页面、独立读写接口（直接读写 `schedule.json`，不经 worktable / 不经 pocket 代理）。dsh-pocket 那套可照常同时使用。

**启动**：

**方式一（推荐）：随 DSH 自动启停**。已注册插件 `dsh-timetable-mobile`（`mobile-plugin/`，已 link 进 `~/.dsh/profiles/web` 的 bundles）——**DSH web 启动时自动拉起 mobile-server.mjs，DSH 关闭时自动优雅回收**（3 秒未退强杀进程树兜底）。若 3190-3199 已有实例（面板拉起/手动启动），插件跳过不重复拉起。重启 DSH web 生效。

**方式二（手动）**，工作区目录下：

```bash
node mobile-server.mjs                    # 直连端口只回引导页；功能走隧道 / 127.0.0.1:3191
node mobile-server.mjs --host 127.0.0.1   # 仅绑定本机（公网完全不监听，连引导页也不对外）
```

打开 `schedule.html` 工具栏的 **「手机访问」** 按钮，面板显示二维码（每 5 秒自动从独立服务的 `/api/status` 刷新地址并本地重绘）。**服务未运行时点按钮会自动拉起**：面板经 dsh-worktable 的终端通道执行 `Start-Process` 分离启动命令（生成的 node 进程独立于页面/终端存活），通常 3 秒内上线并显示二维码；自动拉起连续失败 3 次后不再重试、改为提示手动执行。无需手动开终端：

- **访问地址（唯一功能入口）**：`https://<你的子域>`（Cloudflare 隧道，全程 TLS）——手机在任何网络（WiFi/蜂窝）都走这里。`http://<电脑IPv4>:3190/` 的明文直连**已全量收口**：对**一切来源**（含本机）只返回一张引导页（显示当前隧道地址并自动跳转），不承载任何功能（页面 / 日程读写 / 对话 / 流式均无）；本机调试与桌面面板改走功能端口 `127.0.0.1:3191`（隧道回连端口，仅本机监听，不对外）。
- **HTTPS 隧道通道**：cloudflared named tunnel 独立常驻，ingress 指向本机回连端口 `127.0.0.1:3191`（`.mobile-srv/tunnel-port`），手机经 `https://<你的子域>` 全程 TLS 访问，URL 固定、公网零入站端口，PWA/Web Push 需要的 secure context 随之可用。配置见 `CLOUDFLARED-SETUP.md`。

**安全密码（仅存本机）**：面板中输入 8-64 位密码点「保存密码」，以 **scrypt 哈希**存储于本机 `.mobile-srv/settings.json`（明文不落盘、不进二维码 / URL / 日志）。**首次启动若尚未设置密码，服务会自动生成 12 位随机密码**（明文仅在启动日志展示一次），建议尽快在面板改成自己的密码。**修改或清除密码需先输入当前密码**（旧密码验证，防本机恶意页面篡改）。

- 设置后：手机端首次访问需输入密码，验证通过后由服务端种 **HttpOnly + SameSite=Strict Cookie**（30 天），密码不落 localStorage、不进 URL；
- **必须设置安全密码**：公网唯一功能入口（隧道）直接暴露在互联网上，密码是唯一准入凭据——未设置密码时手机端功能请求一律拒绝（503），新部署由上述自动生成的随机密码兜底。

**连接安全加固**（功能入口只剩「HTTPS 隧道（外网）+ 功能端口 127.0.0.1:3191（本机）」两条；直连端口对所有人只回引导页）：

- **直连端口全量收口**：`0.0.0.0:3190` 对**一切来源**（含本机回环）——`GET/HEAD` 任意路径返回显示当前隧道地址的引导页（3 秒自动跳转），其余方法 403+地址，WebSocket 升级一律拒绝——收口闸门置于一切路由与鉴权之前；明文 HTTP 从此不承载任何数据与凭据（引导页 URL 做了 HTML 转义，隧道未就绪时提示稍后刷新）；

- **管理栅栏（网络层）**：`/api/admin/*` 要求**连接本身来自本机回环**（socket 层判定，公网直连下 Host/Origin 头可被 curl 伪造，仅凭头部判定不够），另加 Host 为 loopback 权威、`sec-fetch-site` 非 cross-site、Origin 同权威——防伪造 Host 与 DNS rebinding；
- **登录限速（指数升级）**：密码尝试按连接来源 IP 限速（60 秒 5 次；连续触限锁定 10 分钟起、翻倍升级、封顶 24 小时，返回 429 与剩余秒数）；
- **全局慢速闸**：60 秒内全网合计 30 次失败 → 暂缓受理登录 60 秒——端口公网可达，攻击者可轮换来源 IP 绕过单 IP 桶，全局闸拖慢分布式爆破（不影响正确密码登录）；
- **转发头分域采信**：直连端口（3190）客户端 IP 一律取 socket 对端地址（`cf-connecting-ip` / `x-forwarded-for` 等可伪造头不参与限流计数）；**隧道端口（127.0.0.1:3191，仅 cloudflared 回连）** 上 `cf-connecting-ip` 由 CF 边缘强制覆写、经隧道不可伪造 → 按真实访客 IP 计数，本地直击隧道端口无 cf 头者落 `tunnel-unknown` 单独桶；
- **管理面迁至功能端口 + CF 标记拒绝**：`/api/admin/*` 只在功能端口（127.0.0.1:3191）开放——经 cloudflared/CF 边缘转发的流量**必然**带边缘注入的 `cf-connecting-ip`/`cf-ray`（隧道客户端不可伪造也不可剥离）→ 一律拒于管理面外；无这些头的直连本机请求还需通过 loopback socket + Host 权威 + `sec-fetch-site`/Origin 纪律（防伪造 Host 与 DNS rebinding）。本地恶意页面伪造 cf 头只会把自己排除出管理面（失败方向安全）；隧道端口 Cookie 自动加 `Secure`；
- **CORS 收敛**：仅对 loopback / 同源 Origin 回显 CORS 头；`/api/status` 对不可信来源只返回最小状态（不含局域网 IP、pinSet）；
- **`?pin=` 已移除**：凭据只经 Cookie 或 `X-TT-Pin` 头传输；
- **`/api/respond` 白名单**：rpcId 必须命中服务端暂存的交互请求，approvalId 以服务端记录为准，受理后即失效；
- **CSP + 响应头 + 流式上限**：页面下发 CSP（connect-src 'self'、frame-ancestors 'none'）；全响应 `X-Content-Type-Options: nosniff`；流式连接（SSE + WebSocket 统一）单 IP ≤4、全局 ≤16；
- **`--host` 参数**：`node mobile-server.mjs --host 127.0.0.1` 可仅绑定本机（默认 0.0.0.0 直连）。

> 明文直连说明：直连端口（3190）对**所有人**（含本机）只回引导页（见上方"直连端口全量收口"），密码与数据只经 TLS 隧道传输，明文链路无凭据可窃。注意三点：① 引导页**仅对本机回环来源显示当前隧道地址**，非本机来源只显示通用引导文案（不泄露你的子域）；② 若想公网完全不监听，把启动方式改为 `--host 127.0.0.1` 即可；③ 手机从直连切到隧道域后是新的源，需重新输入一次安全密码。

回归测试：`node .qrtest/security-test.js`（注意：最后一项锁定测试会把 127.0.0.1 锁 10 分钟，测完重启服务即可）。

**手机页功能**：顶部日期选择（默认今天）→ 所选日的日程列表 → 点击任一日程弹出**对话框**查看并修改（名称 / 起止时间 / 地点 / 备注 / 提前提醒分钟数），保存即写回电脑端 `schedule.json`；对话框内可**删除此事件**（两段式确认）。电脑端周视图每 45 秒自动重载（编辑器打开期间暂停），也可点「刷新」立即同步。

**开始前提醒（系统级通知，后台/锁屏可送达）**：手机页顶部点 **「🔔 开启系统通知」**——请求通知权限 → 注册 Service Worker（`sw.js`）→ 订阅 Web Push（VAPID 密钥仅存电脑端本机 `.mobile-srv/settings.json`；订阅列表存 `.mobile-srv/push-subscriptions.json`）。**后台不再依赖手机页面存活**：电脑端 `mobile-server` 每 20 秒扫描 `schedule.json`，事件到 `start − remindLead` 即向所有订阅设备推送系统通知（点击通知回到日程页）。Android Chrome 直接可用；**iOS 需 16.4+ 且把页面「添加到主屏幕」**（PWA，已提供 `manifest.webmanifest` 与图标）。未开启系统通知时维持原有页内弹窗兜底（开启后前台提醒同样走系统通知，tag 去重不会弹两次）。

提前量仍是**事件级字段 `remindLead`**（默认 20 分钟，`0` = 不提醒，双端编辑对话框均可改）；服务端与手机端使用同一判定规则（取消的事件不再推、改期后按新时间重新提醒），服务端已推送键存 `.mobile-srv/remind-fired.json`（48h 清理）。计时基准：推送按电脑端本地时钟、页内检查按手机本地时钟（日程为无时区的本地墙上时间）。验证捷径：手机开启系统通知后，电脑端建一条 2 分钟后开始、remindLead=1 的 `once` 日程，锁屏等待推送；页内弹窗验证仍可用 `?remindLead=0.05`。

**对话电脑端 DSH（输入框）**：手机页底部输入框直连电脑端 DSH——消息经本服务在本机转发给一个专属 DSH 会话（工作目录即本日程表目录），DSH 按自然语言指示直接查看/编辑 `schedule.json`，回复后日程列表自动刷新。支持**图片附件**（📷 拍照/相册，最多 4 张、单图约 5MB，手机端自动压缩到最长边 1568px；gif 保持原样）。对话框**限高 46vh、内部滚动**，双端消息原样镜像（电脑端 GUI 在该会话的发言也会出现）；**完整过程**与电脑端对等：💭 思考过程（可折叠）、🔧 工具调用卡片（含**入参**与**输出**，运行中 ⏳ / 成功 ✓ / 失败 ✕）、每一步的中间回复全部随生成实时展示；DSH 发起的**提问 / 工具批准**会渲染为可点选卡片，手机直接作答或批准/拒绝。mux 事件流断线自动重连（指数退避），重连期间由 4 秒轮询兜底补发消息与未答的提问/批准。**实时链路自愈**（防"无流式响应、要手动刷新才可见"）：① 服务端所有流式通道每 15/25 秒下发**应用层 ping 帧**，手机前台超过 45 秒收不到任何帧即判定连接已静默死亡（手机休眠/运营商 NAT 丢映射时双方都收不到断开通知）并主动重连；② 宿主会话失效自愈重建时，服务端把仍绑旧会话的 watch 连接**立即改绑新会话**并下发 `reset` 帧，手机清空按会话去重的状态后重连拿新会话快照（seq 按会话独立编号，不清表会撞号丢帧）；③ 写文件工具一返回就**节流刷新日程**（≥2 秒一次），不再只等最终消息落地。对话区标题行有 **「✚ 新对话」** 按钮（两段式确认防误触；DSH 处理中禁用）：另建全新专属会话、清空手机端对话区并重连 watch 流，旧对话仍保留在电脑端 DSH；自动恢复默认模型选择。**系统设定注入**（宿主 RPC 无 instructions 通道）：每次新建会话（或会话失效重建）后的首条消息会内联注入日程助手设定——含 **schedule.json 修改规范**（文件最小改动纪律、事件通用字段、weekly/once/custom 三类类型与字段、HH:MM 与日期格式及跨天/月重复约束、歧义先确认等行为规范）。**提示词正文统一维护于 `TTPROMPT.md`（唯一权威来源）**：服务运行时按次加载（mtime 缓存），直接编辑其中代码块即生效——无需改代码、无需重启，新会话的首次注入即读到最新；文件暂不可读/被改坏时沿用上一次成功内容并在服务端日志告警，从未成功加载过则以「发送失败：提示词加载失败：…」显式报错，绝不静默注入陈旧副本（代码中无内置副本，防双源漂移）；watch 镜像与历史快照回手机时自动剥离设定前缀，手机端只见用户真实消息（保证「原位采纳」文本一致、不重复）。消息（含流式生成中的气泡）按 **markdown 渲染**：标题、粗/斜体、删除线、行内代码与 fenced 代码块（带语言标签）、GFM 表格（含对齐）、有序/无序/任务/嵌套列表、引用块、分隔线、链接与裸 URL 自动链接、远程图片渲染为可点链接——安全语义与官方 DSH 前端（dsh-pocket 镜像到手机的 `MarkdownText`）一致：渲染只用 `createElement`/`textContent` 构建节点，消息源文本里的 HTML 一律按字面显示**不会执行**，链接仅放行 `http:`/`https:`/`mailto:`（`javascript:` 等按纯文本渲染）。

**实时通道**：`/api/chat/watch` **优先走 WebSocket**（含协议层 Ping 心跳保活，25s 周期 + 静默断链检测，并同周期下发应用层 `{t:'ping'}` 帧供手机端做活性自检），WS 不可用时自动回落 SSE（EventSource，服务端 15 秒心跳 + ping 数据帧保活）。原因：移动网络中间设备可能**缓冲无 Content-Length 的 GET SSE 流式响应体**（首帧可长时间延迟），WebSocket 帧不被缓冲——蜂窝网络下长时间保持实时镜像更可靠；而手机休眠/运营商 NAT 静默丢映射造成的**僵尸连接**由客户端 45 秒无帧检测兜底自愈。**客户端识别**：一律按 socket 对端 IP 计数（不采信任何可伪造的转发头），流式连接配额（单 IP ≤4、全局 ≤16）与登录限速同源。

> 图片说明：带图消息会自动把会话切换到视觉模型（如 `glm-5v-turbo`）。当前部署若未订阅视觉模型，会立刻返回订阅错误提示（不阻塞纯文本使用）；一旦账号开通即可正常用图。

**独立服务接口**（`mobile-server.mjs` 私有路由，均带 CORS；`/api/admin/*` 仅接受本机 loopback 请求）：

| 路由 | 说明 |
| --- | --- |
| `GET /` | 手机页 `mobile.html` |
| `GET /api/schedule` | 读 `schedule.json`（设密码后凭登录 Cookie 或 `X-TT-Pin` 头；`?pin=` 查询参数已移除） |
| `POST /api/schedule` | 写 `schedule.json`（body `{content}`，服务端校验必须为合法日程 JSON，只可写这一个文件） |
| `POST /api/chat` | 对话电脑端 DSH（body `{message, images?:[{mediaType,data(base64),name}]}`；转发至本机 DSH 专属会话，等待并返回助手回复） |
| `POST /api/chat/stream` | 同 `/api/chat`，SSE 流式逐帧返回：`{t:'open'}` → `{t:'partial',text}`（增量文本）→ `{t:'done',reply}` / `{t:'error'}`；手机端气泡边收边渲染（跨 step 间隙不清屏） |
| `GET /api/chat/watch` | **双端同会话完整过程镜像**（参考 dsh-pocket：订阅宿主 `/api/events.mux` 实时事件流）：连接先下发 `{t:'hello',sid}`（手机端据 sid 变化清空按会话去重的 seq 表）再下发完整过程快照（消息 / 思考 / 工具入参与输出，按 seq 幂等），此后实时推送该会话双端消息、流式增量、思考、工具调用与输出；周期性 `{t:'ping'}` 心跳帧；**优先 WebSocket**（`Upgrade: websocket`，移动网络首选；含心跳保活），自动回落 SSE（EventSource）；mux 断开时自动退化为 4 秒轮询补漏；会话重建时下发 `{t:'reset',sid}` 并改绑监听；手机与电脑端 GUI 共用同一条会话，任一端发言与全部中间步骤都会原样出现在手机对话框 |
| `POST /api/respond` | **手机端答复 DSH 的提问/批准**：`{rpcId, kind:'question', answer:[{id,selected,custom?}]}` 或 `{rpcId, kind:'approval', approvalId, outcome:'allowed-once'\|'rejected'}`，转发至宿主 `POST /api/respond`；对应问题/批准经 watch 流推给手机渲染为可点选卡片 |
| `POST /api/chat/cancel` | 取消当前卡住的轮次（`session.cancel`），解阻塞后可重新发送 |
| `POST /api/chat/reset` | **新建对话**：尽力中止旧轮次（忙碌时 `session.cancel`）、丢弃旧会话未答的提问/批准暂存，另建全新专属会话并恢复默认模型；旧会话历史仍保留在宿主/电脑端 |
| `GET /api/chat/models` | 列出专属会话可用的模型（`session.models`：当前选择 + 按供应商分组 + 推理档位） |
| `POST /api/chat/model` | 切换对话模型 `{provider, model, reasoningEffort?}`（`session.selectModel`；结果记为默认模型，纯文本消息沿用，带图消息仍会临时切视觉模型） |
| `GET /api/chat/log` | 会话消息快照（调试/兜底用） |
| `POST /api/logout` | 退出登录：吊销当前会话 token 并清除 Cookie |
| `GET /api/status` | `{port, lanIp, lanUrl, pinSet}`，供 PC 端面板生成二维码 |
| `POST /api/admin/pin` | 设置 / 清除安全密码（body `{pin}`，空串清除；仅本机） |
| `POST /api/admin/shutdown` | 优雅停机（由 DSH 插件 `dsh-timetable-mobile` 在宿主关闭时调用；仅功能端口本机请求） |

## 实现内幕：读代码容易看漏的约定（踩坑实录）

> 以下细节在代码里分散、无注释级展开，但**每一条都对应真实踩过的坑**。改动相关区域前先读这一节，能省掉重复排障。

### 会话与消息转发（`chatOnce` / `chat-setup.mjs`）

- **宿主 RPC 信封**：所有调用 POST 到 `http://127.0.0.1:3080/api/<method>`，body 是 `{type:'client-request', rpcId, method, payload}`（**不是** `{params}`），返回 `{result:{ok,value}}`。宿主**没有 instructions/system 通道**——系统设定只能内联进首条用户消息（`withSetup`），这是整套注入架构的根因。
- **提示词正文只在 `TTPROMPT.md`，代码里没有副本**：`loadInstruction()` 按次读取、mtime+size 缓存（改提示词无需重启）；提取按「## 手机端对话系统设定」**章节锚定**取首个代码块——别改成"全文件第一个代码块"，文件前面出现任何示例块就会被误注入。加载失败分两级：曾成功过 → 告警 + 沿用上次内容；从未成功 → 抛错到手机端「发送失败：…」。**不要**给代码加回内置兜底副本——它必然与 md 漂移，且 md 被改坏时会静默注入旧提示词，用户毫无感知。分隔标记（SETUP_SEP）是协议常量，加载期校验提示词里不得混入（混入会让 stripSetup 错位截断）。
- **`chatInited` 落盘时序**：只有 `session.prompt` **成功之后**才写 `chatInited=true`——提交失败则下一条消息会再次注入设定（幂等，无害）；会话重建/新建对话一律复位 `false`。新增"发消息"的路径必须复用 `chatOnce`，别自己拼 RPC，否则**注入、剥离、模型形态切换**三件事都会缺。
- **`stripSetup` 必须覆盖所有用户消息回显路径**：mux 实时帧、快照 `chatHistoryFrames`、`/api/chat/log` 三处都剥（兼容新旧两种分隔标记，历史会话也能剥）。漏掉一处，手机就会显示设定原文，且发送气泡的「原位采纳」因文本比对不一致而失效——表现为**消息重复**。
- **中间步骤的 `assistant/message` 是空文本**：多步轮次（带工具调用）每个中间步骤都落一条空 message 事件，只有最后一步带全文——这不是异常。`chatOnce` 的稳定收尾（marker 之后出现 assistant/message + 3 秒无新事件）与镜像层的 `if (text)` 过滤都依赖这一点。
- **历史 `tool/result` 常缺顶层 callId**：快照按序配对最近的 `tool/call`（`lastToolId`）；实时帧用 `toolCallIdOf` 再翻 `message.source.callId`。
- **会话失效自愈可能发生在任何 `ensureChatSession` 调用点**（发消息、watch 连接、cancel、respond……）——`chatSessionId` 随时可能变。持有 sid 的长生命周期对象（MUX listener、`MUX.pending`）必须跟着换绑/清理，统一走 `notifySessionReset`，不要在别处手工改。
- **图片"污染"自愈**：历史含图片块 + 纯文本模型 → 宿主报 1210 类错误（`POISON_RE` 命中）→ 丢弃重建会话；仅**纯文本**消息自动重试一次，带图直接报错不重试。
- **视觉模型切换顺序**：`ensureModelShape` 在**第一次切换前**把当前模型存进 settings 当"默认"（会话重建后才能恢复默认），然后才切视觉模型——顺序反了默认模型就永久丢失。

### watch 实时镜像（seq / 去重 / 自愈）

- **seq 是每会话独立编号，不是全局**：两个会话都可能有 seq 5。客户端 `renderedSeqs` 只在单会话内有效；hello 帧携带 sid 且**必须先于快照下发**——顺序反了，快照帧先到、被旧表的撞号 seq 丢弃（"刷新才可见"的根因之一）。
- **实时帧与快照帧的去重键不同**：live 的 message 帧带 seq；partial/tool/toolresult **不带 seq**（工具按 callId 幂等、思考快照按内容前缀去重、partial 全量替换文本）。给 live 帧补 seq 会破坏这套幂等设计。
- **协议层 Ping 对页面 JS 不可见**（浏览器网络栈自动回 Pong）：服务端检测静默断链靠它（2 个周期零入站即杀连接）；客户端检测僵尸连接必须靠**应用层 `{t:'ping'}` 帧**（前台 45 秒无任何帧即判死重连）。两套心跳各管一边，不能合并。
- **WS 优先的真正原因**：移动网络中间设备会**缓冲无 Content-Length 的 GET SSE 响应体**（首帧可延迟数分钟）；WS 帧不被缓冲。SSE（EventSource）只是兜底通道，不是平级选项。
- **发送气泡的"原位采纳"不能用 lastElementChild 判断**：发送后对话区末尾是流式气泡/思考块/工具卡，用户气泡**不在最后**。用 `pendingLocalUser.el` 元素引用优先，兜底向前扫 8 个元素；比对用 `_mdRaw`（markdown 渲染前的原文）而非渲染后的 textContent。
- **`chatGen` 代数护栏**：新建对话后，旧 POST 流的全部回调（partial/done/error/finally）先查 `gen !== chatGen` 再动手，否则旧会话的迟到帧会写进新对话。
- **`openWatch` 关旧连接时必须摘掉 onmessage**：已排队未派发的帧一帧都不能再进（清屏后旧会话帧混入即脏屏）。
- **mux 断线的 4 秒轮询兜底**会整段重放快照（幂等靠 seq/callId/内容前缀）并补发未答的提问/批准（按 rpcId）——快照帧天生要可重放，别往快照路径里塞"只应出现一次"的副作用。

### 页面与渲染（`mobile.html`）

- **markdown 渲染的安全不变量**：只用 `createElement`/`textContent` 构建节点，**永远不拼 innerHTML**；URL 白名单 `http/https/mailto` 用 `new URL().protocol` 判定；消息源文本里的 HTML 一律按字面显示。改渲染器时这条不变量不能破——XSS 防护靠构建方式本身，不靠过滤。
- **流式渲染是整段重渲**：未闭合标记按字面显示，闭合后重渲染整个气泡（不做增量 patch）；`_mdRaw` 存的就是原始全文。
- **`load()`（日程刷新）的触发点**：页面加载、最终 bot 消息帧、POST 流 `done`、`toolresult` 帧（≥2 秒节流）。新增触发点必须节流——`load()` 会整段重渲染日程列表。
- **`GET /` 每次请求都从磁盘重读 `mobile.html`**：改页面无需重启服务，手机刷新即生效；但**已打开的旧页面不会自动换新 JS**（要用户刷新一次）。改 `TTPROMPT.md`（提示词正文）同样无需重启（按次加载）；只有改 `mobile-server.mjs` / `chat-setup.mjs` 才需要重启进程。

### 服务生命周期（`mobile-plugin` / 端口 / 重启）

- **直连端口全量收口的判定位置**：收口闸门在**一切路由与鉴权之前**，`!viaTunnel` 即拦（不看来源、不看路径——GET/HEAD 回引导页，其余 403）；WebSocket upgrade 里有一份**同策略的独立闸门**（upgrade 事件不走路由链）。两处必须同步改——只堵 HTTP 不堵 upgrade，手机页的 watch WS 仍会从直连端口漏进去。引导页读的是 `TUNNEL_URL`（quick tunnel 重启会换 URL，页面按请求时现值渲染）。
- **管理面只可能在功能端口被路由到**（直连端口在管理路由之前就被收口闸门截断）；`trustedLocalRequest` 因此不再按端口否决，而是按 **CF 标记**否决（带 `cf-connecting-ip`/`cf-ray` ⇒ 经边缘流量 ⇒ 拒绝）——这两个头由 CF 边缘注入、隧道客户端既不可伪造也不可剥离，是功能端口上区分「隧道转发」与「本机直连」的唯一可靠信号。

- **插件在 DSH web 启动/重新 apply 时拉起一次**，并对已占端口做**身份探测**（`/api/status` 返回 `ok:true` 且 `port` 匹配才认定是本服务，其他进程占用则跳过该端口继续向后探）；**服务进程意外退出会自动守护重启**（指数退避 5s→80s，连续 5 次失败放弃并记日志；稳定运行满 60s 后计数归零）；宿主 dispose 触发的正常退出不重启。手动先起的实例，插件 apply 时探明身份后跳过（日志 `port already serving, skip auto-start`）。
- **服务日志落盘**：mobile-plugin 拉起的实例 stdout/stderr 逐行带 ISO 时间前缀写入 `.mobile-srv/server.log`（超 1MB 自动截断保留后半）——排查"手机连不上 / 服务没起来"先看这里。
- **port 文件写的是"功能端口"（回连端口），不是直连端口**：`.mobile-srv/port` 与 `tunnel-port` 由实例启动时写入（均为功能端口），插件 dispose 的 shutdown 与面板的管理调用都按它寻址——管理接口只存在于功能端口，写直连端口会找错对象。port 文件是"最后启动者写"：**双实例竞争真实发生过**（手动重启撞上插件/面板自动拉起），清理双实例后要**手工核对 port 文件指向存活实例的功能端口**。
- **`Start-Process node` 返回的 pid 是 PATH shim**（瞬态），真正 node 进程 pid 不同且已分离——追进程用 `netstat -ano` 按监听端口找，别信 Start-Process 的返回值。
- **重启后几秒的 `ECONNREFUSED` 是启动窗口期抖动**，等待即可；cloudflared named tunnel 随服务重启自动恢复**同 URL**。
- **手动安全重启流程**：loopback `POST 127.0.0.1:3191/api/admin/shutdown`（带密码）→ 轮询端口释放 → `Start-Process node mobile-server.mjs -WindowStyle Hidden`（工作区目录）→ 轮询 `127.0.0.1:3191/api/status`。**若 Start-Process 起的实例在发起它的命令结束后被环境回收**（作业对象清理：表现为"启动时探活正常、下一条命令就 ECONNREFUSED 且日志无退出记录"），改用面板同款拉起通道：`node .qrtest/spawn-via-worktable.mjs`——经 dsh-worktable 终端 WS 让 DSH web 宿主代为 spawn，服务成为宿主子进程（与本插件 apply 拉起的实例同级，可跨命令/长存活）；诊断脚本 `.qrtest/lockdown-verify.mjs` 可一键复核收口/功能/隧道/watch 全链路。
- **`.mobile-srv/settings.json` 是唯一持久状态**：`chatSessionId`/`chatInited`/默认与视觉模型/VAPID/pin 都在这里，服务重启不丢；删掉它会孤儿化当前会话（下次自愈重建、`chatInited` 复位 → 首条消息重新注入设定）。

### 测试架（`.qrtest/page-harness.mjs`）

- 页面测试在 `node:vm` 里执行**真实的内联 `<script>`** + 桩 DOM。桩必须模拟真实 DOM 语义：**appendChild 会先从旧父节点摘除子节点**（否则 `while(firstChild) appendChild` 类移动代码死循环到 RangeError）、**textContent getter 拼接后代文本**——这两个语义差异都真实炸过测试。
- 给页面新增元素 id 时，必须同步加进 harness 的 `ids` 列表，否则页面 `$(id)` 拿到 null 直接炸测试。

## 怎么改日程

方式一（推荐，直接在窗口里改）：

- **新建**：工具栏点 **「＋ 新建」**，或**双击时间表空白格**——按点击位置预填开始时间（30 分钟对齐、默认时长 1 小时）与该格日期，以一次性事件打开新建编辑器（保存时自动生成 id）；
- **单击**某条内容查看只读详情（时间 / 重复规则 / 地点 / 备注；Enter 打开、Esc 关闭）；
- **双击**某条内容打开编辑器，可修改：**名称、开始/结束时间、重复间隔（类型 + 星期/日期/间隔单位 + 起始日期）、地点、备注**，各字段自动带出当前值；
- **长周期任务**：编辑器类型选 **「任务（长周期·截止日）」**——无起止时刻，只填**截止日期（必填）**。保存后任务不出现在时段网格里，而是集中在时间表**最右侧「⏰ 截止任务」侧栏**（与普通日程不混排），按截止日升序排列，卡片按紧急度分级配色（逾期/今天=红、≤3 天=橙、≤7 天=黄、更远=蓝），并显示「今天截止 / 还剩 N 天 / 已逾期 N 天」；**截止当日**所在日列顶部会显示**红色横幅「⏰ 截止：任务名」**（点击查看详情）；任务同样计入顶部统计卡「截止任务」；
- 点 **保存** 生效并**自动写回 `schedule.json`**；点 **取消** 或按 **Esc** 放弃修改；校验失败（如名称为空、结束时间早于开始时间）会提示且不落盘；
- 点 **删除此事件**（编辑器右下角红色按钮）并确认后，该事件从数据中移除并写回 `schedule.json`；
- 按周重复的自定义间隔可勾选每周具体哪几天。

方式二（外部编辑器）：

1. 用任意文本编辑器打开 `schedule.json`。
2. 增删改 `events` 数组里的条目。
3. 回到窗口点「刷新」，页面会重新读取并渲染。

> 持久化：修改通过工作台 `/api/worktable/write` 接口直接写回 `schedule.json`；若服务端写入失败，会自动存本地备份——下次打开时若备份与文件不一致会弹出**冲突面板**供二选一（使用备份写回 / 保留文件现值），不会自动覆写。
> 若浏览器环境无法自动读取文件，可点「临时预览」粘贴 JSON 预览（不写回文件）；正式数据仍以 `schedule.json` 为准。

## 数据格式

顶层结构：

```json
{
  "_说明": "给人看的备注（如课表适用学期/周次），程序不解析",
  "meta": { "title": "标题", "weekStart": 1, "termStart": "2026-09-07" },
  "events": [ ... ],
  "archive": [ ... ]
}
```

`_说明`（可选）：写在文件顶部的备注（实际数据文件即用它登记学期/周次信息）；页面与手机端写入时原样保留，AI 修改也遵守保留约定，程序不解析其内容。

`archive`（可选）：**过期归档节点**——过期满 3 个月的事件由 `mobile-server` 自动从 `events` 移入（保留原始字段 + `archivedAt` 归档时间戳）；不渲染、不提醒、不参与校验。周视图工具栏「历史」面板可查看并一键恢复到日程（恢复后请自行修改已过期的 `deadline`）。

### meta（可选）

| 字段 | 说明 | 默认 |
| --- | --- | --- |
| `title` | 窗口标题 | `每周日程表` |
| `weekStart` | 一周从周几开始：`1` 周一 / `0` 周日 | `1` |
| `timeStart` / `timeEnd` | 固定时间范围（`"07:00"`、`"23:00"`）；不填则按日程自动适配 | 自动适配 |
| `termStart` | 学期首周周一 `"YYYY-MM-DD"`（可选）：配置后周视图标题栏显示「第 N 教学周」徽标 | 不显示 |

### 事件通用字段

| 字段 | 说明 |
| --- | --- |
| `id` | 唯一标识（可选，建议填） |
| `title` | 事件名称（必填） |
| `start` / `end` | 当天起止时间，`"HH:MM"`（必填） |
| `location` | 地点（可选） |
| `color` | 十六进制色值，如 `"#4f8ef7"`（可选，缺省按类型配色） |
| `note` | 备注（可选） |
| `remindLead` | 提前提醒分钟数（可选，默认 `20`；`0` = 不提醒）——手机推送/桌面提醒/服务端判定三端统一语义 |
| `deadline` | 截止日期 `"YYYY-MM-DD"`（可选）：**到该日（含）为止生效**——之后不再渲染、不再提醒；数据不删除，`mobile-server` 会在**过期满 3 个月**后自动把事件**移入顶层 `archive` 归档节点**（附 `archivedAt` 时间戳，不渲染不提醒，可在周视图「历史」面板查看/恢复）。`once` 型缺省即其 `date`；`custom` 型缺省对齐 `repeat.until`；**`task` 型该字段含义为「任务必须完成日」且必填**。三个编辑入口（周视图编辑器 / 手机端对话框 / AI 对话）均可改 |
| `skip` | 例外日期列表 `["YYYY-MM-DD", …]`（可选，全类型生效）：**停课/调休日**——事件在这些日期不发生（不渲染、不提醒），无需删除整个事件。判定顺序：`deadline` → `skip` → 原重复规则。周视图与手机端对话框均可编辑（多日期用逗号/空格分隔） |
| `weekPattern` | 单双周 `{ "start": "YYYY-MM-DD", "odd": true \| false }`（可选，仅 `weekly` 型）：以 `start` 所在周为第 1 教学周，`odd:true` 仅单数周（1/3/5…）发生、`false` 仅双数周（2/4/6…）；与 `skip` 可共存。周视图与手机端对话框均可编辑（`start` 缺省取 `meta.termStart`，无则本周一） |

### 四种组件类型

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

#### 4. 长周期任务（截止日）

一个长周期内**必须完成**的事项（如「12 月底前完成项目报告」）：不占时段、不进网格、不参与时刻提醒，集中在周视图右侧**「⏰ 截止任务」侧栏**展示；`deadline` = **必须完成日（必填）**，截止当日网格列顶部红色横幅醒目标出，手机端当日列表红字显示「截止」。

```json
{ "title": "完成课程项目申请书", "type": "task", "deadline": "2026-12-20", "note": "可选备注" }
```

- 逾期任务保留展示（红色「已逾期 N 天」），过期满 3 个月照常自动归档；
- 导出 ICS 时任务按 RFC 5545 导出为 `VTODO`（`DUE` = 截止日全天）。

## 明暗主题

页面自动与 DSH 系统的明暗主题保持同步：嵌入工作台时实时读取并监听主界面主题（`data-ds-dark-theme` / 背景亮度），切换 DSH 主题后时间表立即跟着变亮/变暗；若 DSH 未注入亮色设计变量，页面会按实际解析亮度自动补一组亮色 `--dsw-alias-*` 变量兜底；独立打开时则跟随系统偏好（`prefers-color-scheme`），切换带平滑过渡动画（尊重系统「减少动态」设置）。

## 已知限制

- 跨天日程仅支持跨午夜一段（如 23:00–01:00）：当天显示至 24:00，次日 0 点起显示「次日续」段；周日跨午夜的部分延伸到下一周周一显示。不支持持续超过一天以上的事件。
- 按月重复时按「几号」匹配，起始日若大于 28 号，个别月份会自然跳过（如 31 号在小月不出现）。
- `remindLead` 语义（桌面端与手机端已统一）：`0` = 不提醒；显式设置时双端均按该值单档提醒。留空/未填时的默认档不同——桌面提醒回落 30/10 分钟双档，手机端与 Web Push 为 20 分钟单档。

## 故障排查 FAQ

- **保存失败 / 提示「已存本地备份（服务端写入失败）」**：写回依赖 dsh-worktable 的 `/api/worktable/write`——确认 DSH web 已启动、`dsh-worktable` 已注册（见「安装与运行 · 0」）。失败内容已存浏览器本地备份，下次打开页面若与文件不一致会弹**冲突面板**二选一（使用备份写回 / 保留文件现值），数据不会丢。
- **「手机访问」面板提示服务未运行**：面板会经终端通道自动拉起 `mobile-server.mjs`（通常 3 秒内上线）；连续失败 3 次后不再自动重试，请在工作区手动执行 `node mobile-server.mjs`，面板每 5 秒轮询会自动刷出二维码。
- **重启 DSH web 报 `profile bundle "…" declares no dsh.bundle in its package.json`**：bundle 契约缺失——插件 `package.json` 必须声明 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` 且包根目录存在 `cordis.patch.yml`，详见「安装与运行 · 2」的契约必读段。
- **二维码不显示 / 一直「获取中…」**：面板正在探测端口（3190–3199）等待 `/api/status` 就绪，约 3 秒；仍未出现就点「收起」再展开「手机访问」重新触发，或按上一条手动启动服务。
- **手机扫码打不开 / 连不上**：① 确认电脑端 cloudflared 隧道在运行、面板显示的隧道地址与手机访问的一致（配置见 `CLOUDFLARED-SETUP.md`）；② 密码连续输错触发限速（60 秒 5 次即锁 10 分钟起、逐次翻倍），等锁定结束再试；③ 新部署首启的随机密码只在服务启动日志里显示一次，找不到就在本机面板重新设置。
- **桌面提醒不弹**：按 Ctrl+Alt+T（仅 Windows；其他平台由宿主 show/hide 控制）唤出主窗口确认 helper 在运行；热键无响应可能是被其他程序占用（启动时会提示「Ctrl+Alt+T 注册失败」）——关掉占用程序后重启；可用 `DSH_TTR_SHOW_ON_START=1 python runtime/helper.py` 带窗口验证。
- **桌面提醒窗口顶部出现「⚠ 日程数据文件损坏或不可读」**：`schedule.json` 语法损坏或不可读（此时列表为空），用编辑器修复 JSON 语法后窗口每分钟自动重读恢复。
