$ErrorActionPreference = "Stop"
$projectDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path

$processFiles = @(
  @{ File = "tunnel.pid"; Name = "cloudflared" },
  @{ File = "server.pid"; Name = "node" }
)

foreach ($entry in $processFiles) {
  $pidFile = Join-Path $projectDirectory $entry.File
  if (-not (Test-Path -LiteralPath $pidFile)) { continue }

  $savedProcessId = [int](Get-Content -Raw -LiteralPath $pidFile)
  $process = Get-Process -Id $savedProcessId -ErrorAction SilentlyContinue
  if ($process -and $process.ProcessName -eq $entry.Name) {
    Stop-Process -Id $savedProcessId
  }
  Remove-Item -LiteralPath $pidFile -Force
}

Write-Host "Shared Board has stopped."
