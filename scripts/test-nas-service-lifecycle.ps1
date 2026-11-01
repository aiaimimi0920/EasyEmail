param(
    [Parameter(Mandatory = $true)]
    [string]$BaseUrl,
    [Parameter(Mandatory = $true)]
    [string]$ApiTokenPath,
    [string]$ConfigPath = 'config.yaml',
    [int]$TimeoutSeconds = 240,
    [switch]$ConfirmExternalSideEffects
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $ConfirmExternalSideEffects) {
    throw 'Pass -ConfirmExternalSideEffects to create, send to, read, and release test mailboxes.'
}
if ($TimeoutSeconds -lt 30) {
    throw 'TimeoutSeconds must be at least 30.'
}

$workspaceRoot = (Resolve-Path (Split-Path -Parent $PSScriptRoot)).Path
. (Join-Path $PSScriptRoot 'lib/easyemail-config.ps1')

$resolvedTokenPath = [System.IO.Path]::GetFullPath($ApiTokenPath)
if (-not (Test-Path -LiteralPath $resolvedTokenPath -PathType Leaf)) {
    throw "API token file not found: $resolvedTokenPath"
}
$apiToken = (Get-Content -LiteralPath $resolvedTokenPath -Raw).Trim()
if ([string]::IsNullOrWhiteSpace($apiToken)) {
    throw 'API token file is empty.'
}

$resolvedConfigPath = Resolve-EasyEmailPath -Path $ConfigPath
$config = Read-EasyEmailConfig -ConfigPath $resolvedConfigPath
$cloudflareMail = Get-EasyEmailSection -Config $config -Name 'cloudflareMail'
$sending = Get-EasyEmailSection -Config $cloudflareMail -Name 'sending'
$senderDomain = [string](Get-EasyEmailConfigValue `
    -Object $sending `
    -Name 'preferredSenderDomain' `
    -Default '')
if ([string]::IsNullOrWhiteSpace($senderDomain)) {
    throw 'cloudflareMail.sending.preferredSenderDomain is required.'
}

$serviceBaseUrl = $BaseUrl.TrimEnd('/')
$headers = @{ Authorization = "Bearer $apiToken" }

function Invoke-EasyEmailNasRequest {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet('GET', 'POST')]
        [string]$Method,
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [hashtable]$Body,
        [int]$RequestTimeoutSeconds = 45
    )

    $request = @{
        Method = $Method
        Uri = "$serviceBaseUrl$Path"
        Headers = $headers
        TimeoutSec = $RequestTimeoutSeconds
    }
    if ($null -ne $Body) {
        $request.ContentType = 'application/json'
        $request.Body = $Body | ConvertTo-Json -Depth 12 -Compress
    }
    Invoke-RestMethod @request
}

function Release-TestMailbox {
    param([object]$Session)

    if ($null -eq $Session -or [string]::IsNullOrWhiteSpace([string]$Session.id)) {
        return $null
    }
    $response = Invoke-EasyEmailNasRequest `
        -Method POST `
        -Path '/mail/mailboxes/release' `
        -Body @{
            sessionId = [string]$Session.id
            reason = 'nas-lan-validation-cleanup'
        }
    $sessionStatus = [string]$response.result.session.status
    $releaseDetail = ''
    if ($response.result.PSObject.Properties.Name -contains 'detail') {
        $releaseDetail = [string]$response.result.detail
    }
    return [pscustomobject]@{
        SessionClosed = @('expired', 'resolved') -contains $sessionStatus
        SessionStatus = $sessionStatus
        UpstreamReleased = $response.result.released -eq $true
        Detail = $releaseDetail
    }
}

function Test-ReleaseConfirmed {
    param([object]$ReleaseResult)

    return $null -ne $ReleaseResult -and $ReleaseResult.SessionClosed -eq $true
}

function Get-SafeFailureMessage {
    param([object]$ErrorRecord)

    $message = [string]$ErrorRecord.Exception.Message
    if (-not [string]::IsNullOrWhiteSpace($apiToken)) {
        $message = $message.Replace($apiToken, '[REDACTED_SECRET]')
    }
    return $message
}

$runName = 'nas-lan-' + [Guid]::NewGuid().ToString('N').Substring(0, 12)
$recipientSession = $null
$senderSession = $null
$recipientRelease = $null
$senderRelease = $null
$runFailure = $null
$cleanupFailures = [System.Collections.Generic.List[string]]::new()

try {
    $instancesResponse = Invoke-EasyEmailNasRequest `
        -Method GET `
        -Path '/mail/query/provider-instances?providerTypeKey=cloudflare_temp_email&limit=20'
    $providerInstance = @($instancesResponse.instances | Where-Object {
        $_.status -eq 'active'
    } | Select-Object -First 1)
    if ($providerInstance.Count -ne 1) {
        throw 'No active cloudflare_temp_email instance is available.'
    }
    $preferredInstanceId = [string]$providerInstance[0].id

    $recipientResponse = Invoke-EasyEmailNasRequest `
        -Method POST `
        -Path '/mail/mailboxes/open' `
        -Body @{
            hostId = "$runName-recipient"
            providerTypeKey = 'cloudflare_temp_email'
            preferredInstanceId = $preferredInstanceId
            provisionMode = 'reuse-only'
            bindingMode = 'shared-instance'
            ttlMinutes = 30
            metadata = @{ source = 'nas-lan-deployment-validation' }
        }
    $recipientSession = $recipientResponse.result.session

    $senderResponse = Invoke-EasyEmailNasRequest `
        -Method POST `
        -Path '/mail/mailboxes/open' `
        -Body @{
            hostId = "$runName-sender"
            providerTypeKey = 'cloudflare_temp_email'
            preferredInstanceId = $preferredInstanceId
            provisionMode = 'reuse-only'
            bindingMode = 'shared-instance'
            requestedDomain = $senderDomain.Trim().ToLowerInvariant()
            ttlMinutes = 30
            metadata = @{ source = 'nas-lan-deployment-validation' }
        }
    $senderSession = $senderResponse.result.session

    if ([string]::IsNullOrWhiteSpace([string]$recipientSession.id) -or
        [string]::IsNullOrWhiteSpace([string]$senderSession.id)) {
        throw 'Mailbox open response omitted a session ID.'
    }

    $senderAddressParts = ([string]$senderSession.emailAddress).Split('@', 2)
    if ($senderAddressParts.Count -ne 2) {
        throw 'Sender mailbox address is invalid.'
    }
    $null = Invoke-EasyEmailNasRequest `
        -Method POST `
        -Path '/mail/mailboxes/update-session' `
        -Body @{
            sessionId = [string]$recipientSession.id
            fromContains = [string]$senderAddressParts[1]
        }

    $marker = [Guid]::NewGuid().ToString('N')
    $expectedCode = (Get-Random -Minimum 100000 -Maximum 1000000).ToString()
    $sendResponse = Invoke-EasyEmailNasRequest `
        -Method POST `
        -Path '/mail/mailboxes/send' `
        -RequestTimeoutSeconds 90 `
        -Body @{
            sessionId = [string]$senderSession.id
            toEmailAddress = [string]$recipientSession.emailAddress
            subject = "EasyEmail NAS lifecycle $marker"
            textBody = "NAS lifecycle marker $marker. Verification code: $expectedCode"
            htmlBody = "<html><body><p>NAS lifecycle marker <strong>$marker</strong>.</p><p>Verification code: <strong>$expectedCode</strong></p></body></html>"
            fromName = 'EasyEmail NAS Validation'
        }
    $deliveryMode = [string]$sendResponse.result.deliveryMode
    if ([string]::IsNullOrWhiteSpace($deliveryMode)) {
        throw 'Mailbox send returned no delivery mode.'
    }

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $matchingMessage = $null
    $observedMessageCount = 0
    do {
        $escapedSessionId = [Uri]::EscapeDataString([string]$recipientSession.id)
        $null = Invoke-EasyEmailNasRequest `
            -Method POST `
            -Path "/mail/mailboxes/$escapedSessionId/refresh" `
            -RequestTimeoutSeconds 90
        $observedResponse = Invoke-EasyEmailNasRequest `
            -Method GET `
            -Path "/mail/query/observed-messages?sessionId=$escapedSessionId&limit=50&newestFirst=true"
        $observedMessages = @($observedResponse.messages)
        $observedMessageCount = $observedMessages.Count
        $matchingMessage = $observedMessages | Where-Object {
            ([string]$_.subject).Contains($marker) -and
            (([string]$_.textBody).Contains($expectedCode) -or
                ([string]$_.htmlBody).Contains($expectedCode))
        } | Select-Object -First 1
        if ($null -eq $matchingMessage) {
            Start-Sleep -Seconds 8
        }
    } while ($null -eq $matchingMessage -and (Get-Date) -lt $deadline)

    if ($null -eq $matchingMessage) {
        throw 'Controlled message was not observed before timeout.'
    }

    $escapedMessageId = [Uri]::EscapeDataString([string]$matchingMessage.id)
    $messageDetail = (Invoke-EasyEmailNasRequest `
        -Method GET `
        -Path "/mail/query/observed-messages/$escapedMessageId").message
    if ($null -eq $messageDetail -or
        -not ([string]$messageDetail.subject).Contains($marker) -or
        (-not ([string]$messageDetail.textBody).Contains($expectedCode) -and
            -not ([string]$messageDetail.htmlBody).Contains($expectedCode))) {
        throw 'Message detail did not preserve the controlled subject, body, and code.'
    }

    $codePayload = (Invoke-EasyEmailNasRequest `
        -Method GET `
        -Path "/mail/mailboxes/$escapedSessionId/code").code
    $serializedCode = $codePayload | ConvertTo-Json -Depth 8 -Compress
    if (-not $serializedCode.Contains($expectedCode)) {
        throw 'Code endpoint did not return the controlled verification code.'
    }

    $recipientRelease = Release-TestMailbox -Session $recipientSession
    $senderRelease = Release-TestMailbox -Session $senderSession
    if (-not (Test-ReleaseConfirmed -ReleaseResult $recipientRelease) -or
        -not (Test-ReleaseConfirmed -ReleaseResult $senderRelease)) {
        throw 'Mailbox release did not close both local sessions.'
    }

    [pscustomobject]@{
        BaseUrl = $serviceBaseUrl
        ProviderInstance = $preferredInstanceId
        RecipientEmail = [string]$recipientSession.emailAddress
        SenderEmail = [string]$senderSession.emailAddress
        DeliveryMode = $deliveryMode
        ObservedMessageCount = $observedMessageCount
        MessageListRead = $true
        MessageDetailRead = $true
        VerificationCodeMatched = $true
        RecipientSessionClosed = $recipientRelease.SessionClosed
        SenderSessionClosed = $senderRelease.SessionClosed
        RecipientUpstreamReleased = $recipientRelease.UpstreamReleased
        SenderUpstreamReleased = $senderRelease.UpstreamReleased
        RecipientReleaseDetail = $recipientRelease.Detail
        SenderReleaseDetail = $senderRelease.Detail
    } | ConvertTo-Json
} catch {
    $runFailure = $_
} finally {
    $cleanupTargets = @(
        [pscustomobject]@{
            Label = 'recipient'
            Session = $recipientSession
            Release = $recipientRelease
        },
        [pscustomobject]@{
            Label = 'sender'
            Session = $senderSession
            Release = $senderRelease
        }
    )
    foreach ($target in $cleanupTargets) {
        if ($null -eq $target.Session -or
            (Test-ReleaseConfirmed -ReleaseResult $target.Release)) {
            continue
        }

        $cleanupConfirmed = $false
        $lastCleanupDetail = 'no release response'
        for ($attempt = 1; $attempt -le 2; $attempt++) {
            try {
                $cleanupResult = Release-TestMailbox -Session $target.Session
                if (Test-ReleaseConfirmed -ReleaseResult $cleanupResult) {
                    $cleanupConfirmed = $true
                    break
                }
                $lastCleanupDetail = "session status '$($cleanupResult.SessionStatus)'"
            } catch {
                $lastCleanupDetail = Get-SafeFailureMessage -ErrorRecord $_
            }
            if ($attempt -lt 2) {
                Start-Sleep -Seconds 2
            }
        }
        if (-not $cleanupConfirmed) {
            $cleanupFailures.Add(
                "$($target.Label) release unconfirmed after 2 attempts: $lastCleanupDetail"
            )
        }
    }
}

if ($null -ne $runFailure) {
    if ($cleanupFailures.Count -gt 0) {
        $primaryFailure = Get-SafeFailureMessage -ErrorRecord $runFailure
        throw "$primaryFailure Cleanup warning: $($cleanupFailures -join '; ')"
    }
    throw $runFailure
}
if ($cleanupFailures.Count -gt 0) {
    throw "Mailbox cleanup failed: $($cleanupFailures -join '; ')"
}
