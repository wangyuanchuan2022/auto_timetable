package io.github.wangyuanchuan2022.timetable

import android.content.Context
import android.webkit.CookieManager
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.Constraints
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.TimeUnit

/**
 * 周期拉取电脑端 /api/plan → 全量重排本地精确闹钟。
 *
 * 鉴权复用 WebView 登录会话：页面 /api/login 种下的 30 天 HttpOnly Cookie 存在
 * WebView CookieManager（含 HttpOnly，原生可读），这里取出后随请求发送。
 * 拉取失败/未登录时保留既有闹钟不动（PC 关机期间已排提醒照常响）。
 */
class PlanPoller(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {

    override suspend fun doWork(): Result {
        val base = Prefs.baseUrl(applicationContext) ?: return Result.success()
        val cookie = withContext(Dispatchers.Main) {
            CookieManager.getInstance().getCookie(base)
        }
        val conn = try {
            // days=30（服务端 clamp 1..60）：离线安全期 = 计划窗口长度——电脑失联 30 天内，
            // 已排到本机的课前提醒仍整段有效（v1.5 起从 7 天扩到 30 天，用户要求防提醒静默断档）。
            (URL("$base/api/plan?days=30").openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = 8000
                readTimeout = 15000
                setRequestProperty("Accept", "application/json")
                if (!cookie.isNullOrBlank()) setRequestProperty("Cookie", cookie)
            }
        } catch (e: Exception) {
            return Result.success() // 地址非法等：等下个周期
        }
        return try {
            when (conn.responseCode) {
                200 -> {
                    val body = conn.inputStream.bufferedReader().readText()
                    val items = parsePlan(body)
                    Prefs.setLastPlanJson(applicationContext, body) // 落盘：重启后可离线恢复闹钟
                    AlarmScheduler.rescheduleAll(applicationContext, items)
                    Result.success()
                }
                401 -> Result.success() // 未登录：用户在页面登录后 NativeBridge.refreshPlan 会再触发
                else -> if (runAttemptCount < 5) Result.retry() else Result.success()
            }
        } catch (e: Exception) {
            if (runAttemptCount < 3) Result.retry() else Result.success() // 保底：不再无限重试
        } finally {
            conn.disconnect()
        }
    }

    companion object {
        private const val PERIODIC = "periodic-plan-poll"
        private const val ONCE = "once-plan-poll"

        private fun constraints() = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build()

        /** 每 6 小时全量刷新提醒计划（WorkManager 持久化：重启后自动恢复）。 */
        fun enqueuePeriodic(ctx: Context) {
            val req = PeriodicWorkRequestBuilder<PlanPoller>(6, TimeUnit.HOURS)
                .setConstraints(constraints())
                .build()
            WorkManager.getInstance(ctx).enqueueUniquePeriodicWork(
                PERIODIC, ExistingPeriodicWorkPolicy.KEEP, req,
            )
        }

        /** 立即刷新一次（开屏 / 登录成功 / 开机 / 换服务器）。 */
        fun enqueueOnce(ctx: Context) {
            val req = OneTimeWorkRequestBuilder<PlanPoller>()
                .setConstraints(constraints())
                .build()
            WorkManager.getInstance(ctx).enqueueUniqueWork(
                ONCE, ExistingWorkPolicy.REPLACE, req,
            )
        }
    }
}
