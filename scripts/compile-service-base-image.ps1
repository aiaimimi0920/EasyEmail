param(
    [string]$ConfigPath = (Join-Path $PSScriptRoot '..\config.yaml'),
    [switch]$NoCache,
    [switch]$Push
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot 'lib\easyemail-config.ps1')

$config = Read-EasyEmailConfig -ConfigPath $ConfigPath
$serviceBase = Get-EasyEmailSection -Config $config -Name 'serviceBase'
if ($null -eq $serviceBase) {
    throw 'Missing serviceBase section in config.yaml.'
}

$context = Resolve-EasyEmailPath -Path (Get-EasyEmailConfigValue -Object $serviceBase -Name 'context' -Default '.')
$dockerfile = Resolve-EasyEmailPath -Path (Get-EasyEmailConfigValue -Object $serviceBase -Name 'dockerfile' -Default 'deploy/service/base/Dockerfile')
$image = [string](Get-EasyEmailConfigValue -Object $serviceBase -Name 'image' -Default 'easyemail/easy-email-service:local')

if (-not (Test-Path -LiteralPath $dockerfile)) {
    throw "Dockerfile not found: $dockerfile"
}

$args = @('build', '-f', $dockerfile, '-t', $image)
if ($NoCache) {
    $args += '--no-cache'
}
$args += $context

Write-Host "Building Docker image: $image" -ForegroundColor Cyan
& docker @args
if ($LASTEXITCODE -ne 0) {
    throw "Docker build failed with exit code $LASTEXITCODE"
}

if ($Push) {
    Write-Host "Pushing Docker image: $image" -ForegroundColor Cyan
    & docker push $image
    if ($LASTEXITCODE -ne 0) {
        throw "Docker push failed with exit code $LASTEXITCODE"
    }
}

Write-Host "Docker image ready: $image"
