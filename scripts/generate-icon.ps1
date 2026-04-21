$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$buildDir = Join-Path $root 'build'
New-Item -ItemType Directory -Force $buildDir | Out-Null

Add-Type -AssemblyName System.Drawing

function New-IconBitmap([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)

  $scale = $size / 512.0
  function S([float]$v) { return [int][Math]::Round($v * $scale) }

  $bgBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 22, 22, 22))
  $bookBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 233, 79, 87))
  $pageBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 246, 240, 229))
  $spineBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 16, 16, 16))
  $accentBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 43, 179, 163))
  $inkPen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 22, 22, 22)), (S 20)
  $linePen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 200, 185, 162)), (S 10)

  $g.FillRectangle($bgBrush, 0, 0, $size, $size)
  $g.FillRectangle($bookBrush, (S 110), (S 102), (S 282), (S 250))
  $g.FillRectangle($pageBrush, (S 142), (S 132), (S 210), (S 188))
  $g.FillRectangle($spineBrush, (S 374), (S 82), (S 40), (S 330))
  $g.FillRectangle($pageBrush, (S 145), (S 342), (S 269), (S 62))
  $g.DrawLine($linePen, (S 150), (S 366), (S 354), (S 366))
  $g.DrawLine($linePen, (S 150), (S 388), (S 332), (S 388))
  $g.DrawLine($inkPen, (S 201), (S 198), (S 306), (S 198))
  $g.DrawLine($inkPen, (S 201), (S 240), (S 280), (S 240))

  $points = @(
    (New-Object System.Drawing.Point (S 320), (S 133)),
    (New-Object System.Drawing.Point (S 365), (S 178)),
    (New-Object System.Drawing.Point (S 320), (S 223))
  )
  $g.FillPolygon($accentBrush, $points)

  $g.Dispose()
  return $bmp
}

$sizes = @(256, 128, 64, 48, 32, 16)
$pngBytes = @()
foreach ($s in $sizes) {
  $bmp = New-IconBitmap $s
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $pngBytes += ,$ms.ToArray()
  $ms.Dispose()
  $bmp.Dispose()
}

$icoPath = Join-Path $buildDir 'icon.ico'
$fs = [System.IO.File]::Create($icoPath)
$bw = New-Object System.IO.BinaryWriter($fs)
$bw.Write([UInt16]0)
$bw.Write([UInt16]1)
$bw.Write([UInt16]$sizes.Count)

$offset = 6 + (16 * $sizes.Count)
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $size = $sizes[$i]
  $bytes = $pngBytes[$i]
  if ($size -eq 256) { $bw.Write([byte]0) } else { $bw.Write([byte]$size) }
  if ($size -eq 256) { $bw.Write([byte]0) } else { $bw.Write([byte]$size) }
  $bw.Write([byte]0)
  $bw.Write([byte]0)
  $bw.Write([UInt16]1)
  $bw.Write([UInt16]32)
  $bw.Write([UInt32]$bytes.Length)
  $bw.Write([UInt32]$offset)
  $offset += $bytes.Length
}

foreach ($bytes in $pngBytes) { $bw.Write($bytes) }
$bw.Close()
$fs.Close()

Write-Host "Generated $icoPath"
