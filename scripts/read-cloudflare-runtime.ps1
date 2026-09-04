param(
    [string]$ConfigPath = '.\config.yaml',
    [string]$OutputPath = (Join-Path $PWD 'cloudflare-email-runtime-readback.json'),
    [string]$GitHubOutputPath = $env:GITHUB_OUTPUT
)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'lib/easyemail-config.ps1')

$config = Read-EasyEmailConfig -ConfigPath $ConfigPath
$cloudflare = Get-EasyEmailSection -Config $config -Name 'cloudflareMail'
$baseUrl = [string](Get-EasyEmailConfigValue -Object $cloudflare -Name 'publicBaseUrl' -Default '')
if ([string]::IsNullOrWhiteSpace($baseUrl)) {
    throw 'cloudflareMail.publicBaseUrl is required for runtime readback.'
}

$healthUrl = $baseUrl.TrimEnd('/') + '/health_check'
$settingsUrl = $baseUrl.TrimEnd('/') + '/open_api/settings'
$health = (Invoke-WebRequest -Uri $healthUrl -Method Get -TimeoutSec 10).Content.Trim()
if ($health -ne 'OK') {
    throw "Unexpected health response from ${healthUrl}: $health"
}

$settings = Invoke-RestMethod -Uri $settingsUrl -Method Get -TimeoutSec 10
$runtimeReadback = [pscustomobject]@{
    baseUrl = $baseUrl
    healthUrl = $healthUrl
    settingsUrl = $settingsUrl
    version = [string]$settings.version
    domains = @($settings.domains)
    randomSubdomainDomains = @($settings.randomSubdomainDomains)
    needAuth = [bool]$settings.needAuth
    gitSha = [string]$env:GITHUB_SHA
    ref = [string]$env:GITHUB_REF
}

$runtimeReadback | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $OutputPath -Encoding UTF8
if (-not [string]::IsNullOrWhiteSpace($GitHubOutputPath)) {
    @(
        "runtime_path=$OutputPath"
        "version=$($runtimeReadback.version)"
        "base_url=$($runtimeReadback.baseUrl)"
    ) | Add-Content -LiteralPath $GitHubOutputPath -Encoding UTF8
}
