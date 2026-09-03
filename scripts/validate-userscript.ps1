param(
    [string]$ConfigPath = 'config.example.yaml',
    [string]$SourcePath = 'runtimes/userscript/easy_email_proxy.user.js',
    [string]$OutputPath = '.tmp/easy_email_proxy.validation.user.js',
    [switch]$KeepOutput
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot 'lib/easyemail-config.ps1')

$resolvedConfigPath = Resolve-EasyEmailPath -Path $ConfigPath
$resolvedSourcePath = Resolve-EasyEmailPath -Path $SourcePath
$resolvedOutputPath = Resolve-EasyEmailPath -Path $OutputPath
$resolvedTemplateOutputPath = Resolve-EasyEmailPath -Path '.tmp/easy_email_proxy.template.validation.user.js'
$compileScriptPath = Join-Path $PSScriptRoot 'compile-userscript.ps1'
$templateAssemblerPath = Join-Path $PSScriptRoot 'userscript_template.py'
$powerShellCommand = Get-EasyEmailPowerShellCommand

function Invoke-UserscriptCompile {
    & $powerShellCommand -ExecutionPolicy Bypass -File $compileScriptPath `
        -ConfigPath $resolvedConfigPath `
        -SourcePath $resolvedSourcePath `
        -OutputPath $resolvedOutputPath

    if ($LASTEXITCODE -ne 0) {
        throw "Userscript compilation failed: $compileScriptPath"
    }
}

function Test-JavaScriptSyntax {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    & node --check $Path
    if ($LASTEXITCODE -ne 0) {
        throw "JavaScript syntax validation failed: $Path"
    }
}

& python $templateAssemblerPath --source $resolvedSourcePath --output $resolvedTemplateOutputPath
if ($LASTEXITCODE -ne 0) {
    throw "Userscript template assembly failed: $resolvedSourcePath"
}

Invoke-UserscriptCompile

if (-not (Test-Path -LiteralPath $resolvedOutputPath)) {
    throw "Generated userscript not found: $resolvedOutputPath"
}

$generatedUserscript = Get-Content -Raw -LiteralPath $resolvedOutputPath

if ($generatedUserscript -notmatch '^// LOCAL DEV BUILD') {
    throw "Generated userscript is missing the local build banner: $resolvedOutputPath"
}

if ($generatedUserscript -match '__LOCAL_SECRET_[A-Z0-9_]+__') {
    throw "Generated userscript still contains unreplaced local secret placeholders: $resolvedOutputPath"
}

Test-JavaScriptSyntax -Path $resolvedTemplateOutputPath
Test-JavaScriptSyntax -Path $resolvedOutputPath

Write-Host "Validated userscript template and generated build: $resolvedOutputPath"

if (-not $KeepOutput -and (Test-Path -LiteralPath $resolvedOutputPath)) {
    Remove-Item -LiteralPath $resolvedOutputPath -Force
}
if (Test-Path -LiteralPath $resolvedTemplateOutputPath) {
    Remove-Item -LiteralPath $resolvedTemplateOutputPath -Force
}
