package io.github.wangyuanchuan2022.timetable

import android.content.Context

/** 轻量配置存取：服务器地址、最近一次提醒计划缓存（开机离线恢复用）、精确闹钟提示标记。 */
object Prefs {
    private const val FILE = "tt_prefs"
    private const val KEY_BASE = "base_url"
    private const val KEY_EXACT_HINT = "exact_hint_shown"
    private const val KEY_LAST_PLAN = "last_plan_json"

    fun baseUrl(ctx: Context): String? =
        ctx.getSharedPreferences(FILE, Context.MODE_PRIVATE)
            .getString(KEY_BASE, null)?.trim()?.trimEnd('/')

    fun setBaseUrl(ctx: Context, url: String?) {
        ctx.getSharedPreferences(FILE, Context.MODE_PRIVATE).edit()
            .putString(KEY_BASE, url?.trim()?.trimEnd('/'))
            .apply()
    }

    fun exactHintShown(ctx: Context): Boolean =
        ctx.getSharedPreferences(FILE, Context.MODE_PRIVATE).getBoolean(KEY_EXACT_HINT, false)

    fun setExactHintShown(ctx: Context, shown: Boolean) {
        ctx.getSharedPreferences(FILE, Context.MODE_PRIVATE).edit()
            .putBoolean(KEY_EXACT_HINT, shown)
            .apply()
    }

    /** 最近一次 /api/plan 原始响应（开机后先按它离线重排，再联网刷新）。 */
    fun lastPlanJson(ctx: Context): String? =
        ctx.getSharedPreferences(FILE, Context.MODE_PRIVATE).getString(KEY_LAST_PLAN, null)

    fun setLastPlanJson(ctx: Context, json: String?) {
        ctx.getSharedPreferences(FILE, Context.MODE_PRIVATE).edit()
            .putString(KEY_LAST_PLAN, json)
            .apply()
    }
}
