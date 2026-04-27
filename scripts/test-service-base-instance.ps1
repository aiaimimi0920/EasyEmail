param(
    [string]$BaseUrl = "http://127.0.0.1:18081",
    [string]$ConfigPath = 'config.yaml',
    [string]$ApiKey = "",
    [string]$ProviderTypeKey = "cloudflare_temp_email",
    [string]$ProviderStrategyModeId = "cloudflare_temp_email-first",
    [switch]$RequestRandomSubdomain
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot 'lib/easyemail-config.ps1')

if (-not $ApiKey -and (Test-Path -LiteralPath $ConfigPath)) {
    try {
        $config = Read-EasyEmailConfig -ConfigPath $ConfigPath
        $serviceBase = Get-EasyEmailSection -Config $config -Name 'serviceBase'
        $runtime = Get-EasyEmailSection -Config $serviceBase -Name 'runtime'
        $server = Get-EasyEmailSection -Config $runtime -Name 'server'
        $ApiKey = [string](Get-EasyEmailConfigValue -Object $server -Name 'apiKey' -Default '')
    } catch {
        Write-Warning ("Failed to read service API key from config: " + $_.Exception.Message)
    }
}

$normalizedBaseUrl = $BaseUrl.TrimEnd('/')
$headers = @{}
if (-not [string]::IsNullOrWhiteSpace($ApiKey)) {
    $headers["Authorization"] = "Bearer $ApiKey"
}

$catalogUrl = "$normalizedBaseUrl/mail/catalog"
$catalog = $null
for ($attempt = 1; $attempt -le 30; $attempt += 1) {
    try {
        $catalog = Invoke-RestMethod -Method Get -Uri $catalogUrl -Headers $headers -TimeoutSec 5
        break
    } catch {
        Start-Sleep -Seconds 1
    }
}

if (-not $catalog) {
    throw "EasyEmail API did not become ready at $catalogUrl"
}

Write-Host ("[OK] GET " + $catalogUrl)
$providerKeys = @($catalog.catalog.providerTypes | ForEach-Object { $_.key })
Write-Host ("Providers: " + ($providerKeys -join ", "))

$openUrl = "$normalizedBaseUrl/mail/mailboxes/open"
$openBody = @{
    hostId = "ghcr-service-base-smoke"
    provisionMode = "reuse-only"
    bindingMode = "shared-instance"
    providerTypeKey = $ProviderTypeKey
    providerStrategyModeId = $ProviderStrategyModeId
    requestRandomSubdomain = [bool]$RequestRandomSubdomain
} | ConvertTo-Json -Depth 5

$openHeaders = @{}
foreach ($key in $headers.Keys) {
    $openHeaders[$key] = $headers[$key]
}
$openHeaders["Content-Type"] = "application/json"

$openResult = Invoke-RestMethod -Method Post -Uri $openUrl -Headers $openHeaders -Body $openBody -TimeoutSec 15
$emailAddress = [string]$openResult.result.session.emailAddress
if ([string]::IsNullOrWhiteSpace($emailAddress)) {
    throw "Mailbox open result from $openUrl did not return an email address."
}

Write-Host ("[OK] POST " + $openUrl + " => " + $emailAddress)
