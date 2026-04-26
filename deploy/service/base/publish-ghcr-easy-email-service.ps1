param(
  [string]$ConfigPath = (Join-Path $PSScriptRoot "..\..\..\config.yaml"),
  [string]$Registry = "ghcr.io",
  [string]$Owner = "",
  [string]$Username = "",
  [string]$ImageName = "easy-email-service",
  [string]$Version = "",
  [switch]$Push,
  [switch]$DryRun,
  [string]$Platform = "linux/amd64"
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$workspaceRoot = Resolve-Path (Join-Path $scriptDir "..\..\..")
$serviceRepo = Join-Path $workspaceRoot "service\base"

. (Join-Path $workspaceRoot "scripts\lib\easyemail-config.ps1")

$config = $null
if (Test-Path -LiteralPath $ConfigPath) {
  $config = Read-EasyEmailConfig -ConfigPath $ConfigPath
}

$publishing = if ($config) { Get-EasyEmailSection -Config $config -Name 'publishing' } else { $null }
$ghcr = if ($publishing) { Get-EasyEmailSection -Config $publishing -Name 'ghcr' } else { $null }

$configuredRegistry = [string](Get-EasyEmailConfigValue -Object $ghcr -Name 'registry' -Default '')
if (-not [string]::IsNullOrWhiteSpace($configuredRegistry)) {
  $Registry = $configuredRegistry
}

if (-not $Owner) {
  $Owner = [string](Get-EasyEmailConfigValue -Object $ghcr -Name 'owner' -Default '')
}

if (-not $Owner) {
  $Owner = $env:GITHUB_REPOSITORY_OWNER
}
if (-not $Owner -and $env:GHCR_IMAGE_PREFIX -match '^ghcr\.io/([^/]+)$') {
  $Owner = $Matches[1]
}
if (-not $Owner) {
  $Owner = $env:GHCR_USERNAME
}
if (-not $Owner) {
  throw "Owner is required. Pass -Owner or set GITHUB_REPOSITORY_OWNER / GHCR_IMAGE_PREFIX / GHCR_USERNAME."
}

if (-not $Username) {
  $Username = [string](Get-EasyEmailConfigValue -Object $ghcr -Name 'username' -Default '')
}
if (-not $Username) {
  $Username = $env:GHCR_USERNAME
}
if (-not $Username) {
  $Username = $Owner
}

$ghcrToken = [string](Get-EasyEmailConfigValue -Object $ghcr -Name 'token' -Default '')

if (-not $Version) {
  $dateTag = (Get-Date -Format "yyyyMMdd")
  $existingTags = @()
  try {
    $existingTags = docker image ls "$Registry/$Owner/$ImageName" --format "{{.Tag}}" 2>$null |
      Where-Object { $_ -match "^release-$dateTag-(\d+)$" }
  } catch {}
  $seq = 1
  if ($existingTags) {
    $maxSeq = $existingTags | ForEach-Object {
      if ($_ -match "^release-$dateTag-(\d+)$") { [int]$Matches[1] } else { 0 }
    } | Measure-Object -Maximum | Select-Object -ExpandProperty Maximum
    $seq = $maxSeq + 1
  }
  $Version = "release-$dateTag-$($seq.ToString('000'))"
}

$gitSha = "local"
try {
  $gitSha = (git -C $serviceRepo rev-parse --short HEAD).Trim()
} catch {
  Write-Warning "Unable to read git sha from $serviceRepo; using 'local'."
}

$imageRef = "$Registry/$Owner/$ImageName"
$tags = @(
  "${imageRef}:$Version",
  "${imageRef}:sha-$gitSha"
)

if ($Push) {
  $tags += "${imageRef}:latest"
}

$buildArgs = @(
  "buildx", "build",
  "--platform", $Platform,
   "-f", "deploy/service/base/Dockerfile"
)

foreach ($tag in $tags) {
  $buildArgs += @("--tag", $tag)
}

if ($Push) {
  $buildArgs += "--push"
} else {
  $buildArgs += "--load"
}

$buildArgs += "."

Push-Location $workspaceRoot
try {
  if ($DryRun) {
    Write-Host "Registry: $Registry"
    Write-Host "Owner: $Owner"
    Write-Host "Username: $Username"
    Write-Host "Service repo: $serviceRepo"
    Write-Host "Tags:"
    $tags | ForEach-Object { Write-Host " - $_" }
    Write-Host "Build command: docker $($buildArgs -join ' ')"
    if ($Push) {
      Write-Host 'Push mode: enabled'
      Write-Host ('GHCR token configured: ' + (-not [string]::IsNullOrWhiteSpace($ghcrToken)))
    }
    return
  }
  if ($Push -and -not [string]::IsNullOrWhiteSpace($ghcrToken)) {
    Write-Host "Logging into $Registry as $Username"
    $ghcrToken | docker login $Registry --username $Username --password-stdin
    if ($LASTEXITCODE -ne 0) {
      throw "docker login failed with exit code $LASTEXITCODE"
    }
  }
  Write-Host "Running: docker $($buildArgs -join ' ')"
  docker @buildArgs
} finally {
  Pop-Location
}

Write-Host "Published tags:"
$tags | ForEach-Object { Write-Host " - $_" }
