param(
    [string]$ExecutablePath = (Join-Path $PSScriptRoot '../apps/desktop/src-tauri/target/release/easyemailam.exe'),
    [string]$BundleDirectory = (Join-Path $PSScriptRoot '../apps/desktop/src-tauri/target/release/bundle')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$signScript = Join-Path $PSScriptRoot 'sign-and-verify-desktop-artifacts.ps1'
$sourceExe = [System.IO.Path]::GetFullPath($ExecutablePath)
$bundleRoot = [System.IO.Path]::GetFullPath($BundleDirectory)
if (-not (Test-Path -LiteralPath $sourceExe -PathType Leaf)) {
    throw "Release executable is missing for codesign drill: $sourceExe"
}

$drillRoot = [System.IO.Path]::GetFullPath((Join-Path ([System.IO.Path]::GetTempPath()) 'easyemail-codesign-drill'))
$runRoot = Join-Path $drillRoot ([Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $runRoot -Force | Out-Null

$prevPfxB64 = $env:WINDOWS_CODESIGN_PFX_BASE64
$prevPfxPwd = $env:WINDOWS_CODESIGN_PFX_PASSWORD
$prevTsUrl = $env:WINDOWS_CODESIGN_TIMESTAMP_URL
$certThumbprint = $null

try {
    $targets = @()
    $copiedExe = Join-Path $runRoot 'EasyEmail.exe'
    Copy-Item -LiteralPath $sourceExe -Destination $copiedExe -Force
    $targets += $copiedExe

    $msiSource = Get-ChildItem -LiteralPath (Join-Path $bundleRoot 'msi') -Filter '*.msi' -File -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($msiSource) {
        $copiedMsi = Join-Path $runRoot $msiSource.Name
        Copy-Item -LiteralPath $msiSource.FullName -Destination $copiedMsi -Force
        $targets += $copiedMsi
    }

    $nsisSource = Get-ChildItem -LiteralPath (Join-Path $bundleRoot 'nsis') -Filter '*-setup.exe' -File -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($nsisSource) {
        $copiedNsis = Join-Path $runRoot $nsisSource.Name
        Copy-Item -LiteralPath $nsisSource.FullName -Destination $copiedNsis -Force
        $targets += $copiedNsis
    }

    # 1. Prove -RequireValidSignature fails closed on unsigned artifacts
    Remove-Item Env:WINDOWS_CODESIGN_PFX_BASE64 -ErrorAction SilentlyContinue
    Remove-Item Env:WINDOWS_CODESIGN_PFX_PASSWORD -ErrorAction SilentlyContinue
    $unsignedRejected = $false
    try {
        & $signScript -ArtifactPaths $targets -VerifyOnly -RequireValidSignature | Out-Null
    } catch {
        $unsignedRejected = $true
    }
    if (-not $unsignedRejected) {
        throw 'Release signing gate failed to reject unsigned desktop artifacts.'
    }
    Write-Output 'UNSIGNED_REJECTED_BY_RELEASE_GATE=True'

    # 2. Generate ephemeral self-signed code-signing cert, export PFX, and immediately remove from store
    $cert = New-SelfSignedCertificate `
        -Type CodeSigningCert `
        -Subject 'CN=EasyEmail Ephemeral Signing Drill' `
        -KeyExportPolicy Exportable `
        -KeySpec Signature `
        -KeyLength 2048 `
        -HashAlgorithm SHA256 `
        -CertStoreLocation 'Cert:\CurrentUser\My'
    $certThumbprint = $cert.Thumbprint
    $pwdPlain = [Guid]::NewGuid().ToString('N')
    $pwdSecure = ConvertTo-SecureString -String $pwdPlain -Force -AsPlainText
    $pfxBytes = $cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx, $pwdSecure)
    Remove-Item -LiteralPath "Cert:\CurrentUser\My\$certThumbprint" -Force

    $env:WINDOWS_CODESIGN_PFX_BASE64 = [Convert]::ToBase64String($pfxBytes)
    $env:WINDOWS_CODESIGN_PFX_PASSWORD = $pwdPlain
    $env:WINDOWS_CODESIGN_TIMESTAMP_URL = 'none'
    [Array]::Clear($pfxBytes, 0, $pfxBytes.Length)

    $reportPath = Join-Path $runRoot 'signing-report.json'
    & $signScript -ArtifactPaths $targets -ReportOutputPath $reportPath | Out-Null

    foreach ($signedTarget in $targets) {
        $sig = Get-AuthenticodeSignature -LiteralPath $signedTarget
        if (-not $sig.SignerCertificate -or $sig.SignerCertificate.Thumbprint -ne $certThumbprint) {
            throw "Signed artifact $($signedTarget) did not carry expected Authenticode certificate thumbprint."
        }
    }
    Write-Output "AUTHENTICODE_SIGNED_TARGETS=$($targets.Count)"
    Write-Output 'AUTHENTICODE_THUMBPRINT_MATCHED=True'

    # 3. Prove untrusted self-signed cert is STILL rejected by -RequireValidSignature (requires CA-trusted chain)
    $untrustedRejected = $false
    try {
        & $signScript -ArtifactPaths $targets -VerifyOnly -RequireValidSignature | Out-Null
    } catch {
        $untrustedRejected = $true
    }
    if (-not $untrustedRejected) {
        throw 'Release signing gate unexpectedly accepted an untrusted self-signed certificate.'
    }
    Write-Output 'UNTRUSTED_CERT_REJECTED_BY_RELEASE_GATE=True'
} finally {
    if ($certThumbprint -and (Test-Path -LiteralPath "Cert:\CurrentUser\My\$certThumbprint")) {
        Remove-Item -LiteralPath "Cert:\CurrentUser\My\$certThumbprint" -Force -ErrorAction SilentlyContinue
    }
    if ($null -eq $prevPfxB64) { Remove-Item Env:WINDOWS_CODESIGN_PFX_BASE64 -ErrorAction SilentlyContinue } else { $env:WINDOWS_CODESIGN_PFX_BASE64 = $prevPfxB64 }
    if ($null -eq $prevPfxPwd) { Remove-Item Env:WINDOWS_CODESIGN_PFX_PASSWORD -ErrorAction SilentlyContinue } else { $env:WINDOWS_CODESIGN_PFX_PASSWORD = $prevPfxPwd }
    if ($null -eq $prevTsUrl) { Remove-Item Env:WINDOWS_CODESIGN_TIMESTAMP_URL -ErrorAction SilentlyContinue } else { $env:WINDOWS_CODESIGN_TIMESTAMP_URL = $prevTsUrl }
    if (Test-Path -LiteralPath $runRoot) {
        $resolvedRun = [System.IO.Path]::GetFullPath($runRoot)
        if ($resolvedRun.StartsWith($drillRoot + [System.IO.Path]::DirectorySeparatorChar)) {
            Remove-Item -LiteralPath $resolvedRun -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}
