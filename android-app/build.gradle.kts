// 根构建脚本：插件版本集中在此声明（子模块 apply）。
// AGP 8.5.2 需 Gradle 8.7+ 与 JDK 17（Android Studio 自带 JBR 17/21 均可）。
plugins {
    id("com.android.application") version "8.5.2" apply false
    id("org.jetbrains.kotlin.android") version "1.9.24" apply false
}
