param(
    [switch]$ConfirmExternalSideEffects,
    [string]$ConfigPath = 'config.yaml',
    [string]$Image = '',
    [switch]$Pull,
    [switch]$Rebuild,
    [int]$HostPort = 0,
    [int]$TimeoutSeconds = 240,
    [int]$PollIntervalSeconds = 8,
    [string]$ResultOutputPath = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $ConfirmExternalSideEffects) {
    throw 'Real-provider validation is opt-in. Pass -ConfirmExternalSideEffects to create mailboxes and send one test message.'
}
if ($TimeoutSeconds -lt 30) {
    throw 'TimeoutSeconds must be at least 30.'
}
if ($PollIntervalSeconds -lt 1) {
    throw 'PollIntervalSeconds must be at least 1.'
}
if ($HostPort -eq 18081) {
    throw 'Port 18081 is reserved for the existing local service and cannot be used by this isolated validation.'
}

$workspaceRoot = (Resolve-Path (Split-Path -Parent $PSScriptRoot)).Path
. (Join-Path $PSScriptRoot 'lib/easyemail-config.ps1')
. (Join-Path $PSScriptRoot 'lib/real-provider-redaction.ps1')
. (Join-Path $PSScriptRoot 'lib/real-provider-http.ps1')
. (Join-Path $PSScriptRoot 'lib/real-provider-mailbox.ps1')
. (Join-Path $PSScriptRoot 'lib/real-provider-persistence.ps1')

$powerShellCommand = Get-EasyEmailPowerShellCommand
$smokeScript = Join-Path $workspaceRoot 'deploy/service/base/smoke-easy-email-docker-api.ps1'
$composeFile = Join-Path $workspaceRoot 'deploy/service/base/docker-compose.yaml'
$resolvedConfigPath = Resolve-EasyEmailPath -Path $ConfigPath

if (-not (Test-Path -LiteralPath $resolvedConfigPath -PathType Leaf)) {
    throw "Config file not found: $resolvedConfigPath"
}

$config = Read-EasyEmailConfig -ConfigPath $resolvedConfigPath
$serviceBase = Get-EasyEmailSection -Config $config -Name 'serviceBase'
$runtime = Get-EasyEmailSection -Config $serviceBase -Name 'runtime'
$server = Get-EasyEmailSection -Config $runtime -Name 'server'
$persistence = Get-EasyEmailSection -Config $runtime -Name 'persistence'
$providers = Get-EasyEmailSection -Config $runtime -Name 'providers'
$cloudflareProvider = Get-EasyEmailSection -Config $providers -Name 'cloudflareTempEmail'
$cloudflareMail = Get-EasyEmailSection -Config $config -Name 'cloudflareMail'
$sending = Get-EasyEmailSection -Config $cloudflareMail -Name 'sending'
$worker = Get-EasyEmailSection -Config $cloudflareMail -Name 'worker'
$workerVars = Get-EasyEmailSection -Config $worker -Name 'vars'

$apiKey = [string](Get-EasyEmailConfigValue -Object $server -Name 'apiKey' -Default '')
$providerBaseUrl = [string](Get-EasyEmailConfigValue -Object $cloudflareProvider -Name 'baseUrl' -Default '')
$providerApiKey = [string](Get-EasyEmailConfigValue -Object $cloudflareProvider -Name 'apiKey' -Default '')
$providerDomain = [string](Get-EasyEmailConfigValue -Object $cloudflareProvider -Name 'domain' -Default '')
$resendToken = [string](Get-EasyEmailConfigValue -Object $workerVars -Name 'RESEND_TOKEN' -Default '')
$deleteAddressEnabled = [string](Get-EasyEmailConfigValue -Object $workerVars -Name 'ENABLE_USER_DELETE_EMAIL' -Default '')
$senderDomain = [string](Get-EasyEmailConfigValue -Object $sending -Name 'preferredSenderDomain' -Default '')
$deleteAddressEnabledValue = @('1', 'true', 'yes', 'on') -contains $deleteAddressEnabled.Trim().ToLowerInvariant()
$persistenceEnabledRaw = Get-EasyEmailConfigValue -Object $persistence -Name 'enabled' -Default $true
$persistenceEnabled = if ($persistenceEnabledRaw -is [bool]) {
    [bool]$persistenceEnabledRaw
} else {
    @('1', 'true', 'yes', 'on') -contains ([string]$persistenceEnabledRaw).Trim().ToLowerInvariant()
}
$persistenceIntervalMs = [int](Get-EasyEmailConfigValue -Object $persistence -Name 'intervalMs' -Default 60000)

$missingPrerequisites = New-Object System.Collections.Generic.List[string]
foreach ($entry in @(
    @{ Name = 'serviceBase.runtime.server.apiKey'; Value = $apiKey },
    @{ Name = 'serviceBase.runtime.providers.cloudflareTempEmail.baseUrl'; Value = $providerBaseUrl },
    @{ Name = 'serviceBase.runtime.providers.cloudflareTempEmail.apiKey'; Value = $providerApiKey },
    @{ Name = 'serviceBase.runtime.providers.cloudflareTempEmail.domain'; Value = $providerDomain },
    @{ Name = 'cloudflareMail.worker.vars.RESEND_TOKEN'; Value = $resendToken },
    @{ Name = 'cloudflareMail.worker.vars.ENABLE_USER_DELETE_EMAIL=true'; Value = if ($deleteAddressEnabledValue) { 'true' } else { '' } },
    @{ Name = 'cloudflareMail.sending.preferredSenderDomain'; Value = $senderDomain },
    @{ Name = 'serviceBase.runtime.persistence.enabled=true'; Value = if ($persistenceEnabled) { 'true' } else { '' } }
)) {
    if ([string]::IsNullOrWhiteSpace([string]$entry.Value)) {
        $missingPrerequisites.Add([string]$entry.Name) | Out-Null
    }
}
if ($missingPrerequisites.Count -gt 0) {
    throw ('Missing real-provider prerequisites: ' + ($missingPrerequisites -join ', '))
}

$sensitiveValues = @(
    Get-SensitiveConfigValues -Value $config |
        Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) } |
        Select-Object -Unique
)

if ($HostPort -le 0) {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    try {
        $listener.Start()
        $HostPort = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
    } finally {
        $listener.Stop()
    }
}
if ($HostPort -eq 18081) {
    throw 'The selected host port collides with the existing local service on 18081.'
}

$runName = 'real-m1-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
$containerName = "easy-email-$runName"
$networkName = "easy-email-$runName"
$composeProjectName = "easy-email-$runName"
$runtimeRoot = Join-Path $workspaceRoot ".tmp/service-base-real/$runName"
$launchLogPath = Join-Path $workspaceRoot ".tmp/$runName-launch.log"
$effectiveImage = if ([string]::IsNullOrWhiteSpace($Image)) { "easy-email/easy-email:$runName" } else { $Image.Trim() }
$effectiveRebuild = $Rebuild.IsPresent -or [string]::IsNullOrWhiteSpace($Image)
$ownsImage = [string]::IsNullOrWhiteSpace($Image)
$baseUrl = "http://127.0.0.1:$HostPort"

$script:ServiceApiKey = $apiKey
$script:ServiceBaseUrl = $baseUrl

$runFailure = ''
$cleanupFailure = ''
$result = $null
$recipientSession = $null
$senderSession = $null
$recipientReleased = $false
$senderReleased = $false
$script:OwnedMailboxTargets = New-Object System.Collections.Generic.List[object]
try {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $launchLogPath) | Out-Null
    $smokeArguments = @(
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', $smokeScript,
        '-BaseUrl', $baseUrl,
        '-ConfigPath', $resolvedConfigPath,
        '-Image', $effectiveImage,
        '-InstanceName', $runName,
        '-HostPort', [string]$HostPort,
        '-RuntimeRoot', $runtimeRoot,
        '-NetworkName', $networkName,
        '-NetworkAlias', $runName,
        '-ComposeProjectName', $composeProjectName,
        '-KeepRunning',
        '-SkipMailboxOpen'
    )
    if ($Pull) {
        $smokeArguments += '-Pull'
    }
    if ($effectiveRebuild) {
        $smokeArguments += '-Rebuild'
    }

    $previousErrorActionPreference = $ErrorActionPreference
    $smokeExitCode = 1
    try {
        $ErrorActionPreference = 'Continue'
        & $powerShellCommand @smokeArguments *> $launchLogPath
        $smokeExitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    if ($smokeExitCode -ne 0) {
        throw 'Failed to start the isolated real-provider service.'
    }
    $providerReadiness = Wait-ServiceReady -ReadyTimeoutSeconds 90
    $preferredInstanceId = [string]$providerReadiness.InstanceId
    $providerReportedDomains = @($providerReadiness.Domains | ForEach-Object {
        ([string]$_).Trim().ToLowerInvariant()
    } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    $marker = [Guid]::NewGuid().ToString('N')
    $expectedCode = (Get-Random -Minimum 100000 -Maximum 1000000).ToString()
    $recipientSession = Open-CloudflareMailbox `
        -HostId "$runName-recipient" `
        -PreferredInstanceId $preferredInstanceId
    $senderSession = Open-CloudflareMailbox `
        -HostId "$runName-sender" `
        -PreferredInstanceId $preferredInstanceId `
        -RequestedDomain $senderDomain
    $senderAddressParts = ([string]$senderSession.emailAddress).Split('@', 2)
    if ($senderAddressParts.Count -ne 2) {
        throw 'Real provider sender mailbox returned an invalid address.'
    }
    $configuredSenderDomainSelected = (
        [string]$senderAddressParts[1]
    ).Trim().ToLowerInvariant() -eq $senderDomain.Trim().ToLowerInvariant()
    if (-not $configuredSenderDomainSelected) {
        throw 'Real provider sender mailbox did not use the configured sender domain.'
    }

    $null = Invoke-ServiceRequest -Method POST -Path '/mail/mailboxes/update-session' -Body @{
        sessionId = [string]$recipientSession.id
        fromContains = [string]$senderAddressParts[1]
    }
    $sendResponse = Invoke-ServiceRequest -Method POST -Path '/mail/mailboxes/send' -Body @{
        sessionId = [string]$senderSession.id
        toEmailAddress = [string]$recipientSession.emailAddress
        subject = "EasyEmail M1 lifecycle $marker"
        textBody = "Controlled lifecycle marker $marker. Your verification code is $expectedCode."
        htmlBody = "<html><body><p>Controlled lifecycle marker <strong>$marker</strong>.</p><p>Your verification code is <strong>$expectedCode</strong>.</p></body></html>"
        fromName = 'EasyEmail M1 Validation'
    } -RequestTimeoutSeconds 90
    if ($null -eq $sendResponse.result -or [string]::IsNullOrWhiteSpace([string]$sendResponse.result.deliveryMode)) {
        throw 'Real provider send did not return a delivery result.'
    }

    $codeResult = Wait-ExpectedCode -SessionId ([string]$recipientSession.id) -ExpectedCode $expectedCode
    $escapedSessionId = [Uri]::EscapeDataString([string]$recipientSession.id)
    $observed = Invoke-ServiceRequest -Method GET -Path "/mail/query/observed-messages?sessionId=$escapedSessionId&limit=50&newestFirst=true"
    $matchingMessages = @($observed.messages | Where-Object {
        $observedSubject = [string](Get-EasyEmailConfigValue -Object $_ -Name 'subject' -Default '')
        $observedTextBody = [string](Get-EasyEmailConfigValue -Object $_ -Name 'textBody' -Default '')
        $observedHtmlBody = [string](Get-EasyEmailConfigValue -Object $_ -Name 'htmlBody' -Default '')
        $observedSubject.Contains($marker) -and
        ($observedTextBody.Contains($expectedCode) -or $observedHtmlBody.Contains($expectedCode))
    })
    if ($matchingMessages.Count -lt 1) {
        throw 'Observed-message readback did not preserve the controlled subject/body/code.'
    }

    $releaseResponse = Invoke-ServiceRequest -Method POST -Path '/mail/mailboxes/release' -Body @{
        sessionId = [string]$recipientSession.id
        reason = 'm1-real-provider-lifecycle'
    }
    $releaseResult = $releaseResponse.result
    $recipientReleased = $releaseResult.released -eq $true
    if ([string]$releaseResult.session.id -ne [string]$recipientSession.id) {
        throw 'Mailbox release returned a different session.'
    }
    if ([string]::IsNullOrWhiteSpace([string]$releaseResult.session.metadata.releasedAt)) {
        throw 'Mailbox release did not persist releasedAt metadata.'
    }
    if ([string]$releaseResult.session.metadata.releaseStatus -ne 'released' -or $releaseResult.released -ne $true) {
        throw 'Cloudflare Temp Email release did not delete the upstream mailbox.'
    }
    if ([string]$releaseResult.detail -ne 'deleted') {
        throw 'Cloudflare Temp Email release returned an unexpected detail.'
    }
    $senderReleaseResponse = Invoke-ServiceRequest -Method POST -Path '/mail/mailboxes/release' -Body @{
        sessionId = [string]$senderSession.id
        reason = 'm1-real-provider-lifecycle-sender'
    }
    $senderReleased = $senderReleaseResponse.result.released -eq $true
    if (
        [string]$senderReleaseResponse.result.session.metadata.releaseStatus -ne 'released' -or
        $senderReleaseResponse.result.released -ne $true -or
        [string]$senderReleaseResponse.result.detail -ne 'deleted'
    ) {
        throw 'Cloudflare Temp Email sender release returned unexpected semantics.'
    }

    Wait-PersistedLifecycleState `
        -SessionId ([string]$recipientSession.id) `
        -Marker $marker `
        -ExpectedCode $expectedCode

    & docker restart --time 30 $containerName *> $null
    if ($LASTEXITCODE -ne 0) {
        throw 'Failed to restart the isolated real-provider service.'
    }
    $null = Wait-ServiceReady -ReadyTimeoutSeconds 90

    $snapshotResponse = Invoke-ServiceRequest -Method GET -Path '/mail/snapshot'
    $persistedSession = @($snapshotResponse.snapshot.sessions | Where-Object { [string]$_.id -eq [string]$recipientSession.id }) | Select-Object -First 1
    if ($null -eq $persistedSession) {
        throw 'Released mailbox session was not restored after restart.'
    }
    if ([string]$persistedSession.emailAddress -ne [string]$recipientSession.emailAddress) {
        throw 'Restart readback changed the mailbox address.'
    }
    if ([string]$persistedSession.metadata.releaseStatus -ne 'released') {
        throw 'Restart readback lost release metadata.'
    }
    $persistedMessages = @($snapshotResponse.snapshot.messages | Where-Object {
        $persistedSessionId = [string](Get-EasyEmailConfigValue -Object $_ -Name 'sessionId' -Default '')
        $persistedSubject = [string](Get-EasyEmailConfigValue -Object $_ -Name 'subject' -Default '')
        $persistedTextBody = [string](Get-EasyEmailConfigValue -Object $_ -Name 'textBody' -Default '')
        $persistedHtmlBody = [string](Get-EasyEmailConfigValue -Object $_ -Name 'htmlBody' -Default '')
        $persistedSessionId -eq [string]$recipientSession.id -and
        $persistedSubject.Contains($marker) -and
        ($persistedTextBody.Contains($expectedCode) -or $persistedHtmlBody.Contains($expectedCode))
    })
    if ($persistedMessages.Count -lt 1) {
        throw 'Restart readback lost the controlled observed message.'
    }

    $previousErrorActionPreference = $ErrorActionPreference
    $containerLogsExitCode = 1
    try {
        $ErrorActionPreference = 'Continue'
        $containerLogs = (& docker logs $containerName 2>&1 | Out-String)
        $containerLogsExitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    if ($containerLogsExitCode -ne 0) {
        throw 'Failed to read isolated service logs for redaction validation.'
    }
    $launchLogs = if (Test-Path -LiteralPath $launchLogPath) { Get-Content -LiteralPath $launchLogPath -Raw } else { '' }
    if ((Test-ContainsSensitiveValue -Text $containerLogs) -or (Test-ContainsSensitiveValue -Text $launchLogs)) {
        throw 'Real-provider validation output leaked a configured credential.'
    }

    $result = [ordered]@{
        schemaVersion = 1
        providerTypeKey = 'cloudflare_temp_email'
        authenticatedCatalog = $true
        providerReadiness = [ordered]@{
            activeProbe = $true
            reportedDomainsAvailable = ($providerReportedDomains.Count -gt 0)
            configuredSenderDomainSelected = $configuredSenderDomainSelected
        }
        mailboxCreate = $true
        sendDeliveryMode = [string]$sendResponse.result.deliveryMode
        verificationCodeMatched = ([string]$codeResult.code -eq $expectedCode)
        observedBodyMatched = $true
        release = [ordered]@{
            upstreamReleased = [bool]$releaseResult.released
            localStatus = [string]$releaseResult.session.metadata.releaseStatus
            detail = [string]$releaseResult.detail
        }
        restartReadback = [ordered]@{
            sessionRestored = $true
            messageRestored = $true
        }
        credentialScan = 'passed'
        isolatedHostPort = $HostPort
        existingPort18081Touched = $false
    }
} catch {
    $runFailure = ConvertTo-SafeFailureMessage -Message ([string]$_.Exception.Message)
} finally {
    $cleanupErrors = New-Object System.Collections.Generic.List[string]
    foreach ($pendingRelease in @(
        @{ Session = $senderSession; Released = $senderReleased; Label = 'sender' },
        @{ Session = $recipientSession; Released = $recipientReleased; Label = 'recipient' }
    )) {
        if ($null -eq $pendingRelease.Session -or $pendingRelease.Released -eq $true) {
            continue
        }
        try {
            $cleanupRelease = Invoke-ServiceRequest -Method POST -Path '/mail/mailboxes/release' -Body @{
                sessionId = [string]$pendingRelease.Session.id
                reason = 'm1-real-provider-lifecycle-cleanup'
            }
            if ($cleanupRelease.result.released -ne $true) {
                throw 'upstream_release_not_confirmed'
            }
        } catch {
            $cleanupErrors.Add("Failed to release the isolated validation $($pendingRelease.Label) mailbox.") | Out-Null
        }
    }
    $capturedHostIds = @(
        @($senderSession, $recipientSession) |
            Where-Object { $null -ne $_ } |
            ForEach-Object { [string]$_.hostId }
    )
    foreach ($ownedTarget in $script:OwnedMailboxTargets) {
        if ($capturedHostIds -contains [string]$ownedTarget.HostId) {
            continue
        }
        try {
            $uncertainSessions = @(Find-OwnedOpenMailboxes `
                -HostId ([string]$ownedTarget.HostId) `
                -PreferredInstanceId ([string]$ownedTarget.PreferredInstanceId) `
                -WaitSeconds 30)
            foreach ($uncertainSession in $uncertainSessions) {
                $uncertainRelease = Invoke-ServiceRequest -Method POST -Path '/mail/mailboxes/release' -Body @{
                    sessionId = [string]$uncertainSession.id
                    reason = 'm1-real-provider-lifecycle-uncertain-open-cleanup'
                }
                if ($uncertainRelease.result.released -ne $true) {
                    throw 'upstream_uncertain_open_release_not_confirmed'
                }
            }
        } catch {
            $cleanupErrors.Add('Failed to reconcile and release an uncertain mailbox open result.') | Out-Null
        }
    }
    try {
        $matchingContainers = @(& docker ps -a --filter "name=$containerName" --format '{{.Names}}')
        if ($LASTEXITCODE -ne 0) {
            throw 'container_lookup_failed'
        }
        if ($matchingContainers -contains $containerName) {
            & docker rm -f $containerName *> $null
            if ($LASTEXITCODE -ne 0) {
                throw 'container_remove_failed'
            }
        }
    } catch {
        $cleanupErrors.Add('Failed to remove the isolated validation container.') | Out-Null
    }
    try {
        $matchingNetworks = @(& docker network ls --filter "name=$networkName" --format '{{.Name}}')
        if ($LASTEXITCODE -ne 0) {
            throw 'network_lookup_failed'
        }
        if ($matchingNetworks -contains $networkName) {
            & docker network rm $networkName *> $null
            if ($LASTEXITCODE -ne 0) {
                throw 'network_remove_failed'
            }
        }
    } catch {
        $cleanupErrors.Add('Failed to remove the isolated validation network.') | Out-Null
    }
    try {
        Remove-IsolatedRuntimeRoot -Path $runtimeRoot -CleanupImage $effectiveImage
    } catch {
        $cleanupErrors.Add('Failed to remove the isolated validation runtime root.') | Out-Null
    }
    try {
        if (Test-Path -LiteralPath $launchLogPath) {
            Remove-Item -LiteralPath $launchLogPath -Force
        }
    } catch {
        $cleanupErrors.Add('Failed to remove the isolated validation launch log.') | Out-Null
    }
    try {
        if ($ownsImage) {
            & docker image rm $effectiveImage *> $null
            if ($LASTEXITCODE -ne 0) {
                throw 'image_remove_failed'
            }
        }
    } catch {
        $cleanupErrors.Add('Failed to remove the isolated validation image.') | Out-Null
    }
    if ($cleanupErrors.Count -gt 0) {
        $cleanupFailure = $cleanupErrors -join ' '
    }
}

if (-not [string]::IsNullOrWhiteSpace($cleanupFailure)) {
    if (-not [string]::IsNullOrWhiteSpace($runFailure)) {
        throw "$runFailure Cleanup also failed: $cleanupFailure"
    }
    throw $cleanupFailure
}
if (-not [string]::IsNullOrWhiteSpace($runFailure)) {
    throw $runFailure
}
if ($null -eq $result) {
    throw 'Real-provider validation completed without a result.'
}

$resultJson = $result | ConvertTo-Json -Depth 8
if (-not [string]::IsNullOrWhiteSpace($ResultOutputPath)) {
    $resolvedResultOutputPath = Resolve-EasyEmailPath -Path $ResultOutputPath
    $resultDirectory = Split-Path -Parent $resolvedResultOutputPath
    if (-not [string]::IsNullOrWhiteSpace($resultDirectory)) {
        New-Item -ItemType Directory -Force -Path $resultDirectory | Out-Null
    }
    Set-Content -LiteralPath $resolvedResultOutputPath -Value $resultJson -Encoding UTF8
}
$resultJson
