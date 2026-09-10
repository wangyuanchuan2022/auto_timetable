# 生成应用图标：品牌色圆角方块 + 白色日历图形（legacy ic_launcher）与
# 自适应图标前景（透明底 + 居中日历图形，安全区 66/108）。输出 mipmap 各密度。
$Root = "D:\tools\auto_timetable\android-app\app\src\main\res"

Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = 'Stop'

function New-CalendarBitmap([int]$size, [bool]$withBg) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)

    $brand = [System.Drawing.Color]::FromArgb(255, 79, 110, 247)
    $bgBrush = New-Object System.Drawing.SolidBrush($brand)

    if ($withBg) {
        $r = [float]($size * 0.22)
        $path = New-Object System.Drawing.Drawing2D.GraphicsPath
        $path.AddArc(0, 0, 2 * $r, 2 * $r, 180, 90)
        $path.AddArc($size - 2 * $r, 0, 2 * $r, 2 * $r, 270, 90)
        $path.AddArc($size - 2 * $r, $size - 2 * $r, 2 * $r, 2 * $r, 0, 90)
        $path.AddArc(0, $size - 2 * $r, 2 * $r, 2 * $r, 90, 90)
        $path.CloseFigure()
        $g.FillPath($bgBrush, $path)
    }

    # 日历图形的有效边长与原点（自适应前景缩到 66/108 安全区并居中）
    if ($withBg) { $unit = [float]$size; $ox = 0.0; $oy = 0.0 }
    else {
        $unit = [float]($size * 66.0 / 108.0)
        $ox = [float](($size - $unit) / 2.0)
        $oy = $ox
    }

    $white = [System.Drawing.Brushes]::White

    # 日历主体 0.18..0.82 × 0.26..0.84
    $bx = $ox + 0.18 * $unit; $by = $oy + 0.26 * $unit
    $bw = 0.64 * $unit;       $bh = 0.58 * $unit
    $bodyPath = New-Object System.Drawing.Drawing2D.GraphicsPath
    $rad = 0.06 * $unit
    $bodyPath.AddArc($bx, $by, 2 * $rad, 2 * $rad, 180, 90)
    $bodyPath.AddArc($bx + $bw - 2 * $rad, $by, 2 * $rad, 2 * $rad, 270, 90)
    $bodyPath.AddArc($bx + $bw - 2 * $rad, $by + $bh - 2 * $rad, 2 * $rad, 2 * $rad, 0, 90)
    $bodyPath.AddArc($bx, $by + $bh - 2 * $rad, 2 * $rad, 2 * $rad, 90, 90)
    $bodyPath.CloseFigure()
    $g.FillPath($white, $bodyPath)

    # 顶部两个挂环（白色竖条）
    $ringW = 0.055 * $unit; $ringH = 0.12 * $unit
    $g.FillRectangle($white, $ox + 0.32 * $unit, $oy + 0.16 * $unit, $ringW, $ringH)
    $g.FillRectangle($white, $ox + 0.62 * $unit, $oy + 0.16 * $unit, $ringW, $ringH)

    # 头带（品牌色横条）+ 3×2 日期点阵
    $headBrush = New-Object System.Drawing.SolidBrush($brand)
    $g.FillRectangle($headBrush, $bx, $by, $bw, 0.12 * $unit)
    $dot = 0.075 * $unit
    foreach ($gy in @(0.52, 0.68)) {
        foreach ($gx in @(0.30, 0.46, 0.62)) {
            $g.FillRectangle($headBrush, $ox + $gx * $unit, $oy + $gy * $unit, $dot, $dot)
        }
    }

    $g.Dispose()
    return $bmp
}

$densities = @{
    'mipmap-mdpi'    = 48
    'mipmap-hdpi'    = 72
    'mipmap-xhdpi'   = 96
    'mipmap-xxhdpi'  = 144
    'mipmap-xxxhdpi' = 192
}
foreach ($d in $densities.Keys) {
    $dir = Join-Path $Root $d
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $legacy = New-CalendarBitmap $densities[$d] $true
    $legacy.Save((Join-Path $dir 'ic_launcher.png'), [System.Drawing.Imaging.ImageFormat]::Png)
    $legacy.Dispose()
    # 自适应前景：108dp 画布（mdpi=108px 基准）
    $fgSize = [int]($densities[$d] * 108.0 / 48.0)
    $fg = New-CalendarBitmap $fgSize $false
    $fg.Save((Join-Path $dir 'ic_launcher_foreground.png'), [System.Drawing.Imaging.ImageFormat]::Png)
    $fg.Dispose()
    Write-Host ("[OK] {0}: ic_launcher.png {1}px + ic_launcher_foreground.png {2}px" -f $d, $densities[$d], $fgSize)
}
Write-Host '[DONE] icons generated'
