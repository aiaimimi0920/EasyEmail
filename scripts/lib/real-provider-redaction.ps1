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
