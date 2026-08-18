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

if (-not $env:OWNER_PASSWORD) {
  $localSettingsFile = Join-Path $projectDirectory "data\settings.json"
  if (Test-Path -LiteralPath $localSettingsFile -PathType Leaf) {
    $localSettings = Get-Content -LiteralPath $localSettingsFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($localSettings.ownerPassword) {
      $env:OWNER_PASSWORD = [string]$localSettings.ownerPassword
    }
  }
}

if (-not $env:OWNER_PASSWORD) {
  throw "Set OWNER_PASSWORD in PowerShell before starting the local website."
}

& (Join-Path $projectDirectory "install-3d.ps1")

Write-Host "Starting QE Star Bottle locally..."
Write-Host "Local URL: http://localhost:8787"
Write-Host "Local data: $localDataDirectory"
Write-Host "Close this window to stop the server."
node .\server.js
