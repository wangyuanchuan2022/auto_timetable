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
        versionCode = 3
        versionName = "1.2"
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
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    // 周期轮询 /api/plan + 开机重排（无需前台服务，省电且不受 Android 14 前台服务类型限制）
    implementation("androidx.work:work-runtime-ktx:2.9.1")
    // 扫码（Maven Central，不依赖 Google Play Services，国内 ROM 可用）
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
}
