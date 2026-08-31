# 防火墙收窄命令清单（需管理员权限）

## 背景

安全检查发现两条 Windows 自动生成的放行规则：

- 规则名 `Node.js JavaScript Runtime`（TCP 与 UDP 各一条）
- 内容：**任意 node.exe 进程 × 任意端口 × 任意远程 IP**（Public profile 也启用）

后果：本机任何 node 服务只要监听 0.0.0.0 就自动对全公网敞开（本次实测：3190 日程服务、3081 dsh-pocket 均因此暴露）。应替换为**按端口**的最小放行。

## 执行（管理员 PowerShell）

```powershell
# 1. 删除过宽的 node.exe 程序级放行规则（TCP+UDP 一起删）
Get-NetFirewallRule -DisplayName "Node.js JavaScript Runtime" -ErrorAction SilentlyContinue | Remove-NetFirewallRule

# 2. 只放行日程服务需要的端口
New-NetFirewallRule -DisplayName "Timetable Mobile (TCP 3190)" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3190

# 3.（可选）若手机还需访问 dsh-pocket（3081），另行放行；不需要则不加
# New-NetFirewallRule -DisplayName "dsh-pocket (TCP 3081)" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3081

# 4. 验证
Get-NetFirewallRule -DisplayName "Timetable Mobile (TCP 3190)" | Format-List DisplayName,Enabled,Action,Direction,Profile
```

纯 netsh 等价写法（管理员 cmd）：

```bat
netsh advfirewall firewall delete rule name="Node.js JavaScript Runtime"
netsh advfirewall firewall add rule name="Timetable Mobile (TCP 3190)" dir=in action=allow protocol=TCP localport=3190
netsh advfirewall firewall show rule name="Timetable Mobile (TCP 3190)"
```

## 效果与回滚

- 效果：公网只能触达 TCP 3190（受 PIN+限速保护的服务本身）；DSH GUI(3080) 本就仅 loopback，不受影响；其他将来出现的 node 服务默认不再自动暴露。
- 注意：删除 node.exe 规则后，若有**其他**确实需要公网入站的 node 服务，Windows 会在其监听时重新弹窗询问，按需放行或为其建端口规则即可。
- 回滚：`New-NetFirewallRule -DisplayName "Node.js JavaScript Runtime" -Direction Inbound -Action Allow -Program "C:\Program Files\nodejs\node.exe"`（不推荐，仅应急）。
- 验证方式：手机蜂窝网络访问 `http://101.5.187.121:3190/` 应正常；访问 `http://101.5.187.121:3081/` 应超时（若未加可选规则）。
