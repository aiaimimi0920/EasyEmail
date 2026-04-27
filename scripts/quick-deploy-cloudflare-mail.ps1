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
$minimumNodeVersion = [Version]'20.19.0'
$powerShellCommand = Get-EasyEmailPowerShellCommand
$placeholderDatabaseId = '00000000-0000-0000-0000-000000000000'
$placeholderDomains = @('example.com', 'mail.example.com', '*.example.com')

function Assert-MinimumNodeVersion {
    param(
        [Parameter(Mandatory = $true)]
        [Version]$MinimumVersion
    )

    $rawNodeVersion = (& node --version).Trim()
    if ($LASTEXITCODE -ne 0) {
        throw 'Node.js is required but was not found in PATH.'
    }

    $currentNodeVersion = [Version]($rawNodeVersion.TrimStart('v'))
    if ($currentNodeVersion -lt $MinimumVersion) {
        throw "Node.js $MinimumVersion or newer is required. Current version: $currentNodeVersion"
    }
}

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

function Invoke-PythonJsonTool {
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
        $output = & $Executable @Arguments
        if ($LASTEXITCODE -ne 0) {
            throw "Command failed: $Executable $($Arguments -join ' ')"
        }
        $json = ($output | Out-String).Trim()
        if ([string]::IsNullOrWhiteSpace($json)) {
            throw "Command did not return JSON output: $Executable $($Arguments -join ' ')"
        }
        return $json | ConvertFrom-Json
    } finally {
        Pop-Location
    }
}

function Invoke-LocalNodeTool {
    param(
        [Parameter(Mandatory = $true)]
        [string]$CommandPath,
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments,
        [Parameter(Mandatory = $true)]
        [string]$WorkingDirectory
    )

    if (-not (Test-Path -LiteralPath $CommandPath)) {
        throw "Local command not found: $CommandPath"
    }

    Invoke-Tool -Executable $CommandPath -Arguments $Arguments -WorkingDirectory $WorkingDirectory
}

function Get-FirstEasyEmailString {
    param([object]$Value)

    $values = Convert-ToEasyEmailStringArray -Value $Value
    if ($values.Count -eq 0) {
        return ''
    }

    return [string]$values[0]
}

function Test-IsPlaceholderD1DatabaseId {
    param([string]$Value)

    if ([string]::IsNullOrWhiteSpace($Value)) {
        return $true
    }

    return $Value.Trim() -eq $script:placeholderDatabaseId
}

function Invoke-CloudflareBootstrap {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ConfigPathValue,
        [Parameter(Mandatory = $true)]
        [string]$WorkerDirectory,
        [switch]$CreateMissingZones,
        [switch]$DryRunMode
    )

    $bootstrapScript = Resolve-EasyEmailPath -Path 'deploy/upstreams/cloudflare_temp_email/scripts/bootstrap_cloudflare_mail.py'
    if (-not (Test-Path -LiteralPath $bootstrapScript)) {
        throw "Missing bootstrap script: $bootstrapScript"
    }

    $wranglerCommand = Resolve-EasyEmailLocalNodeTool -PackageDirectory $WorkerDirectory -ToolName 'wrangler'
    $args = @(
        $bootstrapScript,
        '--config', $ConfigPathValue,
        '--worker-dir', $WorkerDirectory,
        '--wrangler-command', $wranglerCommand
    )
    if ($CreateMissingZones) {
        $args += '--create-missing-zones'
    }
    if ($DryRunMode) {
        $args += '--dry-run'
    }

    Write-Host "Bootstrapping missing Cloudflare resources..." -ForegroundColor Cyan
    return Invoke-PythonJsonTool -Executable 'python' -Arguments $args -WorkingDirectory $script:EasyEmailRepoRoot
}

function Wait-CloudflareRuntimeHealthy {
    param(
        [Parameter(Mandatory = $true)]
        [string]$BaseUrl,
        [int]$TimeoutSeconds = 180
    )

    $healthUrl = $BaseUrl.TrimEnd('/') + '/health_check'
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        try {
            $response = Invoke-WebRequest -Uri $healthUrl -Method Get -TimeoutSec 10
            if ($response.Content.Trim() -eq 'OK') {
                return
            }
        } catch {
            Start-Sleep -Seconds 5
            continue
        }

        Start-Sleep -Seconds 5
    } while ([DateTime]::UtcNow -lt $deadline)

    throw "Timed out waiting for Cloudflare runtime health at $healthUrl"
}

function Invoke-CloudflareDatabaseInitialization {
    param(
        [Parameter(Mandatory = $true)]
        [object]$CloudflareConfig
    )

    $baseUrl = [string](Get-EasyEmailConfigValue -Object $CloudflareConfig -Name 'publicBaseUrl' -Default '')
    if ([string]::IsNullOrWhiteSpace($baseUrl)) {
        throw 'cloudflareMail.publicBaseUrl is required for database initialization.'
    }

    $worker = Get-EasyEmailSection -Config $CloudflareConfig -Name 'worker'
    $vars = Get-EasyEmailSection -Config $worker -Name 'vars'
    $customAuth = Get-FirstEasyEmailString -Value (Get-EasyEmailConfigValue -Object $vars -Name 'PASSWORDS' -Default @())
    $adminAuth = Get-FirstEasyEmailString -Value (Get-EasyEmailConfigValue -Object $vars -Name 'ADMIN_PASSWORDS' -Default @())

    if ([string]::IsNullOrWhiteSpace($customAuth)) {
        throw 'cloudflareMail.worker.vars.PASSWORDS must contain at least one value for bootstrap database initialization.'
    }
    if ([string]::IsNullOrWhiteSpace($adminAuth)) {
        throw 'cloudflareMail.worker.vars.ADMIN_PASSWORDS must contain at least one value for bootstrap database initialization.'
    }

    Wait-CloudflareRuntimeHealthy -BaseUrl $baseUrl

    $headers = @{
        'x-custom-auth' = $customAuth
        'x-admin-auth'  = $adminAuth
    }

    $initializeUrl = $baseUrl.TrimEnd('/') + '/admin/db_initialize'
    $migrationUrl = $baseUrl.TrimEnd('/') + '/admin/db_migration'
    $versionUrl = $baseUrl.TrimEnd('/') + '/admin/db_version'

    Write-Host "Initializing Cloudflare D1 schema..." -ForegroundColor Cyan
    $null = Invoke-RestMethod -Uri $initializeUrl -Method Post -Headers $headers -TimeoutSec 20
    $null = Invoke-RestMethod -Uri $migrationUrl -Method Post -Headers $headers -TimeoutSec 20
    $version = Invoke-RestMethod -Uri $versionUrl -Method Get -Headers $headers -TimeoutSec 20

    if ($version.need_initialization -or $version.need_migration) {
        throw "Cloudflare D1 bootstrap did not finish cleanly at $versionUrl"
    }
}

function Convert-ToEasyEmailStringArray {
    param(
        [object]$Value
    )

    if ($null -eq $Value) {
        return @()
    }

    if ($Value -is [string]) {
        $text = [string]$Value
        return @($text) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    }

    $items = New-Object System.Collections.Generic.List[string]
    foreach ($item in $Value) {
        if ($null -eq $item) {
            continue
        }
        $text = [string]$item
        if (-not [string]::IsNullOrWhiteSpace($text)) {
            $items.Add($text)
        }
    }
    return $items.ToArray()
}

function Convert-ToEasyEmailTomlString {
    param([string]$Value)

    $escaped = $Value.Replace('\', '\\').Replace('"', '\"')
    return '"' + $escaped + '"'
}

function Convert-ToEasyEmailTomlArray {
    param([object]$Value)

    $items = Convert-ToEasyEmailStringArray -Value $Value
    if ($items.Count -eq 0) {
        return '[]'
    }

    $formatted = $items | ForEach-Object { '  ' + (Convert-ToEasyEmailTomlString -Value $_) }
    return "[`r`n$($formatted -join ",`r`n")`r`n]"
}

function Remove-EasyEmailPlaceholderDomains {
    param([object]$Value)

    $items = Convert-ToEasyEmailStringArray -Value $Value
    return @($items | Where-Object { $script:placeholderDomains -notcontains $_.Trim().ToLowerInvariant() })
}

function Write-CloudflareRoutingPlanFile {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Plan
    )

    $labels = Convert-ToEasyEmailStringArray -Value (Get-EasyEmailConfigValue -Object $Plan -Name 'subdomainLabelPool' -Default @())
    $domains = Remove-EasyEmailPlaceholderDomains -Value (Get-EasyEmailConfigValue -Object $Plan -Name 'domains' -Default @())
    $defaultDomainsValue = Get-EasyEmailConfigValue -Object $Plan -Name 'defaultDomains' -Default $null
    $defaultDomains = if ($null -eq $defaultDomainsValue) {
        $domains
    } else {
        Remove-EasyEmailPlaceholderDomains -Value $defaultDomainsValue
    }

    if ($labels.Count -eq 0) {
        throw 'Missing cloudflareMail.routing.plan.subdomainLabelPool in config.yaml.'
    }
    if ($domains.Count -eq 0) {
        throw 'Missing cloudflareMail.routing.plan.domains in config.yaml.'
    }
    if ($defaultDomains.Count -eq 0) {
        $defaultDomains = $domains
    }

    $path = New-EasyEmailTempFile -Prefix 'cloudflare-routing-plan' -Extension '.toml'
    $content = @(
        '# generated from config.yaml',
        'SUBDOMAIN_LABEL_POOL = ' + (Convert-ToEasyEmailTomlArray -Value $labels),
        'DOMAINS = ' + (Convert-ToEasyEmailTomlArray -Value $domains),
        'DEFAULT_DOMAINS = ' + (Convert-ToEasyEmailTomlArray -Value $defaultDomains)
    ) -join "`r`n`r`n"

    Set-Content -LiteralPath $path -Value $content -Encoding UTF8
    return $path
}

$config = Read-EasyEmailConfig -ConfigPath $resolvedConfigPath
$cloudflare = Get-EasyEmailSection -Config $config -Name 'cloudflareMail'
if ($null -eq $cloudflare) {
    throw 'Missing cloudflareMail section in config.yaml.'
}

$bootstrap = Get-EasyEmailSection -Config $cloudflare -Name 'bootstrap'
$bootstrapEnabled = [bool]$BootstrapMissingResources -or [bool](Get-EasyEmailConfigValue -Object $bootstrap -Name 'enabled' -Default $false)
$bootstrapCreateZones = if ($bootstrapEnabled) {
    [bool](Get-EasyEmailConfigValue -Object $bootstrap -Name 'createZones' -Default $true)
} else {
    $false
}

$projectRoot = Resolve-EasyEmailPath -Path (Get-EasyEmailConfigValue -Object $cloudflare -Name 'projectRoot' -Default 'upstreams/cloudflare_temp_email')
$workerDir = Resolve-EasyEmailPath -Path (Join-Path $projectRoot (Get-EasyEmailConfigValue -Object $cloudflare -Name 'workerDir' -Default 'worker'))
$frontendDir = Resolve-EasyEmailPath -Path (Join-Path $projectRoot (Get-EasyEmailConfigValue -Object $cloudflare -Name 'frontendDir' -Default 'frontend'))
$workerConfig = Get-EasyEmailSection -Config $cloudflare -Name 'worker'
$d1Entries = @(Get-EasyEmailConfigValue -Object $workerConfig -Name 'd1_databases' -Default @())
$firstD1Entry = if ($d1Entries.Count -gt 0) { $d1Entries[0] } else { $null }
$configuredDatabaseId = [string](Get-EasyEmailConfigValue -Object $firstD1Entry -Name 'database_id' -Default '')

if (-not $bootstrapEnabled -and (Test-IsPlaceholderD1DatabaseId -Value $configuredDatabaseId)) {
    throw 'cloudflareMail.worker.d1_databases[0].database_id is empty or placeholder. Enable bootstrap mode with -BootstrapMissingResources, or provide an existing D1 database id before deploying.'
}

if ($bootstrapEnabled) {
    $bootstrapSummary = Invoke-CloudflareBootstrap `
        -ConfigPathValue $resolvedConfigPath `
        -WorkerDirectory $workerDir `
        -CreateMissingZones:$bootstrapCreateZones `
        -DryRunMode:$DryRun

    $effectiveConfigPath = [string]$bootstrapSummary.configPath
    if (-not [string]::IsNullOrWhiteSpace($effectiveConfigPath)) {
        $resolvedConfigPath = Resolve-EasyEmailPath -Path $effectiveConfigPath
        $config = Read-EasyEmailConfig -ConfigPath $resolvedConfigPath
        $cloudflare = Get-EasyEmailSection -Config $config -Name 'cloudflareMail'
    }
}

$projectRoot = Resolve-EasyEmailPath -Path (Get-EasyEmailConfigValue -Object $cloudflare -Name 'projectRoot' -Default 'upstreams/cloudflare_temp_email')
$workerDir = Resolve-EasyEmailPath -Path (Join-Path $projectRoot (Get-EasyEmailConfigValue -Object $cloudflare -Name 'workerDir' -Default 'worker'))
$frontendDir = Resolve-EasyEmailPath -Path (Join-Path $projectRoot (Get-EasyEmailConfigValue -Object $cloudflare -Name 'frontendDir' -Default 'frontend'))
$routing = Get-EasyEmailSection -Config $cloudflare -Name 'routing'
$routingPlan = Get-EasyEmailSection -Config $routing -Name 'plan'
$renderScript = Join-Path $PSScriptRoot 'render-derived-configs.ps1'
$renderedWorkerWrangler = Resolve-EasyEmailPath -Path '.tmp/cloudflare_temp_email.wrangler.toml'
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
if ($bootstrapEnabled -and -not $deployWorker) {
    throw 'Bootstrap mode requires cloudflareMail.deployWorker=true so the new runtime can be initialized after deployment.'
}

Assert-MinimumNodeVersion -MinimumVersion $minimumNodeVersion

& $renderScript -ConfigPath $resolvedConfigPath -CloudflareMail -WorkerOutput $renderedWorkerWrangler

if ($buildFrontend) {
    Write-Host "Building cloudflare frontend..." -ForegroundColor Cyan
    if (-not $NoInstall -and -not (Test-Path -LiteralPath (Join-Path $frontendDir 'node_modules'))) {
        Invoke-Tool -Executable 'corepack' -Arguments @('pnpm', 'install', '--frozen-lockfile') -WorkingDirectory $frontendDir
    }
    $frontendBuildCommand = Resolve-EasyEmailLocalNodeTool -PackageDirectory $frontendDir -ToolName 'vite'
    Invoke-LocalNodeTool -CommandPath $frontendBuildCommand -Arguments @('build', '-m', 'prod', '--emptyOutDir') -WorkingDirectory $frontendDir
}

if ($deployWorker) {
    Write-Host "Deploying cloudflare worker..." -ForegroundColor Cyan
    if (-not $NoInstall -and -not (Test-Path -LiteralPath (Join-Path $workerDir 'node_modules'))) {
        Invoke-Tool -Executable 'corepack' -Arguments @('pnpm', 'install', '--frozen-lockfile') -WorkingDirectory $workerDir
    }
    $workerWranglerCommand = Resolve-EasyEmailLocalNodeTool -PackageDirectory $workerDir -ToolName 'wrangler'
    $publicDomain = [string](Get-EasyEmailConfigValue -Object $cloudflare -Name 'publicDomain' -Default '')
    if ($DryRun) {
        $workerArgs = @('deploy', '--config', $renderedWorkerWrangler, '--dry-run', '--outdir', 'dist', '--minify')
        Invoke-LocalNodeTool -CommandPath $workerWranglerCommand -Arguments $workerArgs -WorkingDirectory $workerDir
    } else {
        $deployArgs = @('deploy', '--config', $renderedWorkerWrangler, '--minify')
        if (-not [string]::IsNullOrWhiteSpace($workerEnv) -and $workerEnv -ne 'production') {
            $deployArgs += '--env'
            $deployArgs += $workerEnv
        }
        if (-not [string]::IsNullOrWhiteSpace($publicDomain)) {
            $deployArgs += '--domain'
            $deployArgs += $publicDomain
        }
        Invoke-LocalNodeTool -CommandPath $workerWranglerCommand -Arguments $deployArgs -WorkingDirectory $workerDir
    }
}

if ($syncRouting) {
    $routingPlanPath = $null
    $controlCenterDnsToken = [string](Get-EasyEmailConfigValue -Object $routing -Name 'controlCenterDnsToken' -Default '')
    $globalAuth = Get-EasyEmailSection -Config $routing -Name 'cloudflareGlobalAuth'
    $authEmail = [string](Get-EasyEmailConfigValue -Object $globalAuth -Name 'authEmail' -Default '')
    $globalApiKey = [string](Get-EasyEmailConfigValue -Object $globalAuth -Name 'globalApiKey' -Default '')
    $generatedRoutingPlanFile = $null

    if ([string]::IsNullOrWhiteSpace($controlCenterDnsToken) -and [string]::IsNullOrWhiteSpace($authEmail) -and [string]::IsNullOrWhiteSpace($globalApiKey)) {
        Write-Warning 'Routing sync is enabled, but no routing secrets were provided in config.yaml. Skipping routing sync.'
    } else {
        $controlCenterTokenFile = $null
        $globalAuthFile = $null
        try {
            if ($routingPlan) {
                $generatedRoutingPlanFile = Write-CloudflareRoutingPlanFile -Plan $routingPlan
                $routingPlanPath = $generatedRoutingPlanFile
            } else {
                throw 'Missing cloudflareMail.routing.plan in config.yaml.'
            }

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
                Invoke-Tool -Executable $powerShellCommand -Arguments @(
                    '-ExecutionPolicy', 'Bypass',
                    '-File', (Resolve-EasyEmailPath -Path 'deploy/upstreams/cloudflare_temp_email/scripts/sync_email_routing_dns.ps1'),
                    '-PlanPath', $routingPlanPath,
                    '-Mode', $effectiveSyncMode,
                    '-ApiToken', $controlCenterDnsToken
                ) -WorkingDirectory $projectRoot
            }
        } finally {
            if ($generatedRoutingPlanFile -and (Test-Path -LiteralPath $generatedRoutingPlanFile)) {
                Remove-Item -Force $generatedRoutingPlanFile
            }
            if ($controlCenterTokenFile -and (Test-Path -LiteralPath $controlCenterTokenFile)) {
                Remove-Item -Force $controlCenterTokenFile
            }
            if ($globalAuthFile -and (Test-Path -LiteralPath $globalAuthFile)) {
                Remove-Item -Force $globalAuthFile
            }
        }
    }
}

if ($bootstrapEnabled -and -not $DryRun -and $deployWorker) {
    Invoke-CloudflareDatabaseInitialization -CloudflareConfig $cloudflare
}

Write-Host 'Cloudflare mail quick deploy completed.'
