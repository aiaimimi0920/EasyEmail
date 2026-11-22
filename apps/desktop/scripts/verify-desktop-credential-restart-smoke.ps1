param(
    [string]$ExecutablePath = (Join-Path $PSScriptRoot '../src-tauri/target/debug/easyemailam.exe'),
    [int]$StartupTimeoutSeconds = 70,
    [int]$ActionTimeoutSeconds = 90
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'lib/desktop-credential-smoke-support.ps1')

function Stop-IsolatedWebViewProcesses {
    param([Parameter(Mandatory = $true)][string]$WebViewDirectory)
    $isolatedPath = [System.IO.Path]::GetFullPath($WebViewDirectory)
    $processes = @(
        Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" -ErrorAction SilentlyContinue |
            Where-Object {
                $_.CommandLine -and
                $_.CommandLine.IndexOf($isolatedPath, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
            }
    )
    foreach ($proc in $processes) {
        Stop-Process -Id ([int]$proc.ProcessId) -Force -ErrorAction SilentlyContinue
    }
}

function Reserve-LoopbackPort {
    $probe = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $probe.Start()
    $port = ([System.Net.IPEndPoint]$probe.LocalEndpoint).Port
    $probe.Stop()
    return $port
}

function Start-DesktopWithCdp {
    param(
        [Parameter(Mandatory = $true)][string]$Executable,
        [Parameter(Mandatory = $true)][string]$DataDir,
        [Parameter(Mandatory = $true)][string]$WebViewDir,
        [Parameter(Mandatory = $true)][string]$CaCertPath,
        [Parameter(Mandatory = $true)][int]$CdpPort,
        [Parameter(Mandatory = $true)][int]$TimeoutSeconds
    )
    $env:EASYEMAILAM_DATA_DIR = $DataDir
    $env:WEBVIEW2_USER_DATA_FOLDER = $WebViewDir
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-address=127.0.0.1 --remote-debugging-port=$CdpPort"
    $env:NODE_EXTRA_CA_CERTS = $CaCertPath

    $proc = Start-Process -FilePath $Executable -PassThru -WindowStyle Hidden
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $corePid = $null
    $corePort = $null
    $brokerPort = $null
    do {
        Start-Sleep -Milliseconds 250
        $proc.Refresh()
        if ($proc.HasExited) {
            throw "Desktop exited during startup with code $($proc.ExitCode)."
        }
        $child = Get-CimInstance Win32_Process -Filter "ParentProcessId=$($proc.Id)" -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -ieq 'node.exe' } |
            Select-Object -First 1
        if ($child) {
            $corePid = [int]$child.ProcessId
            $listener = Get-NetTCPConnection -OwningProcess $corePid -State Listen -ErrorAction SilentlyContinue |
                Where-Object { $_.LocalAddress -eq '127.0.0.1' } |
                Select-Object -First 1
            if ($listener) { $corePort = [int]$listener.LocalPort }
        }
        $brokerListener = Get-NetTCPConnection -OwningProcess $proc.Id -State Listen -ErrorAction SilentlyContinue |
            Where-Object { $_.LocalAddress -eq '127.0.0.1' } |
            Select-Object -First 1
        if ($brokerListener) { $brokerPort = [int]$brokerListener.LocalPort }
        if ($corePort -and $brokerPort) { break }
    } while ((Get-Date) -lt $deadline)

    if (-not $corePid -or -not $corePort -or -not $brokerPort) {
        throw "Desktop did not start core and credential broker within $TimeoutSeconds seconds."
    }
    return [PSCustomObject]@{
        DesktopProcess = $proc
        CorePid = $corePid
        CorePort = $corePort
        BrokerPort = $brokerPort
    }
}

function Stop-DesktopCleanly {
    param([Parameter(Mandatory = $true)]$Runtime, [Parameter(Mandatory = $true)][string]$WebViewDir)
    if (-not (Request-EasyEmailDesktopClose -Process $Runtime.DesktopProcess)) {
        throw 'Desktop main window did not accept a normal close request.'
    }
    if (-not $Runtime.DesktopProcess.WaitForExit(10000)) {
        throw 'Desktop did not exit within 10 seconds after normal close.'
    }
    $deadline = (Get-Date).AddSeconds(5)
    do {
        $alive = Get-Process -Id $Runtime.CorePid -ErrorAction SilentlyContinue
        if (-not $alive) { break }
        Start-Sleep -Milliseconds 200
    } while ((Get-Date) -lt $deadline)
    if (Get-Process -Id $Runtime.CorePid -ErrorAction SilentlyContinue) {
        throw 'Core child remained alive after normal desktop close.'
    }
    Stop-IsolatedWebViewProcesses -WebViewDirectory $WebViewDir
}

$executable = [System.IO.Path]::GetFullPath($ExecutablePath)
$certScript = Join-Path $PSScriptRoot 'fixtures/ephemeral-loopback-tls-cert.mjs'
$imapScript = Join-Path $PSScriptRoot 'fixtures/loopback-tls-imap-server.mjs'
$cdpProbe = Join-Path $PSScriptRoot 'verify-desktop-credential-restart-cdp.mjs'
$legacySeedScript = Join-Path $PSScriptRoot 'seed-and-import-legacy-accounts.mjs'
foreach ($required in @($executable, $certScript, $imapScript, $cdpProbe, $legacySeedScript)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "Credential restart smoke input is missing: $required"
    }
}

$smokeRoot = [System.IO.Path]::GetFullPath((Join-Path ([System.IO.Path]::GetTempPath()) 'easyemail-desktop-cred-smoke'))
$runRoot = [System.IO.Path]::GetFullPath((Join-Path $smokeRoot ([Guid]::NewGuid().ToString('N'))))
$dataDir = Join-Path $runRoot 'data'
$webViewDir = Join-Path $runRoot 'webview2'
$tlsDir = Join-Path $runRoot 'tls'
$imapStateFile = Join-Path $runRoot 'imap-state.json'
$metadataFile = Join-Path $runRoot 'run1-account.json'
New-Item -ItemType Directory -Path $dataDir, $webViewDir, $tlsDir -Force | Out-Null

$canarySecret = "imap-restart-canary-$([Guid]::NewGuid().ToString('N'))"
$presentIdHex = [Guid]::NewGuid().ToString('N')
$missingIdHex = [Guid]::NewGuid().ToString('N')
$legacyPresentAccountId = "acct_smoke_$presentIdHex"
$legacyPresentSecretKey = "secret://imap/$legacyPresentAccountId"
$legacyMissingAccountId = "acct_smoke_$missingIdHex"
$legacyMissingSecretKey = "secret://imap/$legacyMissingAccountId"
$createdRefSecretKey = $null

$previousEnv = @{
    EASYEMAILAM_DATA_DIR = $env:EASYEMAILAM_DATA_DIR
    WEBVIEW2_USER_DATA_FOLDER = $env:WEBVIEW2_USER_DATA_FOLDER
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
    NODE_EXTRA_CA_CERTS = $env:NODE_EXTRA_CA_CERTS
    EASYEMAIL_SMOKE_EXPECTED_IMAP_SECRET = $env:EASYEMAIL_SMOKE_EXPECTED_IMAP_SECRET
    EASYEMAIL_SMOKE_CANARY_SECRET = $env:EASYEMAIL_SMOKE_CANARY_SECRET
}
$imapProcess = $null
$activeRuntime = $null

try {
    $tlsCert = New-EphemeralLoopbackTlsCertificate -OutputDirectory $tlsDir -GeneratorScriptPath $certScript
    $env:EASYEMAIL_SMOKE_EXPECTED_IMAP_SECRET = $canarySecret
    $imapProcess = Start-Process -FilePath 'node' -ArgumentList @(
        $imapScript,
        '--cert', $tlsCert.CertPath,
        '--key', $tlsCert.KeyPath,
        '--expected-user', 'smoke@example.com',
        '--expected-pass-env', 'EASYEMAIL_SMOKE_EXPECTED_IMAP_SECRET',
        '--state-file', $imapStateFile
    ) -PassThru -WindowStyle Hidden
    Remove-Item Env:EASYEMAIL_SMOKE_EXPECTED_IMAP_SECRET -ErrorAction SilentlyContinue

    $imapDeadline = (Get-Date).AddSeconds(10)
    $imapPort = 0
    do {
        Start-Sleep -Milliseconds 150
        if (Test-Path -LiteralPath $imapStateFile -PathType Leaf) {
            try {
                $imapState = Get-Content -LiteralPath $imapStateFile -Raw | ConvertFrom-Json
                if ([int]$imapState.port -gt 0) {
                    $imapPort = [int]$imapState.port
                    break
                }
            } catch {}
        }
    } while ((Get-Date) -lt $imapDeadline)
    if ($imapPort -le 0) {
        throw 'Loopback TLS IMAP server did not publish a listening port.'
    }

    $cdpPort1 = Reserve-LoopbackPort
    $activeRuntime = Start-DesktopWithCdp -Executable $executable -DataDir $dataDir -WebViewDir $webViewDir `
        -CaCertPath $tlsCert.CertPath -CdpPort $cdpPort1 -TimeoutSeconds $StartupTimeoutSeconds
    $run1CorePid = $activeRuntime.CorePid
    $run1BrokerPort = $activeRuntime.BrokerPort

    $env:EASYEMAIL_SMOKE_CANARY_SECRET = $canarySecret
    & node $cdpProbe --endpoint "http://127.0.0.1:$cdpPort1" --phase 'run1-create-and-test' `
        --metadata-file $metadataFile --imap-port $imapPort --timeout-ms ($ActionTimeoutSeconds * 1000)
    Remove-Item Env:EASYEMAIL_SMOKE_CANARY_SECRET -ErrorAction SilentlyContinue
    if ($LASTEXITCODE -ne 0) {
        throw "Run 1 CDP credential probe failed with exit code $LASTEXITCODE."
    }

    $run1Meta = Get-Content -LiteralPath $metadataFile -Raw | ConvertFrom-Json
    $createdRefSecretKey = [string]$run1Meta.secretKey
    if (-not (Test-EasyEmailSmokeVaultSecret -SecretKey $createdRefSecretKey)) {
        throw 'Windows Credential Manager does not contain the stored ref:v1 credential after Run 1.'
    }

    Stop-DesktopCleanly -Runtime $activeRuntime -WebViewDir $webViewDir
    $activeRuntime = $null

    Set-EasyEmailSmokeVaultSecret -SecretKey $legacyPresentSecretKey -SecretValue $canarySecret
    & node $legacySeedScript `
        --data-dir $dataDir `
        --imap-port $imapPort `
        --imap-username 'smoke@example.com' `
        --present-account-id $legacyPresentAccountId `
        --present-secret-key $legacyPresentSecretKey `
        --missing-account-id $legacyMissingAccountId `
        --missing-secret-key $legacyMissingSecretKey
    if ($LASTEXITCODE -ne 0) {
        throw "Offline legacy account seed/import failed with exit code $LASTEXITCODE."
    }

    $cdpPort2 = Reserve-LoopbackPort
    $activeRuntime = Start-DesktopWithCdp -Executable $executable -DataDir $dataDir -WebViewDir $webViewDir `
        -CaCertPath $tlsCert.CertPath -CdpPort $cdpPort2 -TimeoutSeconds $StartupTimeoutSeconds
    if ($activeRuntime.CorePid -eq $run1CorePid) {
        throw 'Restarted desktop unexpectedly reused the previous core PID.'
    }

    & node $cdpProbe --endpoint "http://127.0.0.1:$cdpPort2" --phase 'run2-restart-and-legacy' `
        --metadata-file $metadataFile --timeout-ms ($ActionTimeoutSeconds * 1000)
    if ($LASTEXITCODE -ne 0) {
        throw "Run 2 CDP restart & legacy credential probe failed with exit code $LASTEXITCODE."
    }

    Stop-DesktopCleanly -Runtime $activeRuntime -WebViewDir $webViewDir
    $activeRuntime = $null

    if (Test-EasyEmailSmokeVaultSecret -SecretKey $createdRefSecretKey) {
        throw 'Account delete in Run 2 did not remove the ref:v1 credential from Windows Credential Manager.'
    }
    if (-not (Test-EasyEmailSmokeVaultSecret -SecretKey $legacyPresentSecretKey)) {
        throw 'Legacy vault entry was unexpectedly deleted during Run 2.'
    }
    Remove-EasyEmailSmokeVaultSecret -SecretKey $legacyPresentSecretKey
    if (Test-EasyEmailSmokeVaultSecret -SecretKey $legacyPresentSecretKey) {
        throw 'Failed to clean up isolated legacy smoke credential from Windows Credential Manager.'
    }

    $finalImapState = Get-Content -LiteralPath $imapStateFile -Raw | ConvertFrom-Json
    if ([int]$finalImapState.authenticatedCount -ne 3) {
        throw "Expected 3 TLS IMAP authentications across Run 1 + Run 2, got $($finalImapState.authenticatedCount)."
    }

    Assert-ZeroCanarySecretMatches -RootDirectory $dataDir -CanarySecrets @($canarySecret)
    Assert-ZeroCanarySecretMatches -RootDirectory $webViewDir -CanarySecrets @($canarySecret)

    Write-Output "BROKER_ROTATED=$($run1BrokerPort -ne 0)"
    Write-Output "TLS_IMAP_AUTHENTICATED_COUNT=$($finalImapState.authenticatedCount)"
    Write-Output 'CANARY_SECRET_ZERO_MATCHES=True'
    Write-Output 'CREDENTIAL_RESTART_SMOKE_PASSED=True'
} finally {
    if ($activeRuntime) {
        if (-not $activeRuntime.DesktopProcess.HasExited) {
            Stop-Process -Id $activeRuntime.DesktopProcess.Id -Force -ErrorAction SilentlyContinue
        }
        Stop-Process -Id $activeRuntime.CorePid -Force -ErrorAction SilentlyContinue
    }
    Stop-IsolatedWebViewProcesses -WebViewDirectory $webViewDir
    if ($imapProcess -and -not $imapProcess.HasExited) {
        Stop-Process -Id $imapProcess.Id -Force -ErrorAction SilentlyContinue
    }
    if ($createdRefSecretKey) {
        try { Remove-EasyEmailSmokeVaultSecret -SecretKey $createdRefSecretKey } catch {}
    }
    try { Remove-EasyEmailSmokeVaultSecret -SecretKey $legacyPresentSecretKey } catch {}
    foreach ($key in $previousEnv.Keys) {
        if ($null -eq $previousEnv[$key]) {
            Remove-Item "Env:$key" -ErrorAction SilentlyContinue
        } else {
            Set-Item "Env:$key" -Value $previousEnv[$key]
        }
    }
    if (Test-Path -LiteralPath $runRoot) {
        $resolvedRunRoot = [System.IO.Path]::GetFullPath($runRoot)
        if ($resolvedRunRoot.StartsWith($smokeRoot + [System.IO.Path]::DirectorySeparatorChar)) {
            Remove-Item -LiteralPath $resolvedRunRoot -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}
