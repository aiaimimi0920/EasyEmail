param(
    [string]$BaseUrl = "http://127.0.0.1:18090",
    [string]$ConfigPath = "config.yaml",
    [string]$ApiKey = "",
    [string[]]$Providers = @(
        "cloudflare_temp_email",
        "mailtm",
        "duckmail",
        "guerrillamail",
        "tempmail-lol",
        "etempmail",
        "moemail",
        "m2u",
        "gptmail",
        "mail2925",
        "im215"
    ),
    [string]$SenderRequestedDomain = "",
    [string]$SenderRequestedLocalPart = "",
    [switch]$UseRandomSenderSubdomain,
    [switch]$SkipRecipientVerification,
    [switch]$ForceRecipientVerification,
    [int]$SenderRetryCount = 6,
    [int]$AuthLinkTimeoutSeconds = 300,
    [int]$VerificationTimeoutSeconds = 120,
    [int]$PostVerificationSettlingSeconds = 90,
    [int]$CodeTimeoutSeconds = 180,
    [int]$PollIntervalSeconds = 8,
    [int]$RecipientRetryCount = 3,
    [int]$RecipientRetryDelaySeconds = 8,
    [int]$ProviderRetryCount = 1,
    [int]$ProviderRetryDelaySeconds = 10,
    [switch]$IsolateTemplateMailbox,
    [string]$ResultOutputPath = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot 'lib/easyemail-config.ps1')

function Get-ConfigSectionValue {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Object,
        [Parameter(Mandatory = $true)]
        [string]$Name,
        $Default = $null
    )

    return Get-EasyEmailConfigValue -Object $Object -Name $Name -Default $Default
}

function Convert-ToMatrixStringArray {
    param(
        $Value
    )

    if ($null -eq $Value) {
        return @()
    }

    if ($Value -is [System.Collections.IEnumerable] -and -not ($Value -is [string])) {
        return @($Value | ForEach-Object { [string]$_ } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    }

    $text = [string]$Value
    if ([string]::IsNullOrWhiteSpace($text)) {
        return @()
    }

    return @($text -split '[,\r\n]+' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
}

function Invoke-PlaywrightCli {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    $sessionArguments = @('-s=default') + $Arguments
    $output = & npx --yes @playwright/cli@latest @sessionArguments
    if ($LASTEXITCODE -ne 0) {
        throw "Playwright CLI failed: $($sessionArguments -join ' ')"
    }
    return ($output | Out-String).Trim()
}

function Invoke-EasyEmailRequest {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet("GET", "POST")]
        [string]$Method,
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [object]$Body = $null
    )

    $headers = @{}
    if (-not [string]::IsNullOrWhiteSpace($script:ApiKeyValue)) {
        $headers["Authorization"] = "Bearer $script:ApiKeyValue"
    }

    $uri = $script:NormalizedBaseUrl + $Path
    if ($Method -eq "GET") {
        return Invoke-RestMethod -Uri $uri -Method Get -Headers $headers -TimeoutSec 60
    }

    $headers["Content-Type"] = "application/json"
    return Invoke-RestMethod -Uri $uri -Method Post -Headers $headers -Body ($Body | ConvertTo-Json -Depth 12) -TimeoutSec 180
}

function Get-ExceptionMessage {
    param(
        [Parameter(Mandatory = $true)]
        [System.Management.Automation.ErrorRecord]$ErrorRecord
    )

    $message = $ErrorRecord.Exception.Message
    if ($ErrorRecord.ErrorDetails) {
        $detailProperty = $ErrorRecord.ErrorDetails.PSObject.Properties['Message']
        if ($null -ne $detailProperty -and -not [string]::IsNullOrWhiteSpace([string]$detailProperty.Value)) {
            $message = "$message :: $($detailProperty.Value)"
        }
    }

    return $message
}

function Resolve-CloudflareAccountId {
    if (-not [string]::IsNullOrWhiteSpace($script:CloudflareAccountId)) {
        return $script:CloudflareAccountId
    }

    $response = Invoke-RestMethod -Uri 'https://api.cloudflare.com/client/v4/accounts' -Headers $script:CloudflareApiHeaders -Method Get
    $accountId = [string]($response.result[0].id)
    if ([string]::IsNullOrWhiteSpace($accountId)) {
        throw 'Unable to resolve Cloudflare account id from /accounts.'
    }

    $script:CloudflareAccountId = $accountId
    return $script:CloudflareAccountId
}

function Get-CloudflareDestinationAddress {
    param(
        [Parameter(Mandatory = $true)]
        [string]$EmailAddress
    )

    $accountId = Resolve-CloudflareAccountId
    $response = Invoke-RestMethod -Uri "https://api.cloudflare.com/client/v4/accounts/$accountId/email/routing/addresses" -Headers $script:CloudflareApiHeaders -Method Get
    $matches = @($response.result | Where-Object { $_.email -eq $EmailAddress } | Select-Object -First 1)
    if ($matches.Count -eq 0) {
        return $null
    }
    return $matches[0]
}

function New-CloudflareDestinationAddress {
    param(
        [Parameter(Mandatory = $true)]
        [string]$EmailAddress
    )

    $accountId = Resolve-CloudflareAccountId
    $response = Invoke-RestMethod `
        -Uri "https://api.cloudflare.com/client/v4/accounts/$accountId/email/routing/addresses" `
        -Headers $script:CloudflareApiHeaders `
        -Method Post `
        -Body (@{ email = $EmailAddress } | ConvertTo-Json)
    return $response.result
}

function Get-CloudflareDestinationAddressById {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Id
    )

    $accountId = Resolve-CloudflareAccountId
    $response = Invoke-RestMethod -Uri "https://api.cloudflare.com/client/v4/accounts/$accountId/email/routing/addresses/$Id" -Headers $script:CloudflareApiHeaders -Method Get
    return $response.result
}

function Wait-AuthenticationLink {
    param(
        [Parameter(Mandatory = $true)]
        [string]$SessionId,
        [int]$TimeoutSeconds = 300
    )

    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        try {
            $response = Invoke-EasyEmailRequest -Method GET -Path "/mail/mailboxes/$SessionId/auth-link"
            if ($response.authLink.url) {
                return $response.authLink
            }
        } catch {
            # Keep polling until timeout.
        }
        Start-Sleep -Seconds $PollIntervalSeconds
    } while ([DateTime]::UtcNow -lt $deadline)

    throw "Timed out waiting for authentication link for session $SessionId."
}

function Invoke-CloudflareVerificationLink {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Url,
        [int]$TimeoutSeconds = 180
    )

    Start-Process $Url | Out-Null
    Start-Sleep -Seconds ([Math]::Min([Math]::Max(5, $TimeoutSeconds), 8))
}

function Ensure-VerifiedDestinationAddress {
    param(
        [Parameter(Mandatory = $true)]
        [psobject]$MailboxSession
    )

    $destination = Get-CloudflareDestinationAddress -EmailAddress $MailboxSession.emailAddress
    if (-not $destination) {
        $destination = New-CloudflareDestinationAddress -EmailAddress $MailboxSession.emailAddress
    }

    if ([string]$destination.status -eq 'verified' -or -not [string]::IsNullOrWhiteSpace([string]$destination.verified)) {
        return $destination
    }

    $authLink = Wait-AuthenticationLink -SessionId $MailboxSession.id -TimeoutSeconds $AuthLinkTimeoutSeconds
    Invoke-CloudflareVerificationLink -Url $authLink.url

    $deadline = [DateTime]::UtcNow.AddSeconds($VerificationTimeoutSeconds)
    do {
        $current = Get-CloudflareDestinationAddressById -Id ([string]$destination.id)
        if ([string]$current.status -eq 'verified' -or -not [string]::IsNullOrWhiteSpace([string]$current.verified)) {
            if ($PostVerificationSettlingSeconds -gt 0) {
                Start-Sleep -Seconds $PostVerificationSettlingSeconds
            }
            return $current
        }
        Start-Sleep -Seconds 5
    } while ([DateTime]::UtcNow -lt $deadline)

    throw "Destination address $($MailboxSession.emailAddress) did not reach verified state."
}

function Open-MailboxSession {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ProviderTypeKey,
        [Parameter(Mandatory = $true)]
        [string]$HostId,
        [string]$RequestedDomain = '',
        [string]$RequestedLocalPart = '',
        [switch]$RequestRandomSubdomain
    )

    $body = @{
        hostId = $HostId
        providerTypeKey = $ProviderTypeKey
        provisionMode = 'reuse-only'
        bindingMode = 'shared-instance'
        ttlMinutes = 30
        fromContains = 'cloudflare'
        requestRandomSubdomain = [bool]$RequestRandomSubdomain
    }
    if (-not [string]::IsNullOrWhiteSpace($RequestedDomain)) {
        $body.requestedDomain = $RequestedDomain.Trim().ToLowerInvariant()
    }
    if (-not [string]::IsNullOrWhiteSpace($RequestedLocalPart)) {
        $body.requestedLocalPart = $RequestedLocalPart.Trim()
    }

    $response = Invoke-EasyEmailRequest -Method POST -Path '/mail/mailboxes/open' -Body $body
    return $response.result.session
}

function Recover-MailboxSessionByEmail {
    param(
        [Parameter(Mandatory = $true)]
        [string]$EmailAddress,
        [Parameter(Mandatory = $true)]
        [string]$ProviderTypeKey,
        [Parameter(Mandatory = $true)]
        [string]$HostId
    )

    $body = @{
        emailAddress = $EmailAddress
        providerTypeKey = $ProviderTypeKey
        hostId = $HostId
    }
    $response = Invoke-EasyEmailRequest -Method POST -Path '/mail/mailboxes/recover-by-email' -Body $body
    if ($response.result.recovered -ne $true -or $null -eq $response.result.session) {
        return $null
    }
    return $response.result.session
}

function Test-ShouldRetryRecipientAddress {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Provider,
        [Parameter(Mandatory = $true)]
        [string]$Message
    )

    $retryableProviders = @('m2u', 'tempmail-lol', 'gptmail')
    if ($retryableProviders -notcontains $Provider.Trim().ToLowerInvariant()) {
        return $false
    }

    return $Message -match 'Timed out waiting for code|Operation failed|MAILBOX_CAPACITY_UNAVAILABLE|PROVIDER_INSTANCE_UNAVAILABLE|Access denied|1010|errorcaptcha|fetch failed|daily_limit_exceeded|rate limit|quota'
}

function Test-ProviderMatrixOnce {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Provider,
        [Parameter(Mandatory = $true)]
        [System.Collections.IEnumerable]$Templates,
        [Parameter(Mandatory = $true)]
        [ref]$SenderSessionRef
    )

    $maxRecipientAttempts = if ($Provider -in @('m2u', 'tempmail-lol', 'gptmail', 'tmailor')) {
        [Math]::Max(1, $RecipientRetryCount)
    } else {
        1
    }

    $useTemplateIsolation = $IsolateTemplateMailbox -or $Provider -eq 'mail2925'

    for ($recipientAttempt = 1; $recipientAttempt -le $maxRecipientAttempts; $recipientAttempt += 1) {
        try {
            if ($useTemplateIsolation) {
                $templateResults = @()
                $firstRecipientSession = $null
                $finalDestinationStatus = 'skipped'

                foreach ($template in $Templates) {
                    $recipientSession = $null
                    $destination = $null
                    try {
                        $recipientSession = Open-MailboxSession -ProviderTypeKey $Provider -HostId ("matrix-$Provider-$($template.key)-$recipientAttempt")
                    } catch {
                        $openMessage = Get-ExceptionMessage -ErrorRecord $_
                        if ($Provider -eq 'moemail' -and $openMessage -match 'MAILBOX_CAPACITY_UNAVAILABLE|最大邮箱数量限制|maximum mailbox|max mailbox') {
                            Write-Host 'MoEmail capacity is exhausted. Triggering provider recovery...' -ForegroundColor Yellow
                            $null = Invoke-ProviderCapacityRecovery -ProviderTypeKey 'moemail'
                            $recipientSession = Open-MailboxSession -ProviderTypeKey $Provider -HostId ("matrix-$Provider-$($template.key)-$recipientAttempt")
                        } else {
                            throw
                        }
                    }

                    if ($null -eq $firstRecipientSession) {
                        $firstRecipientSession = $recipientSession
                    }

                    if (-not $script:SkipRecipientVerificationValue) {
                        $destination = Ensure-VerifiedDestinationAddress -MailboxSession $recipientSession
                        $finalDestinationStatus = $destination.status
                    }

                    $sendResult = Send-MailWithSenderRetries `
                        -SenderSessionRef $SenderSessionRef `
                        -RecipientSessionId $recipientSession.id `
                        -RecipientEmail $recipientSession.emailAddress `
                        -Template $template
                    $codeResult = Wait-VerificationCode -SessionId $recipientSession.id -ExpectedCode $template.expectedCode -TimeoutSeconds $CodeTimeoutSeconds
                    $message = Get-LatestObservedMessage -SessionId $recipientSession.id
                    $templateResults += [pscustomobject]@{
                        template = $template.key
                        expectedCode = $template.expectedCode
                        actualCode = $codeResult.code
                        codeSource = $codeResult.source
                        observedMessageId = $codeResult.observedMessageId
                        deliveryMode = $sendResult.deliveryMode
                        detail = $sendResult.detail
                        hasTextBody = -not [string]::IsNullOrWhiteSpace((Get-MessageFieldText -Message $message -FieldName 'textBody'))
                        hasHtmlBody = -not [string]::IsNullOrWhiteSpace((Get-MessageFieldText -Message $message -FieldName 'htmlBody'))
                        recipientEmail = $recipientSession.emailAddress
                        sessionId = $recipientSession.id
                    }
                }

                return [pscustomobject]@{
                    provider = $Provider
                    ok = $true
                    email = $firstRecipientSession.emailAddress
                    sessionId = $firstRecipientSession.id
                    destinationStatus = $finalDestinationStatus
                    recipientAttempts = $recipientAttempt
                    templates = @($templateResults)
                }
            }

            try {
                $recipientSession = Open-MailboxSession -ProviderTypeKey $Provider -HostId ("matrix-$Provider-$recipientAttempt")
            } catch {
                $openMessage = Get-ExceptionMessage -ErrorRecord $_
                if ($Provider -eq 'moemail' -and $openMessage -match 'MAILBOX_CAPACITY_UNAVAILABLE|最大邮箱数量限制|maximum mailbox|max mailbox') {
                    Write-Host 'MoEmail capacity is exhausted. Triggering provider recovery...' -ForegroundColor Yellow
                    $null = Invoke-ProviderCapacityRecovery -ProviderTypeKey 'moemail'
                    $recipientSession = Open-MailboxSession -ProviderTypeKey $Provider -HostId ("matrix-$Provider-$recipientAttempt")
                } else {
                    throw
                }
            }
            $destination = $null
            if (-not $script:SkipRecipientVerificationValue) {
                $destination = Ensure-VerifiedDestinationAddress -MailboxSession $recipientSession
            }

            $templateResults = @()
            foreach ($template in $Templates) {
                $sendResult = Send-MailWithSenderRetries `
                    -SenderSessionRef $SenderSessionRef `
                    -RecipientSessionId $recipientSession.id `
                    -RecipientEmail $recipientSession.emailAddress `
                    -Template $template
                $codeResult = Wait-VerificationCode -SessionId $recipientSession.id -ExpectedCode $template.expectedCode -TimeoutSeconds $CodeTimeoutSeconds
                $message = Get-LatestObservedMessage -SessionId $recipientSession.id
                $templateResults += [pscustomobject]@{
                    template = $template.key
                    expectedCode = $template.expectedCode
                    actualCode = $codeResult.code
                    codeSource = $codeResult.source
                    observedMessageId = $codeResult.observedMessageId
                    deliveryMode = $sendResult.deliveryMode
                    detail = $sendResult.detail
                    hasTextBody = -not [string]::IsNullOrWhiteSpace((Get-MessageFieldText -Message $message -FieldName 'textBody'))
                    hasHtmlBody = -not [string]::IsNullOrWhiteSpace((Get-MessageFieldText -Message $message -FieldName 'htmlBody'))
                }
            }

            return [pscustomobject]@{
                provider = $Provider
                ok = $true
                email = $recipientSession.emailAddress
                sessionId = $recipientSession.id
                destinationStatus = if ($null -eq $destination) { 'skipped' } else { $destination.status }
                recipientAttempts = $recipientAttempt
                templates = @($templateResults)
            }
        } catch {
            $message = Get-ExceptionMessage -ErrorRecord $_
            if ($recipientAttempt -lt $maxRecipientAttempts -and (Test-ShouldRetryRecipientAddress -Provider $Provider -Message $message)) {
                Write-Host ("Provider {0} recipient attempt {1}/{2} failed ({3}). Reopening recipient mailbox..." -f $Provider, $recipientAttempt, $maxRecipientAttempts, $message) -ForegroundColor Yellow
                Start-Sleep -Seconds $RecipientRetryDelaySeconds
                continue
            }

            return [pscustomobject]@{
                provider = $Provider
                ok = $false
                recipientAttempts = $recipientAttempt
                detail = $message
                errorType = $_.Exception.GetType().FullName
                scriptStackTrace = $_.ScriptStackTrace
            }
        }
    }
}

function Get-EmailDomain {
    param(
        [Parameter(Mandatory = $true)]
        [string]$EmailAddress
    )

    $parts = $EmailAddress.Split('@', 2)
    if ($parts.Count -lt 2) {
        return ''
    }
    return $parts[1].Trim().ToLowerInvariant()
}

function Update-MailboxSessionFilter {
    param(
        [Parameter(Mandatory = $true)]
        [string]$SessionId,
        [string]$FromContains = ''
    )

    $body = @{
        sessionId = $SessionId
        fromContains = $FromContains
    }
    $response = Invoke-EasyEmailRequest -Method POST -Path '/mail/mailboxes/update-session' -Body $body
    return $response.session
}

function Invoke-ProviderCapacityRecovery {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ProviderTypeKey
    )

    $body = @{
        providerTypeKey = $ProviderTypeKey
        force = $true
        maxDeleteCount = 200
        staleAfterSeconds = 0
    }

    return Invoke-EasyEmailRequest -Method POST -Path '/mail/mailboxes/recover-capacity' -Body $body
}

function Wait-VerificationCode {
    param(
        [Parameter(Mandatory = $true)]
        [string]$SessionId,
        [Parameter(Mandatory = $true)]
        [string]$ExpectedCode,
        [int]$TimeoutSeconds = 180
    )

    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $response = Invoke-EasyEmailRequest -Method GET -Path "/mail/mailboxes/$SessionId/code"
        $codeEnvelope = $response.PSObject.Properties['code']
        if ($null -ne $codeEnvelope) {
            $codeResult = $codeEnvelope.Value
            $actualCodeProperty = $codeResult.PSObject.Properties['code']
            if ($null -ne $actualCodeProperty -and [string]$actualCodeProperty.Value -eq $ExpectedCode) {
                return $codeResult
            }
        }
        Start-Sleep -Seconds $PollIntervalSeconds
    } while ([DateTime]::UtcNow -lt $deadline)

    throw "Timed out waiting for code '$ExpectedCode' for session $SessionId."
}

function Get-LatestObservedMessage {
    param(
        [Parameter(Mandatory = $true)]
        [string]$SessionId
    )

    $response = Invoke-EasyEmailRequest -Method GET -Path "/mail/query/observed-messages?sessionId=$SessionId&limit=20"
    $messages = @($response.messages)
    if ($messages.Count -eq 0) {
        throw "No observed messages were returned for session $SessionId."
    }
    return $messages | Sort-Object observedAt -Descending | Select-Object -First 1
}

function Get-MessageFieldText {
    param(
        [Parameter(Mandatory = $true)]
        [psobject]$Message,
        [Parameter(Mandatory = $true)]
        [string]$FieldName
    )

    $property = $Message.PSObject.Properties[$FieldName]
    if ($null -eq $property) {
        return ''
    }

    return [string]$property.Value
}

function Send-MailFromSession {
    param(
        [Parameter(Mandatory = $true)]
        [string]$SenderSessionId,
        [Parameter(Mandatory = $true)]
        [string]$RecipientEmail,
        [Parameter(Mandatory = $true)]
        [psobject]$Template
    )

    $body = @{
        sessionId = $SenderSessionId
        toEmailAddress = $RecipientEmail
        subject = $Template.subject
        textBody = $Template.textBody
        htmlBody = $Template.htmlBody
        fromName = 'EasyEmail Matrix'
    }
    $response = Invoke-EasyEmailRequest -Method POST -Path '/mail/mailboxes/send' -Body $body
    return $response.result
}

function Send-MailWithSenderRetries {
    param(
        [ref]$SenderSessionRef,
        [Parameter(Mandatory = $true)]
        [string]$RecipientSessionId,
        [Parameter(Mandatory = $true)]
        [string]$RecipientEmail,
        [Parameter(Mandatory = $true)]
        [psobject]$Template
    )

    $lastError = $null
    for ($attempt = 1; $attempt -le [Math]::Max(1, $SenderRetryCount); $attempt += 1) {
        if ($null -eq $SenderSessionRef.Value) {
            $staticSenderEmail = ''
            if (-not [string]::IsNullOrWhiteSpace($script:SenderRequestedDomainValue) -and -not [string]::IsNullOrWhiteSpace($script:SenderRequestedLocalPartValue) -and -not $UseRandomSenderSubdomain) {
                $staticSenderEmail = ('{0}@{1}' -f $script:SenderRequestedLocalPartValue, $script:SenderRequestedDomainValue).Trim().ToLowerInvariant()
            }

            if (-not [string]::IsNullOrWhiteSpace($staticSenderEmail)) {
                try {
                    $SenderSessionRef.Value = Recover-MailboxSessionByEmail `
                        -EmailAddress $staticSenderEmail `
                        -ProviderTypeKey 'cloudflare_temp_email' `
                        -HostId 'matrix-sender'
                } catch {
                    $SenderSessionRef.Value = $null
                }
            }

            if ($null -eq $SenderSessionRef.Value) {
                $SenderSessionRef.Value = Open-MailboxSession `
                    -ProviderTypeKey 'cloudflare_temp_email' `
                    -HostId 'matrix-sender' `
                    -RequestedDomain $script:SenderRequestedDomainValue `
                    -RequestedLocalPart $script:SenderRequestedLocalPartValue `
                    -RequestRandomSubdomain:$UseRandomSenderSubdomain
            }
            Write-Host ("Sender mailbox: {0} ({1})" -f $SenderSessionRef.Value.emailAddress, $SenderSessionRef.Value.id)
        }

        try {
            $senderDomain = Get-EmailDomain -EmailAddress $SenderSessionRef.Value.emailAddress
            if ($senderDomain) {
                Update-MailboxSessionFilter -SessionId $RecipientSessionId -FromContains $senderDomain | Out-Null
            }
            return Send-MailFromSession -SenderSessionId $SenderSessionRef.Value.id -RecipientEmail $RecipientEmail -Template $Template
        } catch {
            $lastError = $_
            $message = Get-ExceptionMessage -ErrorRecord $_

            $isRetryableSenderFailure = $message -match 'Operation failed|Invalid domain|EnableSendMailForDomain|EnableResendOrSmtpOrSendMail'
            if (-not $isRetryableSenderFailure -or $attempt -ge [Math]::Max(1, $SenderRetryCount)) {
                throw
            }

            Write-Host ("Sender {0} failed to deliver ({1}). Rotating sender mailbox..." -f $SenderSessionRef.Value.emailAddress, $message) -ForegroundColor Yellow
            $SenderSessionRef.Value = $null
        }
    }

    if ($null -ne $lastError) {
        throw $lastError
    }

    throw 'Unable to send mail after rotating sender mailboxes.'
}

function New-TemplateCatalog {
    return @(
        [pscustomobject]@{
            key = 'numeric_plain'
            expectedCode = '135790'
            subject = 'Numeric verification sample'
            textBody = 'Your verification code is 135790. Keep it for 10 minutes.'
            htmlBody = $null
        },
        [pscustomobject]@{
            key = 'numeric_colored_html'
            expectedCode = '246810'
            subject = 'Numeric html verification sample'
            textBody = 'Alert: order 998877 is separate. Your login code is 246810.'
            htmlBody = '<html><body><div style="font-family:Arial;background:#fff7ed;border:1px solid #fdba74;padding:16px"><p style="color:#9a3412">Security review notice</p><p>Ignore order <strong>998877</strong>.</p><p>Your login code is <span style="color:#2563eb;font-size:24px;font-weight:700">246810</span>.</p></div></body></html>'
        },
        [pscustomobject]@{
            key = 'alpha_html'
            expectedCode = 'QWERTY'
            subject = 'Alphabetic verification sample'
            textBody = 'Use code QWERTY to continue.'
            htmlBody = '<html><body><div style="font-family:Arial"><h2 style="color:#d14a4a">Verification</h2><p>Your code is <strong style="color:#1b6ef3">QWERTY</strong>.</p></div></body></html>'
        },
        [pscustomobject]@{
            key = 'mixed_html'
            expectedCode = 'A1B2C3'
            subject = 'Mixed verification sample'
            textBody = 'Use code A1B2C3 to continue.'
            htmlBody = '<html><body><div style="background:#0f172a;color:#e2e8f0;padding:16px"><p>Order #20260428</p><p>Primary code: <span style="color:#22c55e;font-size:20px;font-weight:700">A1B2C3</span></p><p>Ignore backup id 998877.</p></div></body></html>'
        },
        [pscustomobject]@{
            key = 'mixed_text_noise'
            expectedCode = 'ZX-41Q8-PLM7'
            subject = 'Long mixed verification sample'
            textBody = 'Account 220044 requires confirmation. Use verification code ZX-41Q8-PLM7 to continue. Ignore ticket 771199.'
            htmlBody = '<html><body><table style="font-family:Arial;border-collapse:collapse"><tr><td style="padding:8px;color:#475569">Account 220044 requires confirmation.</td></tr><tr><td style="padding:8px;background:#eff6ff;border:1px solid #93c5fd">Verification code: <strong style="font-size:18px;color:#1d4ed8">ZX-41Q8-PLM7</strong></td></tr><tr><td style="padding:8px;color:#64748b">Ignore ticket 771199.</td></tr></table></body></html>'
        }
    )
}

function Resolve-DefaultSenderDomain {
    param(
        [Parameter(Mandatory = $true)]
        [object]$CloudflareSection
    )

    $publicDomain = [string](Get-ConfigSectionValue -Object $CloudflareSection -Name 'publicDomain' -Default '')
    $publicZone = [string](Get-ConfigSectionValue -Object $CloudflareSection -Name 'publicZone' -Default '')

    if (-not [string]::IsNullOrWhiteSpace($publicDomain)) {
        $normalizedPublicDomain = $publicDomain.Trim().ToLowerInvariant()
        if ($normalizedPublicDomain.StartsWith('mail.')) {
            return ('tx-mail.' + $normalizedPublicDomain.Substring(5))
        }
        return ('tx-mail.' + $normalizedPublicDomain)
    }

    if (-not [string]::IsNullOrWhiteSpace($publicZone)) {
        return ('tx-mail.' + $publicZone.Trim().ToLowerInvariant())
    }

    return ''
}

$config = Read-EasyEmailConfig -ConfigPath $ConfigPath
$serviceBase = Get-EasyEmailSection -Config $config -Name 'serviceBase'
$runtime = Get-EasyEmailSection -Config $serviceBase -Name 'runtime'
$server = Get-EasyEmailSection -Config $runtime -Name 'server'

if (-not $ApiKey) {
    $ApiKey = [string](Get-ConfigSectionValue -Object $server -Name 'apiKey' -Default '')
}
if ([string]::IsNullOrWhiteSpace($ApiKey)) {
    throw 'Missing serviceBase.runtime.server.apiKey for service matrix test.'
}

$cloudflare = Get-EasyEmailSection -Config $config -Name 'cloudflareMail'
$sending = if ($null -ne $cloudflare) { Get-EasyEmailSection -Config $cloudflare -Name 'sending' } else { @{} }
$worker = if ($null -ne $cloudflare) { Get-EasyEmailSection -Config $cloudflare -Name 'worker' } else { @{} }
$workerVars = if ($null -ne $worker) { Get-EasyEmailSection -Config $worker -Name 'vars' } else { @{} }
$routing = if ($null -ne $cloudflare) { Get-EasyEmailSection -Config $cloudflare -Name 'routing' } else { @{} }
$globalAuth = if ($null -ne $routing) { Get-EasyEmailSection -Config $routing -Name 'cloudflareGlobalAuth' } else { @{} }
$sendingSection = if ($null -ne $sending) { $sending } else { @{} }
$globalAuthSection = if ($null -ne $globalAuth) { $globalAuth } else { @{} }
$resendToken = [string](Get-ConfigSectionValue -Object $workerVars -Name 'RESEND_TOKEN' -Default '')
$autoSkipRecipientVerification = (-not $ForceRecipientVerification) -and (-not [string]::IsNullOrWhiteSpace($resendToken))
$authEmail = [string](Get-ConfigSectionValue -Object $globalAuthSection -Name 'authEmail' -Default '')
$globalApiKey = [string](Get-ConfigSectionValue -Object $globalAuthSection -Name 'globalApiKey' -Default '')

if ([string]::IsNullOrWhiteSpace($SenderRequestedDomain)) {
    $SenderRequestedDomain = [string](Get-ConfigSectionValue -Object $sendingSection -Name 'preferredSenderDomain' -Default '')
    if ([string]::IsNullOrWhiteSpace($SenderRequestedDomain)) {
        $configuredSendingDomains = @(Convert-ToMatrixStringArray -Value (Get-ConfigSectionValue -Object $sendingSection -Name 'domains' -Default @()))
        if ($configuredSendingDomains.Count -gt 0) {
            $SenderRequestedDomain = [string]$configuredSendingDomains[0]
        }
    }
    if ([string]::IsNullOrWhiteSpace($SenderRequestedDomain)) {
        $cloudflareSection = if ($null -ne $cloudflare) { $cloudflare } else { @{} }
        $SenderRequestedDomain = Resolve-DefaultSenderDomain -CloudflareSection $cloudflareSection
    }
}

if ([string]::IsNullOrWhiteSpace($SenderRequestedLocalPart)) {
    $SenderRequestedLocalPart = [string](Get-ConfigSectionValue -Object $sendingSection -Name 'preferredSenderLocalPart' -Default '')
}

if (-not ($SkipRecipientVerification -or $autoSkipRecipientVerification) -and ([string]::IsNullOrWhiteSpace($authEmail) -or [string]::IsNullOrWhiteSpace($globalApiKey))) {
    throw 'Missing cloudflareMail.routing.cloudflareGlobalAuth credentials for destination verification.'
}

$script:ApiKeyValue = $ApiKey
$script:NormalizedBaseUrl = $BaseUrl.TrimEnd('/')
$script:SkipRecipientVerificationValue = [bool]($SkipRecipientVerification -or $autoSkipRecipientVerification)
$script:CloudflareApiHeaders = if (-not $script:SkipRecipientVerificationValue) {
    @{
        'X-Auth-Email' = $authEmail
        'X-Auth-Key' = $globalApiKey
        'Content-Type' = 'application/json'
    }
} else {
    @{}
}
$script:CloudflareAccountId = ''
$script:SenderRequestedDomainValue = $SenderRequestedDomain.Trim().ToLowerInvariant()
$script:SenderRequestedLocalPartValue = $SenderRequestedLocalPart.Trim()

$templates = New-TemplateCatalog
$senderSession = $null

$results = @()

foreach ($provider in $Providers) {
    Write-Host ("Testing provider: {0}" -f $provider) -ForegroundColor Cyan
    $providerResult = $null
    for ($attempt = 0; $attempt -le $ProviderRetryCount; $attempt += 1) {
        if ($attempt -gt 0) {
            Write-Host ("Retrying provider {0} (attempt {1}/{2})..." -f $provider, ($attempt + 1), ($ProviderRetryCount + 1)) -ForegroundColor Yellow
            Start-Sleep -Seconds $ProviderRetryDelaySeconds
        }
        $providerResult = Test-ProviderMatrixOnce -Provider $provider -Templates $templates -SenderSessionRef ([ref]$senderSession)
        if ($providerResult.ok) {
            break
        }
    }
    $results += $providerResult
}

$resultJson = $results | ConvertTo-Json -Depth 12
if (-not [string]::IsNullOrWhiteSpace($ResultOutputPath)) {
    $resolvedResultOutputPath = Resolve-EasyEmailPath -Path $ResultOutputPath
    $resultDirectory = Split-Path -Parent $resolvedResultOutputPath
    if (-not [string]::IsNullOrWhiteSpace($resultDirectory)) {
        New-Item -ItemType Directory -Force -Path $resultDirectory | Out-Null
    }
    Set-Content -LiteralPath $resolvedResultOutputPath -Value $resultJson -Encoding UTF8
}
$resultJson
