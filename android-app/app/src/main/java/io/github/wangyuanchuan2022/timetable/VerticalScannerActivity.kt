package io.github.wangyuanchuan2022.timetable

import com.journeyapps.barcodescanner.CaptureActivity

/**
 * 竖屏扫码页：zxing-android-embedded 的 CaptureActivity 在库清单里默认锁定横屏
 * （条码扫描器的传统默认，setOrientationLocked(true) 锁的也是横屏朝向）。
 * 按库官方做法，空子类 + 应用清单声明 screenOrientation="portrait" 即切竖屏。
 */
class VerticalScannerActivity : CaptureActivity()
