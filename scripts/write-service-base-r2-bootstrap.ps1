param(
    [string]$OutputPath = 'deploy/service/base/bootstrap/r2-bootstrap.json',
    [string]$ManifestPath = '',
    [string]$AccountId = '',
    [string]$Bucket = '',
    [string]$ConfigObjectKey = '',
    [string]$RuntimeEnvObjectKey = '',
    [string]$AccessKeyId = '',
    [string]$SecretAccessKey = '',
    [string]$Endpoint = '',
    [string]$ExpectedConfigSha256 = '',
    [string]$ExpectedRuntimeEnvSha256 = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot 'lib/easyemail-config.ps1')

if (-not [string]::IsNullOrWhiteSpace($ManifestPath)) {
    $resolvedManifestPath = Resolve-EasyEmailPath -Path $ManifestPath
    if (-not (Test-Path -LiteralPath $resolvedManifestPath)) {
        throw "ManifestPath not found: $resolvedManifestPath"
    }

    $manifest = Get-Content -LiteralPath $resolvedManifestPath -Raw | ConvertFrom-Json
    if (-not $AccountId) { $AccountId = [string]$manifest.accountId }
    if (-not $Bucket) { $Bucket = [string]$manifest.bucket }
    if (-not $Endpoint) { $Endpoint = [string]$manifest.endpoint }
    if (-not $ConfigObjectKey) { $ConfigObjectKey = [string]$manifest.config.objectKey }
    if (-not $RuntimeEnvObjectKey) { $RuntimeEnvObjectKey = [string]$manifest.runtimeEnv.objectKey }
    if (-not $ExpectedConfigSha256) { $ExpectedConfigSha256 = [string]$manifest.config.sha256 }
    if (-not $ExpectedRuntimeEnvSha256) { $ExpectedRuntimeEnvSha256 = [string]$manifest.runtimeEnv.sha256 }
}

foreach ($required in @(
    @{ Name = 'AccountId'; Value = $AccountId },
    @{ Name = 'Bucket'; Value = $Bucket },
    @{ Name = 'ConfigObjectKey'; Value = $ConfigObjectKey },
    @{ Name = 'RuntimeEnvObjectKey'; Value = $RuntimeEnvObjectKey },
    @{ Name = 'AccessKeyId'; Value = $AccessKeyId },
    @{ Name = 'SecretAccessKey'; Value = $SecretAccessKey }
)) {
    if ([string]::IsNullOrWhiteSpace([string]$required.Value)) {
        throw "$($required.Name) is required."
    }
}

$bootstrap = [ordered]@{
    accountId = $AccountId
    endpoint = if ([string]::IsNullOrWhiteSpace($Endpoint)) {
        "https://$AccountId.r2.cloudflarestorage.com"
    } else {
        $Endpoint
    }
    bucket = $Bucket
    configObjectKey = $ConfigObjectKey
    runtimeEnvObjectKey = $RuntimeEnvObjectKey
    accessKeyId = $AccessKeyId
    secretAccessKey = $SecretAccessKey
}

if (-not [string]::IsNullOrWhiteSpace($ExpectedConfigSha256)) {
    $bootstrap.expectedConfigSha256 = $ExpectedConfigSha256
}
if (-not [string]::IsNullOrWhiteSpace($ExpectedRuntimeEnvSha256)) {
    $bootstrap.expectedRuntimeEnvSha256 = $ExpectedRuntimeEnvSha256
}

$resolvedOutputPath = Resolve-EasyEmailPath -Path $OutputPath
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $resolvedOutputPath) | Out-Null
$bootstrap | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $resolvedOutputPath -Encoding UTF8
Write-Host "Bootstrap file written: $resolvedOutputPath"
