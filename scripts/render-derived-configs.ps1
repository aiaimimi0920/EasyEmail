param(
    [string]$ConfigPath = (Join-Path $PSScriptRoot '..\config.yaml'),
    [switch]$ServiceBase,
    [switch]$CloudflareMail,
    [string]$ServiceOutput = (Join-Path $PSScriptRoot '..\deploy\service\base\config\config.yaml'),
    [string]$ServiceEnvOutput = (Join-Path $PSScriptRoot '..\deploy\service\base\config\runtime.env'),
    [string]$WorkerOutput = (Join-Path $PSScriptRoot '..\.tmp\cloudflare_temp_email.wrangler.toml')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $ServiceBase -and -not $CloudflareMail) {
    $ServiceBase = $true
    $CloudflareMail = $true
}

$renderer = Join-Path $PSScriptRoot 'render-derived-configs.py'
if (-not (Test-Path -LiteralPath $renderer)) {
    throw "Missing renderer script: $renderer"
}

$args = @($renderer, '--root-config', $ConfigPath)
if ($ServiceBase) {
    $args += @('--service-output', $ServiceOutput)
    $args += @('--service-env-output', $ServiceEnvOutput)
}
if ($CloudflareMail) {
    $args += @('--worker-output', $WorkerOutput)
}

& python @args
if ($LASTEXITCODE -ne 0) {
    throw "Failed to render derived configs with exit code $LASTEXITCODE"
}

if ($ServiceBase) {
    Write-Host "Service config rendered: $ServiceOutput"
}
if ($CloudflareMail) {
    Write-Host "Worker wrangler rendered: $WorkerOutput"
}
