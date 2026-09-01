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

function Get-SensitiveConfigValues {
    param(
        [object]$Value,
        [string]$PropertyName = ''
    )

    $values = New-Object System.Collections.Generic.List[string]
    if ($null -eq $Value) {
        return @()
    }

    if ($Value -is [System.Management.Automation.PSCustomObject]) {
        foreach ($property in $Value.PSObject.Properties) {
            foreach ($nested in @(Get-SensitiveConfigValues -Value $property.Value -PropertyName $property.Name)) {
                $values.Add([string]$nested) | Out-Null
            }
        }
        return @($values)
    }

    if ($Value -is [System.Collections.IDictionary]) {
        foreach ($key in $Value.Keys) {
            foreach ($nested in @(Get-SensitiveConfigValues -Value $Value[$key] -PropertyName ([string]$key))) {
                $values.Add([string]$nested) | Out-Null
            }
        }
        return @($values)
    }

    if ($Value -is [System.Collections.IEnumerable] -and -not ($Value -is [string])) {
        foreach ($item in $Value) {
            foreach ($nested in @(Get-SensitiveConfigValues -Value $item -PropertyName $PropertyName)) {
                $values.Add([string]$nested) | Out-Null
            }
        }
        return @($values)
    }

    if ($PropertyName -match '(?i)(api.?key|custom.?auth|admin.?auth|private.?key|signing.?key|encryption.?key|access.?key|client.?secret|credential|token|secret|password|cookie)') {
        $text = [string]$Value
        if (-not [string]::IsNullOrWhiteSpace($text)) {
            $values.Add($text) | Out-Null
        }
    }
    return @($values)
}

$sensitiveValues = @(
    Get-SensitiveConfigValues -Value $config |
        Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) } |
        Select-Object -Unique
)

function Invoke-ServiceRequest {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet('GET', 'POST')]
        [string]$Method,
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [object]$Body = $null,
        [int]$RequestTimeoutSeconds = 60
    )

    $headers = @{ Authorization = "Bearer $script:ServiceApiKey" }
    $uri = $script:ServiceBaseUrl + $Path
    try {
        if ($Method -eq 'GET') {
            return Invoke-RestMethod -Method Get -Uri $uri -Headers $headers -TimeoutSec $RequestTimeoutSeconds
        }
        $headers['Content-Type'] = 'application/json'
        return Invoke-RestMethod `
            -Method Post `
            -Uri $uri `
            -Headers $headers `
            -Body ($Body | ConvertTo-Json -Depth 12) `
            -TimeoutSec $RequestTimeoutSeconds
    } catch {
        $requestError = $_
        $statusCode = ''
        $serviceErrorCode = ''
        if ($null -ne $requestError.Exception.Response -and $null -ne $requestError.Exception.Response.StatusCode) {
            $statusCode = [string][int]$requestError.Exception.Response.StatusCode
        }
        $errorPayloadText = [string]$requestError.ErrorDetails.Message
        if (
            [string]::IsNullOrWhiteSpace($errorPayloadText) -and
            $null -ne $requestError.Exception.Response -and
            $null -ne $requestError.Exception.Response.PSObject.Methods['GetResponseStream']
        ) {
            try {
                $reader = New-Object System.IO.StreamReader($requestError.Exception.Response.GetResponseStream())
                try {
                    $errorPayloadText = $reader.ReadToEnd()
                } finally {
                    $reader.Dispose()
                }
            } catch {
                $errorPayloadText = ''
            }
        }
        if (-not [string]::IsNullOrWhiteSpace($errorPayloadText)) {
            try {
                $errorPayload = $errorPayloadText | ConvertFrom-Json
                $errorEnvelope = Get-EasyEmailConfigValue -Object $errorPayload -Name 'error' -Default $null
                $serviceErrorCode = [string](Get-EasyEmailConfigValue `
                    -Object $errorEnvelope `
                    -Name 'code' `
                    -Default (Get-EasyEmailConfigValue -Object $errorPayload -Name 'code' -Default ''))
                if (
                    [string]::IsNullOrWhiteSpace($serviceErrorCode) -and
                    $errorEnvelope -is [string] -and
                    [string]$errorEnvelope -match '^Cloudflare Temp Email newAddress failed with status ([0-9]{3})(?:[:.]|$)'
                ) {
                    $providerStatus = $Matches[1]
                    $providerErrorText = [string]$errorEnvelope
                    $providerFailureKind = if ($providerErrorText -match '(?i)(Invalid domain|无效的域名)') {
                        'INVALID_DOMAIN'
                    } elseif ($providerErrorText -match '(?i)(Human verification check failed|人机验证检查失败)') {
                        'TURNSTILE'
                    } elseif ($providerErrorText -match '(?i)(Name is too (long|short)|名称太(长|短))') {
                        'INVALID_NAME'
                    } elseif ($providerErrorText -match '(?i)(Address already exists|邮箱地址已存在|UNIQUE constraint)') {
                        'CONFLICT'
                    } elseif ($providerErrorText -match '(?i)(D1_|SQLITE|database)') {
                        'STORAGE'
                    } else {
                        'UNCLASSIFIED'
                    }
                    $serviceErrorCode = "CLOUDFLARE_TEMP_EMAIL_NEW_ADDRESS_${providerFailureKind}_HTTP_$providerStatus"
                }
                if (
                    [string]::IsNullOrWhiteSpace($serviceErrorCode) -and
                    $errorEnvelope -is [string] -and
                    [string]$errorEnvelope -match '^Cloudflare Temp Email (admin )?sendMail failed with status ([0-9]{3})(?:[:.]|$)'
                ) {
                    $sendOperation = if ($Matches[1]) { 'ADMIN_SEND' } else { 'MAILBOX_SEND' }
                    $sendStatus = $Matches[2]
                    $sendErrorText = [string]$errorEnvelope
                    $sendFailureKind = if ($sendErrorText -match '(?i)(Invalid domain|无效的域名)') {
                        'INVALID_DOMAIN'
                    } elseif ($sendErrorText -match '(?i)(No balance|余额不足)') {
                        'NO_BALANCE'
                    } elseif ($sendErrorText -match '(?i)(Resend error)') {
                        'RESEND'
                    } elseif ($sendErrorText -match '(?i)(Please enable resend|请先为此域名启用)') {
                        'TRANSPORT_DISABLED'
                    } elseif ($sendErrorText -match '(?i)(daily send quota|monthly send quota|发信次数已达上限)') {
                        'QUOTA'
                    } else {
                        'UNCLASSIFIED'
                    }
                    $serviceErrorCode = "CLOUDFLARE_TEMP_EMAIL_${sendOperation}_${sendFailureKind}_HTTP_$sendStatus"
                }
            } catch {
                $serviceErrorCode = ''
            }
        }
        $statusSuffix = if ($statusCode) { " status=$statusCode" } else { '' }
        $codeSuffix = if ($serviceErrorCode) { " code=$serviceErrorCode" } else { '' }
        throw "EasyEmail request failed: $Method $Path$statusSuffix$codeSuffix"
    }
}

function Wait-ServiceReady {
    param([int]$ReadyTimeoutSeconds = 60)

    $deadline = [DateTime]::UtcNow.AddSeconds($ReadyTimeoutSeconds)
    do {
        try {
            $catalog = Invoke-ServiceRequest -Method GET -Path '/mail/catalog' -RequestTimeoutSeconds 5
            $providerKeys = @($catalog.catalog.providerTypes | ForEach-Object { [string]$_.key })
            if ($providerKeys -contains 'cloudflare_temp_email') {
                $instancesResponse = Invoke-ServiceRequest `
                    -Method GET `
                    -Path '/mail/query/provider-instances?providerTypeKey=cloudflare_temp_email&limit=20' `
                    -RequestTimeoutSeconds 10
                $activeInstances = @($instancesResponse.instances | Where-Object {
                    [string]$_.providerTypeKey -eq 'cloudflare_temp_email' -and
                    [string]$_.status -eq 'active'
                })
                foreach ($instance in $activeInstances) {
                    $instanceId = [string]$instance.id
                    if ([string]::IsNullOrWhiteSpace($instanceId)) {
                        continue
                    }
                    $escapedInstanceId = [Uri]::EscapeDataString($instanceId)
                    $probeResponse = Invoke-ServiceRequest `
                        -Method GET `
                        -Path "/mail/providers/$escapedInstanceId/probe" `
                        -RequestTimeoutSeconds 30
                    if (
                        $probeResponse.probe.ok -eq $true -and
                        [string]$probeResponse.probe.status -eq 'active' -and
                        [double]$probeResponse.probe.healthScore -ge 0.3
                    ) {
                        $refreshedInstances = Invoke-ServiceRequest `
                            -Method GET `
                            -Path '/mail/query/provider-instances?providerTypeKey=cloudflare_temp_email&limit=20' `
                            -RequestTimeoutSeconds 10
                        $refreshedInstance = @($refreshedInstances.instances | Where-Object {
                            [string]$_.id -eq $instanceId
                        }) | Select-Object -First 1
                        $reportedDomains = New-Object System.Collections.Generic.List[string]
                        if ($null -ne $refreshedInstance) {
                            $metadata = Get-EasyEmailConfigValue -Object $refreshedInstance -Name 'metadata' -Default $null
                            $domainsJson = [string](Get-EasyEmailConfigValue `
                                -Object $metadata `
                                -Name 'providerDefaultDomainsJson' `
                                -Default (Get-EasyEmailConfigValue -Object $metadata -Name 'domainsJson' -Default ''))
                            if (-not [string]::IsNullOrWhiteSpace($domainsJson)) {
                                try {
                                    foreach ($domain in @($domainsJson | ConvertFrom-Json)) {
                                        $normalizedDomain = [string]$domain
                                        if (-not [string]::IsNullOrWhiteSpace($normalizedDomain)) {
                                            $reportedDomains.Add($normalizedDomain.Trim().ToLowerInvariant()) | Out-Null
                                        }
                                    }
                                } catch {
                                    $reportedDomains.Clear()
                                }
                            }
                            if ($reportedDomains.Count -eq 0) {
                                $domainsCsv = [string](Get-EasyEmailConfigValue `
                                    -Object $metadata `
                                    -Name 'providerDefaultDomains' `
                                    -Default (Get-EasyEmailConfigValue -Object $metadata -Name 'domains' -Default ''))
                                foreach ($domain in $domainsCsv -split '[,;\r\n|]') {
                                    if (-not [string]::IsNullOrWhiteSpace($domain)) {
                                        $reportedDomains.Add($domain.Trim().ToLowerInvariant()) | Out-Null
                                    }
                                }
                            }
                        }
                        return [pscustomobject]@{
                            InstanceId = $instanceId
                            Domains = @($reportedDomains | Select-Object -Unique)
                        }
                    }
                }
            }
        } catch {
            # Retry until the isolated runtime is ready or the bounded deadline expires.
        }
        Start-Sleep -Seconds 1
    } while ([DateTime]::UtcNow -lt $deadline)

    throw 'Isolated EasyEmail service did not expose a healthy active cloudflare_temp_email instance.'
}

function Open-CloudflareMailbox {
    param(
        [Parameter(Mandatory = $true)]
        [string]$HostId,
        [Parameter(Mandatory = $true)]
        [string]$PreferredInstanceId,
        [string]$RequestedDomain = ''
    )

    $script:OwnedMailboxTargets.Add([pscustomobject]@{
        HostId = $HostId
        PreferredInstanceId = $PreferredInstanceId
    }) | Out-Null

    $body = @{
        hostId = $HostId
        provisionMode = 'reuse-only'
        bindingMode = 'shared-instance'
        providerTypeKey = 'cloudflare_temp_email'
        preferredInstanceId = $PreferredInstanceId
        ttlMinutes = 30
        metadata = @{ source = 'm1-real-provider-lifecycle' }
    }
    if (-not [string]::IsNullOrWhiteSpace($RequestedDomain)) {
        $body.requestedDomain = $RequestedDomain.Trim().ToLowerInvariant()
    }
    try {
        $response = Invoke-ServiceRequest -Method POST -Path '/mail/mailboxes/open' -Body $body -RequestTimeoutSeconds 30
    } catch {
        $openFailure = $_
        $recoveredSessions = @(Find-OwnedOpenMailboxes `
            -HostId $HostId `
            -PreferredInstanceId $PreferredInstanceId `
            -WaitSeconds 5)
        if ($recoveredSessions.Count -gt 0) {
            return $recoveredSessions[0]
        }
        throw $openFailure
    }
    $openResult = Get-EasyEmailConfigValue -Object $response -Name 'result' -Default $null
    $openSession = Get-EasyEmailConfigValue -Object $openResult -Name 'session' -Default $null
    $openSessionId = [string](Get-EasyEmailConfigValue -Object $openSession -Name 'id' -Default '')
    if ($null -eq $openSession -or [string]::IsNullOrWhiteSpace($openSessionId)) {
        $recoveredSessions = @(Find-OwnedOpenMailboxes `
            -HostId $HostId `
            -PreferredInstanceId $PreferredInstanceId `
            -WaitSeconds 5)
        if ($recoveredSessions.Count -gt 0) {
            return $recoveredSessions[0]
        }
        throw 'Real provider mailbox open did not return a canonical session.'
    }
    return $openSession
}

function Find-OwnedOpenMailboxes {
    param(
        [Parameter(Mandatory = $true)]
        [string]$HostId,
        [Parameter(Mandatory = $true)]
        [string]$PreferredInstanceId,
        [int]$WaitSeconds = 0
    )

    $escapedHostId = [Uri]::EscapeDataString($HostId)
    $escapedInstanceId = [Uri]::EscapeDataString($PreferredInstanceId)
    $path = "/mail/query/mailbox-sessions?hostId=$escapedHostId&providerTypeKey=cloudflare_temp_email&providerInstanceId=$escapedInstanceId&status=open&limit=20&newestFirst=true"
    $deadline = [DateTime]::UtcNow.AddSeconds([Math]::Max(0, $WaitSeconds))
    $querySucceeded = $false
    do {
        try {
            $response = Invoke-ServiceRequest -Method GET -Path $path -RequestTimeoutSeconds 10
            $querySucceeded = $true
            $sessions = @($response.sessions | Where-Object {
                [string]$_.hostId -eq $HostId -and
                [string]$_.providerTypeKey -eq 'cloudflare_temp_email' -and
                [string]$_.providerInstanceId -eq $PreferredInstanceId -and
                [string]$_.status -eq 'open'
            })
            if ($sessions.Count -gt 0) {
                return @($sessions)
            }
        } catch {
            # A timed-out open can overlap service work; retry until the bounded cleanup deadline.
        }
        if ([DateTime]::UtcNow -ge $deadline) {
            break
        }
        Start-Sleep -Seconds 1
    } while ($true)

    if (-not $querySucceeded) {
        throw 'Failed to reconcile an owned mailbox after an uncertain open result.'
    }
    return @()
}

function Wait-ExpectedCode {
    param(
        [Parameter(Mandatory = $true)]
        [string]$SessionId,
        [Parameter(Mandatory = $true)]
        [string]$ExpectedCode
    )

    $escapedSessionId = [Uri]::EscapeDataString($SessionId)
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        try {
            $response = Invoke-ServiceRequest -Method GET -Path "/mail/mailboxes/$escapedSessionId/code" -RequestTimeoutSeconds 30
            if ($null -ne $response.code -and [string]$response.code.code -eq $ExpectedCode) {
                return $response.code
            }
        } catch {
            # Provider delivery is asynchronous; keep polling inside the explicit timeout.
        }
        if ([DateTime]::UtcNow -ge $deadline) {
            break
        }
        Start-Sleep -Seconds $PollIntervalSeconds
    } while ([DateTime]::UtcNow -lt $deadline)

    throw 'Timed out waiting for the controlled verification code.'
}

function Wait-PersistedLifecycleState {
    param(
        [Parameter(Mandatory = $true)]
        [string]$SessionId,
        [Parameter(Mandatory = $true)]
        [string]$Marker,
        [Parameter(Mandatory = $true)]
        [string]$ExpectedCode
    )

    $stateFilePath = Join-Path $runtimeRoot 'data/state/easy-email-state.json'
    $deadline = [DateTime]::UtcNow.AddMilliseconds([Math]::Max(30000, $persistenceIntervalMs + 30000))
    do {
        if (Test-Path -LiteralPath $stateFilePath -PathType Leaf) {
            try {
                $persistedSnapshot = Get-Content -LiteralPath $stateFilePath -Raw | ConvertFrom-Json
                $persistedSession = @($persistedSnapshot.sessions | Where-Object {
                    [string](Get-EasyEmailConfigValue -Object $_ -Name 'id' -Default '') -eq $SessionId
                }) | Select-Object -First 1
                $persistedMessage = @($persistedSnapshot.messages | Where-Object {
                    $messageSessionId = [string](Get-EasyEmailConfigValue -Object $_ -Name 'sessionId' -Default '')
                    $messageSubject = [string](Get-EasyEmailConfigValue -Object $_ -Name 'subject' -Default '')
                    $messageTextBody = [string](Get-EasyEmailConfigValue -Object $_ -Name 'textBody' -Default '')
                    $messageHtmlBody = [string](Get-EasyEmailConfigValue -Object $_ -Name 'htmlBody' -Default '')
                    $messageSessionId -eq $SessionId -and
                    $messageSubject.Contains($Marker) -and
                    ($messageTextBody.Contains($ExpectedCode) -or $messageHtmlBody.Contains($ExpectedCode))
                }) | Select-Object -First 1
                $releaseStatus = [string](Get-EasyEmailConfigValue `
                    -Object (Get-EasyEmailConfigValue -Object $persistedSession -Name 'metadata' -Default $null) `
                    -Name 'releaseStatus' `
                    -Default '')
                if ($null -ne $persistedSession -and $null -ne $persistedMessage -and $releaseStatus -eq 'released') {
                    return
                }
            } catch {
                # The persistence loop writes through a temporary file; retry boundedly while the snapshot settles.
            }
        }
        Start-Sleep -Seconds 1
    } while ([DateTime]::UtcNow -lt $deadline)

    throw 'Timed out waiting for the released mailbox and observed message to reach persistent storage.'
}

function Test-ContainsSensitiveValue {
    param([string]$Text)

    foreach ($secret in $sensitiveValues) {
        if ($Text.Contains([string]$secret)) {
            return $true
        }
    }
    return $false
}

function ConvertTo-SafeFailureMessage {
    param([string]$Message)

    if ([string]::IsNullOrWhiteSpace($Message)) {
        return 'Real-provider validation failed: LOCAL_UNCLASSIFIED'
    }

    $safeMessage = $Message
    foreach ($sensitiveValue in @($sensitiveValues) + @($providerBaseUrl, $providerDomain, $senderDomain)) {
        if (-not [string]::IsNullOrWhiteSpace([string]$sensitiveValue)) {
            $safeMessage = $safeMessage.Replace([string]$sensitiveValue, '[REDACTED_SECRET]')
        }
    }
    $safeMessage = $safeMessage `
        -replace '(?i)Bearer\s+[A-Za-z0-9._~+/=-]+', 'Bearer [REDACTED_SECRET]' `
        -replace '(?i)\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}(?:\.[A-Za-z0-9_-]{8,})?\b', '[REDACTED_SECRET]' `
        -replace '(?i)https?://[^\s"'']+', '[REDACTED_URL]' `
        -replace '(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b', '[REDACTED_EMAIL]' `
        -replace '[\r\n]+', ' '
    if ($safeMessage.Length -gt 400) {
        $safeMessage = $safeMessage.Substring(0, 400) + '...'
    }

    if ($safeMessage -match "(?i)property '([A-Za-z][A-Za-z0-9_]*)' cannot be found") {
        return "Real-provider validation failed: LOCAL_PROPERTY_MISSING_$($Matches[1].ToUpperInvariant())"
    }
    if ($safeMessage -match '(?i)(cannot bind argument|parameter binding validation|cannot convert value)') {
        return 'Real-provider validation failed: LOCAL_PARAMETER_BINDING'
    }
    if ($safeMessage -match '(?i)(null-valued expression|method invocation failed)') {
        return 'Real-provider validation failed: LOCAL_NULL_VALUE'
    }
    if ($safeMessage -match '^Cloudflare Temp Email') {
        return 'Real-provider validation failed: PROVIDER_ERROR_REDACTED'
    }
    if ($safeMessage -match '^(EasyEmail request failed|Timed out|Observed-message|Restart readback|Failed to|Real provider|Real-provider|Isolated EasyEmail|Mailbox release)') {
        return $safeMessage
    }
    return "Real-provider validation failed: $safeMessage"
}

function Remove-IsolatedRuntimeRoot {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [Parameter(Mandatory = $true)]
        [string]$CleanupImage
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        return
    }
    $allowedRoot = [System.IO.Path]::GetFullPath((Join-Path $workspaceRoot '.tmp/service-base-real'))
    $resolvedPath = [System.IO.Path]::GetFullPath($Path)
    if (-not $resolvedPath.StartsWith($allowedRoot + [System.IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to remove runtime root outside the isolated validation directory: $resolvedPath"
    }

    try {
        Remove-Item -LiteralPath $resolvedPath -Recurse -Force
        return
    } catch {
        $mountSpec = "${resolvedPath}:/runtime"
        $cleanupScript = 'from pathlib import Path; import shutil; [shutil.rmtree(p) if p.is_dir() and not p.is_symlink() else p.unlink() for p in Path("/runtime").iterdir()]'
        & docker run --rm --pull never --network none --user 0 --entrypoint /usr/bin/python3 -v $mountSpec $CleanupImage -c $cleanupScript *> $null
        if ($LASTEXITCODE -ne 0) {
            throw 'Docker-owned isolated runtime files could not be cleared.'
        }
        Remove-Item -LiteralPath $resolvedPath -Recurse -Force
    }
}

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

    $containerLogs = (& docker logs $containerName 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0) {
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
