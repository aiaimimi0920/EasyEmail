param(
    [string]$ExecutablePath = (Join-Path $PSScriptRoot '../src-tauri/target/release/easyemailam.exe'),
    [string]$CoreDirectory = (Join-Path $PSScriptRoot '../src-tauri/resources/core'),
    [int]$StartupTimeoutSeconds = 55
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'lib/desktop-credential-smoke-support.ps1')

function Invoke-DesktopHostLifecycle {
    param([Parameter(Mandatory = $true)][string]$Executable)

    $proc = Start-Process -FilePath $Executable -PassThru -WindowStyle Hidden
    $deadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
    $childPid = $null
    $corePort = $null
    $brokerPort = $null
    try {
        do {
            Start-Sleep -Milliseconds 250
            $proc.Refresh()
            if ($proc.HasExited) {
                throw "Desktop binary exited during startup with code $($proc.ExitCode)."
            }
            $child = Get-CimInstance Win32_Process -Filter "ParentProcessId=$($proc.Id)" -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -ieq 'node.exe' } |
                Select-Object -First 1
            if ($child) {
                $childPid = [int]$child.ProcessId
                $listener = Get-NetTCPConnection -OwningProcess $childPid -State Listen -ErrorAction SilentlyContinue |
                    Where-Object { $_.LocalAddress -eq '127.0.0.1' } |
                    Select-Object -First 1
                if ($listener) { $corePort = [int]$listener.LocalPort }
            }
            $broker = Get-NetTCPConnection -OwningProcess $proc.Id -State Listen -ErrorAction SilentlyContinue |
                Where-Object { $_.LocalAddress -eq '127.0.0.1' } |
                Select-Object -First 1
            if ($broker) { $brokerPort = [int]$broker.LocalPort }
            if ($corePort -and $brokerPort) { break }
        } while ((Get-Date) -lt $deadline)

        if (-not $childPid -or -not $corePort -or -not $brokerPort) {
            throw 'Desktop binary did not reach core + credential-broker loopback readiness.'
        }

        if (-not (Request-EasyEmailDesktopClose -Process $proc)) {
            throw 'Desktop main window did not accept a normal close request.'
        }
        if (-not $proc.WaitForExit(10000)) {
            throw 'Desktop binary did not exit within 10 seconds after normal close.'
        }

        $reaped = $false
        $reapDeadline = (Get-Date).AddSeconds(5)
        do {
            if (-not (Get-Process -Id $childPid -ErrorAction SilentlyContinue)) {
                $reaped = $true
                break
            }
            Start-Sleep -Milliseconds 150
        } while ((Get-Date) -lt $reapDeadline)
        if (-not $reaped) {
            throw 'Bundled core child remained alive after normal UI close.'
        }
    } finally {
        if (-not $proc.HasExited) {
            Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        }
        if ($childPid) {
            Stop-Process -Id $childPid -Force -ErrorAction SilentlyContinue
        }
    }
}

function Save-DesktopPreUpgradeBackup {
    param(
        [Parameter(Mandatory = $true)][string]$PreviousInstallDir,
        [Parameter(Mandatory = $true)][string]$DataDir,
        [Parameter(Mandatory = $true)][string]$BackupDir
    )

    New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null
    Copy-Item -LiteralPath $PreviousInstallDir -Destination (Join-Path $BackupDir 'previous-app') -Recurse -Force
    $dataBackup = Join-Path $BackupDir 'pre-upgrade-data'
    New-Item -ItemType Directory -Path $dataBackup -Force | Out-Null
    if (Test-Path -LiteralPath (Join-Path $DataDir 'desktop-host-id')) {
        Copy-Item -LiteralPath (Join-Path $DataDir 'desktop-host-id') -Destination $dataBackup -Force
    }
    if (Test-Path -LiteralPath (Join-Path $DataDir 'core/state')) {
        New-Item -ItemType Directory -Path (Join-Path $dataBackup 'core') -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $DataDir 'core/state') -Destination (Join-Path $dataBackup 'core/state') -Recurse -Force
    }
}

function Restore-DesktopPreUpgradeBackup {
    param(
        [Parameter(Mandatory = $true)][string]$TargetInstallDir,
        [Parameter(Mandatory = $true)][string]$DataDir,
        [Parameter(Mandatory = $true)][string]$BackupDir
    )

    if (Test-Path -LiteralPath $TargetInstallDir) {
        Remove-Item -LiteralPath $TargetInstallDir -Recurse -Force
    }
    Copy-Item -LiteralPath (Join-Path $BackupDir 'previous-app') -Destination $TargetInstallDir -Recurse -Force

    if (Test-Path -LiteralPath (Join-Path $DataDir 'core/state')) {
        Remove-Item -LiteralPath (Join-Path $DataDir 'core/state') -Recurse -Force
    }
    Copy-Item -LiteralPath (Join-Path $BackupDir 'pre-upgrade-data/desktop-host-id') `
        -Destination (Join-Path $DataDir 'desktop-host-id') -Force
    New-Item -ItemType Directory -Path (Join-Path $DataDir 'core') -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $BackupDir 'pre-upgrade-data/core/state') `
        -Destination (Join-Path $DataDir 'core/state') -Recurse -Force
}

$sourceExe = [System.IO.Path]::GetFullPath($ExecutablePath)
$sourceCore = [System.IO.Path]::GetFullPath($CoreDirectory)
if (-not (Test-Path -LiteralPath $sourceExe -PathType Leaf)) {
    throw "Desktop executable is missing for upgrade smoke: $sourceExe"
}
if (-not (Test-Path -LiteralPath (Join-Path $sourceCore 'node.exe') -PathType Leaf)) {
    throw "Bundled core/node.exe is missing for upgrade smoke: $sourceCore"
}
$nodeExe = Join-Path $sourceCore 'node.exe'
$fixtureScript = Join-Path $PSScriptRoot 'seed-desktop-upgrade-fixture.mjs'

$drillRoot = [System.IO.Path]::GetFullPath((Join-Path ([System.IO.Path]::GetTempPath()) 'easyemail-desktop-upgrade-drill'))
$runRoot = Join-Path $drillRoot ([Guid]::NewGuid().ToString('N'))
$prevInstallDir = Join-Path $runRoot 'app-v-previous'
$candidateInstallDir = Join-Path $runRoot 'app-v-candidate'
$backupDir = Join-Path $runRoot 'rollback-backup'
$dataDir = Join-Path $runRoot 'user-data'

$imapRefKey = 'ref:v1:desktop/' + ([Guid]::NewGuid().ToString('N'))
$smtpRefKey = 'ref:v1:desktop/' + ([Guid]::NewGuid().ToString('N'))
$imapCanarySecret = 'upgrade-imap-canary-' + ([Guid]::NewGuid().ToString('N'))
$smtpCanarySecret = 'upgrade-smtp-canary-' + ([Guid]::NewGuid().ToString('N'))
$previousDataDirEnv = $env:EASYEMAILAM_DATA_DIR

try {
    foreach ($dir in @($prevInstallDir, $candidateInstallDir, $dataDir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    foreach ($installTarget in @($prevInstallDir, $candidateInstallDir)) {
        Copy-Item -LiteralPath $sourceExe -Destination (Join-Path $installTarget 'EasyEmail.exe') -Force
        Copy-Item -LiteralPath $sourceCore -Destination (Join-Path $installTarget 'core') -Recurse -Force
    }

    Set-EasyEmailSmokeVaultSecret -SecretKey $imapRefKey -SecretValue $imapCanarySecret
    Set-EasyEmailSmokeVaultSecret -SecretKey $smtpRefKey -SecretValue $smtpCanarySecret

    & $nodeExe $fixtureScript --mode seed --data-dir $dataDir `
        --imap-secret-key $imapRefKey --smtp-secret-key $smtpRefKey
    if ($LASTEXITCODE -ne 0) {
        throw 'Failed to seed pre-upgrade desktop user data fixture.'
    }
    $seededHostId = (Get-Content -LiteralPath (Join-Path $dataDir 'desktop-host-id') -Raw).Trim()

    Save-DesktopPreUpgradeBackup -PreviousInstallDir $prevInstallDir -DataDir $dataDir -BackupDir $backupDir

    # Phase 1: Candidate Upgrade Verification
    $env:EASYEMAILAM_DATA_DIR = $dataDir
    Invoke-DesktopHostLifecycle -Executable (Join-Path $candidateInstallDir 'EasyEmail.exe')

    $upgradedHostId = (Get-Content -LiteralPath (Join-Path $dataDir 'desktop-host-id') -Raw).Trim()
    if ($upgradedHostId -ne $seededHostId) {
        throw 'Desktop host ID mutated during candidate upgrade.'
    }
    if (-not (Test-EasyEmailSmokeVaultSecret -SecretKey $imapRefKey) -or
        -not (Test-EasyEmailSmokeVaultSecret -SecretKey $smtpRefKey)) {
        throw 'OS Credential Manager secrets were lost during candidate upgrade.'
    }

    & $nodeExe $fixtureScript --mode verify --data-dir $dataDir `
        --imap-secret-key $imapRefKey --smtp-secret-key $smtpRefKey
    if ($LASTEXITCODE -ne 0) {
        throw 'Post-upgrade semantic readback verification failed.'
    }
    Write-Output 'UPGRADE_HOST_ID_PRESERVED=True'
    Write-Output 'UPGRADE_DATA_PRESERVED=True'
    Write-Output 'UPGRADE_CREDENTIAL_REF_PRESERVED=True'
    Write-Output 'UPGRADE_QUEUE_AND_SETTINGS_PRESERVED=True'

    # Phase 2: Simulated Failed Upgrade + Full Binary & Data Rollback Drill
    [System.IO.File]::WriteAllBytes((Join-Path $candidateInstallDir 'EasyEmail.exe'), [byte[]](0, 1, 2, 3))
    Set-Content -LiteralPath (Join-Path $dataDir 'core/state/easy-email-state.json') -Value '{corrupt' -Encoding UTF8

    Restore-DesktopPreUpgradeBackup -TargetInstallDir $candidateInstallDir -DataDir $dataDir -BackupDir $backupDir
    Invoke-DesktopHostLifecycle -Executable (Join-Path $candidateInstallDir 'EasyEmail.exe')

    & $nodeExe $fixtureScript --mode verify --data-dir $dataDir `
        --imap-secret-key $imapRefKey --smtp-secret-key $smtpRefKey
    if ($LASTEXITCODE -ne 0) {
        throw 'Post-rollback semantic readback verification failed.'
    }
    if (-not (Test-EasyEmailSmokeVaultSecret -SecretKey $imapRefKey) -or
        -not (Test-EasyEmailSmokeVaultSecret -SecretKey $smtpRefKey)) {
        throw 'OS Credential Manager secrets did not survive rollback.'
    }
    Assert-ZeroCanarySecretMatches -RootDirectory $dataDir -CanarySecrets @($imapCanarySecret, $smtpCanarySecret)
    Write-Output 'ROLLBACK_BINARY_AND_DATA_RESTORED=True'
    Write-Output 'UPGRADE_CANARY_ZERO_MATCHES=True'
} finally {
    Remove-EasyEmailSmokeVaultSecret -SecretKey $imapRefKey
    Remove-EasyEmailSmokeVaultSecret -SecretKey $smtpRefKey
    Stop-IsolatedEasyEmailWebViewProcesses -WebViewDirectory (Join-Path $dataDir 'webview2')
    if ($null -eq $previousDataDirEnv) {
        Remove-Item Env:EASYEMAILAM_DATA_DIR -ErrorAction SilentlyContinue
    } else {
        $env:EASYEMAILAM_DATA_DIR = $previousDataDirEnv
    }
    if (Test-Path -LiteralPath $runRoot) {
        $resolvedRun = [System.IO.Path]::GetFullPath($runRoot)
        if ($resolvedRun.StartsWith($drillRoot + [System.IO.Path]::DirectorySeparatorChar)) {
            Remove-Item -LiteralPath $resolvedRun -Recurse -Force
        }
    }
}
