[CmdletBinding()]
param(
    [ValidateSet("Menu", "Pull", "Push")]
    [string]$Action = "Menu",
    [string]$Server = "root@47.108.215.236",
    [int]$Port = 22,
    [string]$RemoteDataDir = "/var/lib/qe-star-bottle/data",
    [string]$RemoteBackupDir = "/var/backups/qe-star-bottle",
    [string]$IdentityFile = "",
    [string]$LocalDataDir = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0

$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $IdentityFile) {
    $IdentityFile = Join-Path $HOME ".ssh\qe-star-data"
}
if (-not $LocalDataDir) {
    $LocalDataDir = Join-Path $repoRoot "server-data\from-server"
}

$requiredDataNames = @(
    "notes.json",
    "favorites.json",
    "activity.json",
    "owner-devices.json"
)
$optionalDataNames = @(
    "love-stars-messages.json",
    "wrong-counter.json",
    "wrong-bubbles.json",
    "portal-settings.json",
    "portal-activity.json",
    "envelopes.json"
)
$dataNames = @($requiredDataNames + $optionalDataNames)

function Fail([string]$Message) {
    throw $Message
}

function Assert-Configuration {
    if (-not (Test-Path -LiteralPath $IdentityFile -PathType Leaf)) {
        Fail "SSH key was not found: $IdentityFile"
    }
    if ($Server -notmatch '^[A-Za-z0-9_.-]+@[A-Za-z0-9_.:-]+$') {
        Fail "Invalid server value: $Server"
    }
    if ($RemoteDataDir -notmatch '^/[A-Za-z0-9._/-]+$' -or $RemoteDataDir.Contains("..")) {
        Fail "Invalid remote data directory: $RemoteDataDir"
    }
    if ($RemoteBackupDir -notmatch '^/[A-Za-z0-9._/-]+$' -or $RemoteBackupDir.Contains("..")) {
        Fail "Invalid remote backup directory: $RemoteBackupDir"
    }
    if (-not (Get-Command ssh.exe -ErrorAction SilentlyContinue)) {
        Fail "ssh.exe was not found. Install OpenSSH Client in Windows."
    }
    if (-not (Get-Command scp.exe -ErrorAction SilentlyContinue)) {
        Fail "scp.exe was not found. Install OpenSSH Client in Windows."
    }
}

function Invoke-Ssh([string]$RemoteCommand) {
    & ssh.exe -p $Port -i $IdentityFile -o BatchMode=yes -o ConnectTimeout=15 $Server $RemoteCommand
    if ($LASTEXITCODE -ne 0) {
        Fail "SSH command failed with exit code $LASTEXITCODE"
    }
}

function Invoke-Scp([string]$Source, [string]$Destination) {
    & scp.exe -q -P $Port -i $IdentityFile -o BatchMode=yes -o ConnectTimeout=15 $Source $Destination
    if ($LASTEXITCODE -ne 0) {
        Fail "SCP command failed with exit code $LASTEXITCODE"
    }
}

function Get-Stamp {
    return (Get-Date).ToUniversalTime().ToString("yyyyMMdd-HHmmss")
}

function Test-JsonFile([string]$Path, [string]$Name) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        Fail "Missing ${Name}: $Path"
    }

    try {
        # JSON files are UTF-8; Windows PowerShell otherwise uses the system code page.
        $document = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
        Fail "Invalid JSON in ${Name}: $($_.Exception.Message)"
    }

    if ($null -eq $document) {
        Fail "$Name is empty"
    }

    $requiredProperty = switch ($Name) {
        "notes.json" { "notes" }
        "favorites.json" { "noteIds" }
        "activity.json" { "entries" }
        "owner-devices.json" { "devices" }
        "love-stars-messages.json" { "messages" }
        "wrong-counter.json" { "visitors" }
        "wrong-bubbles.json" { "phrases" }
        "portal-settings.json" { "features" }
        "portal-activity.json" { "entries" }
        "envelopes.json" { "memos" }
    }
    if (-not ($document.PSObject.Properties.Name -contains $requiredProperty)) {
        Fail "$Name is missing the '$requiredProperty' property"
    }
}

function Test-DataDirectory([string]$Directory) {
    foreach ($name in $requiredDataNames) {
        Test-JsonFile (Join-Path $Directory $name) $name
    }
    foreach ($name in $optionalDataNames) {
        $candidate = Join-Path $Directory $name
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            Test-JsonFile $candidate $name
        }
    }
}

function New-Directory([string]$Path) {
    New-Item -ItemType Directory -Force -Path $Path | Out-Null
}

function Pull-Data {
    New-Directory (Split-Path -Parent $LocalDataDir)
    $stamp = Get-Stamp
    $runId = [guid]::NewGuid().ToString("N")
    $staging = Join-Path (Split-Path -Parent $LocalDataDir) (".pull-" + $stamp + "-" + [guid]::NewGuid().ToString("N"))
    $backup = Join-Path (Join-Path (Split-Path -Parent $LocalDataDir) "backups") ("pull-" + $stamp + "-" + $runId.Substring(0, 8))
    $remoteSnapshot = "/tmp/qe-star-data-$stamp-$runId"

    New-Directory $staging
    try {
        Write-Host "Creating a server snapshot..."
        $snapshotParts = @(
            "set -eu",
            "mkdir -m 700 -p $remoteSnapshot",
            ": > $remoteSnapshot/data-manifest.txt"
        )
        foreach ($name in $requiredDataNames) {
            $snapshotParts += "cp -p $RemoteDataDir/$name $remoteSnapshot/$name"
            $snapshotParts += "printf '%s\n' '$name' >> $remoteSnapshot/data-manifest.txt"
        }
        foreach ($name in $optionalDataNames) {
            $snapshotParts += "if [ -f $RemoteDataDir/$name ]; then cp -p $RemoteDataDir/$name $remoteSnapshot/$name; printf '%s\n' '$name' >> $remoteSnapshot/data-manifest.txt; fi"
        }
        Invoke-Ssh ($snapshotParts -join "; ")

        $localManifest = Join-Path $staging "data-manifest.txt"
        Invoke-Scp ("{0}:{1}/data-manifest.txt" -f $Server.TrimEnd(":"), $remoteSnapshot) $localManifest
        $downloadNames = @(
            Get-Content -LiteralPath $localManifest -Encoding UTF8 |
                Where-Object { $dataNames -contains $_ }
        )
        foreach ($name in $requiredDataNames) {
            if ($downloadNames -notcontains $name) {
                Fail "Server snapshot is missing required data file: $name"
            }
        }
        foreach ($name in $downloadNames) {
            Write-Host "Downloading $name..."
            Invoke-Scp ("{0}:{1}/{2}" -f $Server.TrimEnd(":"), $remoteSnapshot, $name) (Join-Path $staging $name)
        }
        Remove-Item -LiteralPath $localManifest -Force

        Test-DataDirectory $staging

        if (Test-Path -LiteralPath $LocalDataDir) {
            New-Directory (Split-Path -Parent $backup)
            Move-Item -LiteralPath $LocalDataDir -Destination $backup
        }
        Move-Item -LiteralPath $staging -Destination $LocalDataDir
        Write-Host "Pull complete. Local data: $LocalDataDir" -ForegroundColor Green
        if (Test-Path -LiteralPath $backup) {
            Write-Host "Previous local data backup: $backup"
        }
    } finally {
        try {
            Invoke-Ssh "rm -rf $remoteSnapshot" | Out-Null
        } catch {
            Write-Warning "Could not remove temporary server snapshot: $remoteSnapshot"
        }
        if (Test-Path -LiteralPath $staging) {
            Remove-Item -LiteralPath $staging -Recurse -Force
        }
    }
}

function Push-Data {
    Test-DataDirectory $LocalDataDir
    $uploadNames = @(
        $dataNames | Where-Object { Test-Path -LiteralPath (Join-Path $LocalDataDir $_) -PathType Leaf }
    )
    $stamp = Get-Stamp
    $runId = [guid]::NewGuid().ToString("N")
    $localBackup = Join-Path (Join-Path (Split-Path -Parent $LocalDataDir) "backups") ("before-push-" + $stamp + "-" + $runId.Substring(0, 8))
    $remoteBackup = "$RemoteBackupDir/data-$stamp-$($runId.Substring(0, 8))"
    $remoteStage = "$RemoteDataDir/.push-$stamp-$runId"

    Write-Host "Source data: $LocalDataDir"
    Write-Host "This will replace $($uploadNames.Count) runtime JSON files on the server."
    $answer = Read-Host "Type UPLOAD to continue"
    if ($answer -cne "UPLOAD") {
        Write-Host "Upload cancelled."
        return
    }

    New-Directory (Split-Path -Parent $localBackup)
    Copy-Item -LiteralPath $LocalDataDir -Destination $localBackup -Recurse -Force

    $prepareParts = @(
        "set -eu",
        "mkdir -m 700 -p $remoteBackup $remoteStage"
    )
    foreach ($name in $uploadNames) {
        $prepareParts += "if [ -f $RemoteDataDir/$name ]; then cp -p $RemoteDataDir/$name $remoteBackup/$name; fi"
    }
    Invoke-Ssh ($prepareParts -join "; ")

    try {
        foreach ($name in $uploadNames) {
            Write-Host "Uploading $name..."
            Invoke-Scp (Join-Path $LocalDataDir $name) ("{0}:{1}/{2}" -f $Server.TrimEnd(":"), $remoteStage, $name)
        }

        $remoteFiles = ($uploadNames | ForEach-Object { "$remoteStage/$_" }) -join " "
        # Windows OpenSSH can strip embedded quotes from a remote `node -e`
        # command. Pipe a base64-encoded validator through node instead.
        $nodeCode = 'const fs=require("fs"); for (const f of process.argv.slice(2)) JSON.parse(fs.readFileSync(f,"utf8"));'
        $nodeCodeBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($nodeCode))
        $validateCommand = "printf %s $nodeCodeBase64 | base64 -d | node - $remoteFiles"
        Write-Host "Validating the server upload..."
        Invoke-Ssh $validateCommand

        $finishParts = @(
            'set -eu',
            'stopped=0',
            'restore_app() { if [ "$stopped" -eq 1 ]; then pm2 restart qe-star-bottle --update-env >/dev/null 2>&1 || true; fi; }',
            'trap restore_app EXIT',
            'pm2 stop qe-star-bottle >/dev/null 2>&1 || true',
            'stopped=1'
        )
        foreach ($name in $uploadNames) {
            $finishParts += "mv -f $remoteStage/$name $RemoteDataDir/$name"
            $finishParts += "chmod 600 $RemoteDataDir/$name"
        }
        $finishParts += "rmdir $remoteStage"
        $finishParts += 'pm2 restart qe-star-bottle --update-env'
        $finishParts += 'stopped=0'
        # PM2 returns before the Node process has bound its port. Retry the
        # health check so a normal startup race is not reported as a failed push.
        $finishParts += 'healthy=0'
        $finishParts += 'attempt=0'
        $finishParts += 'while [ "$attempt" -lt 20 ]; do if curl --fail --silent --max-time 15 http://127.0.0.1:8787/api/health >/dev/null; then healthy=1; break; fi; attempt=$((attempt + 1)); sleep 1; done'
        $finishParts += 'if [ "$healthy" -ne 1 ]; then echo "Health check failed after restart" >&2; exit 1; fi'
        $finishParts += 'curl --fail --silent --show-error --max-time 15 http://127.0.0.1:8787/api/health'
        Write-Host "Replacing server data and restarting the app..."
        Invoke-Ssh ($finishParts -join "; ")

        Write-Host "Push complete." -ForegroundColor Green
        Write-Host "Server backup: $remoteBackup"
        Write-Host "Local source backup: $localBackup"
    } finally {
        try {
            Invoke-Ssh "rm -rf $remoteStage" | Out-Null
        } catch {
            Write-Warning "Could not remove temporary server upload directory: $remoteStage"
        }
    }
}

function Show-Menu {
    while ($true) {
        Write-Host ""
        Write-Host "圆圆和QE的星空小铺 - data transfer"
        Write-Host "Local folder: $LocalDataDir"
        Write-Host "[1] Pull server data to local"
        Write-Host "[2] Push local data to server"
        Write-Host "[3] Open local data folder"
        Write-Host "[Q] Exit"
        $choice = (Read-Host "Select").Trim().ToUpperInvariant()
        try {
            switch ($choice) {
                "1" { Pull-Data }
                "2" { Push-Data }
                "3" {
                    New-Directory $LocalDataDir
                    $resolved = (Resolve-Path -LiteralPath $LocalDataDir).Path
                    Start-Process explorer.exe -ArgumentList $resolved
                }
                "Q" { return }
                default { Write-Host "Please choose 1, 2, 3, or Q." }
            }
        } catch {
            Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
        }
    }
}

try {
    Assert-Configuration
    switch ($Action) {
        "Pull" { Pull-Data }
        "Push" { Push-Data }
        default { Show-Menu }
    }
} catch {
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
