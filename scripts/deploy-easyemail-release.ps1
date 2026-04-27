param(
    [string]$ConfigPath = 'config.yaml',
    [string]$SyncMode = '',
    [switch]$BootstrapMissingResources,
    [switch]$ForceRoutingStateSync,
    [switch]$NoInstall,
    [switch]$NoRoutingSync,
    [switch]$DryRun,
    [switch]$SkipCloudflareMail,
    [switch]$SkipServiceBaseGhcr,
    [switch]$SkipCloudflareHealthCheck,
    [switch]$SkipServiceBaseSmoke,
    [string]$ServiceBaseVersion = '',
    [string]$ServiceBasePlatform = 'linux/amd64',
    [int]$HealthCheckMaxAttempts = 30,
    [int]$HealthCheckDelaySeconds = 2
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

$powerShellCommand = Get-EasyEmailPowerShellCommand
$config = Read-EasyEmailConfig -ConfigPath $resolvedConfigPath
$serviceBase = Get-EasyEmailSection -Config $config -Name 'serviceBase'
$cloudflare = Get-EasyEmailSection -Config $config -Name 'cloudflareMail'

function Invoke-EasyEmailScript {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ScriptPath,
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    & $script:powerShellCommand -ExecutionPolicy Bypass -File $ScriptPath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed: $ScriptPath $($Arguments -join ' ')"
    }
}

function Read-EasyEmailJsonFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    return (Get-Content -Raw -LiteralPath $Path) | ConvertFrom-Json
}

function Invoke-ServiceBaseSmokeCheck {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ConfigPath,
        [Parameter(Mandatory = $true)]
        [string]$Image
    )

    $smokeScript = Resolve-EasyEmailPath -Path 'deploy/service/base/smoke-easy-email-docker-api.ps1'
    if (-not (Test-Path -LiteralPath $smokeScript)) {
        throw "Missing service/base smoke script: $smokeScript"
    }

    Write-Host "Running service/base smoke check with image $Image..." -ForegroundColor Cyan
    Invoke-EasyEmailScript -ScriptPath $smokeScript -Arguments @(
        '-ConfigPath', $ConfigPath,
        '-Image', $Image,
        '-Pull'
    )
}

function Invoke-CloudflareRuntimeHealthCheck {
    param(
        [Parameter(Mandatory = $true)]
        [string]$BaseUrl,
        [Parameter(Mandatory = $true)]
        [int]$MaxAttempts,
        [Parameter(Mandatory = $true)]
        [int]$DelaySeconds
    )

    $normalizedBaseUrl = $BaseUrl.TrimEnd('/')
    if ([string]::IsNullOrWhiteSpace($normalizedBaseUrl)) {
        throw 'cloudflareMail.publicBaseUrl is required for health checks.'
    }

    $healthUrl = "$normalizedBaseUrl/health_check"
    $settingsUrl = "$normalizedBaseUrl/open_api/settings"
    $lastError = $null

    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt += 1) {
        try {
            $healthResponse = Invoke-WebRequest -Uri $healthUrl -Method Get -TimeoutSec 10
            $healthBody = [string]$healthResponse.Content.Trim()

            if ($healthBody -eq 'OK') {
                $settings = Invoke-RestMethod -Uri $settingsUrl -Method Get -TimeoutSec 10
                if (-not $settings.version) {
                    throw 'Cloudflare settings response is missing version.'
                }
                if (-not $settings.domains -or @($settings.domains).Count -eq 0) {
                    throw 'Cloudflare settings response is missing domains.'
                }

                return [pscustomobject]@{
                    baseUrl = $normalizedBaseUrl
                    healthUrl = $healthUrl
                    settingsUrl = $settingsUrl
                    version = [string]$settings.version
                    domains = @($settings.domains)
                    randomSubdomainDomains = @($settings.randomSubdomainDomains)
                    needAuth = [bool]$settings.needAuth
                    title = [string]$settings.title
                }
            }

            $lastError = "Unexpected health response body: $healthBody"
        } catch {
            $lastError = $_.Exception.Message
        }

        if ($attempt -lt $MaxAttempts) {
            Start-Sleep -Seconds $DelaySeconds
        }
    }

    throw "Cloudflare runtime health check failed at $healthUrl. Last error: $lastError"
}

$cloudflareDeployScript = Join-Path $PSScriptRoot 'deploy-cloudflare-email.ps1'
$ghcrPublishScript = Resolve-EasyEmailPath -Path 'deploy/service/base/publish-ghcr-easy-email-service.ps1'
$releaseSummary = [ordered]@{}

if (-not $SkipServiceBaseGhcr) {
    if (-not (Test-Path -LiteralPath $ghcrPublishScript)) {
        throw "Missing GHCR publish script: $ghcrPublishScript"
    }

    $ghcrMetadataPath = New-EasyEmailTempFile -Prefix 'service-base-ghcr-release' -Extension '.json'
    $ghcrArgs = @(
        '-ConfigPath', $resolvedConfigPath,
        '-Platform', $ServiceBasePlatform,
        '-MetadataOutput', $ghcrMetadataPath,
        '-Push'
    )
    if (-not [string]::IsNullOrWhiteSpace($ServiceBaseVersion)) {
        $ghcrArgs += '-Version'
        $ghcrArgs += $ServiceBaseVersion
    }
    if ($DryRun) {
        $ghcrArgs += '-DryRun'
    }

    Write-Host 'Publishing service/base image to GHCR...' -ForegroundColor Cyan
    try {
        Invoke-EasyEmailScript -ScriptPath $ghcrPublishScript -Arguments $ghcrArgs
        $serviceReleaseMetadata = Read-EasyEmailJsonFile -Path $ghcrMetadataPath
        $releaseSummary.serviceBase = [ordered]@{
            imageRef = $serviceReleaseMetadata.imageRef
            version = $serviceReleaseMetadata.version
            tags = @($serviceReleaseMetadata.tags)
            smoke = if ($DryRun -or $SkipServiceBaseSmoke) { 'skipped' } else { 'pending' }
        }

        if (-not $DryRun -and -not $SkipServiceBaseSmoke) {
            Invoke-ServiceBaseSmokeCheck -ConfigPath $resolvedConfigPath -Image ([string]$serviceReleaseMetadata.tags[0])
            $releaseSummary.serviceBase.smoke = 'passed'
        }
    } finally {
        if (Test-Path -LiteralPath $ghcrMetadataPath) {
            Remove-Item -Force $ghcrMetadataPath
        }
    }
}

if (-not $SkipCloudflareMail) {
    if (-not (Test-Path -LiteralPath $cloudflareDeployScript)) {
        throw "Missing cloudflare deploy script: $cloudflareDeployScript"
    }

    $cloudflareArgs = @(
        '-ConfigPath', $resolvedConfigPath
    )
    if ($PSBoundParameters.ContainsKey('SyncMode') -and -not [string]::IsNullOrWhiteSpace($SyncMode)) {
        $cloudflareArgs += '-SyncMode'
        $cloudflareArgs += $SyncMode
    }
    if ($NoInstall) {
        $cloudflareArgs += '-NoInstall'
    }
    if ($BootstrapMissingResources) {
        $cloudflareArgs += '-BootstrapMissingResources'
    }
    if ($ForceRoutingStateSync) {
        $cloudflareArgs += '-ForceRoutingStateSync'
    }
    if ($NoRoutingSync) {
        $cloudflareArgs += '-NoRoutingSync'
    }
    if ($DryRun) {
        $cloudflareArgs += '-DryRun'
    }

    Write-Host 'Deploying cloudflare email runtime...' -ForegroundColor Cyan
    Invoke-EasyEmailScript -ScriptPath $cloudflareDeployScript -Arguments $cloudflareArgs

    $releaseSummary.cloudflareMail = [ordered]@{
        baseUrl = [string](Get-EasyEmailConfigValue -Object $cloudflare -Name 'publicBaseUrl' -Default '')
        health = if ($DryRun -or $SkipCloudflareHealthCheck) { 'skipped' } else { 'pending' }
        version = ''
        domains = @()
    }

    if (-not $DryRun -and -not $SkipCloudflareHealthCheck) {
        $cloudflareHealth = Invoke-CloudflareRuntimeHealthCheck `
            -BaseUrl $releaseSummary.cloudflareMail.baseUrl `
            -MaxAttempts $HealthCheckMaxAttempts `
            -DelaySeconds $HealthCheckDelaySeconds
        $releaseSummary.cloudflareMail.health = 'passed'
        $releaseSummary.cloudflareMail.version = $cloudflareHealth.version
        $releaseSummary.cloudflareMail.domains = @($cloudflareHealth.domains)
        $releaseSummary.cloudflareMail.randomSubdomainDomains = @($cloudflareHealth.randomSubdomainDomains)
        $releaseSummary.cloudflareMail.needAuth = $cloudflareHealth.needAuth
    }
}

Write-Host 'Release Summary:' -ForegroundColor Cyan
if ($releaseSummary.Contains('serviceBase')) {
    $serviceBaseSummary = $releaseSummary['serviceBase']
    Write-Host ("service/base image version: " + $serviceBaseSummary.version)
    Write-Host ("service/base tags:")
    foreach ($tag in $serviceBaseSummary.tags) {
        Write-Host (" - " + $tag)
    }
    Write-Host ("service/base smoke: " + $serviceBaseSummary.smoke)
}
if ($releaseSummary.Contains('cloudflareMail')) {
    $cloudflareSummary = $releaseSummary['cloudflareMail']
    Write-Host ("cloudflare base URL: " + $cloudflareSummary.baseUrl)
    if ($cloudflareSummary.version) {
        Write-Host ("cloudflare version: " + $cloudflareSummary.version)
    }
    if ($cloudflareSummary.domains.Count -gt 0) {
        Write-Host ("cloudflare domains: " + ($cloudflareSummary.domains -join ", "))
    }
    Write-Host ("cloudflare health: " + $cloudflareSummary.health)
}

Write-Host 'EasyEmail release workflow finished.' -ForegroundColor Green
