# dsh-worktable 安全补丁（本地加固）：/api/worktable/* 全端点 PIN 鉴权

**针对版本**：dsh-worktable **0.3.3**（上游 2026-09-06 发布；本补丁 2026-09-12 从 0.2.3 基线移植到 0.3.3）
**落点**：本地 fork `D:\tools\deepsek_harness\dsh-worktable\lib\index.js`
（profile `web` 依赖已改为 `link:D:/tools/deepsek_harness/dsh-worktable`，`node_modules\dsh-worktable` 是指向该目录的 junction —— 所以改动不会再被插件安装覆盖）
**状态**：已落在 fork 目录；**DSH web 重启后生效**（插件代码随宿主进程加载）
**补丁与更新流程**：见 `D:\tools\deepsek_harness\dsh-worktable\LOCAL-MODS.md`

## 漏洞清单（0.3.3 原版同样全部无鉴权，服务绑 loopback 但本机任意网页可跨源打击）

| 端点 | 危害 |
| --- | --- |
| `WS /api/worktable/term` | **本机 RCE**：交互式 PowerShell（WebSocket 无 CORS 门禁，任意 http 页面可连） |
| `GET /api/worktable/file?path=` | 任意文件读（≤20MB） |
| `GET /api/worktable/site/<root>/*` | 任意文件读（root 客户端自选，≤40MB） |
| `POST /api/worktable/write` | 任意文件写（2026-09-01 已实证跨源落盘） |
| `POST /api/worktable/mkdir` | 任意目录创建 |
| `POST /api/worktable/fs` | 任意目录列举 |
| `GET /api/worktable/workspaces` | 泄露全部工作区路径 |
| `POST /api/worktable/git` | 任意 cwd 执行 git |
| `GET /api/worktable/health`、`/api/worktable/template/*` | 无敏感数据，保持开放 |

## 补丁设计（与 mobile-server PIN 机制同语义）

- **PIN 存储**：scrypt 加盐哈希（N=16384，与 mobile-server 相同参数）落 `~/.dsh/storages/worktable-auth.json`（可用环境变量 `DSH_WORKTABLE_AUTH_FILE` 覆盖）；**未配置密码时首次 POST login 即设置**（与 mobile-server 首设流程同语义）。
- **会话**：login 签发 24 字节随机 token——浏览器走 `Set-Cookie: tt_wt_v2=<token>; HttpOnly; SameSite=Strict; Max-Age=30d`（SameSite=Strict 保证 evil.com 的跨源 fetch/WS 带不上 Cookie），脚本走响应体 token 拼 `?auth=<token>`（WS 无法自定义头）。
- **兼容头**：`X-TT-Pin: <明文pin>` 直接过门禁（脚本/面板场景）。
- **限速**：密码失败单 IP 60 秒窗口 5 次 → 锁 10 分钟；Cookie/token 会话不受锁影响。
- **浏览器导航 401 → 迷你登录页**（GET + Accept: text/html 时返回内嵌登录 HTML，登录成功 reload）。
- **开放端点**：health（保活探针）与 template（静态皮肤）不设门禁。

## 文件清单

| 文件 | 说明 |
| --- | --- |
| `dsh-worktable.v0.2.3.patch.bak` | **历史留档**：对 0.2.3 原版 `lib/index.js` 的鉴权补丁。现行补丁已迁至 fork：`D:\tools\deepsek_harness\dsh-worktable\patches\01-auth-pin.patch`（基线 0.3.3，同样 +224/−2；对 pristine 0.3.3 apply 后与 fork 内文件逐字节一致） |
| `setup-pin.mjs` | 设置/重置 PIN：`node patches/dsh-worktable/setup-pin.mjs "<PIN>"`（不带参数则随机生成）；明文同时写入 `.mobile-srv/worktable-pin.txt`（gitignored） |
| `test-auth.mjs` | 隔离验证（mock 宿主 + 重定向 auth 文件，不碰真实配置）：15 断言，`node patches/dsh-worktable/test-auth.mjs`；fork 目录内有一份同源副本，可 `node test-auth.mjs` 直接跑 |
| `.qrtest/worktable-auth.mjs` | 应急脚本共用鉴权助手（读明文 PIN → login 换 token；补丁未生效时返回 null 自动回退直连） |

## 上游发新版后怎么更新

**不再往 `node_modules` 里重放补丁**（那是 0.2.3 时代的做法）。现行流程：在 fork 目录内更新上游代码 + 重放两个补丁 + 自检 + 重启。
完整步骤、补丁清单与回滚路径见 **`D:\tools\deepsek_harness\dsh-worktable\LOCAL-MODS.md`**。

要点（避免踩过的坑）：

1. 重放补丁必须带 `-c core.autocrlf=false`，否则 Windows 上 autocrlf 会让 `git apply` 静默跳过（exit 0 且无输出）；
2. 应用后必须做**内容自检**——`authGate`（鉴权）与 `data-ds-dark-theme`（控制台主题）是补丁专属标识符，只出现在新增行；
3. `node --check lib/index.js lib/client.js` + `node test-auth.mjs`（应 15/15）；
4. 补丁对新版 apply 失败时，以新版原件为基线重新移植改动，再重新生成补丁。

## DSH web 重启后的一次性活体验证

```powershell
# 1) 版本号应为 0.3.3
node -e "fetch('http://127.0.0.1:3080/api/worktable/health').then(r=>r.text()).then(t=>console.log(t))"
# 2) 无凭据 → 应 401（501=auth 未配置，先跑 setup-pin.mjs）
node -e "fetch('http://127.0.0.1:3080/api/worktable/workspaces').then(r=>r.text()).then(t=>console.log(r.status,t.slice(0,80)))"
# 3) 带 X-TT-Pin → 应 200
$pin = Get-Content D:\tools\auto_timetable\.mobile-srv\worktable-pin.txt -Raw
node -e "fetch('http://127.0.0.1:3080/api/worktable/workspaces',{headers:{'x-tt-pin':process.argv[1]}}).then(r=>console.log(r.status)).catch(e=>console.log(e))" $pin.Trim()
# 4) .qrtest 应急脚本仍可用（自动带 token；schedule.html 保存/终端在浏览器登录一次后照常）
node .qrtest\spawn-via-worktable.mjs
```

浏览器侧：重启后第一次打开工作台窗口会出现「worktable 访问密码」登录页，输入 `.mobile-srv/worktable-pin.txt` 中的 PIN 即可（Cookie 30 天有效）。

## 上游反馈

见 `upstream-issue-draft.md`（建议私下披露；公开 issue 前先与作者确认披露口径）。
