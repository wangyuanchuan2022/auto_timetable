package io.github.wangyuanchuan2022.timetable

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.os.Build
import org.json.JSONObject

/**
 * 把提醒计划逐条交给系统 AlarmManager 排精确闹钟（无需前台服务/常驻进程）：
 * - 精确闹钟可用（USE_EXACT_ALARM / SCHEDULE_EXACT_ALARM）→ setExactAndAllowWhileIdle（Doze 下也准点）；
 * - 不可用 → setWindow（10 分钟窗内，尽力而为）。
 * 重排前先按 prefs 里记录的 requestCode 取消全部旧闹钟（幂等，改动日程后重排不会重复弹）。
 */
object AlarmScheduler {
    private const val FILE = "tt_prefs"
    private const val KEY_CODES = "alarm_codes"
    private const val REQ_BASE = 4200
    private const val MAX_ALARMS = 80

    fun canScheduleExact(ctx: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true
        val am = ctx.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        return am.canScheduleExactAlarms()
    }

    /** 取消当前全部已排闹钟（换服务器 / 清空时用）。 */
    fun cancelAll(ctx: Context) {
        val prefs = ctx.getSharedPreferences(FILE, Context.MODE_PRIVATE)
        val am = ctx.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        for ((_, code) in loadCodes(prefs)) {
            am.cancel(PendingIntent.getBroadcast(
                ctx, code, plainIntent(ctx),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            ))
        }
        saveCodes(prefs, emptyMap())
    }

    /** 全量重排：先取消旧的全部，再排 remindAt 在未来的条目（升序前 MAX_ALARMS 条）。 */
    fun rescheduleAll(ctx: Context, items: List<PlanItem>) {
        val prefs = ctx.getSharedPreferences(FILE, Context.MODE_PRIVATE)
        val am = ctx.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        cancelAll(ctx)
        val now = System.currentTimeMillis()
        val exact = canScheduleExact(ctx)
        val codes = HashMap<String, Int>()
        for ((i, item) in items.filter { it.remindAt > now }.take(MAX_ALARMS).withIndex()) {
            val code = REQ_BASE + i
            val pi = PendingIntent.getBroadcast(
                ctx, code, AlarmReceiver.preclassIntent(ctx, item),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            if (exact) {
                am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, item.remindAt, pi)
            } else {
                am.setWindow(AlarmManager.RTC_WAKEUP, item.remindAt, 10 * 60 * 1000L, pi)
            }
            codes[item.key] = code
        }
        saveCodes(prefs, codes)
    }

    /** 与已排闹钟 filterEquals 一致的无 extras Intent（取消用；extras 不参与 filterEquals）。 */
    private fun plainIntent(ctx: Context): Intent =
        Intent(AlarmReceiver.ACTION_PRECLASS).setClass(ctx, AlarmReceiver::class.java)

    private fun loadCodes(prefs: SharedPreferences): Map<String, Int> {
        val s = prefs.getString(KEY_CODES, null) ?: return emptyMap()
        return try {
            val o = JSONObject(s)
            val m = LinkedHashMap<String, Int>()
            for (k in o.keys()) m[k] = o.optInt(k)
            m
        } catch (e: Exception) {
            emptyMap()
        }
    }

    private fun saveCodes(prefs: SharedPreferences, codes: Map<String, Int>) {
        prefs.edit().putString(KEY_CODES, JSONObject(codes).toString()).apply()
    }
}
