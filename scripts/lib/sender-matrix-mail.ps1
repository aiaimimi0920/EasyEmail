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
