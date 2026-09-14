# Cloudflare Tunnel 配置指引（HTTPS）

> **当前部署状态（quick tunnel / 快速版）**：已上线运行，双守护自愈。
> - 隧道地址：`https://hazardous-doubt-extensions-vital.trycloudflare.com`（**cloudflared 重启后会变**，以 PC 面板二维码为准，服务端每 10 秒从 `.mobile-srv\tunnel.log` 自动发现）
> - `.mobile-srv\start-server.cmd` = **mobile-server 守护**：每 10 秒查 3190 端口，掉线自动重启，输出追加到 `.mobile-srv\server.log`（排查崩溃必看）
> - `.mobile-srv\start-cloudflared.cmd` = **cloudflared 守护 v2.1**（2026-09-10 v2 + 2026-09-11 http2）：①进程不在 → 分离式拉起（自身最小化控制台）；②**僵尸探测**——每 30 秒跑 `.qrtest\tunnel-probe.mjs`（公网 URL 直连+代理双路各试、两轮全败判僵尸），进程活但边缘死时自动 `taskkill` 重拉。重启动作记入 `.mobile-srv\tunnel-restart.log`；③cloudflared 参数钉死 `--protocol http2`——QUIC 单连接在校园网 NAT 后会静默黑洞成僵尸（进程活/日志净/公网死，09-11 当晚两代中招），TCP 两侧 pre-check 全 PASS，运行时已验证（命令行含 http2 + 日志 `Initial protocol http2` + 边缘注册 protocol:http2）；④探活器**三态语义**（2026-09-14 起）：exit 0 = 健康/无法判定，exit 2 = cloudflared 僵尸（杀+重拉），**exit 3 = 源站内容故障**（公网 200 但回收口引导页——cloudflared/边缘正常，病根在 mobile-server 侧；守护只记录 origin fault 到 tunnel-restart.log、**不杀不重拉**——重拉只会轮换 URL 逼用户重新配对；报警走 tunnel-qq-watcher → 主会话；⑤**lastgood 备份**（2026-09-14 v2.2）——探针健康的循环轮把启动脚本自身快照为 `start-cloudflared.cmd.lastgood`（`copy /y "%~f0" ...`，健康时才刷新，坏脚本永远覆盖不了好备份），作为坏脚本回退锚点）
> - 两个 cmd 均为 ASCII+CRLF、自最小化；双击即用。**开机自启（2026-09-11 已部署）**：启动文件夹里放的是**转发 shim**（源文件 `startup-shim.cmd`，仅 `call` 工作区启动器一行）——启动器全机只有工作区一份，改它即生效；**切勿再把启动器整份复制进启动文件夹**（双副本漂移：09-11 的 http2 修复最初就改在了守护实际未执行的副本上）。重放命令（沙箱外，自己的终端）：
>   ```powershell
>   Copy-Item D:\tools\auto_timetable\.mobile-srv\startup-shim.cmd "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\start-cloudflared.cmd"
>   Copy-Item D:\tools\auto_timetable\.mobile-srv\start-server.cmd    "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\"
>   ```
> - **重启电脑后**：DSH 插件会拉起 mobile-server；cloudflared 需双击上面的 cmd（或已复制进启动文件夹则全自动）
> - **常见日志现象**（`.mobile-srv\tunnel.log`）：`Failed to refresh DNS local resolver region1...` 每 5 分钟一条 = 校园网 DNS 对 `argotunnel.com` 域慢性丢包（08-28 起长期存在，15 天 2000+ 条），背景噪音、不影响在用连接，可忽略勿当死因；`stream canceled by remote` = 手机端锁屏/离开页面主动断开 SSE，非故障；`Unable to reach the origin service` = mobile-server 掉线（守护会在 10 秒内重启它）
> - **进程活但隧道断线**（2026-09-10 实证：公网侧 TLS 握手失败/无边缘连接）：v2 守护的僵尸探测会在下一循环自动 taskkill 重拉（无需人工）；若守护本身也不在了，`Stop-Process -Name cloudflared -Force` 后运行 `node .qrtest\spawn-via-worktable.mjs "C:\Users\ycwan\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\start-cloudflared.cmd"`（经宿主通道拉起 Startup shim，等价开机自启链路；直接 Start-Process 会被沙箱 job-object 回收）；新 URL 约 10 秒内写入 tunnel.log 并被服务端自动发现，**地址会变，APP/手机书签需重新扫码**
> - **2026-09-10 检修结论（为什么 cloudflared 会退出）**：日志证据显示三类退出——①`Initiating graceful shutdown due to signal terminated` = **外部终止信号**（关控制台窗口/注销/清理），8/28 当天多次均属此类，非崩溃；②`no more connections active and exiting`（无 signal 行）= **边缘连接全掉后自退**，与系统睡眠强相关（9/6 16:58 Kernel-Power 睡眠事件前后 9 秒内隧道退出）；③僵死态 = 进程活但边缘全断（9/10 下午实证，代理/VPN/网络切换可致 QUIC 掉线且未自愈）——v2 守护的僵尸探测即为此而设。**2026-09-11 修订**：③僵死态根因定性 = QUIC 单连接被校园网 NAT 静默黑洞（当晚两代中招：21:42 守护击毙重拉、23:27 又死一轮），对策即 v2.1 的 `--protocol http2`；09-10 22:11 的连环 30 秒重拉 = 故障窗口内新生隧道注册不上边缘（日志无 Registered tunnel connection），守护处置正确、非误杀。另外 dsh-pocket 会自管一条到 3081 端口的独立 cloudflared（父进程 = DSH web），与本项目的 3191 隧道互不相干，勿误杀
> - **2026-09-14 事故（隧道全量回「请使用安全地址访问」引导页）**：开机时多个 mobile-server 实例竞态启动，直连口未绑成 3190 顺移占 3191、隧道回连口被挤到 3192，而 cloudflared ingress 硬编码 3191 → 隧道全量命中直连收口引导页（手机端表现为连上地址只见「3 秒跳转」页且永远跳不出去）。已修复：mobile-server main() 改为**隧道口先绑固定 3191、拿不到即 fail-closed 退出**（多实例竞态自动收敛为单实例，杜绝双实例竞争写盘）；探活器（tunnel-probe / tunnel-qq-watcher）补内容校验（健康 = 200 且【非】引导页——收口引导页与错误页同样返回 200，只看状态码会漏判）。症状复现时的处置：确认仅 mobile-server 实例后 `Stop-Process -Name node -Force`，再经 `node .qrtest\spawn-via-worktable.mjs` 重拉单实例；勿手动多开
> - **2026-09-14 事故二（守护脚本自伤 → 隧道全断 13:38-13:52 无告警）**：会话在守护批处理**运行中**直接编辑脚本，块内 echo 文本裸括号令 cmd 解析报「- was unexpected at this time」中止整个批处理；watcher 的 kick 兜底把坏脚本**原样重拉**、连续两次无声失败，直到换址检测才暴露。对策双管齐下：①铁律——改守护类 .cmd 必须先 Stop-Process 杀实例再编辑，改完经 worktable 重拉并行为验证；②兜底升级——watcher kick 后 5 分钟仍不健康 → 自动用 lastgood 备份回退主脚本并重 kick 一次（再给 5 分钟），回退后仍不健康 / 无备份 / 备份与主脚本相同 → **exit 4 显式报警**（追加 `.mobile-srv\watcher-alarm.log` + 通知主会话人工介入），兜底失效绝不静默
> - **tunnel-qq-watcher 退出码全集与回退程序**：0=换址且健康（主会话发 QQ 新地址后重启）；2=24h 无变化例行重启；3=源站引导页态（报警处置，勿重拉 cloudflared）；4=kick 兜底升级失败（人工介入：比对主脚本与 lastgood 哈希、查 cloudflared 二进制/网络/探活链，修复后重启 watcher）。`node .qrtest\tunnel-qq-watcher.mjs --selftest` 跑升级决策 6 例表驱动自测（含负向：未到期不动/回退仅一次/坏备份直通报警）。人工回退坏脚本：`Copy-Item .mobile-srv\start-cloudflared.cmd.lastgood .mobile-srv\start-cloudflared.cmd -Force` 后重拉守护。**QQ 推送出口已闭合（2026-09-14 实证）**：用户给 bot 发消息 → `state/logs/bridge-debug.log` 出现 `收到消息 c2c from=<openid>` → `de_channel_send channels=qq target=c2c:<openid>` 实测送达
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
