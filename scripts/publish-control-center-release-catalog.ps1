param(
    [string]$ConfigPath = (Join-Path $PSScriptRoot '..\config.yaml'),
    [string]$PayloadPath = '',
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot 'lib\easyemail-config.ps1')

$config = Read-EasyEmailConfig -ConfigPath $ConfigPath
$publishing = Get-EasyEmailSection -Config $config -Name 'publishing'
$controlCenter = Get-EasyEmailSection -Config $publishing -Name 'controlCenter'
if ($null -eq $controlCenter) {
    throw 'Missing publishing.controlCenter section in config.yaml.'
}

$baseUrl = [string](Get-EasyEmailConfigValue -Object $controlCenter -Name 'baseUrl' -Default '')
$publishPath = [string](Get-EasyEmailConfigValue -Object $controlCenter -Name 'releaseCatalogPublishPath' -Default '/admin/release-set-catalog')
$accessClientId = [string](Get-EasyEmailConfigValue -Object $controlCenter -Name 'accessClientId' -Default '')
$accessClientSecret = [string](Get-EasyEmailConfigValue -Object $controlCenter -Name 'accessClientSecret' -Default '')
$releasePublishToken = [string](Get-EasyEmailConfigValue -Object $controlCenter -Name 'releasePublishToken' -Default '')

if ([string]::IsNullOrWhiteSpace($PayloadPath)) {
    $PayloadPath = [string](Get-EasyEmailConfigValue -Object $controlCenter -Name 'releaseCatalogPayloadPath' -Default '')
}

if ([string]::IsNullOrWhiteSpace($baseUrl)) {
    throw 'Missing publishing.controlCenter.baseUrl in config.yaml.'
}
if ([string]::IsNullOrWhiteSpace($PayloadPath)) {
    throw 'Missing release catalog payload path. Pass -PayloadPath or set publishing.controlCenter.releaseCatalogPayloadPath in config.yaml.'
}
if ([string]::IsNullOrWhiteSpace($accessClientId) -or [string]::IsNullOrWhiteSpace($accessClientSecret) -or [string]::IsNullOrWhiteSpace($releasePublishToken)) {
    throw 'Missing publishing.controlCenter access or release-publish credentials in config.yaml.'
}

$resolvedPayloadPath = Resolve-EasyEmailPath -Path $PayloadPath
if (-not (Test-Path -LiteralPath $resolvedPayloadPath)) {
    throw "Release catalog payload not found: $resolvedPayloadPath"
}

$endpoint = $baseUrl.TrimEnd('/') + '/' + $publishPath.TrimStart('/')
$headers = @{
    'CF-Access-Client-Id' = $accessClientId
    'CF-Access-Client-Secret' = $accessClientSecret
    'x-release-publish-token' = $releasePublishToken
}

if ($DryRun) {
    Write-Host "Control center endpoint: $endpoint"
    Write-Host "Payload path: $resolvedPayloadPath"
    Write-Host 'Headers: CF-Access-Client-Id, CF-Access-Client-Secret, x-release-publish-token'
    exit 0
}

Write-Host "Publishing release catalog to $endpoint" -ForegroundColor Cyan
$response = Invoke-WebRequest -Method Post -Uri $endpoint -Headers $headers -InFile $resolvedPayloadPath -ContentType 'application/json'
Write-Host ("Control center response: HTTP " + [string]$response.StatusCode)
