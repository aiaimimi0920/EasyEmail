param(
    [string]$PublicKeyOutputPath = '.tmp/easyemail-import-code-owner-public.txt',
    [string]$PrivateKeyOutputPath = '.tmp/easyemail-import-code-owner-private.txt',
    [string]$BundleOutputPath = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'lib/easyemail-config.ps1')

$resolvedPublicKeyOutputPath = Resolve-EasyEmailPath -Path $PublicKeyOutputPath
$resolvedPrivateKeyOutputPath = Resolve-EasyEmailPath -Path $PrivateKeyOutputPath
$bundlePath = if ([string]::IsNullOrWhiteSpace($BundleOutputPath)) {
    ''
} else {
    Resolve-EasyEmailPath -Path $BundleOutputPath
}

Assert-EasyEmailPythonModule -ModuleName 'nacl' -PackageName 'pynacl'

$args = @(
    (Join-Path $PSScriptRoot 'easyemail-import-code.py'),
    'generate-keypair',
    '--public-key-output', $resolvedPublicKeyOutputPath,
    '--private-key-output', $resolvedPrivateKeyOutputPath
)
if (-not [string]::IsNullOrWhiteSpace($bundlePath)) {
    $args += @('--bundle-output', $bundlePath)
}

& python @args
if ($LASTEXITCODE -ne 0) {
    throw "Failed to generate import code keypair with exit code $LASTEXITCODE"
}

Write-Host "Public key written: $resolvedPublicKeyOutputPath"
Write-Host "Private key written: $resolvedPrivateKeyOutputPath"
if (-not [string]::IsNullOrWhiteSpace($bundlePath)) {
    Write-Host "Bundle written: $bundlePath"
}
