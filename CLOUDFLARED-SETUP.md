# Cloudflare Tunnel 配置指引（HTTPS）

> **当前部署状态（quick tunnel / 快速版）**：已上线运行，双守护自愈。
> - 隧道地址：`https://hazardous-doubt-extensions-vital.trycloudflare.com`（**cloudflared 重启后会变**，以 PC 面板二维码为准，服务端每 10 秒从 `.mobile-srv\tunnel.log` 自动发现）
> - `.mobile-srv\start-server.cmd` = **mobile-server 守护**：每 10 秒查 3190 端口，掉线自动重启，输出追加到 `.mobile-srv\server.log`（排查崩溃必看）
> - `.mobile-srv\start-cloudflared.cmd` = **cloudflared 守护**：cloudflared 进程不在时自动拉起
> - 两个 cmd 均为 ASCII+CRLF、自最小化；双击即用，也可复制进启动文件夹实现开机自启（本机沙箱无法代写，在自己的终端执行一次）：
>   ```powershell
>   Copy-Item D:\tools\auto_timetable\.mobile-srv\start-cloudflared.cmd "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\"
>   Copy-Item D:\tools\auto_timetable\.mobile-srv\start-server.cmd    "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\"
>   ```
> - **重启电脑后**：DSH 插件会拉起 mobile-server；cloudflared 需双击上面的 cmd（或已复制进启动文件夹则全自动）
> - **常见日志现象**（`.mobile-srv\tunnel.log`）：`Failed to refresh DNS local resolver region1...` 每 5 分钟一条 = Windows 下 cloudflared 本地 DNS 刷新怪癖，边缘连接不受影响，可忽略；`stream canceled by remote` = 手机端锁屏/离开页面主动断开 SSE，非故障；`Unable to reach the origin service` = mobile-server 掉线（守护会在 10 秒内重启它）
> - **进程活但隧道断线**（2026-09-10 实证：公网侧 TLS 握手失败/无边缘连接，守护只查进程存在性救不了）：`Stop-Process -Name cloudflared -Force` 杀掉僵死实例，再运行 `node .qrtest\spawn-cloudflared-via-worktable.mjs` 经宿主通道重启守护（直接 Start-Process 会被沙箱 job-object 回收）；新 URL 约 10 秒内写入 tunnel.log 并被服务端自动发现，**地址会变，APP/手机书签需重新扫码**
> - 之后有域名了，按下方 named tunnel 步骤升级为固定 URL（手机书签/PWA 不再因重启失效）。

架构：手机 → `https://<隧道地址>`（CF 边缘，TLS）→ cloudflared（本机常驻，出站连接）→ `127.0.0.1:3191`（mobile-server 隧道回连端口）。

- 公网**零入站端口**（隧道是纯出站）；3191 仅 loopback，外部不可达。
- 隧道端口已内置：cf-connecting-ip 按**真实访客 IP** 限流计数、`/api/admin/*` 整体禁用、Cookie 自动加 `Secure`。
- URL 固定不变（named tunnel），手机书签 / PWA / Web Push（secure context）全部可用。

## 前置条件（一次性）

1. Cloudflare 账号（免费）。
2. 一个域名，NS 托管到 Cloudflare（dashboard 添加站点按引导改 NS 即可）。
3. 本机已装 cloudflared（已确认：`C:\Program Files (x86)\cloudflared\cloudflared.exe`，2026.8.2）。

## 步骤

### 1. 授权（交互，需浏览器，一次）

```powershell
cloudflared tunnel login
```

浏览器打开 → 登录 Cloudflare → 选中你的域名 → Authorize。
成功后生成 `C:\Users\<你>\.cloudflared\cert.pem`（隧道创建凭证，与隧道凭证不同）。

### 2. 创建隧道 + 路由 DNS + 写配置（把 `tt.example.com` 换成你的子域）

```powershell
cloudflared tunnel create auto-timetable
# 输出 Tunnel ID（一串 UUID），并生成 credentials 文件

cloudflared tunnel route dns auto-timetable tt.example.com
# 在 CF DNS 里创建 CNAME tt.example.com -> <UUID>.cfargotunnel.com

notepad $env:USERPROFILE\.cloudflared\config.yml
```

`config.yml` 内容（UUID 与 credentials 路径按上一步输出替换）：

```yaml
tunnel: <你的Tunnel-UUID>
credentials-file: C:\Users\<你>\.cloudflared\<你的Tunnel-UUID>.json
ingress:
  - hostname: tt.example.com
    service: http://127.0.0.1:3191
    originRequest:
      noTLSVerify: true
  - service: http_status:404
```

> `service: http://127.0.0.1:3191` 即 mobile-server 的隧道回连端口（`.mobile-srv\tunnel-port` 所写端口）。

### 3. 告知 mobile-server 公网地址（面板二维码用）

```powershell
Set-Content -Path D:\tools\auto_timetable\.mobile-srv\tunnel.json -Value '{"url":"https://tt.example.com"}' -Encoding utf8
```

（重启 mobile-server 后，PC 面板「手机访问」卡片会显示该地址的二维码。）

### 4. 常驻运行（二选一）

**A. Windows 服务（推荐，需一次管理员 PowerShell）：**

```powershell
# 管理员
cloudflared service install
Start-Service cloudflared
```

**B. 计划任务（免管理员，登录自启）：**

```powershell
$action = '"C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel run auto-timetable'
schtasks /create /f /tn "dsh-cloudflared" /tr $action /sc onlogon /rl limited
schtasks /run /tn "dsh-cloudflared"
```

### 5. 验证

```powershell
cloudflared tunnel info auto-timetable   # 应有连接数 ≥ 1
# 手机蜂窝网络（关 WiFi）打开 https://tt.example.com → 出现登录页即通
```

浏览器地址栏是锁形图标 = 全程 TLS；此后敏感流量不再明文跑公网。

## 日常运维

- 日志：服务方式看 `eventvwr`（Windows 日志-应用程序，来源 cloudflared）；任务方式 `schtasks /run` 前台调试可先手动 `cloudflared tunnel run auto-timetable`。
- 升级：重新下载 cloudflared 覆盖安装，重启服务。
- 故障：`cloudflared tunnel cleanup auto-timetable` 清僵尸连接。
- **确认隧道稳定后**：执行 `FIREWALL-HARDENING.md` 但**不加** 3190 放行规则（并删除 node.exe 程序规则），公网入站归零，隧道成为唯一入口。
