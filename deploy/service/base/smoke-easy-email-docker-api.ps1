param(
  [string]$BaseUrl = "http://127.0.0.1:18081",
  [string]$ConfigPath = 'config.yaml',
  [string]$ApiKey = "",
  [string]$Image = "",
  [switch]$Pull,
  [switch]$Rebuild,
  [switch]$KeepRunning,
  [switch]$SkipRenderConfig
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$composeFile = Join-Path $scriptDir "docker-compose.yaml"
$workspaceRoot = (Resolve-Path (Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $scriptDir)))).Path

. (Join-Path $workspaceRoot 'scripts/lib/easyemail-config.ps1')

$powerShellCommand = Get-EasyEmailPowerShellCommand

if (-not $SkipRenderConfig -and (Test-Path -LiteralPath $ConfigPath)) {
  & $powerShellCommand -ExecutionPolicy Bypass -File (Join-Path $workspaceRoot 'scripts/render-derived-configs.ps1') `
    -ConfigPath $ConfigPath `
    -ServiceBase
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to render service/base config from $ConfigPath"
  }
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

if ($Image) {
  $env:EASY_EMAIL_SERVICE_IMAGE = $Image
}

if ($Pull -and $Image) {
  Write-Host "Pulling service image: $Image"
  docker pull $Image | Out-Host
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to pull service image: $Image"
  }
}

$networkName = 'Easy'
docker network inspect $networkName *> $null
if ($LASTEXITCODE -ne 0) {
  Write-Host "Creating docker network: $networkName"
  docker network create $networkName | Out-Host
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to create docker network $networkName"
  }
}

$composeArgs = @("compose", "-f", $composeFile, "up", "-d")
if ($Rebuild) {
  $composeArgs += "--build"
}

Write-Host "Starting docker stack..."
docker @composeArgs | Out-Host

try {
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
} finally {
  if (-not $KeepRunning) {
    Write-Host "Stopping docker stack..."
    docker compose -f $composeFile down | Out-Host
  }
}
