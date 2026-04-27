param(
    [string]$ConfigPath = 'config.yaml',
    [string]$SyncMode = '',
    [switch]$BootstrapMissingResources,
    [switch]$ForceRoutingStateSync,
    [switch]$NoInstall,
    [switch]$NoRoutingSync,
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not [string]::IsNullOrWhiteSpace($SyncMode) -and @('exact', 'wildcard') -notcontains $SyncMode) {
    throw "Unsupported sync mode '$SyncMode'. Use 'exact' or 'wildcard'."
}

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

$quickDeployArgs = @{
    ConfigPath = $resolvedConfigPath
}
if ($PSBoundParameters.ContainsKey('SyncMode') -and -not [string]::IsNullOrWhiteSpace($SyncMode)) {
    $quickDeployArgs.SyncMode = $SyncMode
}
if ($BootstrapMissingResources) {
    $quickDeployArgs.BootstrapMissingResources = $true
}
if ($ForceRoutingStateSync) {
    $quickDeployArgs.ForceRoutingStateSync = $true
}
if ($NoInstall) {
    $quickDeployArgs.NoInstall = $true
}
if ($NoRoutingSync) {
    $quickDeployArgs.NoRoutingSync = $true
}
if ($DryRun) {
    $quickDeployArgs.DryRun = $true
}

& $quickDeploy @quickDeployArgs

if ($LASTEXITCODE -ne 0) {
    throw "Cloudflare email deploy failed with exit code $LASTEXITCODE"
}

Write-Host 'Cloudflare email deploy finished.'
