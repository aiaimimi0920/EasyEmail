param(
    [string]$ExecutablePath = (Join-Path $PSScriptRoot '../src-tauri/target/release/easyemailam.exe'),
    [string]$CoreDirectory = (Join-Path $PSScriptRoot '../src-tauri/resources/core'),
    [int]$StartupTimeoutSeconds = 55
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'lib/desktop-credential-smoke-support.ps1')

function Set-InstallTreeReadOnly {
    param(
        [Parameter(Mandatory = $true)][string]$InstallRoot,
        [Parameter(Mandatory = $true)][string]$Identity
    )

    Get-ChildItem -LiteralPath $InstallRoot -Recurse -File | ForEach-Object {
        $_.IsReadOnly = $true
    }
    $null = & icacls $InstallRoot /inheritance:r /grant:r "${Identity}:(OI)(CI)(RX)" "SYSTEM:(OI)(CI)(F)"
    if ($LASTEXITCODE -ne 0) {
        throw 'Could not apply Program-Files-equivalent read-and-execute ACL to simulated installation directory.'
    }
}

function Clear-InstallTreeReadOnly {
    param(
        [Parameter(Mandatory = $true)][string]$InstallRoot,
        [Parameter(Mandatory = $true)][string]$Identity
    )

    if (-not (Test-Path -LiteralPath $InstallRoot)) {
        return
    }
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $null = & icacls $InstallRoot /grant:r "${Identity}:(OI)(CI)(F)" /T /C
    } finally {
        $ErrorActionPreference = $prevEap
    }
    Get-ChildItem -LiteralPath $InstallRoot -Recurse -File -Force -ErrorAction SilentlyContinue | ForEach-Object {
        $_.IsReadOnly = $false
    }
}

$sourceExe = [System.IO.Path]::GetFullPath($ExecutablePath)
$sourceCore = [System.IO.Path]::GetFullPath($CoreDirectory)
if (-not (Test-Path -LiteralPath $sourceExe -PathType Leaf)) {
    throw "Desktop executable is missing for clean-install smoke: $sourceExe"
}
if (-not (Test-Path -LiteralPath (Join-Path $sourceCore 'node.exe') -PathType Leaf)) {
    throw "Bundled core/node.exe is missing for clean-install smoke: $sourceCore"
}

$smokeRoot = [System.IO.Path]::GetFullPath((Join-Path ([System.IO.Path]::GetTempPath()) 'easyemail-clean-install-smoke'))
$runRoot = Join-Path $smokeRoot ([Guid]::NewGuid().ToString('N'))
$installDir = Join-Path $runRoot 'ProgramFiles-NMail'
$appDataDir = Join-Path $runRoot 'LocalAppData-NMail'
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

$previousPath = $env:PATH
$previousDataDir = $env:EASYEMAILAM_DATA_DIR
$desktopProc = $null
$corePid = $null

try {
    New-Item -ItemType Directory -Path $installDir -Force | Out-Null
    New-Item -ItemType Directory -Path $appDataDir -Force | Out-Null
    Copy-Item -LiteralPath $sourceExe -Destination (Join-Path $installDir 'EasyEmail.exe') -Force
    Copy-Item -LiteralPath $sourceCore -Destination (Join-Path $installDir 'core') -Recurse -Force

    $filesBefore = @(
        Get-ChildItem -LiteralPath $installDir -Recurse -File |
            Sort-Object FullName |
            ForEach-Object { "$($_.FullName.Substring($installDir.Length)):$($_.Length)" }
    )

    Set-InstallTreeReadOnly -InstallRoot $installDir -Identity $currentUser

    # Verify write to installDir actually fails closed under current user privileges
    $writeBlocked = $false
    try {
        [System.IO.File]::WriteAllText((Join-Path $installDir 'forbidden-write.tmp'), 'nope')
    } catch {
        $writeBlocked = $true
    }
    if (-not $writeBlocked) {
        throw 'Read-only installation directory unexpectedly permitted file creation.'
    }

    # Strip external Node.js, npm, Cargo, and Docker from PATH to simulate a clean Windows machine
    $cleanSystemPath = @(
        (Join-Path $env:SystemRoot 'System32'),
        $env:SystemRoot,
        (Join-Path $env:SystemRoot 'System32\Wbem'),
        (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0')
    ) -join ';'
    $env:PATH = $cleanSystemPath
    if ((Get-Command node -ErrorAction SilentlyContinue) -or (Get-Command docker -ErrorAction SilentlyContinue)) {
        throw 'Clean PATH unexpectedly still resolved external node or docker.'
    }
    Write-Output 'EXTERNAL_NODE_ABSENT=True'
    Write-Output 'DOCKER_ABSENT=True'
    Write-Output 'READONLY_INSTALL_DIR_ENFORCED=True'

    $env:EASYEMAILAM_DATA_DIR = $appDataDir
    $installedExe = Join-Path $installDir 'EasyEmail.exe'
    $desktopProc = Start-Process -FilePath $installedExe -WorkingDirectory $installDir -PassThru -WindowStyle Hidden

    $deadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
    $corePort = $null
    $brokerPort = $null
    do {
        Start-Sleep -Milliseconds 250
        $desktopProc.Refresh()
        if ($desktopProc.HasExited) {
            throw "Installed desktop exited prematurely with code $($desktopProc.ExitCode)."
        }
        $child = Get-CimInstance Win32_Process -Filter "ParentProcessId=$($desktopProc.Id)" -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -ieq 'node.exe' } |
            Select-Object -First 1
        if ($child) {
            $corePid = [int]$child.ProcessId
            $listener = Get-NetTCPConnection -OwningProcess $corePid -State Listen -ErrorAction SilentlyContinue |
                Where-Object { $_.LocalAddress -eq '127.0.0.1' } |
                Select-Object -First 1
            if ($listener) { $corePort = [int]$listener.LocalPort }
        }
        $broker = Get-NetTCPConnection -OwningProcess $desktopProc.Id -State Listen -ErrorAction SilentlyContinue |
            Where-Object { $_.LocalAddress -eq '127.0.0.1' } |
            Select-Object -First 1
        if ($broker) { $brokerPort = [int]$broker.LocalPort }
        if ($corePort -and $brokerPort) { break }
    } while ((Get-Date) -lt $deadline)

    if (-not $corePid -or -not $corePort -or -not $brokerPort) {
        throw 'Installed desktop did not reach loopback readiness from read-only install directory without external Node/Docker.'
    }

    if (-not (Request-EasyEmailDesktopClose -Process $desktopProc)) {
        throw 'Installed desktop did not accept a normal close request.'
    }
    if (-not $desktopProc.WaitForExit(10000)) {
        throw 'Installed desktop did not exit within 10 seconds.'
    }
    $desktopProc = $null

    $reaped = $false
    $reapDeadline = (Get-Date).AddSeconds(5)
    do {
        if (-not (Get-Process -Id $corePid -ErrorAction SilentlyContinue)) {
            $reaped = $true
            break
        }
        Start-Sleep -Milliseconds 150
    } while ((Get-Date) -lt $reapDeadline)
    if (-not $reaped) {
        throw 'Bundled core child remained alive after clean-install UI close.'
    }
    $corePid = $null

    $coreLogPath = Join-Path $appDataDir 'core/logs/core.log'
    $statePath = Join-Path $appDataDir 'core/state/easy-email-state.json'
    if (-not (Test-Path -LiteralPath $coreLogPath -PathType Leaf) -or
        -not (Test-Path -LiteralPath $statePath -PathType Leaf)) {
        throw 'Writable runtime state or logs were not persisted under per-user AppData directory.'
    }
    $logText = Get-Content -LiteralPath $coreLogPath -Raw
    if ($logText -notmatch 'event=core_graceful_stop') {
        throw 'Clean-install desktop close did not complete via graceful shutdown.'
    }

    $filesAfter = @(
        Get-ChildItem -LiteralPath $installDir -Recurse -File |
            Sort-Object FullName |
            ForEach-Object { "$($_.FullName.Substring($installDir.Length)):$($_.Length)" }
    )
    if (($filesBefore -join "`n") -ne ($filesAfter -join "`n")) {
        throw 'Installation directory file inventory changed during runtime execution.'
    }

    Write-Output 'WRITABLE_STATE_IN_APPDATA_ONLY=True'
    Write-Output 'CLEAN_INSTALL_GRACEFUL_CLOSE=True'
} finally {
    $env:PATH = $previousPath
    if ($null -eq $previousDataDir) {
        Remove-Item Env:EASYEMAILAM_DATA_DIR -ErrorAction SilentlyContinue
    } else {
        $env:EASYEMAILAM_DATA_DIR = $previousDataDir
    }
    if ($desktopProc -and -not $desktopProc.HasExited) {
        Stop-Process -Id $desktopProc.Id -Force -ErrorAction SilentlyContinue
    }
    if ($corePid) {
        Stop-Process -Id $corePid -Force -ErrorAction SilentlyContinue
    }
    Stop-IsolatedEasyEmailWebViewProcesses -WebViewDirectory (Join-Path $appDataDir 'webview2')
    Clear-InstallTreeReadOnly -InstallRoot $installDir -Identity $currentUser
    if (Test-Path -LiteralPath $runRoot) {
        $resolvedRun = [System.IO.Path]::GetFullPath($runRoot)
        if ($resolvedRun.StartsWith($smokeRoot + [System.IO.Path]::DirectorySeparatorChar)) {
            Remove-Item -LiteralPath $resolvedRun -Recurse -Force
        }
    }
}
