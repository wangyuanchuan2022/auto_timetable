package io.github.wangyuanchuan2022.timetable

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * 开机 / APK 升级完成后恢复课前提醒：
 * ① 先按最近一次缓存的提醒计划离线重排（AlarmManager 闹钟不跨重启，
 *    电脑端未开机/隧道换址/手机离线时也能恢复大部分提醒）；
 * ② 再触发联网刷新拿最新计划。
 */
class BootReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED ||
            intent.action == Intent.ACTION_MY_PACKAGE_REPLACED
        ) {
            NotifyUtil.ensureChannels(context)
            val cached = Prefs.lastPlanJson(context)
            if (cached != null) {
                try {
                    AlarmScheduler.rescheduleAll(context, parsePlan(cached))
                } catch (e: Exception) { // 缓存损坏：弃用，等联网刷新
                }
            }
            PlanPoller.enqueuePeriodic(context)
            PlanPoller.enqueueOnce(context)
        }
    }
}
