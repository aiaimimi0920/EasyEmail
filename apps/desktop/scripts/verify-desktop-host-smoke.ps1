param(
    [string]$ExecutablePath = (Join-Path $PSScriptRoot '../src-tauri/target/debug/easyemailam.exe')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$executable = [System.IO.Path]::GetFullPath($ExecutablePath)
if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
    throw "Desktop executable is missing: $executable"
}

$smokeRoot = [System.IO.Path]::GetFullPath((Join-Path ([System.IO.Path]::GetTempPath()) 'easyemail-desktop-smoke'))
$dataDir = [System.IO.Path]::GetFullPath((Join-Path $smokeRoot ([Guid]::NewGuid().ToString('N'))))
if (-not $dataDir.StartsWith($smokeRoot + [System.IO.Path]::DirectorySeparatorChar)) {
    throw 'The isolated desktop smoke path escaped its dedicated root.'
}
New-Item -ItemType Directory -Path $dataDir -Force | Out-Null

$previousDataDir = $env:EASYEMAILAM_DATA_DIR
$desktopProcess = $null
$corePid = $null
$normalClose = $false
try {
    $env:EASYEMAILAM_DATA_DIR = $dataDir
    $desktopProcess = Start-Process -FilePath $executable -PassThru -WindowStyle Hidden
    $deadline = (Get-Date).AddSeconds(25)
    $corePort = $null

    do {
        Start-Sleep -Milliseconds 250
        $desktopProcess.Refresh()
        if ($desktopProcess.HasExited) {
            throw "Desktop exited during startup with code $($desktopProcess.ExitCode)."
        }
        $child = Get-CimInstance Win32_Process -Filter "ParentProcessId=$($desktopProcess.Id)" -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -ieq 'node.exe' } |
            Select-Object -First 1
        if ($child) {
            $corePid = [int]$child.ProcessId
            $listener = Get-NetTCPConnection -OwningProcess $corePid -State Listen -ErrorAction SilentlyContinue |
                Where-Object { $_.LocalAddress -eq '127.0.0.1' } |
                Select-Object -First 1
            if ($listener) {
                $corePort = [int]$listener.LocalPort
                break
            }
        }
    } while ((Get-Date) -lt $deadline)

    if (-not $corePid) {
        throw 'Desktop did not start its EasyEmail core child within 25 seconds.'
    }

    if (-not $corePort) {
        throw 'EasyEmail core did not expose a loopback listener.'
    }
    $baseUrl = "http://127.0.0.1:$corePort"

    $unauthenticatedStatus = $null
    try {
        Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/mail/catalog" -TimeoutSec 5 | Out-Null
        $unauthenticatedStatus = 200
    } catch {
        if ($_.Exception.Response) {
            $unauthenticatedStatus = [int]$_.Exception.Response.StatusCode
        } else {
            throw
        }
    }
    if ($unauthenticatedStatus -ne 401) {
        throw "Unauthenticated catalog returned $unauthenticatedStatus instead of 401."
    }

    $database = Join-Path $dataDir 'easyemailam.sqlite'
    $stateFile = Join-Path $dataDir 'core/state/easy-email-state.json'
    if (-not (Test-Path -LiteralPath $database -PathType Leaf)) {
        throw 'Desktop SQLite state was not created.'
    }
    if (-not (Test-Path -LiteralPath $stateFile -PathType Leaf)) {
        throw 'Packaged core state was not created.'
    }

    Write-Output "DESKTOP_PID=$($desktopProcess.Id)"
    Write-Output "CORE_PID=$corePid"
    Write-Output 'CORE_LOOPBACK=True'
    Write-Output 'UNAUTHENTICATED_STATUS=401'
    Write-Output "DESKTOP_DB_BYTES=$((Get-Item -LiteralPath $database).Length)"
    Write-Output "CORE_STATE_BYTES=$((Get-Item -LiteralPath $stateFile).Length)"

    if (-not $desktopProcess.CloseMainWindow()) {
        throw 'Desktop main window did not accept a normal close request.'
    }
    if (-not $desktopProcess.WaitForExit(10000)) {
        throw 'Desktop did not exit within 10 seconds after normal close.'
    }
    $normalClose = $true

    $coreDeadline = (Get-Date).AddSeconds(5)
    do {
        $coreAlive = Get-Process -Id $corePid -ErrorAction SilentlyContinue
        if (-not $coreAlive) {
            break
        }
        Start-Sleep -Milliseconds 200
    } while ((Get-Date) -lt $coreDeadline)
    if ($coreAlive) {
        throw 'Desktop core child remained alive after normal UI exit.'
    }

    Write-Output 'NORMAL_CLOSE=True'
    Write-Output 'CORE_EXITED_WITH_UI=True'
} finally {
    if ($desktopProcess -and -not $desktopProcess.HasExited) {
        Stop-Process -Id $desktopProcess.Id -Force -ErrorAction SilentlyContinue
    }
    if ($corePid) {
        Stop-Process -Id $corePid -Force -ErrorAction SilentlyContinue
    }
    if ($null -eq $previousDataDir) {
        Remove-Item Env:EASYEMAILAM_DATA_DIR -ErrorAction SilentlyContinue
    } else {
        $env:EASYEMAILAM_DATA_DIR = $previousDataDir
    }
    if (Test-Path -LiteralPath $dataDir) {
        $resolvedDataDir = [System.IO.Path]::GetFullPath($dataDir)
        if (-not $resolvedDataDir.StartsWith($smokeRoot + [System.IO.Path]::DirectorySeparatorChar)) {
            throw 'Refusing to clean a desktop smoke path outside its dedicated root.'
        }
        Remove-Item -LiteralPath $resolvedDataDir -Recurse -Force
    }
}

Write-Output "ISOLATED_DATA_REMOVED=$(-not (Test-Path -LiteralPath $dataDir))"
if (-not $normalClose) {
    throw 'Desktop runtime smoke did not complete a normal close.'
}
