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
