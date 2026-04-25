param(
    [string]$ExamplePath = (Join-Path $PSScriptRoot '..\config.example.yaml'),
    [string]$ConfigPath = (Join-Path $PSScriptRoot '..\config.yaml'),
    [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $ExamplePath)) {
    throw "Example config not found: $ExamplePath"
}

if ((Test-Path -LiteralPath $ConfigPath) -and -not $Force) {
    Write-Host "Config already exists: $ConfigPath"
    return
}

Copy-Item -LiteralPath $ExamplePath -Destination $ConfigPath -Force
Write-Host "Created config from example: $ConfigPath"
