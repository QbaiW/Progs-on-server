$ErrorActionPreference = "Stop"
$projectDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$vendorDirectory = Join-Path $projectDirectory "public\vendor"
$threeFile = Join-Path $vendorDirectory "three.module.js"
$cannonFile = Join-Path $vendorDirectory "cannon-es.js"
$threeLicense = Join-Path $vendorDirectory "THREE-LICENSE.txt"
$cannonLicense = Join-Path $vendorDirectory "CANNON-LICENSE.txt"

function Download-WithFallback {
  param(
    [string[]]$Urls,
    [string]$Destination
  )

  $lastError = $null
  foreach ($url in $Urls) {
    try {
      Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $Destination
      return
    } catch {
      $lastError = $_
    }
  }
  throw $lastError
}

if (-not (Test-Path -LiteralPath $vendorDirectory)) {
  New-Item -ItemType Directory -Path $vendorDirectory | Out-Null
}

if (-not (Test-Path -LiteralPath $threeFile)) {
  Write-Host "Downloading Three.js 0.168.0..."
  Download-WithFallback -Urls @(
    "https://cdn.jsdelivr.net/npm/three@0.168.0/build/three.module.js",
    "https://unpkg.com/three@0.168.0/build/three.module.js"
  ) -Destination $threeFile
}

if (-not (Test-Path -LiteralPath $cannonFile)) {
  Write-Host "Downloading Cannon ES 0.20.0..."
  Download-WithFallback -Urls @(
    "https://cdn.jsdelivr.net/npm/cannon-es@0.20.0/dist/cannon-es.js",
    "https://unpkg.com/cannon-es@0.20.0/dist/cannon-es.js"
  ) -Destination $cannonFile
}

if (-not (Test-Path -LiteralPath $threeLicense)) {
  Download-WithFallback -Urls @(
    "https://cdn.jsdelivr.net/npm/three@0.168.0/LICENSE",
    "https://unpkg.com/three@0.168.0/LICENSE"
  ) -Destination $threeLicense
}

if (-not (Test-Path -LiteralPath $cannonLicense)) {
  Download-WithFallback -Urls @(
    "https://cdn.jsdelivr.net/npm/cannon-es@0.20.0/LICENSE",
    "https://unpkg.com/cannon-es@0.20.0/LICENSE"
  ) -Destination $cannonLicense
}

Write-Host "3D dependencies are ready."
