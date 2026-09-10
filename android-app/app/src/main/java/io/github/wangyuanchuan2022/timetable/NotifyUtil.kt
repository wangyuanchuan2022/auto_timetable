package io.github.wangyuanchuan2022.timetable

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat

/** 系统通知：高优先级渠道 → 锁屏/后台都会弹出横幅（用户要的「消息弹窗提醒」）。 */
object NotifyUtil {
    const val CHANNEL_PRECLASS = "preclass"

    fun ensureChannels(ctx: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val ch = NotificationChannel(
            CHANNEL_PRECLASS,
            ctx.getString(R.string.app_name) + " · 课前提醒",
            NotificationManager.IMPORTANCE_HIGH,
        ).apply {
            description = "上课前按设定的提前量弹出系统通知"
            enableVibration(true)
        }
        nm.createNotificationChannel(ch)
    }

    fun notifyPermissionGranted(ctx: Context): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED

    fun showPreclass(ctx: Context, key: String, body: String) {
        ensureChannels(ctx)
        if (!notifyPermissionGranted(ctx)) return
        val pi = PendingIntent.getActivity(
            ctx, 1001,
            Intent(ctx, MainActivity::class.java).setFlags(
                Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP,
            ),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val n = NotificationCompat.Builder(ctx, CHANNEL_PRECLASS)
            .setSmallIcon(R.drawable.ic_stat_notify)
            .setContentTitle("⏰ 课前提醒")
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setAutoCancel(true)
            .setContentIntent(pi)
            .build()
        try {
            // id 用计划条目 key（含事件 id+日期）：同一门课不同日期互不覆盖
            NotificationManagerCompat.from(ctx).notify("preclass", key.hashCode(), n)
        } catch (e: SecurityException) {
            // 权限在弹窗瞬间被撤销：静默
        }
    }
}
