param(
    [string[]]$InstanceName = @(),
    [string[]]$ContainerName = @(),
    [switch]$AllTestInstances,
    [switch]$RemoveInstanceData,
    [switch]$IncludePrimary
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$composeFile = Join-Path $repoRoot 'deploy/service/base/docker-compose.yaml'
$composeDir = Split-Path -Parent $composeFile

if (-not (Test-Path -LiteralPath $composeFile)) {
    throw "Missing docker compose file: $composeFile"
}

function Get-ServiceBaseComposeProjectName {
    param(
        [string]$Name
    )

    if ([string]::IsNullOrWhiteSpace($Name)) {
    return 'easy-email'
    }

    return "easyemail-$Name"
}

function Get-ServiceBaseContainerName {
    param(
        [string]$Name
    )

    if ([string]::IsNullOrWhiteSpace($Name)) {
    return 'easy-email'
    }

    return "easy-email-$Name"
}

function Get-TestInstanceNames {
    $names = @()
    $containerNames = (& docker ps -a --format "{{.Names}}")
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to enumerate docker containers."
    }

    foreach ($candidate in $containerNames) {
        if ($candidate -match '^easy-email-(.+)$') {
            $names += $Matches[1]
        }
    }

    return @($names | Sort-Object -Unique)
}

function Test-DockerContainerExists {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name
    )

    $containerNames = (& docker ps -a --format "{{.Names}}")
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to enumerate docker containers."
    }

    return ($containerNames -contains $Name)
}

function Remove-ServiceBaseComposeProject {
    param(
        [string]$Name
    )

    $projectName = Get-ServiceBaseComposeProjectName -Name $Name
    Write-Host ("Removing service/base compose project: {0}" -f $projectName) -ForegroundColor Cyan
    & docker compose -p $projectName -f $composeFile down --remove-orphans
    if ($LASTEXITCODE -ne 0) {
        Write-Warning ("docker compose down returned exit code {0} for project {1}" -f $LASTEXITCODE, $projectName)
    }

    $resolvedContainerName = Get-ServiceBaseContainerName -Name $Name
    if (Test-DockerContainerExists -Name $resolvedContainerName) {
        & docker rm -f $resolvedContainerName *> $null
    }

    if ($RemoveInstanceData -and -not [string]::IsNullOrWhiteSpace($Name)) {
        $instanceRoot = Join-Path $composeDir ("instances/{0}" -f $Name)
        if (Test-Path -LiteralPath $instanceRoot) {
            Write-Host ("Removing instance directory: {0}" -f $instanceRoot) -ForegroundColor Cyan
            Remove-Item -LiteralPath $instanceRoot -Recurse -Force
        }
    }
}

$targetInstances = New-Object System.Collections.Generic.List[string]
$targetContainerNames = New-Object System.Collections.Generic.List[string]

foreach ($name in $InstanceName) {
    if (-not [string]::IsNullOrWhiteSpace($name)) {
        $targetInstances.Add($name)
    }
}

if ($AllTestInstances) {
    foreach ($name in (Get-TestInstanceNames)) {
        $targetInstances.Add($name)
    }
}

if ($IncludePrimary) {
    $targetInstances.Add('')
}

foreach ($name in $ContainerName) {
    if (-not [string]::IsNullOrWhiteSpace($name)) {
        $targetContainerNames.Add($name)
    }
}

$resolvedInstances = @($targetInstances | Sort-Object -Unique)
$resolvedContainerNames = @($targetContainerNames | Sort-Object -Unique)

if ($resolvedInstances.Count -eq 0 -and $resolvedContainerNames.Count -eq 0) {
    Write-Host 'No service/base instances matched the requested cleanup scope.' -ForegroundColor Yellow
    exit 0
}

foreach ($name in $resolvedInstances) {
    Remove-ServiceBaseComposeProject -Name $name
}

foreach ($name in $resolvedContainerNames) {
    Write-Host ("Removing explicit container: {0}" -f $name) -ForegroundColor Cyan
    if (Test-DockerContainerExists -Name $name) {
        & docker rm -f $name
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to remove container: $name"
        }
    }
}

Write-Host 'service/base cleanup finished.'
