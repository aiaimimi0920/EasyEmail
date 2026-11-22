[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$RequestPath,
    [Parameter(Mandatory = $true)][string]$ResultPath
)
$ErrorActionPreference = 'Stop'
if ($PSScriptRoot.StartsWith('\\') -or (Get-Location).Path.StartsWith('\\')) {
    throw 'Use a local checkout or an existing persistent mapped drive.'
}
$env:PYTHONUTF8 = '1'
$env:PYTHONDONTWRITEBYTECODE = '1'
& python (Join-Path $PSScriptRoot 'application.py') --request $RequestPath --result $ResultPath
exit $LASTEXITCODE
