param(
    [string]$ExecutablePath = (Join-Path $PSScriptRoot '../src-tauri/target/debug/easyemailam.exe'),
    [int]$WindowTimeoutSeconds = 8
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class EasyEmailWindowProbe
{
    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr SendMessageTimeout(
        IntPtr hWnd,
        uint Msg,
        UIntPtr wParam,
        IntPtr lParam,
        uint flags,
        uint timeout,
        out UIntPtr result);
}
'@

$executable = [System.IO.Path]::GetFullPath($ExecutablePath)
$bundleRoot = Split-Path -Parent $executable
$nodePath = Join-Path $bundleRoot 'core/node.exe'
$delayedCoreEntry = Join-Path $PSScriptRoot 'fixtures/delayed-core.mjs'
foreach ($requiredFile in @($executable, $nodePath, $delayedCoreEntry)) {
    if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
        throw "Desktop responsiveness smoke input is missing: $requiredFile"
    }
}

$smokeRoot = Join-Path ([System.IO.Path]::GetTempPath()) 'easyemail-desktop-responsiveness'
$dataDir = Join-Path $smokeRoot ([Guid]::NewGuid().ToString('N'))
$previousDataDir = $env:EASYEMAILAM_DATA_DIR
$previousNodePath = $env:EASY_EMAIL_DESKTOP_NODE_PATH
$previousCoreEntry = $env:EASY_EMAIL_DESKTOP_CORE_ENTRY
$desktopProcess = $null
$corePid = $null
$normalClose = $false
$coreExited = $false

try {
    New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
    $env:EASYEMAILAM_DATA_DIR = $dataDir
    $env:EASY_EMAIL_DESKTOP_NODE_PATH = $nodePath
    $env:EASY_EMAIL_DESKTOP_CORE_ENTRY = $delayedCoreEntry

    $stopwatch = [Diagnostics.Stopwatch]::StartNew()
    $desktopProcess = Start-Process -FilePath $executable -PassThru
    $deadline = (Get-Date).AddSeconds($WindowTimeoutSeconds)
    $windowCreatedMs = $null
    $windowResponsiveMs = $null

    do {
        Start-Sleep -Milliseconds 100
        $desktopProcess.Refresh()
        if ($desktopProcess.HasExited) {
            throw "Desktop exited during responsiveness smoke with code $($desktopProcess.ExitCode)."
        }
        if ($null -eq $windowCreatedMs -and $desktopProcess.MainWindowHandle -ne 0) {
            $windowCreatedMs = $stopwatch.ElapsedMilliseconds
        }
        if ($desktopProcess.MainWindowHandle -ne 0 -and $null -eq $windowResponsiveMs) {
            $messageResult = [UIntPtr]::Zero
            $probe = [EasyEmailWindowProbe]::SendMessageTimeout(
                $desktopProcess.MainWindowHandle,
                0,
                [UIntPtr]::Zero,
                [IntPtr]::Zero,
                3,
                250,
                [ref]$messageResult
            )
            if ($probe -ne [IntPtr]::Zero) {
                $windowResponsiveMs = $stopwatch.ElapsedMilliseconds
            }
        }
        $child = Get-CimInstance Win32_Process -Filter "ParentProcessId=$($desktopProcess.Id)" -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -ieq 'node.exe' } |
            Select-Object -First 1
        if ($child) {
            $corePid = [int]$child.ProcessId
        }
        if ($null -ne $windowResponsiveMs -and $corePid) {
            break
        }
    } while ((Get-Date) -lt $deadline)

    if ($null -eq $windowCreatedMs) {
        throw "Desktop did not create its window within $WindowTimeoutSeconds seconds while the core was delayed."
    }
    if ($null -eq $windowResponsiveMs) {
        throw "Desktop window did not remain responsive while the core was delayed."
    }
    if (-not $corePid) {
        throw 'Desktop did not start the controlled delayed core child.'
    }
    $coreListener = Get-NetTCPConnection -OwningProcess $corePid -State Listen -ErrorAction SilentlyContinue |
        Where-Object { $_.LocalAddress -eq '127.0.0.1' } |
        Select-Object -First 1
    if ($coreListener) {
        throw 'The controlled delayed core unexpectedly exposed a listener.'
    }

    Write-Output "WINDOW_CREATED_MS=$windowCreatedMs"
    Write-Output "WINDOW_RESPONSIVE_MS=$windowResponsiveMs"
    Write-Output 'WINDOW_RESPONSIVE_BEFORE_CORE_READY=True'
    Write-Output 'CORE_LISTENER_BEFORE_CLOSE=False'

    $null = $desktopProcess.CloseMainWindow()
    $normalClose = $desktopProcess.WaitForExit(10000)
    if ($normalClose) {
        $coreDeadline = (Get-Date).AddSeconds(5)
        do {
            $coreExited = -not (Get-Process -Id $corePid -ErrorAction SilentlyContinue)
            if ($coreExited) {
                break
            }
            Start-Sleep -Milliseconds 100
        } while ((Get-Date) -lt $coreDeadline)
    }
    Write-Output "NORMAL_CLOSE=$normalClose"
    Write-Output "CORE_EXITED_WITH_UI=$coreExited"
} finally {
    if ($desktopProcess -and -not $desktopProcess.HasExited) {
        Stop-Process -Id $desktopProcess.Id -Force -ErrorAction SilentlyContinue
    }
    if ($corePid -and $desktopProcess) {
        $remainingCore = Get-CimInstance Win32_Process -Filter "ProcessId=$corePid" -ErrorAction SilentlyContinue
        if ($remainingCore -and [int]$remainingCore.ParentProcessId -eq $desktopProcess.Id) {
            Stop-Process -Id $corePid -Force -ErrorAction SilentlyContinue
        }
    }
    if ($null -eq $previousDataDir) {
        Remove-Item Env:EASYEMAILAM_DATA_DIR -ErrorAction SilentlyContinue
    } else {
        $env:EASYEMAILAM_DATA_DIR = $previousDataDir
    }
    if ($null -eq $previousNodePath) {
        Remove-Item Env:EASY_EMAIL_DESKTOP_NODE_PATH -ErrorAction SilentlyContinue
    } else {
        $env:EASY_EMAIL_DESKTOP_NODE_PATH = $previousNodePath
    }
    if ($null -eq $previousCoreEntry) {
        Remove-Item Env:EASY_EMAIL_DESKTOP_CORE_ENTRY -ErrorAction SilentlyContinue
    } else {
        $env:EASY_EMAIL_DESKTOP_CORE_ENTRY = $previousCoreEntry
    }
    if (Test-Path -LiteralPath $dataDir) {
        $resolvedSmokeRoot = [System.IO.Path]::GetFullPath($smokeRoot)
        $resolvedDataDir = [System.IO.Path]::GetFullPath($dataDir)
        if (-not $resolvedDataDir.StartsWith($resolvedSmokeRoot + [System.IO.Path]::DirectorySeparatorChar)) {
            throw 'Refusing to clean a responsiveness smoke path outside its dedicated root.'
        }
        Remove-Item -LiteralPath $resolvedDataDir -Recurse -Force
    }
}

if (-not $normalClose) {
    throw 'Desktop responsiveness smoke did not complete a normal close.'
}
if (-not $coreExited) {
    throw 'The controlled delayed core outlived the desktop process.'
}
