param(
    [string]$ExecutablePath = (Join-Path $PSScriptRoot '../src-tauri/target/debug/easyemailam.exe'),
    [int]$StartupTimeoutSeconds = 55
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Start-IsolatedDesktopRuntime {
    param([Parameter(Mandatory = $true)][string]$Executable)

    $process = Start-Process -FilePath $Executable -PassThru -WindowStyle Hidden
    # The host may perform three 15-second core-readiness attempts before failing.
    $deadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
    $childProcessId = $null
    $corePort = $null
    $brokerPort = $null

    try {
        do {
            Start-Sleep -Milliseconds 250
            $process.Refresh()
            if ($process.HasExited) {
                throw "Desktop exited during startup with code $($process.ExitCode)."
            }
            $child = Get-CimInstance Win32_Process -Filter "ParentProcessId=$($process.Id)" -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -ieq 'node.exe' } |
                Select-Object -First 1
            if ($child) {
                $childProcessId = [int]$child.ProcessId
                $listener = Get-NetTCPConnection -OwningProcess $childProcessId -State Listen -ErrorAction SilentlyContinue |
                    Where-Object { $_.LocalAddress -eq '127.0.0.1' } |
                    Select-Object -First 1
                if ($listener) {
                    $corePort = [int]$listener.LocalPort
                }
            }
            $brokerListener = Get-NetTCPConnection -OwningProcess $process.Id -State Listen -ErrorAction SilentlyContinue |
                Where-Object { $_.LocalAddress -eq '127.0.0.1' } |
                Select-Object -First 1
            if ($brokerListener) {
                $brokerPort = [int]$brokerListener.LocalPort
            }
            if ($corePort -and $brokerPort) {
                break
            }
        } while ((Get-Date) -lt $deadline)

        if (-not $childProcessId) {
            throw "Desktop did not start its EasyEmail core child within $StartupTimeoutSeconds seconds."
        }
        if (-not $corePort) {
            throw 'EasyEmail core did not expose a loopback listener.'
        }
        if (-not $brokerPort) {
            throw 'Desktop host did not expose its private loopback credential broker.'
        }

        return [PSCustomObject]@{
            DesktopProcess = $process
            CorePid = $childProcessId
            CorePort = $corePort
            BrokerPort = $brokerPort
        }
    } catch {
        if (-not $process.HasExited) {
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        }
        if ($childProcessId) {
            Stop-Process -Id $childProcessId -Force -ErrorAction SilentlyContinue
        }
        throw
    }
}

function Get-UnauthenticatedStatus {
    param(
        [Parameter(Mandatory = $true)][string]$Uri,
        [switch]$PostJson
    )

    try {
        if ($PostJson) {
            Invoke-WebRequest -UseBasicParsing -Uri $Uri -Method Post -ContentType 'application/json' `
                -Body '{}' -TimeoutSec 5 | Out-Null
        } else {
            Invoke-WebRequest -UseBasicParsing -Uri $Uri -TimeoutSec 5 | Out-Null
        }
        return 200
    } catch {
        if ($_.Exception.Response) {
            return [int]$_.Exception.Response.StatusCode
        }
        throw
    }
}

function Stop-IsolatedDesktopRuntime {
    param([Parameter(Mandatory = $true)]$Runtime)

    $process = $Runtime.DesktopProcess
    if (-not $process.CloseMainWindow()) {
        throw 'Desktop main window did not accept a normal close request.'
    }
    if (-not $process.WaitForExit(10000)) {
        throw 'Desktop did not exit within 10 seconds after normal close.'
    }

    $coreAlive = $null
    $coreDeadline = (Get-Date).AddSeconds(5)
    do {
        $coreAlive = Get-Process -Id $Runtime.CorePid -ErrorAction SilentlyContinue
        if (-not $coreAlive) {
            break
        }
        Start-Sleep -Milliseconds 200
    } while ((Get-Date) -lt $coreDeadline)
    if ($coreAlive) {
        throw 'Desktop core child remained alive after normal UI exit.'
    }
}

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
$restartClose = $false
try {
    $env:EASYEMAILAM_DATA_DIR = $dataDir
    $runtime = Start-IsolatedDesktopRuntime -Executable $executable
    $desktopProcess = $runtime.DesktopProcess
    $corePid = $runtime.CorePid
    $corePort = $runtime.CorePort
    $brokerPort = $runtime.BrokerPort
    $baseUrl = "http://127.0.0.1:$corePort"

    $unauthenticatedStatus = Get-UnauthenticatedStatus -Uri "$baseUrl/mail/catalog"
    if ($unauthenticatedStatus -ne 401) {
        throw "Unauthenticated catalog returned $unauthenticatedStatus instead of 401."
    }

    $desktopOrigin = 'http://tauri.localhost'
    $preflight = Invoke-WebRequest -UseBasicParsing -Method Options -Uri "$baseUrl/mail/mailboxes/open" -Headers @{
        Origin = $desktopOrigin
        'Access-Control-Request-Method' = 'POST'
        'Access-Control-Request-Headers' = 'authorization, content-type'
    } -TimeoutSec 5
    if ($preflight.StatusCode -ne 204) {
        throw "Desktop CORS preflight returned $($preflight.StatusCode) instead of 204."
    }
    if ($preflight.Headers['Access-Control-Allow-Origin'] -ne $desktopOrigin) {
        throw 'Desktop CORS preflight did not allow the Tauri production origin.'
    }
    if ($preflight.Headers['Access-Control-Allow-Headers'] -notmatch '(?i)authorization') {
        throw 'Desktop CORS preflight did not allow the bearer authorization header.'
    }
    if ($preflight.Headers['Access-Control-Allow-Headers'] -notmatch '(?i)content-type') {
        throw 'Desktop CORS preflight did not allow JSON request bodies.'
    }

    $unauthenticatedBrokerStatus = Get-UnauthenticatedStatus `
        -Uri "http://127.0.0.1:$brokerPort/v1/credentials/resolve" -PostJson
    if ($unauthenticatedBrokerStatus -ne 401) {
        throw "Unauthenticated credential broker returned $unauthenticatedBrokerStatus instead of 401."
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
    Write-Output 'DESKTOP_CORS_PREFLIGHT=True'
    Write-Output 'BROKER_LOOPBACK=True'
    Write-Output 'BROKER_UNAUTHENTICATED_STATUS=401'
    Write-Output "DESKTOP_DB_BYTES=$((Get-Item -LiteralPath $database).Length)"
    Write-Output "CORE_STATE_BYTES=$((Get-Item -LiteralPath $stateFile).Length)"

    $hostIdPath = Join-Path $dataDir 'desktop-host-id'
    $firstHostId = (Get-Content -LiteralPath $hostIdPath -Raw).Trim()
    Stop-IsolatedDesktopRuntime -Runtime $runtime
    $normalClose = $true
    Write-Output 'NORMAL_CLOSE=True'
    Write-Output 'CORE_EXITED_WITH_UI=True'

    $desktopProcess = $null
    $corePid = $null
    $restartedRuntime = Start-IsolatedDesktopRuntime -Executable $executable
    $desktopProcess = $restartedRuntime.DesktopProcess
    $corePid = $restartedRuntime.CorePid
    $restartedBaseUrl = "http://127.0.0.1:$($restartedRuntime.CorePort)"
    if ((Get-UnauthenticatedStatus -Uri "$restartedBaseUrl/mail/catalog") -ne 401) {
        throw 'Restarted core did not preserve its authenticated HTTP boundary.'
    }
    if ((Get-UnauthenticatedStatus `
        -Uri "http://127.0.0.1:$($restartedRuntime.BrokerPort)/v1/credentials/resolve" -PostJson) -ne 401) {
        throw 'Restarted credential broker did not preserve its authenticated HTTP boundary.'
    }
    $restartedHostId = (Get-Content -LiteralPath $hostIdPath -Raw).Trim()
    if (-not $firstHostId -or $restartedHostId -ne $firstHostId) {
        throw 'Desktop host ID changed across an isolated process restart.'
    }
    if (-not (Test-Path -LiteralPath $stateFile -PathType Leaf) -or (Get-Item -LiteralPath $stateFile).Length -le 0) {
        throw 'Packaged core state did not survive the desktop process restart.'
    }
    Stop-IsolatedDesktopRuntime -Runtime $restartedRuntime
    $restartClose = $true
    Write-Output 'RESTART_HOST_ID_STABLE=True'
    Write-Output 'RESTART_CORE_STATE_PERSISTED=True'
    Write-Output 'RESTART_AUTH_BOUNDARIES=True'
    Write-Output 'RESTART_NORMAL_CLOSE=True'
    Write-Output 'RESTART_CORE_EXITED_WITH_UI=True'
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
if (-not $restartClose) {
    throw 'Desktop runtime smoke did not complete the restart close.'
}
