$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$buildRepo = Join-Path $root 'mihon-extension-build'
$sourceModule = Join-Path $root 'mihon-extension'
$targetModule = Join-Path $buildRepo 'src/all/mangalibrary'

if (-not (Test-Path $buildRepo)) {
  git clone --depth 1 https://github.com/keiyoushi/extensions-source.git $buildRepo
}

if (Test-Path $targetModule) {
  Remove-Item -LiteralPath $targetModule -Recurse -Force
}
New-Item -ItemType Directory -Force $targetModule | Out-Null

Copy-Item -LiteralPath (Join-Path $sourceModule 'build.gradle') -Destination (Join-Path $targetModule 'build.gradle') -Force
Copy-Item -LiteralPath (Join-Path $sourceModule 'AndroidManifest.xml') -Destination (Join-Path $targetModule 'AndroidManifest.xml') -Force
Copy-Item -LiteralPath (Join-Path $sourceModule 'src') -Destination $targetModule -Recurse -Force

Push-Location $buildRepo
try {
  if (-not (Test-Path 'local.properties') -and $env:ANDROID_HOME) {
    $sdk = $env:ANDROID_HOME.Replace('\', '/')
    "sdk.dir=$sdk" | Set-Content -Encoding ASCII 'local.properties'
  }
  .\gradlew.bat :src:all:mangalibrary:assembleDebug
} finally {
  Pop-Location
}
