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
                    degraded = $false
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
                degraded = $false
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

            $degraded = Test-IsNonBlockingUpstreamTransientFailure `
                -Provider $Provider `
                -Message $message `
                -AllowedProviders $NonBlockingTransientProviders

            return [pscustomobject]@{
                provider = $Provider
                ok = $false
                degraded = $degraded
                recipientAttempts = $recipientAttempt
                detail = $message
                errorType = $_.Exception.GetType().FullName
                scriptStackTrace = $_.ScriptStackTrace
            }
        }
    }
}
