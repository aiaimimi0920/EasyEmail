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
