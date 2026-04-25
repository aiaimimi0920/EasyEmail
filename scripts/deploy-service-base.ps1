param(
    [string]$ConfigPath = (Join-Path $PSScriptRoot '..\config.yaml'),
    [switch]$NoBuild
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$render = Join-Path $PSScriptRoot 'render-derived-configs.ps1'
if (-not (Test-Path -LiteralPath $render)) {
    throw "Missing render script: $render"
}

& $render -ConfigPath $ConfigPath -ServiceBase

$composeFile = Join-Path $PSScriptRoot '..\deploy\service\base\docker-compose.yaml'
if (-not (Test-Path -LiteralPath $composeFile)) {
    throw "Missing docker compose file: $composeFile"
}

$networkName = 'Easy'
& docker network inspect $networkName *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Host "Creating docker network: $networkName" -ForegroundColor Cyan
    & docker network create $networkName
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to create docker network $networkName"
    }
}

$args = @('compose', '-f', $composeFile, 'up', '-d')
if (-not $NoBuild) {
    $args += '--build'
}

Write-Host "Starting service/base via docker compose..." -ForegroundColor Cyan
& docker @args
if ($LASTEXITCODE -ne 0) {
    throw "docker compose failed with exit code $LASTEXITCODE"
}

Write-Host 'Service/base deployment finished.'
