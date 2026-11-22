param(
    [Parameter(Mandatory = $true)][string[]]$ArtifactPaths,
    [switch]$VerifyOnly,
    [switch]$RequireValidSignature,
    [string]$ReportOutputPath = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Resolve-SignToolExecutable {
    if ($env:WINDOWS_SIGNTOOL_PATH -and (Test-Path -LiteralPath $env:WINDOWS_SIGNTOOL_PATH -PathType Leaf)) {
        return [System.IO.Path]::GetFullPath($env:WINDOWS_SIGNTOOL_PATH)
    }
    $fromPath = Get-Command signtool.exe -ErrorAction SilentlyContinue
    if ($fromPath) {
        return $fromPath.Source
    }
    $kitsRoot = 'C:\Program Files (x86)\Windows Kits\10\bin'
    if (Test-Path -LiteralPath $kitsRoot -PathType Container) {
        $found = Get-ChildItem -LiteralPath $kitsRoot -Filter 'signtool.exe' -Recurse -File -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -match '\\x64\\signtool\.exe$' } |
            Sort-Object FullName -Descending |
            Select-Object -First 1
        if ($found) {
            return $found.FullName
        }
    }
    throw 'Windows signtool.exe is required for Authenticode signing but was not found.'
}

function Protect-TempSecretFile {
    param([Parameter(Mandatory = $true)][string]$Path)
    $currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $null = & icacls $Path /inheritance:r /grant:r "${currentUser}:(F)"
    if ($LASTEXITCODE -ne 0) {
        throw 'Could not restrict temporary code-signing PFX ACL to current user.'
    }
}

$resolvedArtifacts = @()
foreach ($entry in $ArtifactPaths) {
    foreach ($rawPath in ($entry -split ',')) {
        $trimmed = $rawPath.Trim()
        if ([string]::IsNullOrWhiteSpace($trimmed)) { continue }
        $full = [System.IO.Path]::GetFullPath($trimmed)
        if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
            throw "Signing target artifact does not exist: $full"
        }
        $ext = [System.IO.Path]::GetExtension($full).ToLowerInvariant()
        if ($ext -notin @('.exe', '.msi')) {
            throw "Unsupported Authenticode signing target extension ($ext): $full"
        }
        $resolvedArtifacts += $full
    }
}
if ($resolvedArtifacts.Count -lt 1) {
    throw 'At least one .exe or .msi artifact path is required.'
}

if (-not $VerifyOnly) {
    $pfxBase64 = $env:WINDOWS_CODESIGN_PFX_BASE64
    $pfxPassword = $env:WINDOWS_CODESIGN_PFX_PASSWORD
    $timestampUrl = if ($env:WINDOWS_CODESIGN_TIMESTAMP_URL) {
        $env:WINDOWS_CODESIGN_TIMESTAMP_URL.Trim()
    } else {
        'http://timestamp.digicert.com'
    }

    if ([string]::IsNullOrWhiteSpace($pfxBase64) -or [string]::IsNullOrWhiteSpace($pfxPassword)) {
        if ($RequireValidSignature) {
            throw 'Protected code-signing secrets (WINDOWS_CODESIGN_PFX_BASE64 / WINDOWS_CODESIGN_PFX_PASSWORD) are required for formal Desktop release signing.'
        }
        Write-Output 'CODESIGN_MODE=skipped-unsigned-candidate'
    } else {
        $signTool = Resolve-SignToolExecutable
        $tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('easyemail-codesign-' + [Guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
        $pfxPath = Join-Path $tempRoot 'codesign.pfx'
        $pfxBytes = [Convert]::FromBase64String($pfxBase64.Trim())
        try {
            [System.IO.File]::WriteAllBytes($pfxPath, $pfxBytes)
            Protect-TempSecretFile -Path $pfxPath
            foreach ($target in $resolvedArtifacts) {
                $signArgs = @(
                    'sign',
                    '/fd', 'SHA256',
                    '/f', $pfxPath,
                    '/p', $pfxPassword
                )
                if ($timestampUrl -and $timestampUrl -ne 'none') {
                    $signArgs += @('/tr', $timestampUrl, '/td', 'SHA256')
                }
                $signArgs += $target
                & $signTool @signArgs | Out-Null
                if ($LASTEXITCODE -ne 0) {
                    throw "signtool.exe failed while signing $([System.IO.Path]::GetFileName($target))."
                }
            }
            Write-Output 'CODESIGN_MODE=signed'
        } finally {
            [Array]::Clear($pfxBytes, 0, $pfxBytes.Length)
            if (Test-Path -LiteralPath $pfxPath) {
                $zero = New-Object byte[] ((Get-Item -LiteralPath $pfxPath).Length)
                [System.IO.File]::WriteAllBytes($pfxPath, $zero)
                Remove-Item -LiteralPath $pfxPath -Force -ErrorAction SilentlyContinue
            }
            if (Test-Path -LiteralPath $tempRoot) {
                Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
            }
        }
    }
}

$records = @()
$allValid = $true
foreach ($target in $resolvedArtifacts) {
    $sig = Get-AuthenticodeSignature -LiteralPath $target
    $status = [string]$sig.Status
    if ($status -ne 'Valid') {
        $allValid = $false
    }
    $subject = if ($sig.SignerCertificate) { [string]$sig.SignerCertificate.Subject } else { '' }
    $thumbprint = if ($sig.SignerCertificate) { [string]$sig.SignerCertificate.Thumbprint } else { '' }
    if ($RequireValidSignature -and ($status -ne 'Valid' -or [string]::IsNullOrWhiteSpace($thumbprint))) {
        throw "Artifact $([System.IO.Path]::GetFileName($target)) failed mandatory Authenticode signature verification (status=$status)."
    }
    $records += [ordered]@{
        file = [System.IO.Path]::GetFileName($target)
        status = $status
        signerSubject = $subject
        certificateThumbprint = $thumbprint
        hasTimestamp = ($null -ne $sig.TimeStamperCertificate)
    }
}

$summary = [ordered]@{
    schemaVersion = 1
    verified = $allValid
    requireValidSignature = [bool]$RequireValidSignature
    artifacts = $records
}

if ($ReportOutputPath) {
    $fullReport = [System.IO.Path]::GetFullPath($ReportOutputPath)
    New-Item -ItemType Directory -Path (Split-Path -Parent $fullReport) -Force | Out-Null
    ($summary | ConvertTo-Json -Depth 6) + "`n" | Set-Content -LiteralPath $fullReport -Encoding UTF8
}

Write-Output "CODESIGN_ALL_VALID=$allValid"
