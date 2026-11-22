param(
    [string]$ExecutablePath = (Join-Path $PSScriptRoot '../src-tauri/target/release/easyemailam.exe'),
    [int]$StartupTimeoutSeconds = 70,
    [int]$ActionTimeoutSeconds = 120
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Stop-IsolatedWebViewProcesses {
    param([Parameter(Mandatory = $true)][string]$WebViewDirectory)

    $isolatedPath = [System.IO.Path]::GetFullPath($WebViewDirectory)
    $processes = @(
        Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" -ErrorAction SilentlyContinue |
            Where-Object {
                $_.CommandLine -and
                $_.CommandLine.IndexOf(
                    $isolatedPath,
                    [System.StringComparison]::OrdinalIgnoreCase
                ) -ge 0
            }
    )
    foreach ($process in $processes) {
        Stop-Process -Id ([int]$process.ProcessId) -Force -ErrorAction SilentlyContinue
        $ownedProcess = Get-Process -Id ([int]$process.ProcessId) -ErrorAction SilentlyContinue
        if ($ownedProcess) {
            $null = $ownedProcess.WaitForExit(5000)
        }
    }
}

$executable = [System.IO.Path]::GetFullPath($ExecutablePath)
$expectedCoreRoot = [System.IO.Path]::GetFullPath(
    (Join-Path (Split-Path -Parent $executable) 'core')
).TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
$probe = Join-Path $PSScriptRoot 'verify-desktop-functional-cdp.mjs'
$playwrightPackage = Join-Path $PSScriptRoot '../node_modules/playwright-core/package.json'
foreach ($requiredFile in @($executable, $probe, $playwrightPackage)) {
    if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
        throw "Desktop functional smoke input is missing: $requiredFile"
    }
}

$smokeRoot = [System.IO.Path]::GetFullPath(
    (Join-Path ([System.IO.Path]::GetTempPath()) 'easyemail-desktop-functional')
)
$dataDir = [System.IO.Path]::GetFullPath((Join-Path $smokeRoot ([Guid]::NewGuid().ToString('N'))))
if (-not $dataDir.StartsWith($smokeRoot + [System.IO.Path]::DirectorySeparatorChar)) {
    throw 'The isolated desktop functional path escaped its dedicated root.'
}
$webViewDir = Join-Path $dataDir 'webview2'
New-Item -ItemType Directory -Path $webViewDir -Force | Out-Null

$portProbe = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
$portProbe.Start()
$cdpPort = ([System.Net.IPEndPoint]$portProbe.LocalEndpoint).Port
$portProbe.Stop()

$previousDataDir = $env:EASYEMAILAM_DATA_DIR
$previousWebViewDir = $env:WEBVIEW2_USER_DATA_FOLDER
$previousBrowserArguments = $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
$desktopProcess = $null
$corePid = $null
$normalClose = $false
$coreExited = $false

try {
    $env:EASYEMAILAM_DATA_DIR = $dataDir
    $env:WEBVIEW2_USER_DATA_FOLDER = $webViewDir
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS =
        "--remote-debugging-address=127.0.0.1 --remote-debugging-port=$cdpPort"
    $desktopProcess = Start-Process -FilePath $executable -PassThru -WindowStyle Hidden

    $startupDeadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
    do {
        Start-Sleep -Milliseconds 200
        $desktopProcess.Refresh()
        if ($desktopProcess.HasExited) {
            throw "Desktop exited during functional startup with code $($desktopProcess.ExitCode)."
        }
        $core = Get-CimInstance Win32_Process -Filter "ParentProcessId=$($desktopProcess.Id)" -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -ieq 'node.exe' } |
            Select-Object -First 1
        if ($core) {
            $corePid = [int]$core.ProcessId
            break
        }
    } while ((Get-Date) -lt $startupDeadline)
    if (-not $corePid) {
        throw "Desktop did not start its bundled core within $StartupTimeoutSeconds seconds."
    }

    & node $probe `
        --endpoint "http://127.0.0.1:$cdpPort" `
        --data-dir $dataDir `
        --timeout-ms ($ActionTimeoutSeconds * 1000)
    if ($LASTEXITCODE -ne 0) {
        throw "Packaged desktop functional probe failed with exit code $LASTEXITCODE."
    }

    if (-not $desktopProcess.CloseMainWindow()) {
        throw 'Desktop main window did not accept a normal close request.'
    }
    $normalClose = $desktopProcess.WaitForExit(10000)
    if (-not $normalClose) {
        throw 'Desktop did not exit within 10 seconds after its functional smoke.'
    }
    $coreDeadline = (Get-Date).AddSeconds(5)
    do {
        $coreExited = -not (Get-Process -Id $corePid -ErrorAction SilentlyContinue)
        if ($coreExited) {
            break
        }
        Start-Sleep -Milliseconds 200
    } while ((Get-Date) -lt $coreDeadline)
    if (-not $coreExited) {
        throw 'Desktop core child remained alive after the functional smoke closed the UI.'
    }
    Write-Output 'NORMAL_CLOSE=True'
    Write-Output 'CORE_EXITED_WITH_UI=True'
} finally {
    if ($desktopProcess -and -not $desktopProcess.HasExited) {
        Stop-Process -Id $desktopProcess.Id -Force -ErrorAction SilentlyContinue
        $null = $desktopProcess.WaitForExit(10000)
    }
    if ($corePid) {
        $remainingCore = Get-CimInstance Win32_Process -Filter "ProcessId=$corePid" -ErrorAction SilentlyContinue
        if ($remainingCore -and $remainingCore.ExecutablePath) {
            $remainingCorePath = [System.IO.Path]::GetFullPath([string]$remainingCore.ExecutablePath)
            if ($remainingCorePath.StartsWith($expectedCoreRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
                Stop-Process -Id $corePid -Force -ErrorAction SilentlyContinue
            }
        }
    }
    Stop-IsolatedWebViewProcesses -WebViewDirectory $webViewDir
    if ($null -eq $previousDataDir) {
        Remove-Item Env:EASYEMAILAM_DATA_DIR -ErrorAction SilentlyContinue
    } else {
        $env:EASYEMAILAM_DATA_DIR = $previousDataDir
    }
    if ($null -eq $previousWebViewDir) {
        Remove-Item Env:WEBVIEW2_USER_DATA_FOLDER -ErrorAction SilentlyContinue
    } else {
        $env:WEBVIEW2_USER_DATA_FOLDER = $previousWebViewDir
    }
    if ($null -eq $previousBrowserArguments) {
        Remove-Item Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS -ErrorAction SilentlyContinue
    } else {
        $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = $previousBrowserArguments
    }
    if (Test-Path -LiteralPath $dataDir) {
        $resolvedDataDir = [System.IO.Path]::GetFullPath($dataDir)
        if (-not $resolvedDataDir.StartsWith($smokeRoot + [System.IO.Path]::DirectorySeparatorChar)) {
            throw 'Refusing to clean a functional smoke path outside its dedicated root.'
        }
        $cleanupDeadline = (Get-Date).AddSeconds(10)
        do {
            try {
                Remove-Item -LiteralPath $resolvedDataDir -Recurse -Force -ErrorAction Stop
            } catch {
                if ((Get-Date) -ge $cleanupDeadline) {
                    throw
                }
                Start-Sleep -Milliseconds 250
            }
        } while (Test-Path -LiteralPath $resolvedDataDir)
    }
}

if (-not $normalClose) {
    throw 'Desktop functional smoke did not complete a normal close.'
}
if (-not $coreExited) {
    throw 'The bundled core outlived the desktop functional smoke.'
}
Write-Output "ISOLATED_DATA_REMOVED=$(-not (Test-Path -LiteralPath $dataDir))"
