Set-StrictMode -Version Latest

function Get-FreeLoopbackPort {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $listener.Start()
    try {
        return ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
    } finally {
        $listener.Stop()
    }
}

function Start-StandaloneServiceBase {
    param(
        [Parameter(Mandatory = $true)][string]$NodeExecutable,
        [Parameter(Mandatory = $true)][string]$ServiceRoot,
        [Parameter(Mandatory = $true)][string]$WorkspaceDir
    )

    $port = Get-FreeLoopbackPort
    $apiToken = "standalone-token-$([Guid]::NewGuid().ToString('N'))"
    $stateDir = Join-Path $WorkspaceDir 'state'
    New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
    $normalizedState = $stateDir.Replace('\', '/')
    $configPath = Join-Path $WorkspaceDir 'standalone-config.yaml'
    $configText = @"
server:
  host: 127.0.0.1
  port: $port
  apiKey: "$apiToken"
maintenance:
  enabled: false
  activeProbeEnabled: false
persistence:
  enabled: true
  driver: file
  intervalMs: 5000
  filePath: "$normalizedState/easy-email-state.json"
"@
    Set-Content -LiteralPath $configPath -Value $configText -Encoding UTF8

    $prevConfig = $env:EASY_EMAIL_CONFIG_PATH
    $prevState = $env:EASY_EMAIL_STATE_DIR
    $prevBundled = $env:EASY_EMAIL_BUNDLED_CHILD_MODE
    try {
        $env:EASY_EMAIL_CONFIG_PATH = $configPath
        $env:EASY_EMAIL_STATE_DIR = $stateDir
        Remove-Item Env:EASY_EMAIL_BUNDLED_CHILD_MODE -ErrorAction SilentlyContinue
        $entryPath = Join-Path $ServiceRoot 'dist/src/runtime/main.js'
        $proc = Start-Process -FilePath $NodeExecutable -ArgumentList @($entryPath) `
            -WorkingDirectory $ServiceRoot -WindowStyle Hidden -PassThru
    } finally {
        if ($null -eq $prevConfig) { Remove-Item Env:EASY_EMAIL_CONFIG_PATH -ErrorAction SilentlyContinue } else { $env:EASY_EMAIL_CONFIG_PATH = $prevConfig }
        if ($null -eq $prevState) { Remove-Item Env:EASY_EMAIL_STATE_DIR -ErrorAction SilentlyContinue } else { $env:EASY_EMAIL_STATE_DIR = $prevState }
        if ($null -eq $prevBundled) { Remove-Item Env:EASY_EMAIL_BUNDLED_CHILD_MODE -ErrorAction SilentlyContinue } else { $env:EASY_EMAIL_BUNDLED_CHILD_MODE = $prevBundled }
    }

    $baseUrl = "http://127.0.0.1:$port"
    $deadline = (Get-Date).AddSeconds(15)
    $ready = $false
    do {
        Start-Sleep -Milliseconds 150
        $proc.Refresh()
        if ($proc.HasExited) {
            throw "Standalone service/base exited prematurely with code $($proc.ExitCode)."
        }
        try {
            $resp = Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/mail/catalog" `
                -Headers @{ Authorization = "Bearer $apiToken" } -TimeoutSec 2
            if ($resp.StatusCode -eq 200) {
                $ready = $true
                break
            }
        } catch {}
    } while ((Get-Date) -lt $deadline)

    if (-not $ready) {
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        throw 'Standalone service/base did not become ready within 15 seconds.'
    }

    return [PSCustomObject]@{
        Process = $proc
        Port = $port
        BaseUrl = $baseUrl
        ApiToken = $apiToken
    }
}

function Assert-StandaloneServiceAlive {
    param([Parameter(Mandatory = $true)]$Standalone)

    $Standalone.Process.Refresh()
    if ($Standalone.Process.HasExited) {
        throw "Standalone service/base (PID $($Standalone.Process.Id)) was unexpectedly terminated!"
    }
    $resp = Invoke-WebRequest -UseBasicParsing -Uri "$($Standalone.BaseUrl)/mail/catalog" `
        -Headers @{ Authorization = "Bearer $($Standalone.ApiToken)" } -TimeoutSec 5
    if ($resp.StatusCode -ne 200) {
        throw "Standalone service/base returned status $($resp.StatusCode) instead of 200."
    }
}

function Stop-StandaloneServiceBase {
    param($Standalone)
    if ($Standalone -and $Standalone.Process -and -not $Standalone.Process.HasExited) {
        Stop-Process -Id $Standalone.Process.Id -Force -ErrorAction SilentlyContinue
        $null = $Standalone.Process.WaitForExit(5000)
    }
}

function Get-OversizedPayloadStatus {
    param(
        [Parameter(Mandatory = $true)][string]$BaseUrl,
        [string]$BearerToken = ''
    )

    $oversizedBody = '{"pad":"' + ('x' * (1100 * 1024)) + '"}'
    $headers = @{}
    if ($BearerToken) {
        $headers['Authorization'] = "Bearer $BearerToken"
    }
    try {
        Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/mail/mailboxes/open" -Method Post `
            -Headers $headers -ContentType 'application/json' -Body $oversizedBody -TimeoutSec 8 | Out-Null
        return 200
    } catch {
        if ($_.Exception.Response) {
            return [int]$_.Exception.Response.StatusCode
        }
        throw
    }
}

function Assert-MultiInstanceGuardBlocksSecondUi {
    param(
        [Parameter(Mandatory = $true)][string]$Executable,
        [Parameter(Mandatory = $true)]$ActiveRuntime
    )

    $secondProcess = Start-Process -FilePath $Executable -PassThru -WindowStyle Hidden
    try {
        if (-not $secondProcess.WaitForExit(10000)) {
            throw 'Second concurrent desktop UI instance did not exit under single-instance lock.'
        }
        $ActiveRuntime.DesktopProcess.Refresh()
        if ($ActiveRuntime.DesktopProcess.HasExited) {
            throw 'Primary desktop UI exited when second instance was rejected.'
        }
        if (-not (Get-Process -Id $ActiveRuntime.CorePid -ErrorAction SilentlyContinue)) {
            throw 'Primary bundled core child was disturbed by rejected second UI launch.'
        }
    } finally {
        if (-not $secondProcess.HasExited) {
            Stop-Process -Id $secondProcess.Id -Force -ErrorAction SilentlyContinue
        }
    }
}

function Assert-UiCrashParentEofReapsBundledChild {
    param(
        [Parameter(Mandatory = $true)][string]$Executable,
        [Parameter(Mandatory = $true)][scriptblock]$StartRuntimeFn
    )

    $crashRuntime = & $StartRuntimeFn $Executable
    $crashCorePid = $crashRuntime.CorePid
    Stop-Process -Id $crashRuntime.DesktopProcess.Id -Force
    $null = $crashRuntime.DesktopProcess.WaitForExit(5000)

    $eofDeadline = (Get-Date).AddSeconds(8)
    $childExited = $false
    do {
        if (-not (Get-Process -Id $crashCorePid -ErrorAction SilentlyContinue)) {
            $childExited = $true
            break
        }
        Start-Sleep -Milliseconds 150
    } while ((Get-Date) -lt $eofDeadline)

    if (-not $childExited) {
        Stop-Process -Id $crashCorePid -Force -ErrorAction SilentlyContinue
        throw 'Bundled core child did not exit on parent-pipe EOF after simulated UI crash.'
    }
}

function Assert-ForcedTimeoutFallbackKillsOnlyExactChild {
    param(
        [Parameter(Mandatory = $true)][string]$Executable,
        [Parameter(Mandatory = $true)][string]$NodeExecutable,
        [Parameter(Mandatory = $true)][string]$FixtureEntry,
        [Parameter(Mandatory = $true)][string]$DataDir,
        [Parameter(Mandatory = $true)][scriptblock]$StartRuntimeFn,
        [Parameter(Mandatory = $true)][scriptblock]$StopRuntimeFn
    )

    $prevNode = $env:EASY_EMAIL_DESKTOP_NODE_PATH
    $prevEntry = $env:EASY_EMAIL_DESKTOP_CORE_ENTRY
    $prevTimeout = $env:EASY_EMAIL_DESKTOP_SHUTDOWN_TIMEOUT_MS
    try {
        $env:EASY_EMAIL_DESKTOP_NODE_PATH = $NodeExecutable
        $env:EASY_EMAIL_DESKTOP_CORE_ENTRY = $FixtureEntry
        $env:EASY_EMAIL_DESKTOP_SHUTDOWN_TIMEOUT_MS = '350'

        $wedgedRuntime = & $StartRuntimeFn $Executable
        & $StopRuntimeFn $wedgedRuntime

        $coreLogPath = Join-Path $DataDir 'core/logs/core.log'
        $logContent = Get-Content -LiteralPath $coreLogPath -Raw
        if ($logContent -notmatch 'event=core_forced_kill_fallback') {
            throw 'Forced-timeout fallback did not record core_forced_kill_fallback in core.log.'
        }
    } finally {
        if ($null -eq $prevNode) { Remove-Item Env:EASY_EMAIL_DESKTOP_NODE_PATH -ErrorAction SilentlyContinue } else { $env:EASY_EMAIL_DESKTOP_NODE_PATH = $prevNode }
        if ($null -eq $prevEntry) { Remove-Item Env:EASY_EMAIL_DESKTOP_CORE_ENTRY -ErrorAction SilentlyContinue } else { $env:EASY_EMAIL_DESKTOP_CORE_ENTRY = $prevEntry }
        if ($null -eq $prevTimeout) { Remove-Item Env:EASY_EMAIL_DESKTOP_SHUTDOWN_TIMEOUT_MS -ErrorAction SilentlyContinue } else { $env:EASY_EMAIL_DESKTOP_SHUTDOWN_TIMEOUT_MS = $prevTimeout }
    }
}
