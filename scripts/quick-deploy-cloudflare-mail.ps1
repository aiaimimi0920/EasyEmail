param(
    [string]$ConfigPath = (Join-Path $PSScriptRoot '..\config.yaml'),
    [ValidateSet('exact', 'wildcard')]
    [string]$SyncMode = 'exact',
    [switch]$NoInstall,
    [switch]$NoRoutingSync,
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot 'lib\easyemail-config.ps1')

function Invoke-InDirectory {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [Parameter(Mandatory = $true)]
        [scriptblock]$Action
    )

    Push-Location $Path
    try {
        & $Action
        if ($LASTEXITCODE -ne 0) {
            throw "Command failed in $Path with exit code $LASTEXITCODE"
        }
    } finally {
        Pop-Location
    }
}

function Invoke-Tool {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Executable,
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments,
        [Parameter(Mandatory = $true)]
        [string]$WorkingDirectory
    )

    Push-Location $WorkingDirectory
    try {
        & $Executable @Arguments
        if ($LASTEXITCODE -ne 0) {
            throw "Command failed: $Executable $($Arguments -join ' ')"
        }
    } finally {
        Pop-Location
    }
}

$config = Read-EasyEmailConfig -ConfigPath $ConfigPath
$cloudflare = Get-EasyEmailSection -Config $config -Name 'cloudflareMail'
if ($null -eq $cloudflare) {
    throw 'Missing cloudflareMail section in config.yaml.'
}

$projectRoot = Resolve-EasyEmailPath -Path (Get-EasyEmailConfigValue -Object $cloudflare -Name 'projectRoot' -Default 'upstreams/cloudflare_temp_email')
$workerDir = Resolve-EasyEmailPath -Path (Join-Path $projectRoot (Get-EasyEmailConfigValue -Object $cloudflare -Name 'workerDir' -Default 'worker'))
$frontendDir = Resolve-EasyEmailPath -Path (Join-Path $projectRoot (Get-EasyEmailConfigValue -Object $cloudflare -Name 'frontendDir' -Default 'frontend'))
$routing = Get-EasyEmailSection -Config $cloudflare -Name 'routing'
$buildFrontend = [bool](Get-EasyEmailConfigValue -Object $cloudflare -Name 'buildFrontend' -Default $true)
$deployWorker = [bool](Get-EasyEmailConfigValue -Object $cloudflare -Name 'deployWorker' -Default $true)
$syncRouting = -not $NoRoutingSync -and [bool](Get-EasyEmailConfigValue -Object $cloudflare -Name 'syncRouting' -Default $false)
$workerEnv = [string](Get-EasyEmailConfigValue -Object $cloudflare -Name 'workerEnv' -Default 'production')
$effectiveSyncMode = if ($PSBoundParameters.ContainsKey('SyncMode')) {
    $SyncMode
} else {
    [string](Get-EasyEmailConfigValue -Object $routing -Name 'mode' -Default 'exact')
}

if (-not (Test-Path -LiteralPath $workerDir)) {
    throw "Worker directory not found: $workerDir"
}

if ($buildFrontend) {
    Write-Host "Building cloudflare frontend..." -ForegroundColor Cyan
    if (-not $NoInstall -and -not (Test-Path -LiteralPath (Join-Path $frontendDir 'node_modules'))) {
        Invoke-Tool -Executable 'corepack' -Arguments @('pnpm', 'install', '--frozen-lockfile') -WorkingDirectory $frontendDir
    }
    Invoke-Tool -Executable 'corepack' -Arguments @('pnpm', 'build') -WorkingDirectory $frontendDir
}

if ($deployWorker) {
    Write-Host "Deploying cloudflare worker..." -ForegroundColor Cyan
    if (-not $NoInstall -and -not (Test-Path -LiteralPath (Join-Path $workerDir 'node_modules'))) {
        Invoke-Tool -Executable 'corepack' -Arguments @('pnpm', 'install', '--frozen-lockfile') -WorkingDirectory $workerDir
    }
    if ($DryRun) {
        Invoke-Tool -Executable 'corepack' -Arguments @('pnpm', 'build') -WorkingDirectory $workerDir
    } else {
        $deployArgs = @('pnpm', 'deploy')
        if (-not [string]::IsNullOrWhiteSpace($workerEnv) -and $workerEnv -ne 'production') {
            $deployArgs += '--'
            $deployArgs += '--env'
            $deployArgs += $workerEnv
        }
        Invoke-Tool -Executable 'corepack' -Arguments $deployArgs -WorkingDirectory $workerDir
    }
}

if ($syncRouting) {
    $routingPlanPath = Resolve-EasyEmailPath -Path (Get-EasyEmailConfigValue -Object $routing -Name 'planPath' -Default 'deploy/upstreams/cloudflare_temp_email/config/subdomain_pool_plan_20260402.toml')
    $controlCenterDnsToken = [string](Get-EasyEmailConfigValue -Object $routing -Name 'controlCenterDnsToken' -Default '')
    $globalAuth = Get-EasyEmailSection -Config $routing -Name 'cloudflareGlobalAuth'
    $authEmail = [string](Get-EasyEmailConfigValue -Object $globalAuth -Name 'authEmail' -Default '')
    $globalApiKey = [string](Get-EasyEmailConfigValue -Object $globalAuth -Name 'globalApiKey' -Default '')

    if ([string]::IsNullOrWhiteSpace($controlCenterDnsToken) -and [string]::IsNullOrWhiteSpace($authEmail) -and [string]::IsNullOrWhiteSpace($globalApiKey)) {
        Write-Warning 'Routing sync is enabled, but no routing secrets were provided in config.yaml. Skipping routing sync.'
    } else {
        $controlCenterTokenFile = $null
        $globalAuthFile = $null
        try {
            if (-not [string]::IsNullOrWhiteSpace($controlCenterDnsToken)) {
                $controlCenterTokenFile = New-EasyEmailTempFile -Prefix 'control-center-cloudflare-dns' -Extension '.json'
                Write-EasyEmailJsonFile -Path $controlCenterTokenFile -Value @{ token = $controlCenterDnsToken } | Out-Null
            }

            if (-not [string]::IsNullOrWhiteSpace($authEmail) -and -not [string]::IsNullOrWhiteSpace($globalApiKey)) {
                $globalAuthFile = New-EasyEmailTempFile -Prefix 'cloudflare-global-auth' -Extension '.json'
                Write-EasyEmailJsonFile -Path $globalAuthFile -Value @{
                    deployment_platform_auth = @{
                        cloudflare = @{
                            auth_email = $authEmail
                            global_api_key = $globalApiKey
                        }
                    }
                } | Out-Null
            }

            if ($globalAuthFile) {
                Write-Host "Syncing cloudflare email routing state..." -ForegroundColor Cyan
                Invoke-Tool -Executable 'python' -Arguments @(
                    (Resolve-EasyEmailPath -Path 'deploy/upstreams/cloudflare_temp_email/scripts/sync_email_routing_state.py'),
                    '--plan', $routingPlanPath,
                    '--secret-file', $globalAuthFile,
                    '--worker-name', [string](Get-EasyEmailConfigValue -Object $cloudflare -Name 'workerName' -Default 'cloudflare_temp_email')
                ) -WorkingDirectory $projectRoot
            }

            if ($controlCenterTokenFile) {
                Write-Host "Syncing cloudflare email routing DNS..." -ForegroundColor Cyan
                Invoke-Tool -Executable 'powershell' -Arguments @(
                    '-ExecutionPolicy', 'Bypass',
                    '-File', (Resolve-EasyEmailPath -Path 'deploy/upstreams/cloudflare_temp_email/scripts/sync_email_routing_dns.ps1'),
                    '-PlanPath', $routingPlanPath,
                    '-Mode', $effectiveSyncMode,
                    '-ApiToken', $controlCenterDnsToken
                ) -WorkingDirectory $projectRoot
            }
        } finally {
            if ($controlCenterTokenFile -and (Test-Path -LiteralPath $controlCenterTokenFile)) {
                Remove-Item -Force $controlCenterTokenFile
            }
            if ($globalAuthFile -and (Test-Path -LiteralPath $globalAuthFile)) {
                Remove-Item -Force $globalAuthFile
            }
        }
    }
}

Write-Host 'Cloudflare mail quick deploy completed.'
