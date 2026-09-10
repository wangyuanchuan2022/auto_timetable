package io.github.wangyuanchuan2022.timetable

import org.json.JSONObject

/** 一条课前提醒（由电脑端 /api/plan 按 occur.js 单一实现算好，端上不做领域判定）。 */
data class PlanItem(
    val key: String,
    val title: String,
    val remindAt: Long,
    val body: String,
)

/** /api/plan 响应解析（org.json，Android 内置）。 */
fun parsePlan(json: String): List<PlanItem> {
    val root = JSONObject(json)
    if (!root.optBoolean("ok", false)) return emptyList()
    val arr = root.optJSONArray("items") ?: return emptyList()
    val out = ArrayList<PlanItem>(arr.length())
    for (i in 0 until arr.length()) {
        val o = arr.optJSONObject(i) ?: continue
        val key = o.optString("key", "")
        val remindAt = o.optLong("remindAt", 0L)
        if (key.isEmpty() || remindAt <= 0L) continue
        out.add(
            PlanItem(
                key = key,
                title = o.optString("title", "(未命名)"),
                remindAt = remindAt,
                body = o.optString("body", ""),
            )
        )
    }
    return out
}
