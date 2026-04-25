param(
  [string]$Registry = "ghcr.io",
  [string]$Owner = "",
  [string]$ImageName = "easy-email-service",
  [string]$Version = "",
  [switch]$Push,
  [string]$Platform = "linux/amd64"
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$workspaceRoot = Resolve-Path (Join-Path $scriptDir "..\..")
$serviceRepo = Join-Path $workspaceRoot "repos\EasyEmail"

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
  "$imageRef:$Version",
  "$imageRef:sha-$gitSha"
)

if ($Push) {
  $tags += "$imageRef:latest"
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
  Write-Host "Running: docker $($buildArgs -join ' ')"
  docker @buildArgs
} finally {
  Pop-Location
}

Write-Host "Published tags:"
$tags | ForEach-Object { Write-Host " - $_" }
