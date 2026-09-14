package io.github.wangyuanchuan2022.timetable

import android.Manifest
import android.annotation.SuppressLint
import android.app.AlarmManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.View
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanIntentResult
import com.journeyapps.barcodescanner.ScanOptions

import org.json.JSONArray

import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 单 Activity 壳：
 *   配对屏（扫码 / 手动输入服务器地址） → WebView 加载电脑端移动页（全部既有功能）。
 *   原生增强：课前提醒精确闹钟（PlanPoller/AlarmScheduler）+ JS 桥 NativeBridge。
 */
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var pairingView: View
    private lateinit var errorView: View
    private lateinit var errorText: TextView
    private lateinit var urlInput: EditText
    private var fileCallback: ValueCallback<Array<Uri>>? = null

    // 离线兜底（v1.3）：连不上服务器时，用 assets 离线页 + 上次同步的课表缓存继续看，别困在错误屏
    private val cacheFile by lazy { File(filesDir, "offline-cache.json") }
    private val offlineUrl = "file:///android_asset/offline.html"

    // ---- ActivityResult 注册（须在 onCreate 前完成，属性初始化即满足） ----

    private val scanLauncher = registerForActivityResult(ScanContract()) { result: ScanIntentResult ->
        val raw = result.contents?.trim()
        if (raw.isNullOrEmpty()) return@registerForActivityResult // 用户取消
        val url = normalizeServerUrl(raw)
        if (url == null) toast("二维码内容不是有效的服务器地址") else connectTo(url)
    }

    private val notifPermLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { /* 授权结果无需处理：未授权时通知自动静默跳过 */ }

    private val fileChooserLauncher =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
            val cb = fileCallback
            fileCallback = null
            cb?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(r.resultCode, r.data))
        }

    // ---- 生命周期 ----

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        webView = findViewById(R.id.webView)
        pairingView = findViewById(R.id.pairingView)
        errorView = findViewById(R.id.errorView)
        errorText = findViewById(R.id.errorText)
        urlInput = findViewById(R.id.urlInput)

        setupWebView()
        NotifyUtil.ensureChannels(this)

        findViewById<Button>(R.id.btnScan).setOnClickListener { launchScanner() }
        findViewById<Button>(R.id.btnConnect).setOnClickListener {
            val url = normalizeServerUrl(urlInput.text?.toString())
            if (url == null) toast("请输入 http(s) 服务器地址") else connectTo(url)
        }
        findViewById<Button>(R.id.btnRetry).setOnClickListener {
            val b = Prefs.baseUrl(this)
            if (b == null) showPairing() else loadServer(b)
        }
        findViewById<Button>(R.id.btnRescan).setOnClickListener { launchScanner() }
        findViewById<Button>(R.id.btnReinput).setOnClickListener { showPairing() }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.visibility == View.VISIBLE && webView.canGoBack()) webView.goBack() else finish()
            }
        })

        PlanPoller.enqueuePeriodic(this) // 幂等（KEEP）：WorkManager 持久化，重启后自动续期
        val saved = Prefs.baseUrl(this)
        if (saved == null) showPairing() else loadServer(saved)
    }

    override fun onResume() {
        super.onResume()
        if (Prefs.baseUrl(this) != null) PlanPoller.enqueueOnce(this) // 回前台即刷新提醒计划
        maybeHintExactAlarm()
    }

    override fun onPause() {
        super.onPause()
        try { CookieManager.getInstance().flush() } catch (e: Exception) { /* 尽力落盘 */ }
    }

    // ---- WebView ----

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true          // 页面 localStorage（页内提醒去重等）
            allowFileAccess = false
            allowContentAccess = true         // 聊天图片附件走 content://
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            useWideViewPort = true
            loadWithOverviewMode = true
        }
        CookieManager.getInstance().setAcceptCookie(true)

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url
                val scheme = url.scheme ?: return true
                if (scheme == "http" || scheme == "https") {
                    if (isSameOrigin(url, Prefs.baseUrl(this@MainActivity))) return false
                    openExternal(url) // 非本站链接交系统浏览器
                    return true
                }
                openExternal(url) // tel:/mailto:/intent: 等交系统处理
                return true
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (!request.isForMainFrame) return
                routeFailure("无法连接服务器：${error.description}\n若电脑刚重启过，隧道地址可能已变化，请重新扫码。")
            }

            override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, errorResponse: WebResourceResponse) {
                // 隧道失效时 Cloudflare 边缘回 530/5xx 错误【网页】，WebView 会把它当正常页面渲染，
                // 用户被困在 CF 错误页里没有重扫入口——主框架 5xx/403 一律切原生错误屏。
                // （只看主框架：页内 /api/* 的 401/429 由页面自己的登录闸处理，不受影响）
                if (!request.isForMainFrame) return
                val code = errorResponse.statusCode
                if (code >= 500 || code == 403) {
                    routeFailure("服务器暂时不可达（HTTP $code）。\n若电脑刚重启过，隧道地址可能已变化，请重新扫码或稍后重试。")
                }
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                view: WebView,
                filePathCallback: ValueCallback<Array<Uri>>,
                fileChooserParams: FileChooserParams,
            ): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = filePathCallback
                return try {
                    fileChooserLauncher.launch(fileChooserParams.createIntent())
                    true
                } catch (e: Exception) {
                    fileCallback = null
                    false
                }
            }
        }

        webView.addJavascriptInterface(Bridge(), "NativeBridge")
    }

    /** 页面内 <input type="file">（聊天图片附件） */
    // 由 onShowFileChooser 处理；ValueCallback 生命周期见 fileCallback。

    // ---- JS 桥（mobile-app.js 检测到 NativeBridge 时走 APP 模式） ----

    inner class Bridge {
        @JavascriptInterface
        fun requestNotifyPermission() {
            runOnUiThread { maybeAskNotifyPermission() }
        }

        @JavascriptInterface
        fun refreshPlan() {
            PlanPoller.enqueueOnce(this@MainActivity) // 登录成功后立即同步提醒计划
        }

        // ---- 离线兜底（v1.3）：页面把最新课表交给壳落盘；连接失败时壳路由到 assets 离线页读缓存 ----

        @JavascriptInterface
        fun saveCache(json: String) {
            try {
                cacheFile.writeText(json)
            } catch (e: Exception) {
                /* 尽力缓存，失败不影响在线功能 */
            }
        }

        @JavascriptInterface
        fun readCache(): String = try {
            if (cacheFile.isFile) cacheFile.readText() else ""
        } catch (e: Exception) {
            ""
        }

        @JavascriptInterface
        fun retryConnect() {
            runOnUiThread {
                val b = Prefs.baseUrl(this@MainActivity)
                if (b == null) showPairing() else loadServer(b)
            }
        }

        @JavascriptInterface
        fun startScan() {
            runOnUiThread { launchScanner() }
        }

        @JavascriptInterface
        fun showPairingScreen() {
            runOnUiThread { showPairing() }
        }

        /**
         * 下一个已排课前提醒的触发时间（MM-dd HH:mm；无则空串）。
         * 来源 = 最近一次成功同步的提醒计划（Prefs.lastPlanJson，与 AlarmScheduler 已排闹钟同源、
         * 同为 7 天窗）：PlanPoller 拉取失败/离线时既有闹钟原样保留（见 PlanPoller 注释），
         * 手机重启/覆盖安装由 BootReceiver 按同份缓存重排——离线期间弹窗不漏。
         */
        @JavascriptInterface
        fun nextReminderAt(): String {
            return try {
                val json = Prefs.lastPlanJson(this@MainActivity)
                val arr = if (json != null) JSONArray(json) else null
                val now = System.currentTimeMillis()
                var best = 0L
                if (arr != null) {
                    for (i in 0 until arr.length()) {
                        val t = arr.optJSONObject(i)?.optLong("remindAt", 0L) ?: 0L
                        if (t > now && (best == 0L || t < best)) best = t
                    }
                }
                if (best == 0L) "" else SimpleDateFormat("MM-dd HH:mm", Locale.CHINA).format(Date(best))
            } catch (e: Exception) {
                ""
            }
        }
    }

    // ---- 界面状态切换 ----

    private fun loadServer(base: String) {
        pairingView.visibility = View.GONE
        errorView.visibility = View.GONE
        webView.visibility = View.VISIBLE
        webView.loadUrl("$base/")
    }

    private fun showPairing() {
        webView.visibility = View.GONE
        errorView.visibility = View.GONE
        pairingView.visibility = View.VISIBLE
        if (urlInput.text.isNullOrBlank()) Prefs.baseUrl(this)?.let { urlInput.setText(it) }
    }

    /**
     * 主框架加载失败（v1.3）：优先离线兜底页（assets + 上次同步的课表缓存），
     * 无缓存才进错误屏。已在离线页时不再路由（离线页自足、不会再触发服务器加载，防循环）。
     */
    private fun routeFailure(msg: String) {
        if (webView.visibility != View.VISIBLE) return // 只在网页加载失败时接管
        if (webView.url?.startsWith(offlineUrl) == true) return
        if (cacheFile.isFile) {
            webView.loadUrl(offlineUrl)
        } else {
            showError(msg)
        }
    }

    private fun showError(msg: String) {
        if (webView.visibility != View.VISIBLE) return // 只在网页加载失败时接管
        webView.visibility = View.GONE
        errorView.visibility = View.VISIBLE
        errorText.text = msg
    }

    private fun connectTo(url: String) {
        val old = Prefs.baseUrl(this)
        Prefs.setBaseUrl(this, url)
        if (old != null && old != url) AlarmScheduler.cancelAll(this) // 换服务器：旧提醒全部作废
        urlInput.setText(url)
        loadServer(url)
        PlanPoller.enqueueOnce(this)
        maybeAskNotifyPermission() // 配对即申请通知权限（评审 P1-1：不依赖页面按钮这一单一入口）
        toast("已连接：$url")
    }

    // ---- 扫码 / 地址归一 ----

    private fun launchScanner() {
        val opts = ScanOptions().apply {
            setCaptureActivity(VerticalScannerActivity::class.java) // 库默认锁横屏，换我们的竖屏扫码页
            setDesiredBarcodeFormats(ScanOptions.QR_CODE)
            setPrompt("对准电脑端「日程安排」面板上的公网访问二维码")
            setBeepEnabled(false)
            setOrientationLocked(true)
        }
        scanLauncher.launch(opts)
    }

    /** 任意输入 → http(s) 源地址（去路径/查询）；非法返回 null。 */
    private fun normalizeServerUrl(raw: String?): String? {
        var s = raw?.trim() ?: return null
        if (s.isEmpty()) return null
        if (!s.startsWith("http://") && !s.startsWith("https://")) s = "https://$s"
        return try {
            val u = Uri.parse(s)
            val scheme = u.scheme
            val host = u.host
            if (host.isNullOrBlank() || (scheme != "http" && scheme != "https")) null
            else buildString {
                append(scheme).append("://").append(host)
                if (u.port != -1) append(':').append(u.port)
            }
        } catch (e: Exception) {
            null
        }
    }

    /** url 是否落在 base 源内（防 "https://a.trycloudflare.com.evil.com" 式前缀绕过）。 */
    private fun isSameOrigin(url: Uri, base: String?): Boolean {
        if (base.isNullOrEmpty()) return false
        val s = url.toString()
        return s == base || s.startsWith("$base/") || s.startsWith("$base?")
    }

    // ---- 权限 / 系统设置引导 ----

    private fun maybeAskNotifyPermission() {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            notifPermLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    private fun maybeHintExactAlarm() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return
        val am = getSystemService(Context.ALARM_SERVICE) as AlarmManager
        if (am.canScheduleExactAlarms() || Prefs.exactHintShown(this)) return
        Prefs.setExactHintShown(this, true)
        AlertDialog.Builder(this)
            .setTitle("开启精确提醒")
            .setMessage("为保证课前提醒准点弹出，建议允许本应用使用「闹钟和提醒」（精确闹钟）。")
            .setPositiveButton("去设置") { _, _ ->
                try {
                    startActivity(
                        Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, Uri.parse("package:$packageName")),
                    )
                } catch (e: Exception) {
                    toast("未找到设置入口，可在系统设置中手动开启")
                }
            }
            .setNegativeButton("暂不", null)
            .show()
    }

    // ---- 杂项 ----

    private fun openExternal(u: Uri) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, u))
        } catch (e: Exception) {
            toast("无法打开链接")
        }
    }

    private fun toast(msg: String) {
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()
    }
}
