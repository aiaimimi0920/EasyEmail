param(
    [string]$ConfigPath = (Join-Path $PSScriptRoot '..\..\config.yaml'),
    [switch]$CopyToClipboard
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$compileScript = Join-Path $PSScriptRoot '..\..\scripts\compile-userscript.ps1'
if (-not (Test-Path -LiteralPath $compileScript)) {
    throw "Missing compile script: $compileScript"
}

& $compileScript -ConfigPath $ConfigPath -CopyToClipboard:$CopyToClipboard
