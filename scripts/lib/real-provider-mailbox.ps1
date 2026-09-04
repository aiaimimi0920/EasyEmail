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
