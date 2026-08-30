param(
  [string]$BaseUrl = "",
  [string]$ConfigPath = 'config.yaml',
  [string]$ApiKey = "",
  [string]$Image = "",
  [string]$InstanceName = "",
  [int]$HostPort = 0,
  [string]$RuntimeRoot = "",
  [string]$NetworkName = "",
  [string]$NetworkAlias = "easy-email-service-smoke",
  [string]$ComposeProjectName = "",
  [switch]$Pull,
  [switch]$Rebuild,
  [switch]$KeepRunning,
  [switch]$SkipRenderConfig,
  [switch]$SkipMailboxOpen
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$composeFile = Join-Path $scriptDir "docker-compose.yaml"
$workspaceRoot = (Resolve-Path (Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $scriptDir)))).Path

. (Join-Path $workspaceRoot 'scripts/lib/easyemail-config.ps1')

$powerShellCommand = Get-EasyEmailPowerShellCommand
$runName = if ([string]::IsNullOrWhiteSpace($InstanceName)) {
  "smoke-$([Guid]::NewGuid().ToString('N').Substring(0, 8))"
} else {
  $InstanceName.Trim()
}
if ($runName -notmatch '^[A-Za-z0-9][A-Za-z0-9_.-]*$') {
  throw "Invalid smoke instance name '$runName'. Use letters, digits, dots, underscores, or hyphens."
}

if ($HostPort -le 0) {
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  try {
    $listener.Start()
    $HostPort = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
  } finally {
    $listener.Stop()
  }
}

if ([string]::IsNullOrWhiteSpace($BaseUrl)) {
  $BaseUrl = "http://127.0.0.1:$HostPort"
}
if ([string]::IsNullOrWhiteSpace($RuntimeRoot)) {
  $RuntimeRoot = Join-Path $workspaceRoot ".tmp/service-base-smoke/$runName"
}
if ([string]::IsNullOrWhiteSpace($NetworkName)) {
  $NetworkName = "easy-email-smoke-$runName"
}
if ([string]::IsNullOrWhiteSpace($ComposeProjectName)) {
  $ComposeProjectName = "easy-email-smoke-$($runName.ToLowerInvariant())"
}
if ([string]::IsNullOrWhiteSpace($Image)) {
  $Image = "easy-email/easy-email:smoke-$runName"
}
if ($ComposeProjectName -notmatch '^[a-z0-9][a-z0-9_-]*$') {
  throw "Invalid Compose project name '$ComposeProjectName'. Use lowercase letters, digits, underscores, or hyphens."
}

$resolvedRuntimeRoot = Resolve-EasyEmailPath -Path $RuntimeRoot
$configMountPath = Join-Path $resolvedRuntimeRoot 'config'
$dataMountPath = Join-Path $resolvedRuntimeRoot 'data'
$envFilePath = Join-Path $configMountPath 'runtime.env'
$serviceConfigPath = Join-Path $configMountPath 'config.yaml'
if (Test-Path -LiteralPath $resolvedRuntimeRoot) {
  throw "Refusing to reuse an existing smoke runtime root: $resolvedRuntimeRoot"
}

try {
  New-Item -ItemType Directory -Force -Path $configMountPath | Out-Null
  New-Item -ItemType Directory -Force -Path $dataMountPath | Out-Null

  if (-not $SkipRenderConfig -and (Test-Path -LiteralPath $ConfigPath)) {
    & $powerShellCommand -ExecutionPolicy Bypass -File (Join-Path $workspaceRoot 'scripts/render-derived-configs.ps1') `
      -ConfigPath $ConfigPath `
      -ServiceBase `
      -ServiceOutput $serviceConfigPath `
      -ServiceEnvOutput $envFilePath
    if ($LASTEXITCODE -ne 0) {
      throw "Failed to render service/base config from $ConfigPath"
    }
  }
  if (-not (Test-Path -LiteralPath $serviceConfigPath)) {
    throw "Isolated service config was not created: $serviceConfigPath"
  }
} catch {
  Remove-Item -LiteralPath $resolvedRuntimeRoot -Recurse -Force -ErrorAction SilentlyContinue
  throw
}

if (-not $ApiKey -and (Test-Path -LiteralPath $ConfigPath)) {
  try {
    $config = Read-EasyEmailConfig -ConfigPath $ConfigPath
    $serviceBase = Get-EasyEmailSection -Config $config -Name 'serviceBase'
    $runtime = Get-EasyEmailSection -Config $serviceBase -Name 'runtime'
    $server = Get-EasyEmailSection -Config $runtime -Name 'server'
    $ApiKey = [string](Get-EasyEmailConfigValue -Object $server -Name 'apiKey' -Default '')
  } catch {
    Write-Warning ("Failed to read service API key from config: " + $_.Exception.Message)
  }
}

$environmentNames = @(
  'EASY_EMAIL_SERVICE_IMAGE',
  'EASY_EMAIL_SERVICE_CONTAINER_NAME',
  'EASY_EMAIL_SERVICE_HOST_PORT',
  'EASY_EMAIL_SERVICE_ENV_FILE',
  'EASY_EMAIL_SERVICE_CONFIG_DIR',
  'EASY_EMAIL_SERVICE_DATA_DIR',
  'EASY_EMAIL_SERVICE_NETWORK',
  'EASY_EMAIL_SERVICE_NETWORK_ALIAS'
)
$previousEnvironment = @{}
foreach ($name in $environmentNames) {
  $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}

$env:EASY_EMAIL_SERVICE_IMAGE = $Image
$containerName = "easy-email-$runName"
$env:EASY_EMAIL_SERVICE_CONTAINER_NAME = $containerName
$env:EASY_EMAIL_SERVICE_HOST_PORT = [string]$HostPort
$env:EASY_EMAIL_SERVICE_ENV_FILE = $envFilePath
$env:EASY_EMAIL_SERVICE_CONFIG_DIR = $configMountPath
$env:EASY_EMAIL_SERVICE_DATA_DIR = $dataMountPath
$env:EASY_EMAIL_SERVICE_NETWORK = $NetworkName
$env:EASY_EMAIL_SERVICE_NETWORK_ALIAS = $NetworkAlias

function Ensure-DockerNetwork {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name
  )

  if ([string]::IsNullOrWhiteSpace($Name)) {
    return $false
  }

  $existingNetworks = @(& docker network ls --filter "name=$Name" --format "{{.Name}}")
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to inspect docker networks before creating $Name"
  }
  if ($existingNetworks -contains $Name) {
    throw "Refusing to reuse existing docker network $Name for an isolated smoke run"
  }

  Write-Host "Creating docker network: $Name"
  docker network create $Name | Out-Host
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to create docker network $Name"
  }
  return $true
}

function Assert-DockerIsolationAvailable {
  $matchingContainers = @(& docker ps -a --filter "name=$containerName" --format "{{.Names}}")
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to inspect docker containers before starting $containerName"
  }
  if ($matchingContainers -contains $containerName) {
    throw "Refusing to reuse existing docker container $containerName"
  }

  $projectContainers = @(& docker ps -a --filter "label=com.docker.compose.project=$ComposeProjectName" --format "{{.Names}}")
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to inspect compose project $ComposeProjectName"
  }
  if ($projectContainers.Count -gt 0) {
    throw "Refusing to reuse existing compose project $ComposeProjectName"
  }
}

$networkCreated = $false
$composeAttempted = $false
$cleanupFailure = ''
try {
  Assert-DockerIsolationAvailable

  if ($Pull -and $Image) {
    Write-Host "Pulling service image: $Image"
    docker pull $Image | Out-Host
    if ($LASTEXITCODE -ne 0) {
      throw "Failed to pull service image: $Image"
    }
  }

  $networkCreated = Ensure-DockerNetwork -Name $NetworkName
  $composeArgs = @("compose", "-p", $ComposeProjectName, "-f", $composeFile, "up", "-d")
  if ($Rebuild) {
    $composeArgs += "--build"
  }

  Write-Host "Starting isolated docker stack $ComposeProjectName on $BaseUrl..."
  $composeAttempted = $true
  docker @composeArgs | Out-Host
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to start isolated service/base smoke stack."
  }

  $catalogUrl = "$BaseUrl/mail/catalog"
  $headers = @{}
  if ($ApiKey.Trim()) {
    $headers["Authorization"] = "Bearer $ApiKey"
  }
  $maxAttempts = 30
  $catalog = $null
  for ($i = 1; $i -le $maxAttempts; $i++) {
    try {
      $catalog = Invoke-RestMethod -Method Get -Uri $catalogUrl -Headers $headers -TimeoutSec 5
      break
    } catch {
      Start-Sleep -Seconds 1
    }
  }

  if (-not $catalog) {
    throw "EasyEmail API did not become ready at $catalogUrl"
  }

  Write-Host "[OK] GET $catalogUrl"
  $providerKeys = @($catalog.catalog.providerTypes | ForEach-Object { $_.key })
  Write-Host ("Providers: " + ($providerKeys -join ", "))

  if (-not $SkipMailboxOpen) {
    $openUrl = "$BaseUrl/mail/mailboxes/open"
    $openBody = @{
      hostId = "smoke-easy-email"
      provisionMode = "reuse-only"
      bindingMode = "shared-instance"
      providerTypeKey = "cloudflare_temp_email"
      providerStrategyModeId = "cloudflare_temp_email-first"
      requestRandomSubdomain = $true
    } | ConvertTo-Json -Depth 5

    try {
      $openHeaders = @{}
      foreach ($key in $headers.Keys) {
        $openHeaders[$key] = $headers[$key]
      }
      $openHeaders["Content-Type"] = "application/json"
      $openResult = Invoke-RestMethod -Method Post -Uri $openUrl -Headers $openHeaders -Body $openBody -TimeoutSec 10
      if ($openResult.result.session.emailAddress) {
        Write-Host ("[OK] POST " + $openUrl + " => " + $openResult.result.session.emailAddress)
      }
    } catch {
      Write-Warning ("Mailbox open smoke failed: " + $_.Exception.Message)
    }
  }
} finally {
  if (-not $KeepRunning) {
    $composeDownExitCode = 0
    if ($composeAttempted) {
      Write-Host "Stopping isolated docker stack $ComposeProjectName..."
      $previousErrorActionPreference = $ErrorActionPreference
      $ErrorActionPreference = 'Continue'
      try {
        docker compose -p $ComposeProjectName -f $composeFile down --remove-orphans | Out-Host
        $composeDownExitCode = $LASTEXITCODE
      } finally {
        $ErrorActionPreference = $previousErrorActionPreference
      }
    }
    if ($composeDownExitCode -ne 0) {
      $cleanupFailure = "Failed to remove isolated compose project $ComposeProjectName."
      Write-Warning $cleanupFailure
    } elseif ($networkCreated) {
      $previousErrorActionPreference = $ErrorActionPreference
      $ErrorActionPreference = 'Continue'
      try {
        docker network rm $NetworkName *> $null
        $networkRemoveExitCode = $LASTEXITCODE
      } finally {
        $ErrorActionPreference = $previousErrorActionPreference
      }
      if ($networkRemoveExitCode -ne 0) {
        $cleanupFailure = "Failed to remove isolated smoke network $NetworkName."
        Write-Warning $cleanupFailure
      }
    }
    if (-not $cleanupFailure -and (Test-Path -LiteralPath $resolvedRuntimeRoot)) {
      try {
        Remove-Item -LiteralPath $resolvedRuntimeRoot -Recurse -Force
      } catch {
        $cleanupFailure = "Failed to remove isolated smoke runtime root $resolvedRuntimeRoot."
        Write-Warning $cleanupFailure
      }
    }
  } else {
    Write-Host "Smoke stack retained: project=$ComposeProjectName runtimeRoot=$resolvedRuntimeRoot" -ForegroundColor Yellow
  }

  foreach ($name in $environmentNames) {
    [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], 'Process')
  }
}

if ($cleanupFailure) {
  throw $cleanupFailure
}
