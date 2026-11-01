[CmdletBinding()]
param(
    [string]$ConfigPath,
    [string]$BaseConfigPath,
    [string]$GitHubEnvironmentPath = $env:GITHUB_ENV,
    [string]$GitHubOutputPath = $env:GITHUB_OUTPUT
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
    $ConfigPath = Join-Path $PWD 'config.yaml'
}
if ([string]::IsNullOrWhiteSpace($BaseConfigPath)) {
    $BaseConfigPath = Join-Path $repoRoot 'config.example.yaml'
}
if ([string]::IsNullOrWhiteSpace($GitHubEnvironmentPath)) {
    throw 'GitHubEnvironmentPath is required (normally provided by GITHUB_ENV).'
}
if ([string]::IsNullOrWhiteSpace($GitHubOutputPath)) {
    throw 'GitHubOutputPath is required (normally provided by GITHUB_OUTPUT).'
}

. (Join-Path $PSScriptRoot 'lib/easyemail-config.ps1')

function Add-GitHubFileLine {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [Parameter(Mandatory = $true)]
        [string]$Value
    )

    [IO.File]::AppendAllText(
        $Path,
        "$Value$([Environment]::NewLine)",
        [Text.UTF8Encoding]::new($false)
    )
}

$granularSecretNames = @(
    'EASYEMAIL_CF_PUBLIC_BASE_URL',
    'EASYEMAIL_CF_PUBLIC_DOMAIN',
    'EASYEMAIL_CF_PASSWORDS',
    'EASYEMAIL_CF_ADMIN_PASSWORDS',
    'EASYEMAIL_CF_JWT_SECRET',
    'EASYEMAIL_CF_DOMAINS',
    'EASYEMAIL_CF_SUBDOMAIN_LABEL_POOL',
    'EASYEMAIL_CF_SENDING_DOMAINS',
    'EASYEMAIL_CF_D1_DATABASE_ID',
    'EASYEMAIL_CF_D1_DATABASE_NAME',
    'EASYEMAIL_CF_AUTH_EMAIL',
    'EASYEMAIL_CF_GLOBAL_API_KEY',
    'EASYEMAIL_CF_API_TOKEN',
    'EASYEMAIL_CF_RESEND_TOKEN'
)

$hasGranularSecrets = $false
foreach ($secretName in $granularSecretNames) {
    $secret = Get-Item -Path "Env:$secretName" -ErrorAction SilentlyContinue
    if ($null -ne $secret -and -not [string]::IsNullOrWhiteSpace([string]$secret.Value)) {
        $hasGranularSecrets = $true
        break
    }
}

if ($hasGranularSecrets) {
    & python (Join-Path $PSScriptRoot 'materialize-action-config.py') `
        --base-config $BaseConfigPath `
        --output $ConfigPath
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to materialize config.yaml from GitHub Actions secrets with exit code $LASTEXITCODE"
    }

    $materializedConfig = Read-EasyEmailConfig -ConfigPath $ConfigPath
    $cloudflareMail = Get-EasyEmailSection -Config $materializedConfig -Name 'cloudflareMail'
    $routing = Get-EasyEmailSection -Config $cloudflareMail -Name 'routing'
    $globalAuth = Get-EasyEmailSection -Config $routing -Name 'cloudflareGlobalAuth'
    $authEmail = [string](Get-EasyEmailConfigValue -Object $globalAuth -Name 'authEmail' -Default '')
    $globalApiKey = [string](Get-EasyEmailConfigValue -Object $globalAuth -Name 'globalApiKey' -Default '')
    $apiToken = [string]$env:EASYEMAIL_CF_API_TOKEN

    if (-not [string]::IsNullOrWhiteSpace($apiToken)) {
        Write-Host 'Exporting CLOUDFLARE_API_TOKEN for Wrangler and bootstrap scripts.'
        Write-Host "::add-mask::$apiToken"
        Add-GitHubFileLine -Path $GitHubEnvironmentPath -Value "CLOUDFLARE_API_TOKEN=$apiToken"
    } elseif (-not [string]::IsNullOrWhiteSpace($authEmail) -and -not [string]::IsNullOrWhiteSpace($globalApiKey)) {
        Write-Host 'Config contains Cloudflare global auth credentials; exporting them for Wrangler.'
        Write-Host "::add-mask::$authEmail"
        Write-Host "::add-mask::$globalApiKey"
        Add-GitHubFileLine -Path $GitHubEnvironmentPath -Value "CLOUDFLARE_EMAIL=$authEmail"
        Add-GitHubFileLine -Path $GitHubEnvironmentPath -Value "CLOUDFLARE_API_KEY=$globalApiKey"
    } else {
        throw 'Missing Cloudflare authentication. Set EASYEMAIL_CF_API_TOKEN, or set both EASYEMAIL_CF_AUTH_EMAIL and EASYEMAIL_CF_GLOBAL_API_KEY.'
    }

    Write-Host 'Wrote Cloudflare config from EASYEMAIL_CF_* repository secrets.'
    Add-GitHubFileLine -Path $GitHubOutputPath -Value 'source=granular-secrets'
} elseif ($env:ALLOW_EXAMPLE_CONFIG -eq 'true') {
    Copy-Item -LiteralPath $BaseConfigPath -Destination $ConfigPath -Force
    Write-Warning 'No EASYEMAIL_CF_* secrets were provided; using config.example.yaml for dry-run validation.'
    Add-GitHubFileLine -Path $GitHubOutputPath -Value 'source=example'
} else {
    throw 'Missing EASYEMAIL_CF_* secrets. Add the granular Cloudflare repository secrets before deploying.'
}
