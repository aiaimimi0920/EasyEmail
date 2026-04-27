param(
    [string]$ConfigPath = 'config.yaml',
    [string]$BackupPath = '',
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

$projectRoot = Resolve-EasyEmailPath -Path (Get-EasyEmailConfigValue -Object $cloudflare -Name 'projectRoot' -Default 'upstreams/cloudflare_temp_email')
$workerDir = Resolve-EasyEmailPath -Path (Join-Path $projectRoot (Get-EasyEmailConfigValue -Object $cloudflare -Name 'workerDir' -Default 'worker'))
if (-not (Test-Path -LiteralPath $workerDir)) {
    throw "Worker directory not found: $workerDir"
}

$teardownScript = Resolve-EasyEmailPath -Path 'deploy/upstreams/cloudflare_temp_email/scripts/teardown_cloudflare_mail.py'
if (-not (Test-Path -LiteralPath $teardownScript)) {
    throw "Missing teardown script: $teardownScript"
}

$wranglerCommand = Resolve-EasyEmailLocalNodeTool -PackageDirectory $workerDir -ToolName 'wrangler'
$arguments = @(
    $teardownScript,
    '--config', $resolvedConfigPath,
    '--worker-dir', $workerDir,
    '--wrangler-command', $wranglerCommand
)
if (-not [string]::IsNullOrWhiteSpace($BackupPath)) {
    $arguments += '--backup-path'
    $arguments += (Resolve-EasyEmailPath -Path $BackupPath)
}
if ($DryRun) {
    $arguments += '--dry-run'
}

Write-Host 'Backing up and removing Cloudflare email resources...' -ForegroundColor Cyan
$output = & python @arguments
if ($LASTEXITCODE -ne 0) {
    throw "Cloudflare email removal failed with exit code $LASTEXITCODE"
}

$summary = (($output | Out-String).Trim() | ConvertFrom-Json)
Write-Host ("Backup file: " + [string]$summary.backupPath) -ForegroundColor Yellow
if ($DryRun) {
    Write-Host 'Cloudflare email removal dry-run completed.' -ForegroundColor Green
} else {
    Write-Host 'Cloudflare email resources removed.' -ForegroundColor Green
}
