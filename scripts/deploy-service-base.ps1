param(
    [string]$ConfigPath = 'config.yaml',
    [switch]$NoBuild,
    [string]$Image = '',
    [switch]$Pull,
    [string]$InstanceName = '',
    [string]$ContainerName = '',
    [int]$HostPort = 0,
    [string]$NetworkName = 'Easy',
    [string]$ComposeProjectName = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'lib/easyemail-config.ps1')
$render = Join-Path $PSScriptRoot 'render-derived-configs.ps1'
if (-not (Test-Path -LiteralPath $render)) {
    throw "Missing render script: $render"
}

function Get-DefaultInstanceValue {
    param(
        [string]$ExplicitValue,
        [string]$DerivedValue
    )

    if (-not [string]::IsNullOrWhiteSpace($ExplicitValue)) {
        return $ExplicitValue
    }

    return $DerivedValue
}

$composeFile = Join-Path $PSScriptRoot '../deploy/service/base/docker-compose.yaml'
if (-not (Test-Path -LiteralPath $composeFile)) {
    throw "Missing docker compose file: $composeFile"
}

$resolvedConfigPath = Resolve-EasyEmailPath -Path $ConfigPath
$composeDir = Split-Path -Parent $composeFile
$instanceRoot = $null
$serviceOutput = 'deploy/service/base/config/config.yaml'
$serviceEnvOutput = 'deploy/service/base/config/runtime.env'
$configMountPath = './config'
$dataMountPath = './data'
$envFilePath = './config/runtime.env'

if (-not [string]::IsNullOrWhiteSpace($InstanceName)) {
    $instanceRoot = Join-Path $composeDir ("instances/{0}" -f $InstanceName)
    $instanceConfigRoot = Join-Path $instanceRoot 'config'
    $instanceDataRoot = Join-Path $instanceRoot 'data'
    New-Item -ItemType Directory -Force -Path $instanceConfigRoot | Out-Null
    New-Item -ItemType Directory -Force -Path $instanceDataRoot | Out-Null

    $serviceOutput = Resolve-EasyEmailPath -Path (Join-Path $instanceConfigRoot 'config.yaml')
    $serviceEnvOutput = Resolve-EasyEmailPath -Path (Join-Path $instanceConfigRoot 'runtime.env')
    $configMountPath = "./instances/$InstanceName/config"
    $dataMountPath = "./instances/$InstanceName/data"
    $envFilePath = "./instances/$InstanceName/config/runtime.env"
}

& $render -ConfigPath $resolvedConfigPath -ServiceBase -ServiceOutput $serviceOutput -ServiceEnvOutput $serviceEnvOutput

if ($Image -and $Pull) {
    Write-Host "Pulling service image: $Image" -ForegroundColor Cyan
    & docker pull $Image
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to pull docker image: $Image"
    }
}

$derivedContainerName = if (-not [string]::IsNullOrWhiteSpace($InstanceName)) {
    "easyemail-service-base-$InstanceName"
} else {
    'easyemail-service-base'
}
$resolvedContainerName = Get-DefaultInstanceValue -ExplicitValue $ContainerName -DerivedValue $derivedContainerName

$resolvedHostPort = if ($HostPort -gt 0) {
    $HostPort
} elseif (-not [string]::IsNullOrWhiteSpace($InstanceName)) {
    18082
} else {
    18081
}

$resolvedComposeProjectName = if (-not [string]::IsNullOrWhiteSpace($ComposeProjectName)) {
    $ComposeProjectName
} elseif (-not [string]::IsNullOrWhiteSpace($InstanceName)) {
    "easyemail-$InstanceName"
} else {
    'easyemail-service-base'
}

if (-not [string]::IsNullOrWhiteSpace($Image)) {
    $env:EASY_EMAIL_SERVICE_IMAGE = $Image
}
$env:EASY_EMAIL_SERVICE_CONTAINER_NAME = $resolvedContainerName
$env:EASY_EMAIL_SERVICE_HOST_PORT = [string]$resolvedHostPort
$env:EASY_EMAIL_SERVICE_ENV_FILE = $envFilePath
$env:EASY_EMAIL_SERVICE_CONFIG_DIR = $configMountPath
$env:EASY_EMAIL_SERVICE_DATA_DIR = $dataMountPath
$env:EASY_EMAIL_SERVICE_NETWORK = $NetworkName

& docker network inspect $networkName *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Host "Creating docker network: $networkName" -ForegroundColor Cyan
    & docker network create $networkName
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to create docker network $networkName"
    }
}

$args = @('compose', '-p', $resolvedComposeProjectName, '-f', $composeFile, 'up', '-d')
if (-not $NoBuild) {
    $args += '--build'
}

Write-Host "Starting service/base via docker compose..." -ForegroundColor Cyan
& docker @args
if ($LASTEXITCODE -ne 0) {
    throw "docker compose failed with exit code $LASTEXITCODE"
}

Write-Host 'Service/base deployment finished.'
Write-Host ("Container name: " + $resolvedContainerName)
Write-Host ("Base URL: http://127.0.0.1:{0}" -f $resolvedHostPort)
