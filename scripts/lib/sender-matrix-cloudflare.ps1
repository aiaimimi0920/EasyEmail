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
