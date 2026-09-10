# 安卓 APP 编译风险与配置正确性评审报告

- 评审对象：`android-app/` 新增安卓 APP 源码 + 服务端配套（`server-routes.mjs` buildPlanItems / GET /api/plan、`mobile-app.js` NativeBridge 桥接，已随 commit fbe1c13 入库）
- 评审方式：**全部待审文件逐行人工读完**（只读，未执行任何 install/build/修改）；关键外部 API 签名与依赖构件存在性做了**联网核实**（方法见附录 B）
- 评审人：session-fbdf6daf（安卓APP编译风险与配置评审）

## 1. 结论汇总表

| 维度 | 结论 | 关键证据 |
|---|---|---|
| **P0 编译阻断** | **0 条**。未发现 import 缺失、Kotlin 类型/语法错误、override 签名不匹配、资源引用断链、Gradle 组合矛盾 | 逐项核查清单见 §2 |
| Gradle 版本组合 | 成立：AGP 8.5.2（需 Gradle ≥8.7、JDK 17）+ wrapper Gradle 8.7 + Kotlin 1.9.24 + compileSdk 34 + minSdk 24 + targetSdk 34，全部依赖（core-ktx 1.13.1 / appcompat 1.7.0 / work-runtime-ktx 2.9.1 / zxing-android-embedded 4.3.0）在配置的仓库中可解析 | android-app/build.gradle.kts:4-5、gradle/wrapper/gradle-wrapper.properties:3、app/build.gradle.kts:8-13,34-39；附录 B |
| layout ↔ 代码 | 10 个 `@+id` 与 MainActivity findViewById 全部一致 | activity_main.xml:8,15,73,85,107,125,134,143,152 ↔ MainActivity.kt:75-94 |
| res 引用 | `@string`×11、`@color`×7、`@drawable`×1、`@mipmap`×2（含 adaptive-icon 前景）全部有定义；mipmap PNG 五个密度桶齐全 | §2 表 |
| Manifest | 组件类名与 Kotlin 包名/类名一致；API 31+ intent-filter 组件均显式 `android:exported`；权限组合（SCHEDULE_EXACT_ALARM maxSdk 32 + USE_EXACT_ALARM）设计自洽 | AndroidManifest.xml:27-52 |
| zxing 4.3.0 用法 | ScanContract/ScanOptions/ScanIntentResult 用法与 v4.3.0 源码签名逐一吻合（含 varargs 重载核实，避免误报） | MainActivity.kt:32-34,52-57,226-232；附录 B.1 |
| WorkManager / AlarmManager / WebView | CoroutineWorker/Constraints、setExactAndAllowWhileIdle + FLAG_IMMUTABLE、onShowFileChooser/CookieManager 均正确；API 等级守卫完备（S=31 检查在 24 minSdk 下无缺口） | §2 表 |
| 服务端配套 | buildPlanItems 依赖的 occur.js 四函数全部存在且导出；/api/plan 响应结构与 APP 端 parsePlan 字段完全对齐；mobile-app.js 三处 SW/Notification 使用点均被 APP 分支守卫，浏览器路径零变化 | §5 |
| **P1 运行期/功能** | **2 条**（通知权限申请入口单一；重启后闹钟恢复无本地兜底） | §3 |
| **P2 改进建议** | **12 条** | §4 |

## 2. P0 清单：0 条（已核查项全记录）

以下每一项都专门核查过、**均未发现问题**，列出以证明覆盖面：

| # | 核查项 | 证据与结论 |
|---|---|---|
| 1 | Kotlin import 完整性与正确性 | 8 个 .kt 文件所有 import 均被使用且包路径正确。易错点核实：`androidx.activity.OnBackPressedCallback` / `androidx.activity.result.contract.ActivityResultContracts`（MainActivity.kt:27-28）为 androidx.activity 正确包名（AppCompatActivity → FragmentActivity → ComponentActivity 继承链可用）；`com.journeyapps.barcodescanner.{ScanContract,ScanIntentResult,ScanOptions}`（MainActivity.kt:32-34）与 v4.3.0 源码路径一致（附录 B.1） |
| 2 | ScanOptions/ScanContract API（疑似 P0 已排除） | `setDesiredBarcodeFormats(ScanOptions.QR_CODE)`（MainActivity.kt:227）——`setDesiredBarcodeFormats` 除 `Collection<String>`（ScanOptions.java:169）外**还有 `String...` varargs 重载（ScanOptions.java:180，v4.3.0 实测源码）**，单 String 调用合法；`QR_CODE` 常量（:39）、`setPrompt`（:99）、`setOrientationLocked`（:111）、`setBeepEnabled`（:147）全部存在。`ScanContract extends ActivityResultContract<ScanOptions, ScanIntentResult>`（ScanContract.java:10）→ `registerForActivityResult(ScanContract()) { result: ScanIntentResult -> }`（MainActivity.kt:52）泛型吻合 |
| 3 | override 签名 | `shouldOverrideUrlLoading(WebView, WebResourceRequest)`（MainActivity.kt:134，API 24+＝minSdk 恰好覆盖）、`onReceivedError(WebView, WebResourceRequest, WebResourceError)`（:146，API 23+）、`onShowFileChooser(WebView, ValueCallback<Array<Uri>>, FileChooserParams)`（:153-157）与 WebChromeClient 平台签名一致；`WebChromeClient.FileChooserParams.parseResult`（:66）为静态方法，存在 |
| 4 | WorkManager API | `CoroutineWorker(ctx, params)` 构造（PlanPoller.kt:27）、`PeriodicWorkRequestBuilder<PlanPoller>(6, TimeUnit.HOURS)`（:72）、`OneTimeWorkRequestBuilder`（:82）、`Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED)`（:66-68）、`enqueueUniquePeriodicWork(KEEP)`（:75-77）/`enqueueUniqueWork(REPLACE)`（:85-87）签名均正确；`applicationContext`/`runAttemptCount` 为 ListenableWorker 真实属性；`work-runtime-ktx` 传递 `kotlinx-coroutines-android` → `Dispatchers.Main`（PlanPoller.kt:31）可解析 |
| 5 | AlarmManager / PendingIntent | `setExactAndAllowWhileIdle(RTC_WAKEUP, …)`（AlarmScheduler.kt:57，API 23+）与 `setWindow`（:59）签名正确；所有 `PendingIntent.getBroadcast/getActivity` 均带 `FLAG_UPDATE_CURRENT or FLAG_IMMUTABLE`（AlarmScheduler.kt:34-36,52-55；NotifyUtil.kt:41-47），满足 targetSdk 31+ 强制可变性声明；取消匹配依赖 Intent.filterEquals（action+component，extras 不参与），`plainIntent`（AlarmScheduler.kt:67-68）与 `preclassIntent`（AlarmReceiver.kt:20-23）action/组件一致 → cancel 语义正确 |
| 6 | API 等级守卫（minSdk 24） | `canScheduleExactAlarms()`（AlarmScheduler.kt:24-26、MainActivity.kt:273）均被 `SDK_INT < S` 前置 return 守卫；`Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM`（MainActivity.kt:283）在 S 守卫内；`POST_NOTIFICATIONS`（MainActivity.kt:264、NotifyUtil.kt:34）均 ≥33 守卫；`NotificationChannel`/`IMPORTANCE_HIGH`（NotifyUtil.kt:20-30）≥26 守卫。无未守卫的高 API 调用 |
| 7 | org.json | `JSONObject(Map)` 构造器（AlarmScheduler.kt:83，`Map<String,Int>`）在 Android org.json 中自 API 1 存在；`JSONObject(String)/optBoolean/optJSONArray/optJSONObject/optString(name,default)/optLong/keys`（PlanItem.kt:15-31、AlarmScheduler.kt:73-75）均为 Android 内置 API |
| 8 | layout ↔ findViewById | `webView/pairingView/errorView/errorText/urlInput/btnScan/btnConnect/btnRetry/btnRescan/btnReinput`（activity_main.xml:8,15,73,85,107,125,134,143,152）与 MainActivity.kt:75-94 十个全部一一对应，控件类型（WebView/ScrollView→View/LinearLayout→View/TextView/EditText/Button×5）与泛型 findViewById 匹配 |
| 9 | @string 引用 | app_name/pair_title/pair_hint/btn_scan/pair_or/url_hint/btn_connect/pair_note/btn_retry/btn_rescan/btn_reinput（activity_main.xml:32,39,50,60,68,78,90,99,139,148,157）全部定义于 strings.xml:3-13；`\n` 转义（strings.xml:5）为合法资源转义 |
| 10 | @color/@drawable/@mipmap 引用 | `bg/brand/on_brand/text/muted/field_bg`（colors.xml:3-8）全覆盖 layout 与 themes 引用；`@drawable/ic_stat_notify`（NotifyUtil.kt:49 ↔ drawable/ic_stat_notify.xml 存在，vector 24dp 合法）；`@mipmap/ic_launcher`（Manifest:21 + activity_main.xml:33）在 mipmap-anydpi-v26（adaptive-icon，前景 `@mipmap/ic_launcher_foreground` 五密度 PNG 齐全）与 mipmap-mdpi…xxxhdpi PNG 均存在；`@xml/network_security_config`（Manifest:23 ↔ res/xml/ 存在） |
| 11 | Manifest 组件 ↔ 类 | `.MainActivity`/`.BootReceiver`/`.AlarmReceiver`（AndroidManifest.xml:28,41,51）与 namespace `io.github.wangyuanchuan2022.timetable`（app/build.gradle.kts:7）+ 三个类文件包名一致；Manifest 未声明 `package` 属性（AGP 8 必须由 namespace 提供，已正确）；BootReceiver 带 intent-filter 且显式 `exported="true"`（:42，API 31+ 安装硬性要求）；AlarmReceiver 无 filter `exported="false"`（:52）；zxing 库 ScanActivity 由 AAR manifest 合并提供，无需应用侧声明 |
| 12 | Gradle 一致性 | 根 build.gradle.kts 声明 `com.android.application` 8.5.2 / `org.jetbrains.kotlin.android` 1.9.24（apply false），app 模块无版本 apply（app/build.gradle.kts:1-4）——多模块约定正确；AGP 8.5.2 最低 Gradle 8.7＝wrapper 版本（build.gradle.kts:2 注释、gradle-wrapper.properties:3）；JDK 17（compileOptions/kotlinOptions 均 17，app/build.gradle.kts:24-30）；settings.gradle.kts `RepositoriesMode.FAIL_ON_PROJECT_REPOS`（:9）与 app 模块无 repositories 块自洽；`android.nonTransitiveRClass=true`（gradle.properties:3）安全（R 引用全部本模块）；gradle-wrapper.jar/gradlew/gradlew.bat 存在，.gitignore（android-app/.gitignore:1-9）未忽略 wrapper jar，未来入库可构建；lintVitalRelease 无 fatal 级问题预期（硬编码文案等仅 warning） |
| 13 | 依赖可解析性 | 联网 HEAD 核实（附录 B.2）：zxing-android-embedded 4.3.0 AAR 在 Maven Central（settings.gradle.kts:12 已配）；work-runtime-ktx 2.9.1 / core-ktx 1.13.1 / appcompat 1.7.0 在 Google Maven（settings.gradle.kts:11 google() 已配）；zxing 库 minSdkVersion 19（附录 B.1）≤ 24 无 merger 冲突；core-ktx 1.13.x / appcompat 1.7.0 要求 compileSdk 34，与 app/build.gradle.kts:8 一致 |
| 14 | themes | `Theme.Timetable`（themes.xml:4）被 Manifest:25 引用，parent `Theme.AppCompat.DayNight.NoActionBar` 由 appcompat 1.7.0 提供；`android:statusBarColor`/`windowBackground`（API 21+）在 minSdk 24 合法 |

**判定：按当前源码执行 `gradlew assembleDebug`（JDK 17）预期可通过编译。** 未实际执行构建（只读评审约束）。

## 3. P1 清单（2 条：运行期功能失效风险）

### P1-1 通知权限申请入口单一且一次性——Android 13+ 用户不点页面内「通知」按钮则所有课前提醒通知静默丢弃

- **证据链**：
  - NotifyUtil.kt:38-40 —— `showPreclass` 在 `!notifyPermissionGranted(ctx)` 时直接 `return`（闹钟照响，通知不弹，无任何提示）；
  - MainActivity.kt:263-270 —— `maybeAskNotifyPermission()` 的**唯一调用方**是 `Bridge.requestNotifyPermission`（:179-182），而后者仅由页面 JS 触发；
  - mobile-app.js:568-578 —— APP 分支里点击 `notifyBtn` → `nb.requestNotifyPermission()` 后按钮 `disabled = true`（:570，在 APP 分支**之前**执行且不再恢复）→ 用户第一次拒绝权限后，页面内**没有第二次申请入口**；
  - mobile-app.js:615-623 —— `restoreNotifications` 的 APP 分支只改按钮文案，不请求权限。
- **影响**：Android 13+（targetSdk 34 强制运行时通知权限）下，用户完成扫码配对、登录后若从未点开页面设置里的通知按钮——或点了但拒绝了——课前提醒的核心交付（系统通知）**整体静默失效**，且无自愈路径（6 小时周期轮询不碰权限）。这是本次原生增强的主要功能价值点，属于「功能必然失效」的高概率用户路径。
- **修复建议**：MainActivity `connectTo()`（或首次 `loadServer()` 成功后的 `onPageFinished`）主动调用一次 `maybeAskNotifyPermission()`；同时 mobile-app.js:570 的 `btn.disabled = true` 在 APP 分支（:573-578）应恢复 `btn.disabled = false` 或干脆不置灰，保留重新拉起权限申请的入口。
- **需实测**：WebView 内 `Notification.permission` 返回值不影响本判断（APP 分支不依赖它），但真机上确认权限弹窗时序（登录前 vs 登录后请求的转化率差异）建议一并验证。

### P1-2 重启后闹钟恢复强依赖「联网 + 电脑端可达」，无本地计划缓存兜底

- **证据链**：
  - BootReceiver.kt:10-18 —— 开机/升级后仅 `PlanPoller.enqueuePeriodic + enqueueOnce`，**不直接重排闹钟**；
  - PlanPoller.kt:66-68 —— once-work 带 `NetworkType.CONNECTED` 约束：无网时挂起等待；
  - AlarmScheduler.kt —— 仅有 requestCode 映射持久化（:82-84），**提醒计划本体（PlanItem 列表）从不落盘**；`rescheduleAll` 只能由 PlanPoller 网络成功路径触发（PlanPoller.kt:47-50）。
- **影响场景**：AlarmManager 闹钟不跨重启。手机重启后若电脑端未开机 / cloudflared 隧道已换址 / 手机离线（早晨开机在路上很常见），once-work 阻塞等网等服务器，期间当天已排的课前提醒**全部丢失**；即使之后网络恢复，`remindAt <= now` 的条目服务端也不再返回（server-routes.mjs:346 `remindAt <= now.getTime()` 过滤）。上次成功轮询时本已排在 AlarmManager 里的提醒，仅因一次重启+短时离线就永久错过。
- **修复建议**：PlanPoller 200 分支（:47-50）把 `parsePlan(body)` 结果 JSON 落入 SharedPreferences；BootReceiver 先读缓存 `rescheduleAll`（离线即时恢复大部分提醒）再触发联网刷新。改动集中在 PlanPoller.kt / BootReceiver.kt / AlarmScheduler.kt 三个文件，量小。
- **说明**：非崩溃类问题；属「重启+服务器不可达」窗口内的功能性必然丢失，定级 P1 偏保守合理。

## 4. P2 清单（12 条改进建议）

| # | 发现 | 证据 | 建议 |
|---|---|---|---|
| P2-1 | PlanPoller 对非 200/401（含 429 限流、5xx）无限 `Result.retry()`——`runAttemptCount < 3` 上限只存在于异常 catch 分支，when 的 `else` 分支没有 | PlanPoller.kt:46-56 | `else -> if (runAttemptCount < 5) Result.retry() else Result.success()`，与异常路径对齐 |
| P2-2 | worker 内 `withContext(Dispatchers.Main)` 跳主线程取 Cookie，若进程由 WorkManager 冷启（无任何 WebView 历史进程），`CookieManager.getInstance()` 会在主线程同步加载 WebView provider，可能造成主线程百毫秒级卡顿（非崩溃） | PlanPoller.kt:31-33 | **需实测**（低端机后台冷启场景）；如卡顿明显，可在 MainActivity 启动时预热线程安全实例 |
| P2-3 | 7 天计划超 80 条时静默截断（`take(MAX_ALARMS)`），无日志无提示 | AlarmScheduler.kt:21,50 | 正常课表远达不到；如遇截断可 log 一行或按天分窗 |
| P2-4 | 通知 `notify("preclass", body.hashCode(), n)`——同一门课多日 body 相同则互相覆盖，同时刻多条仅剩一条 | NotifyUtil.kt:59 | id 改用 `key.hashCode()`（AlarmReceiver 透传 key）或 requestCode |
| P2-5 | 硬编码中文文案：layout 一处 + Kotlin 侧 toast/通知标题/对话框等十余处（lint MissingTranslation/硬编码警告，仅影响本地化规范） | activity_main.xml:119；MainActivity.kt:56,87,148,278-289,299；NotifyUtil.kt:50 | 迁入 strings.xml；至少把 layout 的那条迁走 |
| P2-6 | release 无 signingConfig（只能产出未签名 APK）；minify 关闭时 JS 桥 keep 规则以注释形式存在，未来开启混淆易漏 | app/build.gradle.kts:18-22；proguard-rules.pro:4-6 | 补 debug 签名占位或文档化签名流程；建议直接放开 keep 注释（注释状态与关闭的 minify 一致，无风险） |
| P2-7 | network_security_config 对**全域**放开明文 http（为局域网手动输入），公网 https 页面若被劫持注入 http 子资源也会被 mixedContentMode 拦（MIXED_CONTENT_NEVER_ALLOW 已兜住主场景），但原生 HttpURLConnection 明文无任何限制 | network_security_config.xml:5 | 可接受的设计取舍（局域网场景刚需）；文档注明即可 |
| P2-8 | 未声明 `android:roundIcon`：API 24-25 圆屏启动器用方图拉伸 | AndroidManifest.xml:21 | 补 roundIcon 或沿用现状（视觉细节） |
| P2-9 | DayNight 主题 + 固定深色 palette 混搭：系统浅色模式下 AlertDialog/EditText 光标等 AppCompat 控件走浅色系，与全深色 UI 轻微割裂 | themes.xml:4-9 | parent 换 `Theme.AppCompat.NoActionBar`（恒深）即可消除歧义 |
| P2-10 | `allowBackup="true"` 会备份 base_url/exactHintShown/alarm_codes——换机恢复后 baseUrl 直接指向旧隧道（大概率已失效），首启体验是错误屏而非配对屏 | AndroidManifest.xml:20 | 换 `allowBackup="false"` 或 backup rules 排除 tt_prefs |
| P2-11 | buildPlanItems 的 key 用 `ev.id || title`：无 id 且同名同起止的两条事件 key 冲突，AlarmScheduler codes map 相互覆盖（闹钟仍会排，仅 cancelAll 时少取消一个 PI） | server-routes.mjs:351；AlarmScheduler.kt:61 | key 掺入数组下标或 ev 的稳定去重键；影响极小 |
| P2-12 | /api/plan 每请求全量读盘 + JSON.parse schedule.json（无内存缓存），事件量大时重复开销 | server-routes.mjs:728-736 | 量小可忽略；如需优化与 /api/schedule 共用读缓存 |

## 5. 服务端配套核对（server-routes.mjs / mobile-app.js，commit fbe1c13）

**全部通过，未发现 P0/P1 级问题：**

1. **buildPlanItems 依赖完整性**：`fmtDate`（occur.js:32）、`parseHHMM`（:36）、`occursOn`（:70）、`leadMinutes`（:109）四个函数在 occur.js 中存在且于 :241-244 统一导出——单一实现约定未被破坏，server-routes.mjs:332-366 仅做编排。`leadMinutes(ev)` 无 def 参数时缺省 20（occur.js:109-115），与 buildPlanItems 注释「非法/缺失默认 20」一致。
2. **语义对齐**：task 不提醒（server-routes.mjs:336）、`!(lead > 0)` 跳过（:339，显式 0=不提醒）、`e <= s` 跨午夜跳过（:341）、`remindAt <= now` 过期不返回（:346）——与 Web Push 调度器语义一致（commit 信息与测试 I1-I9 佐证）。
3. **路由实现**：GET /api/plan（server-routes.mjs:724-738）guardPin 鉴权（:727）与 /api/schedule 同源；`days` 解析 NaN 安全（parseInt(null)→NaN→Number.isFinite 过滤→7）并 clamp 1-14（:728-729）；BOM 剥离（:731）；响应 `{ok, days, generatedAt, items}` 与 APP 端 parsePlan（PlanItem.kt:14-33）读取的 ok/items/key/remindAt/title/body 字段**完全对齐**，key 唯一性过滤与 `remindAt<=0` 防御在两端各有兜底。
4. **401 闭环**：guardPin 无凭据回 401（server-routes.mjs:267,271-279）↔ PlanPoller 401 分支静默成功（PlanPoller.kt:52），登录后 NativeBridge.refreshPlan 再触发——闭环成立。
5. **mobile-app.js NativeBridge**：检测函数带 try/catch + `typeof === 'function'` 双重防御（mobile-app.js:15-17）；登录成功后 `nb.refreshPlan()`（:84-86）对应 MainActivity.kt:184-187 的 `@JavascriptInterface fun refreshPlan`，方法名一字不差；页面全部三处 serviceWorker/Notification 使用点（:517 swReg 守卫、:572-583 notify 分支 APP 先行返回、:618-626 restore 分支 APP 先行返回）均被 APP 分支或 swReg 空值守卫——**浏览器路径零变化、APP 路径不触碰 Web Push**，实现干净。
6. **测试**：I1-I9 九组用例已入库（.qrtest/server-routes-test.mjs:255-321），覆盖 weekly/task/跨午夜/过期/skip/once 升序/days 截断/401/days clamp。

## 6. 【改进点】（按优先级映射到具体文件）

1. **[P1-1] 原生侧主动请求通知权限** → `android-app/.../MainActivity.kt`（connectTo/loadServer 路径加一次 `maybeAskNotificationPermission()`）+ `mobile-app.js:570`（APP 分支按钮不永久置灰）。
2. **[P1-2] 计划本地缓存 + 开机离线重排** → `PlanPoller.kt`（200 分支落盘 items JSON）+ `BootReceiver.kt`（先缓存重排再联网刷新）+ 可选 `AlarmScheduler.kt`（暴露纯重排入口）。
3. **[P2-1] retry 上限对齐** → `PlanPoller.kt:53`（else 分支加 runAttemptCount 上限）。
4. **[P2-4] 通知去重键** → `NotifyUtil.kt:59` + `AlarmReceiver.kt`（透传 key 作 id）。
5. **[P2-5] 文案资源化** → `activity_main.xml:119` 及 Kotlin 各硬编码点迁 `strings.xml`。
6. **[P2-6] 签名与混淆预留** → `app/build.gradle.kts:18-22`（signingConfig）+ `app/proguard-rules.pro:4-6`（放开 keep 注释）。
7. **[P2-9] 主题恒深** → `res/values/themes.xml:4`（parent 去 DayNight）。
8. **[P2-10] 备份语义** → `AndroidManifest.xml:20`（allowBackup=false 或 backup rules）。
9. **[P2-2] 主线程预热实测** → 低端机后台冷启场景跑一次 WorkManager 触发链路（需实测，不阻塞合入）。

---

## 附录 A：评审文件清单（全部逐行读完）

Kotlin（8）：MainActivity.kt(306 行) / PlanPoller.kt(90) / PlanItem.kt(34) / AlarmScheduler.kt(85) / AlarmReceiver.kt(25) / BootReceiver.kt(19) / NotifyUtil.kt(64) / Prefs.kt(29)
资源：AndroidManifest.xml(54) / activity_main.xml(160) / strings.xml(14) / colors.xml(9) / themes.xml(10) / network_security_config.xml(6) / ic_stat_notify.xml(11) / mipmap-anydpi-v26/ic_launcher.xml(5)（另核对了 mipmap-*dpi PNG、gradle-wrapper.jar、gradlew(.bat)、android-app/.gitignore 存在性）
Gradle：settings.gradle.kts(17) / build.gradle.kts(6) / gradle.properties(4) / gradle-wrapper.properties(7) / app/build.gradle.kts(40) / proguard-rules.pro(6)
服务端配套：server-routes.mjs buildPlanItems(:318-366) + GET /api/plan(:724-738) + guardPin 上下文（commit fbe1c13）；mobile-app.js NativeBridge 相关（:11-17, :79-92, :565-590, :615-626）；occur.js 依赖函数（:32/:36/:70/:109/:241-244）；.qrtest/server-routes-test.mjs I1-I9（:255-321）

## 附录 B：联网核实记录（防臆造 API）

**B.1 zxing-android-embedded v4.3.0 源码**（经代理抓取 GitHub tag v4.3.0 原文）：
- `zxing-android-embedded/src/com/journeyapps/barcodescanner/ScanOptions.java`：L20 `public class ScanOptions`；L39 `QR_CODE` 常量；L99 `setPrompt(String)`；L111 `setOrientationLocked(boolean)`；L147 `setBeepEnabled(boolean)`；**L169 `setDesiredBarcodeFormats(Collection<String>)` 与 L180 `setDesiredBarcodeFormats(String...)` 双重载并存** → 本报告 §2-2 结论的依据（单 String 调用编译合法）。
- `ScanContract.java`：L10 `public class ScanContract extends ActivityResultContract<ScanOptions, ScanIntentResult>` → ScanContract/泛型/parseResult 用法（MainActivity.kt:52-66）成立。
- `build.gradle`：L75 `minSdkVersion 19` ≤ app minSdk 24，manifest merger 无冲突。
- 源：https://github.com/journeyapps/zxing-android-embedded/tree/v4.3.0 （raw.githubusercontent.com 抓取，http 200）

**B.2 依赖构件存在性**（代理 HEAD 请求，全部 200）：
- https://repo1.maven.org/maven2/com/journeyapps/zxing-android-embedded/4.3.0/zxing-android-embedded-4.3.0.aar → 200（Maven Central，settings.gradle.kts:12 覆盖）
- https://dl.google.com/android/maven2/androidx/work/work-runtime-ktx/2.9.1/work-runtime-ktx-2.9.1.aar → 200（Google Maven，settings.gradle.kts:11 google() 覆盖；androidx 构件不在 Central 属正常）
- https://dl.google.com/android/maven2/androidx/core/core-ktx/1.13.1/core-ktx-1.13.1.aar → 200
- https://dl.google.com/android/maven2/androidx/appcompat/appcompat/1.7.0/appcompat-1.7.0.aar → 200（首次请求经代理 404 为抖动，重试 200）

**B.3 参考检索**：[Release v4.3.0 · journeyapps/zxing-android-embedded](https://github.com/journeyapps/zxing-android-embedded/releases/tag/v4.3.0)、[DeepWiki: Scan Options](https://deepwiki.com/journeyapps/zxing-android-embedded/7.2-scan-options#1)

## 附录 C：不确定性声明（需实测项汇总）

| 项 | 位置 | 原因 |
|---|---|---|
| 真机扫码权限链路 | MainActivity.kt:225-232 | CAMERA 运行时权限由 zxing 库 CaptureManager 内部请求（4.x 行为），未在真机验证；建议首轮真机冒烟确认 |
| worker 冷启主线程卡顿 | PlanPoller.kt:31-33 | WebView provider 惰性加载耗时因机型而异 |
| assembleDebug 实际编译 | — | 只读评审未执行构建；本报告 P0=0 基于全量静态核查 + API 签名核实，最终以一次真实构建为准 |
