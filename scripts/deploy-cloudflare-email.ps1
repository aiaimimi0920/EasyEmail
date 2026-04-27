param(
    [string]$ConfigPath = 'config.yaml',
    [ValidateSet('exact', 'wildcard')]
    [string]$SyncMode = 'exact',
    [switch]$BootstrapMissingResources,
    [switch]$NoInstall,
    [switch]$NoRoutingSync,
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot 'lib/easyemail-config.ps1')

$resolvedConfigPath = Resolve-EasyEmailPath -Path $ConfigPath
if (-not (Test-Path -LiteralPath $resolvedConfigPath)) {
    throw "Missing config file: $resolvedConfigPath. Run scripts/init-config.ps1 first."
}

$config = Read-EasyEmailConfig -ConfigPath $resolvedConfigPath
$cloudflare = Get-EasyEmailSection -Config $config -Name 'cloudflareMail'
if ($null -eq $cloudflare) {
    throw 'Missing cloudflareMail section in config.yaml.'
}

$quickDeploy = Join-Path $PSScriptRoot 'quick-deploy-cloudflare-mail.ps1'
if (-not (Test-Path -LiteralPath $quickDeploy)) {
    throw "Missing quick deploy script: $quickDeploy"
}

& $quickDeploy `
    -ConfigPath $resolvedConfigPath `
    -SyncMode $SyncMode `
    -BootstrapMissingResources:([bool]$BootstrapMissingResources) `
    -NoInstall:([bool]$NoInstall) `
    -NoRoutingSync:([bool]$NoRoutingSync) `
    -DryRun:([bool]$DryRun)

if ($LASTEXITCODE -ne 0) {
    throw "Cloudflare email deploy failed with exit code $LASTEXITCODE"
}

Write-Host 'Cloudflare email deploy finished.'
