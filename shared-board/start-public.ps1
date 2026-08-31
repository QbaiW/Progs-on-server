$ErrorActionPreference = "Stop"
$projectDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$tunnelProgram = Join-Path $projectDirectory "cloudflared.exe"
$serverLog = Join-Path $projectDirectory "server.log"
$serverErrorLog = Join-Path $projectDirectory "server-error.log"
$tunnelRunId = Get-Date -Format "yyyyMMdd-HHmmss-fff"
$tunnelLog = Join-Path $projectDirectory "tunnel-$tunnelRunId.log"
$tunnelErrorLog = Join-Path $projectDirectory "tunnel-error-$tunnelRunId.log"
$dependencyInstaller = Join-Path $projectDirectory "install-3d.ps1"

function Save-ProcessId {
  param(
    [string]$Path,
    [int]$StartedId
  )

  try {
    Set-Content -LiteralPath $Path -Value $StartedId -Force -ErrorAction Stop
  } catch {
    Write-Warning "The process started, but its PID file could not be updated: $Path"
  }
}

if (-not (Test-Path -LiteralPath $tunnelProgram)) {
  throw "cloudflared.exe is missing. Public access cannot be started."
}

& $dependencyInstaller

Write-Host "Starting the website server..."

$serverIsReady = $false
try {
  $response = Invoke-WebRequest -Uri "http://127.0.0.1:8787/api/health" -UseBasicParsing -TimeoutSec 1
  $serverIsReady = $response.StatusCode -eq 200
} catch {
  $serverIsReady = $false
}

if (-not $serverIsReady) {
  $serverProcess = Start-Process -FilePath "node" -ArgumentList ".\server.js" -WorkingDirectory $projectDirectory -WindowStyle Hidden -RedirectStandardOutput $serverLog -RedirectStandardError $serverErrorLog -PassThru
  Save-ProcessId -Path (Join-Path $projectDirectory "server.pid") -StartedId $serverProcess.Id

  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    Start-Sleep -Milliseconds 250

    if ($serverProcess.HasExited) {
      $serverFailure = ""
      if (Test-Path -LiteralPath $serverErrorLog) {
        $serverFailure = Get-Content -Raw -LiteralPath $serverErrorLog
      }
      throw "The website server exited during startup.`n$serverFailure"
    }

    try {
      $response = Invoke-WebRequest -Uri "http://127.0.0.1:8787/api/health" -UseBasicParsing -TimeoutSec 1
      if ($response.StatusCode -eq 200) {
        $serverIsReady = $true
        break
      }
    } catch {
      $serverIsReady = $false
    }
  }
}

if (-not $serverIsReady) {
  throw "The website server did not start. Check server-error.log."
}

Write-Host "Website server is ready."

$tunnelProcess = Start-Process -FilePath $tunnelProgram -ArgumentList "tunnel", "--url", "http://localhost:8787", "--no-autoupdate" -WorkingDirectory $projectDirectory -WindowStyle Hidden -RedirectStandardOutput $tunnelLog -RedirectStandardError $tunnelErrorLog -PassThru
Save-ProcessId -Path (Join-Path $projectDirectory "tunnel.pid") -StartedId $tunnelProcess.Id

Write-Host "Requesting a public URL. Please wait..."
for ($attempt = 0; $attempt -lt 30; $attempt++) {
  Start-Sleep -Milliseconds 500

  if ($tunnelProcess.HasExited) {
    $tunnelFailure = ""
    if (Test-Path -LiteralPath $tunnelErrorLog) {
      $tunnelFailure = Get-Content -Raw -LiteralPath $tunnelErrorLog
    }
    throw "The public tunnel exited during startup.`n$tunnelFailure"
  }

  $logText = ""
  if (Test-Path -LiteralPath $tunnelLog) { $logText += Get-Content -Raw -LiteralPath $tunnelLog }
  if (Test-Path -LiteralPath $tunnelErrorLog) { $logText += Get-Content -Raw -LiteralPath $tunnelErrorLog }
  $match = [regex]::Match($logText, "https://[a-z0-9-]+\.trycloudflare\.com")
  if ($match.Success) {
    try {
      Set-Content -LiteralPath (Join-Path $projectDirectory "public-url.txt") -Value $match.Value -Force -ErrorAction Stop
    } catch {
      Write-Warning "The public URL could not be saved to public-url.txt."
    }
    Write-Host "Public URL: $($match.Value)"
    Write-Host "Share this URL with other computers."
    Write-Host "Run STOP.cmd to stop the website."
    exit 0
  }
}

throw "A public URL was not created. Check $tunnelErrorLog."
