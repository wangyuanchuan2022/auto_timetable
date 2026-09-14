plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "io.github.wangyuanchuan2022.timetable"
    compileSdk = 34
    // 本机 SDK 无 build-tools 34.0.0，用已有的 35.0.0（AGP 8.5 允许高于默认版本）
    buildToolsVersion = "35.0.0"

    defaultConfig {
        applicationId = "io.github.wangyuanchuan2022.timetable"
        minSdk = 24
        targetSdk = 34
        versionCode = 5
        versionName = "1.4"   // v1.4: 离线横幅带上次同步时间/陈旧度 + 提醒计划状态（下次提醒时间）
    }

    signingConfigs {
        getByName("debug") {
            // 密钥库放工程内（gitignore），不依赖 ~/.android（沙箱/免装环境也能签名）
            storeFile = file("debug.keystore")
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
        debug {
            signingConfig = signingConfigs.getByName("debug")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    // 离线页 assets：加生成目录（构建时由下方 syncOccurJs 填充 occur.js）
    sourceSets["main"].assets.srcDir(layout.buildDirectory.dir("generated-assets"))
}

// 领域判定单一实现约定：离线页用的 occur.js 永远从仓库根构建期同步（单一来源），禁止手改 assets 副本
val syncOccurJs = tasks.register<Copy>("syncOccurJs") {
    from(rootProject.file("../occur.js"))
    into(layout.buildDirectory.dir("generated-assets"))
}
tasks.named("preBuild") { dependsOn(syncOccurJs) }

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    // 周期轮询 /api/plan + 开机重排（无需前台服务，省电且不受 Android 14 前台服务类型限制）
    implementation("androidx.work:work-runtime-ktx:2.9.1")
    // 扫码（Maven Central，不依赖 Google Play Services，国内 ROM 可用）
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
}
