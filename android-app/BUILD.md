# android-app · 「日程」安卓客户端构建与使用说明

原生 Kotlin WebView 壳（`io.github.wangyuanchuan2022.timetable`）：加载电脑端移动页获得全部既有功能，另加三件浏览器做不到的事——**扫码配对隧道地址**、**系统级课前弹窗提醒（精确闹钟，不依赖谷歌服务）**、**离线兜底（v1.3：连不上电脑端时按上次同步的课表继续看 + 重连/扫码入口）**。

## 编译验证记录

**2026-09-14 v1.5 本机真实构建通过**：提醒计划窗 **7→30 天**（用户要求：电脑关机/隧道长时间不通超过一周后，课前提醒不得整段消失）。三处联动——服务端 `/api/plan` days clamp 上限 14→60（APP 请求 days=30，老客户端缺省仍 7）、PlanPoller 请求 `?days=30`、AlarmScheduler MAX_ALARMS 80→250（30 天 × 每交易日 4-8 条 ≈ 120-240，items 升序取前 250 保最近的，截断语义安全）。离线安全期 = 计划窗长度：电脑失联 30 天内已排闹钟整段有效；网恢复后 WorkManager 6h 周期自动续排。学期末全排方案否决：约 500 条精确闹钟，国产 ROM 清理与 Doze 维护风险大于收益。回归：server-routes-test 67（I9 clamp=60）+ page-tabs 64 + offline-page 27 全绿。

**2026-09-14 v1.3 / v1.4 本机真实构建通过**：v1.3（versionCode 4）离线兜底上线（主框架失败路由 assets 离线页，按壳落盘的上次课表渲染）；v1.4（versionCode 5）离线横幅升级——标题改「离线数据 · 上次同步 MM-dd HH:mm（N 天前同步）」，超 1 天显示陈旧警示（期间的电脑端改动不反映），并新增提醒计划状态行「提醒计划仍生效 · 下次提醒 MM-dd HH:mm」（桥 `nextReminderAt()` 从最近一次同步的提醒计划取未来最早一条，与 AlarmManager 已排闹钟同源；PlanPoller 失败路径不碰闹钟、BootReceiver 开机/覆盖安装按同一份缓存重排——离线不漏弹）。两次均 `gradlew assembleDebug` → `BUILD SUCCESSFUL`，aapt2 badging 核对版本号，assets（offline.html + occur.js 构建期同步）确认入包。回归：`.qrtest/page-tabs-test.mjs`（64 断言）+ `.qrtest/offline-page-test.mjs`（27 断言）全绿。

**2026-09-10 本机真实构建通过**：`gradlew assembleDebug` → `BUILD SUCCESSFUL`，产物 `app/build/outputs/apk/debug/app-debug.apk`（约 3.9MB，aapt2 badging 核对包名/权限/入口 Activity 均正确）。验证环境：JDK 17（`~/.bubblewrap/jdk/jdk-17.0.11+9`）+ Android SDK（`~/.bubblewrap/android_sdk`，platform 34 + build-tools 35.0.0）+ Gradle 8.7 wrapper。两点环境适配已固化进工程：

- `buildToolsVersion = "35.0.0"`（AGP 8.5 默认 34.0.0 未装，35.0.0 向下兼容）；
- debug 签名用工程内 `app/debug.keystore`（gitignored 不入库——**从零克隆先按下一节命令生成**；不依赖 `~/.android`，免装环境也能出包）。

剩余待真机验证：扫码（CAMERA 运行时权限由 zxing 库内部申请）、通知弹窗与精确闹钟在国产 ROM 的实际表现、登录 Cookie → 原生轮询闭环。静态评审报告：`review/android-app-review.md`（P0=0 / P1=2 已修 / P2 部分采纳）。

## 技术栈与版本

| 组件 | 版本 | 说明 |
| --- | --- | --- |
| AGP | 8.5.2 | 需 Android Studio Jellyfish (2023.3.1) 及以上 |
| Gradle | 8.7 | wrapper 已含（`gradle/wrapper/`，首次构建自动下载发行包） |
| Kotlin | 1.9.24 | |
| compileSdk / targetSdk | 34 | minSdk 24（Android 7.0+；隧道 HTTPS 证书链建议 7.1+） |
| 扫码 | com.journeyapps:zxing-android-embedded 4.3.0 | Maven Central，无 Google Play Services 依赖 |
| 后台调度 | androidx.work:work-runtime-ktx 2.9.1 | 每 6 小时 + 开屏/登录/开机即时刷新 |

## 首次构建前：生成 debug 密钥库（从零克隆必做）

debug 签名配置（`app/build.gradle.kts` 的 `signingConfigs.debug`）**显式指向工程内的 `app/debug.keystore`**，而该文件已被 `.gitignore` 排除、不随仓库分发——新环境克隆后直接构建会在签名一步失败（`Task :app:validateSigningDebug` 报 keystore 不存在/无法读取）。首次构建前先在 `android-app/` 目录用 keytool 生成（**以下为本机实际执行过的原样命令**，生成后一次通过出包）：

```bat
keytool -genkeypair -v -keystore app/debug.keystore -alias androiddebugkey -keyalg RSA -keysize 2048 -validity 10000 -storepass android -keypass android -dname "CN=Android Debug,O=Android,C=US"
```

- keytool 来自任意 JDK（17+）的 `bin\`；装了 Android Studio 可直接用其自带 JBR：`"<Android Studio 安装目录>\jbr\bin\keytool.exe"`；
- **别名 `androiddebugkey` 与两个密码 `android` 必须保持原样**——AGP 的 debug signingConfig 默认值就是它们（工程只覆写了 storeFile）；要改就同步改 `app/build.gradle.kts`；
- 生成后自检：`keytool -list -keystore app/debug.keystore -storepass android` 应列出一条 `androiddebugkey, PrivateKeyEntry`；
- 该密钥库仅用于本地调试签名（有效期 10000 天）；正式发布签名见「常见问题」最后一节。

## 方式一：Android Studio（推荐）

1. `File → Open` 打开 `android-app/` 目录（首次同步会自动下载 Gradle 8.7 与依赖，需网络代理时在 `Settings → HTTP Proxy` 配置）；
2. 等 Gradle Sync 完成；
3. 菜单 `Build → Build App Bundle(s) / APK(s) → Build APK(s)`；
4. 产物：`app/build/outputs/apk/debug/app-debug.apk`，传到手机安装（需允许「安装未知来源应用」）。

> debug 签名可直接日常使用；如需 release 签名见下文。

## 方式二：命令行

前置：JDK 17、Android SDK（`platforms;android-34` + `build-tools;35.0.0` + `platform-tools`），环境变量 `ANDROID_HOME`（或 `local.properties` 写 `sdk.dir=D:\\path\\to\\Android\\Sdk`）。

```bat
cd android-app
gradlew.bat assembleDebug
```

（首次运行会自动下载 Gradle 8.7 发行包约 130MB 与 Maven 依赖；国内网络建议给 gradle 配代理或用镜像。）

SDK 缺组件时用 sdkmanager 安装（build-tools 版本须与 `app/build.gradle.kts` 的 `buildToolsVersion = "35.0.0"` 一致）：

```bat
sdkmanager "platforms;android-34" "build-tools;35.0.0" "platform-tools"
sdkmanager --licenses
```

## 首次使用流程

1. 电脑端：打开 `schedule.html` →「手机访问」面板，确认隧道二维码已显示（HTTPS 公网地址）；
2. 手机装好 APP → 点「扫码连接」扫该二维码（或手动输入地址）；
3. 页面加载后输入安全密码登录（Cookie 30 天有效，之后页面会再问一次）；
4. 按提示授予 **通知权限**（Android 13+）与 **闹钟和提醒（精确闹钟）**（Android 12+ 首次进入时引导）；
5. 完成：课前按每个事件的「提前提醒」分钟数弹系统横幅（默认提前 20 分钟，事件可单独设置；`0` = 该事件不提醒）。

## 工作原理（数据流）

```
服务端(occur.js 单一实现)                安卓 APP
─────────────────────────               ─────────────────────────────
GET /api/plan?days=30 ───────────────→  PlanPoller（WorkManager 6h/开屏/开机）
  返回 [{key,title,body,remindAt}]        └→ AlarmScheduler 全量重排 AlarmManager
                                          └→ 到点 AlarmReceiver → 高优先级通知（弹窗）
schedule 修改后：APP 下次拉取自动重排；PC 关机期间已排闹钟照常响
```

- 鉴权：复用 WebView 页面登录的 30 天会话 Cookie（原生经 `CookieManager` 读取附带，含 HttpOnly），无需在 APP 里再存密码；
- 领域判定（事件是否发生/提前量）全部在服务端 occur.js——APP 不做任何日历计算，语义与桌面端/Web Push 完全一致；
- 401（Cookie 过期且未重新登录）→ 静默跳过，待用户打开 APP 登录后 `NativeBridge.refreshPlan()` 立即补排。

## 权限清单（为何需要）

| 权限 | 用途 |
| --- | --- |
| INTERNET / ACCESS_NETWORK_STATE | 拉取课表与提醒计划 |
| POST_NOTIFICATIONS | Android 13+ 课前弹窗通知 |
| SCHEDULE_EXACT_ALARM(≤32) / USE_EXACT_ALARM(33+) | 精确闹钟（课表/闹钟类应用的正当用途） |
| RECEIVE_BOOT_COMPLETED | 开机后立即补排提醒 |
| CAMERA | 扫码配对（zxing 扫码页内申请） |

无前台服务、无自启动常驻——提醒靠系统 AlarmManager，耗电可忽略。

## 常见问题

- **扫码后一直「连接不上」**：电脑刚重启过 → 隧道地址已变，重新扫码；确认 `mobile-server.mjs` 在跑（面板二维码正常显示）；
- **收不到课前提醒**：① 系统通知权限未给；② 「闹钟和提醒」未允许（部分国产 ROM 在 应用信息 → 电池/权限 里）；③ 该事件「提前提醒」设了 0（不提醒）；④ 手机电量优化把闹钟拦了 → 把 APP 加入电池白名单/允许后台；
- **换电脑/换隧道**：直接重新扫码，旧服务器排的提醒自动作废重排；
- **想发正式版**：`keytool -genkeypair -v -keystore timetable.jks -alias timetable -keyalg RSA -keysize 2048 -validity 10000`，在 `app/build.gradle.kts` 配 signingConfigs 后 `assembleRelease`（keystore 妥善保管，丢了无法同签名升级）。

## 已知取舍

- ~~页面与数据从服务器加载：PC 关机时 APP 打不开课表~~ **v1.3 已解决**：加载成功后页面自动把课表缓存给壳（`NativeBridge.saveCache` → 应用私有目录 `offline-cache.json`），主框架加载失败自动切 assets 离线页按缓存渲染（领域判定走构建期同步的 occur.js），横幅提供重新连接/重新扫码/手动输入；仅「从未成功连接过」时才进错误屏。离线期间对话/编辑不可用（需服务器），已排提醒照常弹；
- `USE_EXACT_ALARM` 为 Android 13+ 日历/闹钟类应用权限，本项目仅侧载分发不受 Play 政策约束；若将来上架商店需改走 `SCHEDULE_EXACT_ALARM` + 用户授权流程；
- 精确闹钟被用户在系统里撤销时自动降级为 10 分钟窗内的非精确闹钟（尽力而为）。
