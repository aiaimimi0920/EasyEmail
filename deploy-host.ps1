param(
    [string]$ConfigPath = "config.yaml",
    [switch]$NoBuild,
    [string]$Image = "",
    [switch]$Pull,
    [string]$ImportCode = "",
    [string]$BootstrapFile = "",
    [string]$InstanceName = "",
    [string]$ContainerName = "",
    [int]$HostPort = 0,
    [string]$NetworkName = "EasyAiMi",
    [string]$NetworkAlias = "easy-email-service",
    [string]$ComposeProjectName = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Resolve-AbsolutePath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [Parameter(Mandatory = $true)]
        [string]$BaseDir
    )

    if ([System.IO.Path]::IsPathRooted($Path)) {
        return [System.IO.Path]::GetFullPath($Path)
    }
    return [System.IO.Path]::GetFullPath((Join-Path $BaseDir $Path))
}

$repoRoot = Split-Path -Parent $PSCommandPath
$resolvedConfigPath = Resolve-AbsolutePath -Path $ConfigPath -BaseDir $repoRoot
$deployScript = Resolve-AbsolutePath -Path "scripts\deploy-service-base.ps1" -BaseDir $repoRoot

if (-not (Test-Path -LiteralPath $deployScript)) {
    throw "Missing deploy script: $deployScript"
}

$arguments = @(
    "-ExecutionPolicy", "Bypass",
    "-File", $deployScript,
    "-ConfigPath", $resolvedConfigPath,
    "-NetworkName", $NetworkName,
    "-NetworkAlias", $NetworkAlias
)

if ($NoBuild) {
    $arguments += "-NoBuild"
}
if (-not [string]::IsNullOrWhiteSpace($Image)) {
    $arguments += @("-Image", $Image)
}
if ($Pull) {
    $arguments += "-Pull"
}
if (-not [string]::IsNullOrWhiteSpace($ImportCode)) {
    $arguments += @("-ImportCode", $ImportCode)
}
if (-not [string]::IsNullOrWhiteSpace($BootstrapFile)) {
    $arguments += @("-BootstrapFile", (Resolve-AbsolutePath -Path $BootstrapFile -BaseDir $repoRoot))
}
if (-not [string]::IsNullOrWhiteSpace($InstanceName)) {
    $arguments += @("-InstanceName", $InstanceName)
}
if (-not [string]::IsNullOrWhiteSpace($ContainerName)) {
    $arguments += @("-ContainerName", $ContainerName)
}
if ($HostPort -gt 0) {
    $arguments += @("-HostPort", [string]$HostPort)
}
if (-not [string]::IsNullOrWhiteSpace($ComposeProjectName)) {
    $arguments += @("-ComposeProjectName", $ComposeProjectName)
}

& powershell @arguments
