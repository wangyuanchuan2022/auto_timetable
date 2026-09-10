# 上游披露草稿：dsh-worktable 0.2.3 /api/worktable/* 全端点无鉴权（含本机 RCE）

> 用途：提给作者（Aisland-SJL）的私下披露初稿。**建议先以私信/Security Advisory 渠道联系，
> 不要直接公开贴出可武器化细节**；公开前可与作者商定披露口径与修复窗口。

---

**标题**：dsh-worktable 0.2.3 全部 /api/worktable/* 端点无鉴权：终端 WebSocket 可被本机任意网页跨源连下（RCE），另有任意文件读写

**环境**：Windows 11，DSH web（127.0.0.1:3080），插件经 profile bundles 正常安装

**摘要**：`lib/index.ts` 的 `apply()` 注册的 9 个 HTTP 路由与 1 个 WebSocket 升级端点均无任何鉴权/Origin 校验。服务虽绑定 loopback，但浏览器对 loopback 的跨源请求不受 CORS 保护（CORS 只影响响应可读性，不影响请求到达；JSON POST 以 text/plain 简单请求即可绕过预检；WebSocket 握手天然无同源约束）。因此**用户浏览器里打开的任意网页**都可以：

1. `ws://127.0.0.1:3080/api/worktable/term` → 直接获得交互式 PowerShell（node-pty，继承用户权限）→ 本机 RCE；
2. `GET /api/worktable/file?path=C:\Users\<u>\...` → 读任意 ≤20MB 文件（SSH 私钥/浏览器数据/配置）；
3. `GET /api/worktable/site/<任意绝对路径>/...` → 同上（root 由客户端指定）；
4. `POST /api/worktable/write` → 任意路径写文件（已在 2026-09-01 实证跨源 200 且真实落盘）；
5. 另有 mkdir / fs（目录列举）/ workspaces（工作区路径泄露）/ git（任意 cwd）。

**复现要点**（非武器化）：任意 http 页面里 `new WebSocket('ws://127.0.0.1:3080/api/worktable/term')` 即可在 onopen 后发 PowerShell 命令；写端点用 `fetch(..., {method:'POST', body: JSON.stringify({path, content})})`（不手动设 content-type 即可免预检）。

**建议修复方向**（我们已在本地实装验证）：
- 为全部敏感端点加统一鉴权门禁：PIN scrypt 哈希 + HttpOnly SameSite=Strict 会话 Cookie（浏览器）+ `X-TT-Pin` 头 / 一次性 token 查询参数（WS 与脚本场景，WS 无法自定义握手头）；
- WS 升级处理器内校验 Cookie/token/Origin，未授权直接 401 并销毁 socket；
- 密码失败限速；未配置密码时首次登录即设置；
- 浏览器导航类 401 返回内嵌登录页，避免破坏页面流。

**本地补丁**：完整 diff 可提供（`lib/index.ts` 约 +190 行：authGate/deny/login 路由/term 门禁/限速，15 项隔离断言全绿）。如需要请告知传输方式。

---

## 附：我们侧的适配影响面（自用备忘，不随披露发出）

- `.qrtest/spawn-via-worktable.mjs`、`.qrtest/spawn-cloudflared-via-worktable.mjs` 已接 `?auth=<token>`（login 404 时自动回退直连，应急链路在补丁未生效窗口不断）；
- `schedule.html` 的 site/write/term 均为同源 + Cookie，浏览器登录一次即恢复；
- 生效条件：DSH web 重启（插件代码随宿主进程加载）。
