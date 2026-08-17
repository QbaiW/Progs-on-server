$ErrorActionPreference = "Stop"
$projectDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $projectDirectory

& (Join-Path $projectDirectory "install-3d.ps1")

Write-Host "Starting Shared Board..."
Write-Host "Local URL: http://localhost:8787"
Write-Host "Close this window to stop the server."
node .\server.js
