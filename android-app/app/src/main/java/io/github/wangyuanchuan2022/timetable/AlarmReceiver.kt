package io.github.wangyuanchuan2022.timetable

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** 课前提醒闹钟触发 → 弹系统通知（extras 由 AlarmScheduler 排定时写入）。 */
class AlarmReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_PRECLASS) return
        val key = intent.getStringExtra(EXTRA_KEY) ?: return
        val body = intent.getStringExtra(EXTRA_BODY) ?: return
        NotifyUtil.showPreclass(context, key, body)
    }

    companion object {
        const val ACTION_PRECLASS = "io.github.wangyuanchuan2022.timetable.PRECLASS"
        const val EXTRA_KEY = "key"
        const val EXTRA_BODY = "body"

        fun preclassIntent(ctx: Context, item: PlanItem): Intent =
            Intent(ACTION_PRECLASS)
                .setClass(ctx, AlarmReceiver::class.java)
                .putExtra(EXTRA_KEY, item.key)
                .putExtra(EXTRA_BODY, item.body)
    }
}
