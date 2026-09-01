$ErrorActionPreference = "Stop"
$projectDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoDirectory = Split-Path -Parent $projectDirectory
$localDataDirectory = Join-Path $repoDirectory "server-data\from-server"
$localNotesFile = Join-Path $localDataDirectory "notes.json"
Set-Location -LiteralPath $projectDirectory

if (-not (Test-Path -LiteralPath $localNotesFile -PathType Leaf)) {
  throw "Local server data was not found. Run PULL-SERVER-DATA.cmd before starting the website."
}

$env:BOARD_DATA_DIR = $localDataDirectory
$env:HOST = "127.0.0.1"
$env:PORT = "8787"

$localSettingsFile = Join-Path $projectDirectory "data\settings.json"
$localSettings = $null
if (Test-Path -LiteralPath $localSettingsFile -PathType Leaf) {
  $localSettings = Get-Content -LiteralPath $localSettingsFile -Raw -Encoding UTF8 | ConvertFrom-Json
}
if (-not $env:OWNER_PASSWORD -and $localSettings -and $localSettings.ownerPassword) {
  $env:OWNER_PASSWORD = [string]$localSettings.ownerPassword
}
if (-not $env:SITE_USERNAME -and $localSettings -and $localSettings.siteUsername) {
  $env:SITE_USERNAME = [string]$localSettings.siteUsername
}
if (-not $env:SITE_PASSWORD -and $localSettings -and $localSettings.sitePassword) {
  $env:SITE_PASSWORD = [string]$localSettings.sitePassword
}

if (-not $env:OWNER_PASSWORD) {
  throw "Set OWNER_PASSWORD in PowerShell before starting the local website."
}

& (Join-Path $projectDirectory "install-3d.ps1")

Write-Host "Starting 圆圆和QE的星空小铺 locally..."
Write-Host "Local URL: http://localhost:8787"
Write-Host "Local data: $localDataDirectory"
Write-Host "Close this window to stop the server."
node .\server.js
