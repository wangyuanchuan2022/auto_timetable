# 「智能工作表」（auto_timetable）项目评审报告

> 评审形式：多会话 Agent 评审团（会议主席 + 5 位独立角色评审：架构师、全栈开发者、测试工程师、安全工程师、产品/UX）
> 评审日期：2026-08-31 · 评审房间：room-mtgp8qoq-1
> 评审对象：master 分支（commit 6076446），核心代码约 6,300 行（Python / Node / 前端三栈），git 共 3 次提交

---

## 〇、修复执行总结（2026-08-31 · 评审后全量修复完成）

**全部 19 项建议（P0×5 / P1×9 / P2×5）已修复、测试、提交并部署**，由原五位评审员会话分 7 批执行、主席逐块验收，每块独立 git 检查点：

| 批次 | 块 | 核心内容 | 检查点 |
| --- | --- | --- | --- |
| 1 | A | fail-closed 封堵 + 首启随机密码 + scrypt 哈希 + 会话 token 可登出 + login 403 + 引导页分源 + remindLead=0 修复 + fired 先发后标 + 全写盘点原子写 | `081461c` |
| 1 | B | Python 领域收敛 `timetable_core.py` + Toast 滑入方向 + WM_QUIT 线程投递 + 桌面读 remindLead + 损坏告警 | `1493291` |
| 1 | C | 前端新建/删除入口 + SAVE_PATH 相对化 + 备份冲突二选一 + 单击详情双击编辑 + tabindex + 45s 自动重读 + 密码页内输入 | `cf18aae` |
| 1 | D | mobile-plugin 守护重启（指数退避/5 次上限）+ server.log 落盘 + 端口身份探测 + 子进程 env 白名单 | `0490c55` |
| — | P2-4a | schedule.json 真实数据出库（.gitignore + 脱敏示例） | `47eabb6` |
| — | P2-5a | 热键 Ctrl+F5 → Ctrl+Alt+T（三处默认值同步） | `e2b2397` |
| 2 | G | TTPROMPT.md 更名修拼写 + README 命名统一 + FAQ 7 条 + 文档行为对齐 | `2a7ff7a` |
| 2 | E | **occur.js 单一实现**（三端引用）+ schema 校验（400 明细/页面黄条）+ remind-test 漂移修复 + 对拍 31/31 | `903c64f` |
| 3 | P2-3 | skip 例外日期 + weekPattern 单双周 + 归档（archiveFor）+ 历史/恢复 + 导入 JSON/导出 JSON/ICS + 教学周徽标 | `39337e5` |
| 3 | P2-2 | server-routes.mjs 拆分（30 导出可单测）+ mobile.html 内联抽离（1691→196 行）+ SHOW/HIDE 重放 + parseReply 转正 + body 32MB | `0434c2d` |
| 4 | Y-2 | mobile 编辑器 skip/weekPattern 编辑 | `bdcf03d` |
| 4 | F-1 | schedule.html harness + 47 断言（历史事故场景全覆盖） | `767008b` |
| 4 | F-2 | server-routes 49 断言 + security-test 重写（临时实例/SKIP_LOCKOUT）+ pinIsSet 空值修复 + 双源合并 | `8b2bd45` |
| 4 | Y-1 | CSP 去 unsafe-inline + purgeExpired 归档接入 + sw scope 匹配 + TT_DATA_DIR | `35e2809` |
| — | docs | README 补新功能文档 | `后续提交` |

**验证与部署**：npm test 全链 **297 断言** + Python **31 用例** + security-test **21/21**（自启临时实例、生产目录零写入）+ protocol 5/5 全绿；生产实例已安全重启（部署前备份 settings+schedule 至 `.mobile-srv/backups/`），冒烟通过（未认证 401 / 引导页分源 / CSP 收紧 / pinSet 继承）。用户可见变化：手机端旧 Cookie 失效需重新登录一次（安全升级预期）；默认热键改为 Ctrl+Alt+T。

---

## 一、项目总体评价

**综合评分：B+（良好，早期个人项目的罕见高完成度，但存在必须立即处理的安全与正确性缺陷）**

| 维度 | 评价 |
| --- | --- |
| 架构 | **优**。三大模块以 `schedule.json` 为唯一数据契约、DSH 插件仅做宿主生命周期桥接，分层清晰；TTBPROMT.md 单一权威提示词源设计聪明 |
| 安全设计 | **优−**。直连端口全量收口、CF 标记分域采信、限速双闸、构建式 XSS 防护、SSRF 校验——远超同类自用项目；但存在「未设密码 fail-open」这一高危残留 |
| 功能实现 | **中+**。三大模块可用、实时链路自愈设计精细；但存在多个用户可感知的正确性 bug（提醒语义反转、Toast 动画死循环、推送失败丢失） |
| 代码质量 | **中**。领域逻辑（事件展开判定）存在 **5 份平行拷贝**且已实际漂移；巨函数/内联脚本规模失控；硬编码绝对路径多处 |
| 测试 | **中−**。`.qrtest` 测试理念先进（vm 跑真实内联脚本），但 `schedule.html` 零测试、无 CI、无强制回归机制——历史回归（custom 漏 repeat）未能被拦截 |
| 产品/UX | **中−**。核心 CRUD 缺「新建」入口；提醒双轨心智割裂；安装旅程重且路径承诺不实 |
| 可维护性 | **中**。README「踩坑实录」质量极高，但规则演进需同步 6+ 文件的成本正在放大 |

**五份报告一致认可的亮点**：qrgen.js 自包含二维码实现（带 jsQR 回环测试）；helper-process.js 心跳+重启护栏+配置快照重放；markdown 渲染 createElement/textContent 的 XSS 不变量执行彻底；安全收口链路抽审全部通过。

---

## 二、主要问题清单（按主题归并，含交叉印证）

> 「★★★」= 多位评审员独立提出并相互印证，可信度最高。

### A. 安全（发现者：安全工程师）
| # | 严重度 | 问题 | 证据 |
| --- | --- | --- | --- |
| A1 | **高** ★ | **未设密码 = 全功能裸奔 + 引导页主动奉送隧道地址**：checkPin 对所有功能路由放行（含 /api/chat——该会话带工具执行能力，等价公网 RCE 面）；/api/login 明文回「未设置安全密码」供远程探测；引导页向任何扫描者返回隧道 URL | mobile-server.mjs:194、:1217、:1156-1161 |
| A2 | 中 | pin 与 VAPID 私钥**明文落盘** `.mobile-srv/settings.json`（未入库✓，但本地进程/备份同步可直接读取） | :1195、:607-611 |
| A3 | 中 | 登录 Cookie 确定性派生（sha256(pin)）、30 天有效、**无登出/无按设备吊销**，改 pin 全体设备连坐 | :1235、:124 |
| A4 | 低 | /api/admin/pin 旧密码校验用 `===`（与登录路径 timingSafeEqual 不一致）；/api/admin/shutdown 不验 pin（本机 DoS 面）；CSP 含 unsafe-inline；插件子进程继承宿主全量 env；schedule.json 真实个人课表被 git 追踪（转公开即隐私泄露） | :1192、:1200-1207、:1168、mobile-plugin/src/index.js:94-98 |

### B. 领域逻辑多份拷贝与漂移（发现者：架构师 + 全栈 + 测试 ★★★ 三方印证）
| # | 严重度 | 问题 | 证据 |
| --- | --- | --- | --- |
| B1 | **高** | **事件展开判定 occursOn/deadline 存在 ≥5 份平行实现**（schedule.html:324 / mobile.html:279 / mobile-server.mjs:661 / helper.py:436 / reminder_app.py:62），规则演进需同步全部副本+TTBPROMT.md；历史踩坑（漏 repeat 不渲染）正源于此 | 五处代码 |
| B2 | **高** ★ | **remindLead=0 语义反转（实锤 bug）**：服务端把用户显式的「0=不提醒」回落成默认 20 分钟照常推送；手机端写法正确——同一文档化规则两端已不等价 | mobile-server.mjs:754 vs mobile.html:500-528 |
| B3 | 中 | 桌面端「改期重提醒」失效：fired key 不含日期+start（服务端含），带 id 事件改期后不重弹，README 承诺不成立 | reminder_app.py:191-198 vs mobile-server.mjs:764 |
| B4 | 中 | once 的 deadline<date 校验仅 schedule.html 有，手机端与服务端可产生永不渲染的死数据 | schedule.html:655、mobile.html:463-467 |

### C. 数据完整性（发现者：架构师 + 全栈 + 产品 ★★★ 三方印证）
| # | 严重度 | 问题 | 证据 |
| --- | --- | --- | --- |
| C1 | **高** | schedule.json **四通道并发写**（页面经 /api/worktable/write、手机端 POST /api/schedule、AI 直接编辑、服务端清扫任务），全部「读-改-覆写」，无锁无版本检测：并发必丢更新、崩溃可截断损坏（非 tmp+rename 原子写） | schedule.html:551、mobile-server.mjs:1449、:729 |
| C2 | 中 | 本地备份恢复**静默优先**于文件现值并立即回写，可无提示覆盖他端修改 | schedule.html:411-433 |
| C3 | 中 | 文件损坏三端**静默显示「今日暂无日程」**，零告警不可诊断 | reminder_app.py:119-120、helper.py:492-493、mobile-server.mjs:706 |
| C4 | 中 | 推送先标 fired 后 push：网络异常时该提醒永久丢失不重试 | mobile-server.mjs:765-768 |
| C5 | 中 | AI/手机端写入仅验 events 为数组，无逐事件 schema 校验（提示词约束无代码防线） | mobile-server.mjs:1446 |

### D. 功能正确性 bug（发现者：全栈开发者）
| # | 严重度 | 问题 | 证据 |
| --- | --- | --- | --- |
| D1 | **高** | **Toast 滑入动画方向错误**：步长恒为 +2 向右远离目标，after(10) 循环无限空转 | helper.py:800-827、:826 |
| D2 | 中 | helper 重启窗口丢指令（SHOW/HIDE 未纳入 snapshot 重放）；reminder_app.py 退出热键通知发给自己（WM_QUIT 主线程自调用，修复只落了 helper.py 一边） | helper-process.js:119-121、reminder_app.py:296-297 |
| D3 | 低 | chat 路由 body 上限 12MB < 4×7MB 图片承诺；sw.js notificationclick 不按 url 匹配；二维码超长仅清空无提示 | mobile-server.mjs:1290/1425 vs :448、sw.js:23-25 |

### E. 测试与回归防护（发现者：测试工程师）
| # | 严重度 | 问题 | 证据 |
| --- | --- | --- | --- |
| E1 | **高** | schedule.html（1065 行）**零测试**：occursOn/saveEdit/备份恢复全无覆盖；「custom 漏 repeat 不渲染」根因 L332 静默 return false，无测试无告警 | schedule.html:332 |
| E2 | **高** | **无 CI、无强制回归**：README「回归测试」=8 条手工命令；根 package.json 无 scripts | 仓库无 .github/ |
| E3 | 中 | remind-test.js 自带 occursOn 副本已与真实代码漂移（无 deadline 分支）；security-test 需真实服务+真 pin 且自锁本机 10 分钟（CI 毒性）；helper.py 提醒判定核心（check_reminders）与 reminder_app.py 整文件零测试 | remind-test.js:14-43、security-test.js:156-168 |
| E4 | 低 | page-harness 贪婪正则取唯一 script 块（加第二个 script 即崩）；ids 需手工同步 | page-harness.mjs:65 |

### F. 架构与可维护性（发现者：架构师）
| # | 严重度 | 问题 | 证据 |
| --- | --- | --- | --- |
| F1 | 中 | mobile-plugin 进程死亡**不重启**且 stdio ignore（崩溃零日志），与 reminder helper 的心跳+5 次重启护栏同项目内标准不一 | mobile-plugin/src/index.js:97、:101-104 |
| F2 | 中 | 端口探测 3190-3199 任一被占即静默跳过（不验身份，TOCTOU）；双实例竞争真实发生过，port 文件「最后启动者写」需手工核对 | mobile-plugin/src/index.js:87-93、README:219 |
| F3 | 中 | 巨函数/内联失控：createServer 路由约 330 行内联；mobile.html 内联脚本约 1435 行；无模块边界，测试只能靠 vm 提取绕行 | mobile-server.mjs:1147-1474、mobile.html:196-1631 |
| F4 | 低 | protocol.js parseReply 死代码（宿主自行解析）；每分钟 setInterval 整体重建网格 DOM 打断交互 | protocol.js:30-34、schedule.html:944 |

### G. 产品/UX（发现者：产品/UX 评审）
| # | 严重度 | 问题 | 证据 |
| --- | --- | --- | --- |
| G1 | **高** | **双端均无「新建日程」入口**（编辑器只能由已有事件打开），手机端无删除按钮——CRUD 缺 C 与半个 D，加课只能靠 AI 或手改 JSON | schedule.html:597、mobile.html:406、:424-427 |
| G2 | **高** ★ | 安装承诺不实：README 称「可放置任意目录」，实际 SAVE_PATH/ws:// 等硬编码绝对路径——换目录即保存失败、静默落备份循环 | schedule.html:538、:972、:986 |
| G3 | 中 | 提醒双轨割裂：桌面固定 30/10 分钟不读 remindLead（用户设 0=不提醒桌面照弹）；无事件级提前量；无贪睡 | reminder_app.py:5/191/255 |
| G4 | 中 | 交互反通行约定：单击=编辑、双击=详情（应为单击看双击编）；无键盘可达（无 tabindex/role）；手机编辑后桌面不自动重读（要点「刷新」） | schedule.html:849-850、:944 |
| G5 | 中 | 学生场景缺例外机制：weekly 无「某日停课/调课」，国庆/单双周只能删改整条；无历史/统计/ICS 导入导出；删除无撤销；过期数据 3 个月后被静默清除 | schedule.json 现状 |
| G6 | 中 | 命名四重混乱（auto_timetable / 智能时间表 / 智能工作表 / 每周日程表），TTBPROMT.md 拼写错误（应为 PROMPT）——而它恰是面向用户编辑的权威文件 | 各处 |
| G7 | 低 | 手机密码用 window.prompt（iOS 不掩码）；「本机 IP 直连（已停用）」死卡占半幅；「编辑数据」按钮名实不符；Ctrl+F5 劫持浏览器强制刷新 | mobile.html:223、:133-139、:170 |

---

## 三、改进建议列表（优先级排序）

### 🔴 P0 — 立即执行（安全防线与用户可感知正确性，预计 1-2 天）

| # | 建议 | 来源 | 预期影响 |
| --- | --- | --- | --- |
| P0-1 | **未设密码时拒绝隧道功能请求**（/api/chat*、schedule 写、respond、push 返回 503 引导设置）；首启强制生成随机密码；/api/login 未设密码改统一 403 不泄露状态；引导页对非 loopback 隐藏隧道 URL | 安全 A1 | 消灭「零配置即公网 RCE 面」——本次评审最高危项 |
| P0-2 | **修 remindLead=0 判定**（一行：`>= 0` 语义对齐手机端）；**修 Toast 滑入步长符号**；**fired 标记移到 push 成功后** | 全栈 B2/D1/C4 | 三个用户可直接感知的正确性缺陷立即消除 |
| P0-3 | **写盘统一 tmp+rename 原子写**（四通道全部改造，先做最廉价的防截断） | 架构 C1 | 进程崩溃不再损坏 schedule.json |
| P0-4 | **补「新建日程」入口**：周视图「＋新建」（点空白格按时段预填）+ 手机端对话框加删除（两段式确认） | 产品 G1 | 补齐核心闭环，非技术用户受益最大 |
| P0-5 | **统一测试入口**：根 package.json 加 scripts.test 聚合纯逻辑套件（security/e2e 归 test:live） | 测试 E2 | 消灭「有测试没人跑」 |

### 🟡 P1 — 近期（2-4 周，结构与信任重建）

| # | 建议 | 来源 | 预期影响 |
| --- | --- | --- | --- |
| P1-1 | **领域逻辑收敛**：occursOn/deadline 抽单份 JS 模块（三端引用）+ 单份 Python（两桌面入口共用）；schema 以 JSON Schema 固化、TTBPROMT.md 引用不复述；remindLead/deadline/改期重提醒语义随收敛统一（桌面 fired key 纳入日期+start） | 架构 B1 + 测试 B2/E3 + 全栈 B3 | 规则改动面从 6+ 文件降至 2-3 处，杜绝语义分歧（本次三方印证的最大结构性风险） |
| P1-2 | **schedule.json schema 校验**：独立校验进默认测试链 + 页面遇 custom 缺 repeat 等结构缺陷 console.warn + 面板提示 | 测试 E1/C5 | 直接拦截「custom 漏 repeat 不渲染」类历史回归 |
| P1-3 | **pin 改 scrypt/pbkdf2 加盐哈希落盘；Cookie 改服务端随机会话 token，支持登出与按设备吊销；oldPin 统一 timingSafeEqual** | 安全 A2/A3/A4 | 文件泄露≠密码泄露；失窃设备可单独踢出 |
| P1-4 | **统一提醒模型**：桌面读 remindLead（30/10 作默认双档），设置面板支持全局默认+事件覆盖 | 产品 G3 + 全栈 B2 | 重建「设了就生效」的跨端信任 |
| P1-5 | **mobile-plugin 守护重启**（指数退避+N 次上限）+ stderr 落 .mobile-srv/server.log + 端口占用探 /api/status 验明身份 | 架构 F1/F2 | 崩溃免人工重启、可诊断；双实例竞争可防 |
| P1-6 | **消除路径硬编码**：SAVE_PATH/ws:///cwd 按挂载根相对解析或集中配置 | 架构 F2 + 全栈 G2 | 安装承诺「任意目录」可兑现 |
| P1-7 | **损坏显式告警**：schedule.json 读失败三端报错而非「暂无日程」；备份恢复改提示冲突待用户确认 | 全栈 C3 + 产品 C2 | 数据问题可诊断，杜绝静默覆盖 |
| P1-8 | **schedule.html 测试 harness**（复用 page-harness，优先测 saveEdit 类型切换与 deadline 推导）+ remind-test 改提取真实 occursOn 并补 deadline 用例 + mobile-server 拆纯逻辑单测 | 测试 E1/E3 | 前端与判定核心进回归网 |
| P1-9 | **交互对齐**：单击=详情、双击=编辑（或悬浮编辑按钮）；事件块加 tabindex+Enter；桌面每 30-60 秒重读数据；手机密码改页内 password 输入框 | 产品 G4/G7 | 降低误触，跨端一致 |

### 🟢 P2 — 规划（1-2 月，体验与工程化提升）

| # | 建议 | 来源 | 预期影响 |
| --- | --- | --- | --- |
| P2-1 | 统一命名「智能工作表」：README/提示词文件更名（修 PROMT 拼写）、页面标题一致 | 产品 G6 | 认知与检索一致性 |
| P2-2 | 巨函数拆分：createServer 路由独立 handler；mobile.html 抽 mdRender/watch 为独立 js；SHOW/HIDE 纳入 snapshot 重放；删死代码 parseReply；chat body 上限对齐 4×7MB | 全栈 F3/D2/D3 | 可测试性与可读性质变 |
| P2-3 | 事件级例外日期（skip/改期列表）+ 教学周显示；过期移入 archive 节点而非删除；JSON/ICS 导入导出与一键备份 | 产品 G5 | 贴合学生场景，数据资产可沉淀 |
| P2-4 | CSP 去 unsafe-inline（nonce 化）；shutdown 加 pin 校验；子进程 env 白名单；schedule.json 出库改示例文件 | 安全 A4 | 深度加固与隐私出险清零 |
| P2-5 | README 补 _说明 字段文档、故障排查 FAQ；清理直连死卡；热键改低冲突组合 | 产品 G7/G6 | 安装与排障自助率提升 |

---

## 四、主席交叉比对说明

1. **三方独立印证**（最高可信）：领域逻辑 5 份拷贝（架构/全栈/测试分别从架构、语义、测试视角独立提出，全栈给出 remindLead=0 实锤）；schedule.json 并发写与非原子写（架构/全栈/产品）；绝对路径硬编码（架构/全栈/产品）。
2. **两方印证**：提醒双轨割裂（产品提出体验断裂，全栈给出代码级根因）；数据静默（全栈的损坏静默 + 产品的备份静默覆盖同源）。
3. **无矛盾裁定**：五份报告未发现相互冲突的结论；安全工程师的正面确认（收口/XSS/SSRF 抽审通过）与全栈/产品的负面发现互不冲突，共同构成完整画像。
4. 各角色报告原文存于广播房间 room-mtgp8qoq-1（保留 30 天可回看），对应会话可随时 wake 单独质询。

---

## 五、改进路线（建议节奏）

```
第 1 周   P0 全部：安全 fail-open 封堵 → 3 个正确性 bug → 原子写 → 新建/删除入口 → 统一测试入口
          （先 P0-1：这是唯一可能被真实利用的高危项）
第 2-4 周  P1-1/P1-2 领域收敛+schema（结构性收益最大，先于其他 P1）
          其余 P1 按安全(P1-3) → 体验(P1-4/9) → 运维(P1-5/6/7) → 测试(P1-8) 并行小步推进
第 1-2 月  P2 按兴趣与需求节奏；建议 P2-2（拆分）先于 P2-3（新功能）——
          结构不变的情况下堆功能会放大 5 份拷贝类的漂移成本
```

**一句话结论**：这是一个安全设计与文档意识远超平均水准的早期项目，当前真正的危险不在「做得不够好」，而在「零配置裸奔」这一高危残留与「5 份拷贝的领域逻辑正在漂移」这一结构性风险——先堵前者、再收后者，项目即可从 B+ 稳步走向 A。

---

*附：参会评审员会话（可 wake 单独追问）*
*架构师 session-9effdff0-a0e2-4260-8354-d28e1f5dabef · 全栈开发者 session-c321ed35-43be-4664-bbd8-14375248c954 · 测试工程师 session-fbaad270-aa5b-4060-bf32-f6497bd64d8c · 安全工程师 session-75aebd04-8da2-467c-825c-ad4a51447705 · 产品/UX session-09a710de-4d47-4827-954a-010e6bcd463a*
