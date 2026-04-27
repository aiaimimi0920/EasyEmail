param(
    [string]$ConfigPath = 'config.yaml',
    [switch]$ServiceBase,
    [switch]$CloudflareMail,
    [string]$ServiceOutput = 'deploy/service/base/config/config.yaml',
    [string]$ServiceEnvOutput = 'deploy/service/base/config/runtime.env',
    [string]$WorkerOutput = '.tmp/cloudflare_temp_email.wrangler.toml'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot 'lib/easyemail-config.ps1')

if (-not $ServiceBase -and -not $CloudflareMail) {
    $ServiceBase = $true
    $CloudflareMail = $true
}

$renderer = Join-Path $PSScriptRoot 'render-derived-configs.py'
if (-not (Test-Path -LiteralPath $renderer)) {
    throw "Missing renderer script: $renderer"
}

Assert-EasyEmailPythonModule -ModuleName 'yaml' -PackageName 'pyyaml'

$resolvedConfigPath = Resolve-EasyEmailPath -Path $ConfigPath
$args = @($renderer, '--root-config', $resolvedConfigPath)
if ($ServiceBase) {
    $args += @('--service-output', (Resolve-EasyEmailPath -Path $ServiceOutput))
    $args += @('--service-env-output', (Resolve-EasyEmailPath -Path $ServiceEnvOutput))
}
if ($CloudflareMail) {
    $args += @('--worker-output', (Resolve-EasyEmailPath -Path $WorkerOutput))
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
