# 默认关闭 minify；规则预置好，未来开启混淆时 JS 桥方法名不会被改名。
-keepclassmembers class io.github.wangyuanchuan2022.timetable.MainActivity$Bridge {
    @android.webkit.JavascriptInterface <methods>;
}
