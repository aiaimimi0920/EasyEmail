param(
    [string]$EncryptedFilePath,
    [string]$PrivateKeyPath,
    [switch]$ImportCodeOnly,
    [string]$OutputPath = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'lib/easyemail-config.ps1')

if ([string]::IsNullOrWhiteSpace($EncryptedFilePath)) {
    throw 'EncryptedFilePath is required.'
}
if ([string]::IsNullOrWhiteSpace($PrivateKeyPath)) {
    throw 'PrivateKeyPath is required.'
}

$resolvedEncryptedFilePath = Resolve-EasyEmailPath -Path $EncryptedFilePath
$resolvedPrivateKeyPath = Resolve-EasyEmailPath -Path $PrivateKeyPath
$resolvedOutputPath = if ([string]::IsNullOrWhiteSpace($OutputPath)) { '' } else { Resolve-EasyEmailPath -Path $OutputPath }

Assert-EasyEmailPythonModule -ModuleName 'nacl' -PackageName 'pynacl'

$args = @(
    (Join-Path $PSScriptRoot 'easyemail-import-code.py'),
    'decrypt',
    '--encrypted-file', $resolvedEncryptedFilePath,
    '--private-key-file', $resolvedPrivateKeyPath
)
if ($ImportCodeOnly) {
    $args += '--import-code-only'
}
if (-not [string]::IsNullOrWhiteSpace($resolvedOutputPath)) {
    $args += @('--output', $resolvedOutputPath)
}

& python @args
if ($LASTEXITCODE -ne 0) {
    throw "Failed to decrypt import code with exit code $LASTEXITCODE"
}
