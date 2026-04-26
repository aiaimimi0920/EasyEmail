param(
  [string]$BaseUrl = "http://127.0.0.1:18081",
  [string]$ApiKey = "",
  [switch]$Rebuild,
  [switch]$KeepRunning
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$composeFile = Join-Path $scriptDir "docker-compose.yaml"

$composeArgs = @("compose", "-f", $composeFile, "up", "-d")
if ($Rebuild) {
  $composeArgs += "--build"
}

Write-Host "Starting docker stack..."
docker @composeArgs | Out-Host

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

if (-not $KeepRunning) {
  Write-Host "Stopping docker stack..."
  docker compose -f $composeFile down | Out-Host
}
