param(
    [string]$ExecutablePath = (Join-Path $PSScriptRoot '../src-tauri/target/release/easyemailam.exe'),
    [string]$CoreDirectory = (Join-Path $PSScriptRoot '../src-tauri/resources/core'),
    [string]$OutputDirectory = (Join-Path $PSScriptRoot '../src-tauri/target/release/bundle/portable')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-DirectChildPath {
    param(
        [Parameter(Mandatory = $true)][string]$Child,
        [Parameter(Mandatory = $true)][string]$Parent
    )

    $parentPath = [System.IO.Path]::GetFullPath($Parent).TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    )
    $childPath = [System.IO.Path]::GetFullPath($Child)
    $prefix = $parentPath + [System.IO.Path]::DirectorySeparatorChar
    if (-not $childPath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Portable output escaped its dedicated root: $childPath"
    }
    $relative = $childPath.Substring($prefix.Length)
    if (-not $relative -or $relative.Contains([System.IO.Path]::DirectorySeparatorChar) -or
        $relative.Contains([System.IO.Path]::AltDirectorySeparatorChar)) {
        throw "Portable output must be a direct child of its dedicated root: $childPath"
    }
}

function Resolve-CoreMember {
    param(
        [Parameter(Mandatory = $true)][string]$CoreRoot,
        [Parameter(Mandatory = $true)][string]$RelativePath
    )

    if ([System.IO.Path]::IsPathRooted($RelativePath)) {
        throw "Portable core manifest contains a rooted path: $RelativePath"
    }
    $normalizedRelative = $RelativePath.Replace('/', [System.IO.Path]::DirectorySeparatorChar)
    $resolved = [System.IO.Path]::GetFullPath((Join-Path $CoreRoot $normalizedRelative))
    $corePrefix = [System.IO.Path]::GetFullPath($CoreRoot).TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    ) + [System.IO.Path]::DirectorySeparatorChar
    if (-not $resolved.StartsWith($corePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Portable core manifest path escaped the core root: $RelativePath"
    }
    if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
        throw "Portable core file is missing: $resolved"
    }
    return $resolved
}

$executable = [System.IO.Path]::GetFullPath($ExecutablePath)
$coreRoot = [System.IO.Path]::GetFullPath($CoreDirectory)
$outputRoot = [System.IO.Path]::GetFullPath($OutputDirectory)
if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
    throw "Release desktop executable is missing: $executable"
}
if (-not (Test-Path -LiteralPath $coreRoot -PathType Container)) {
    throw "Bundled EasyEmail core directory is missing: $coreRoot"
}

$runtimeManifestPath = Join-Path $coreRoot 'runtime-manifest.json'
if (-not (Test-Path -LiteralPath $runtimeManifestPath -PathType Leaf)) {
    throw "Bundled EasyEmail core manifest is missing: $runtimeManifestPath"
}
$runtimeManifest = Get-Content -LiteralPath $runtimeManifestPath -Raw | ConvertFrom-Json
if ($runtimeManifest.schemaVersion -ne 1 -or
    $runtimeManifest.component -ne 'easyemail-service-base-desktop-core' -or
    $runtimeManifest.platform -ne 'win32' -or
    $runtimeManifest.architecture -ne 'x64') {
    throw 'Bundled EasyEmail core manifest is incompatible with the Windows x64 portable package.'
}
$runtimePath = Resolve-CoreMember -CoreRoot $coreRoot -RelativePath ([string]$runtimeManifest.runtime)
$entryPath = Resolve-CoreMember -CoreRoot $coreRoot -RelativePath ([string]$runtimeManifest.entry)

$desktopPackagePath = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../package.json'))
$desktopPackage = Get-Content -LiteralPath $desktopPackagePath -Raw | ConvertFrom-Json
$version = [string]$desktopPackage.version
if ([string]::IsNullOrWhiteSpace($version)) {
    throw 'Desktop package version is missing.'
}

$packageName = "EasyEmail-Desktop_${version}_x64-portable"
New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
$packageDirectory = Join-Path $outputRoot $packageName
$archivePath = Join-Path $outputRoot "$packageName.zip"
$archiveChecksumPath = "$archivePath.sha256"
$stageRoot = Join-Path $outputRoot ('.portable-stage-' + [Guid]::NewGuid().ToString('N'))
foreach ($path in @($packageDirectory, $archivePath, $archiveChecksumPath, $stageRoot)) {
    Assert-DirectChildPath -Child $path -Parent $outputRoot
}

if (Test-Path -LiteralPath $packageDirectory) {
    Remove-Item -LiteralPath $packageDirectory -Recurse -Force
}
foreach ($path in @($archivePath, $archiveChecksumPath)) {
    if (Test-Path -LiteralPath $path) {
        Remove-Item -LiteralPath $path -Force
    }
}

$stagePackage = Join-Path $stageRoot $packageName
$encoding = [System.Text.UTF8Encoding]::new($false)
try {
    New-Item -ItemType Directory -Path $stagePackage -Force | Out-Null
    Copy-Item -LiteralPath $executable -Destination (Join-Path $stagePackage 'EasyEmail.exe') -Force
    Copy-Item -LiteralPath $coreRoot -Destination $stagePackage -Recurse -Force

    $launcher = @(
        '@echo off',
        'setlocal',
        'set "EASYEMAILAM_DATA_DIR=%~dp0data"',
        'if not exist "%EASYEMAILAM_DATA_DIR%" mkdir "%EASYEMAILAM_DATA_DIR%"',
        'start "" "%~dp0EasyEmail.exe"',
        'endlocal'
    ) -join "`r`n"
    [System.IO.File]::WriteAllText(
        (Join-Path $stagePackage 'Run-EasyEmail-Portable.cmd'),
        $launcher + "`r`n",
        $encoding
    )

    $readme = @(
        'EasyEmail Desktop portable candidate',
        '',
        '1. Extract the complete directory before running it.',
        '2. Run EasyEmail.exe to use the normal per-user application data directory.',
        '3. Run Run-EasyEmail-Portable.cmd to keep non-secret application state in .\data.',
        '4. Keep EasyEmail.exe and the core directory together.',
        '',
        'Windows 10/11 and Microsoft Edge WebView2 Runtime are required.',
        'This development candidate is unsigned and is not a public release.',
        'Mail credentials remain protected by Windows Credential Manager and are machine-specific.'
    ) -join "`r`n"
    [System.IO.File]::WriteAllText(
        (Join-Path $stagePackage 'README.txt'),
        $readme + "`r`n",
        $encoding
    )

    $repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
    $repositoryCommit = $env:GITHUB_SHA
    if ([string]::IsNullOrWhiteSpace($repositoryCommit)) {
        try {
            $gitCommit = (& git -C $repoRoot rev-parse HEAD 2>$null).Trim()
            if ($LASTEXITCODE -eq 0 -and $gitCommit) {
                $repositoryCommit = $gitCommit
            }
        } catch {
            $repositoryCommit = $null
        }
    }
    if ([string]::IsNullOrWhiteSpace($repositoryCommit)) {
        $repositoryCommit = 'unknown'
    }

    $portableManifest = [ordered]@{
        schemaVersion = 1
        artifactKind = 'desktop-portable-candidate'
        releaseEligible = $false
        productName = 'EasyEmail Desktop'
        applicationProductName = 'NMail'
        version = $version
        platform = 'windows'
        architecture = 'x64'
        repositoryCommit = $repositoryCommit
        executable = 'EasyEmail.exe'
        coreDirectory = 'core'
        portableDataLauncher = 'Run-EasyEmail-Portable.cmd'
        coreSourceRevision = [string]$runtimeManifest.sourceRevision
        payload = [ordered]@{
            executableSha256 = (Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash.ToLowerInvariant()
            runtimeSha256 = (Get-FileHash -LiteralPath $runtimePath -Algorithm SHA256).Hash.ToLowerInvariant()
            entrySha256 = (Get-FileHash -LiteralPath $entryPath -Algorithm SHA256).Hash.ToLowerInvariant()
            coreManifestSha256 = (Get-FileHash -LiteralPath $runtimeManifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
        }
    }
    [System.IO.File]::WriteAllText(
        (Join-Path $stagePackage 'portable-manifest.json'),
        ($portableManifest | ConvertTo-Json -Depth 5) + "`n",
        $encoding
    )

    $portableRuntimePath = Join-Path $stagePackage ('core/' + [string]$runtimeManifest.runtime)
    $portableEntryPath = Join-Path $stagePackage ('core/' + [string]$runtimeManifest.entry)
    $checksums = @(
        "$((Get-FileHash -LiteralPath (Join-Path $stagePackage 'EasyEmail.exe') -Algorithm SHA256).Hash.ToLowerInvariant())  EasyEmail.exe",
        "$((Get-FileHash -LiteralPath $portableRuntimePath -Algorithm SHA256).Hash.ToLowerInvariant())  core/$($runtimeManifest.runtime)",
        "$((Get-FileHash -LiteralPath $portableEntryPath -Algorithm SHA256).Hash.ToLowerInvariant())  core/$($runtimeManifest.entry)",
        "$((Get-FileHash -LiteralPath (Join-Path $stagePackage 'core/runtime-manifest.json') -Algorithm SHA256).Hash.ToLowerInvariant())  core/runtime-manifest.json"
    ) -join "`n"
    [System.IO.File]::WriteAllText(
        (Join-Path $stagePackage 'SHA256SUMS'),
        $checksums + "`n",
        $encoding
    )

    Move-Item -LiteralPath $stagePackage -Destination $packageDirectory

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::CreateFromDirectory(
        $packageDirectory,
        $archivePath,
        [System.IO.Compression.CompressionLevel]::Optimal,
        $true
    )

    $archive = [System.IO.Compression.ZipFile]::OpenRead($archivePath)
    try {
        $entries = @($archive.Entries | ForEach-Object { $_.FullName.Replace('\', '/') })
        $expectedEntries = @(
            "$packageName/EasyEmail.exe",
            "$packageName/core/runtime-manifest.json",
            "$packageName/core/$($runtimeManifest.runtime)",
            "$packageName/core/$($runtimeManifest.entry)",
            "$packageName/Run-EasyEmail-Portable.cmd",
            "$packageName/portable-manifest.json",
            "$packageName/SHA256SUMS"
        )
        foreach ($entry in $expectedEntries) {
            if ($entries -notcontains $entry) {
                throw "Portable archive is missing required entry: $entry"
            }
        }
    } finally {
        $archive.Dispose()
    }

    $archiveHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    [System.IO.File]::WriteAllText(
        $archiveChecksumPath,
        "$archiveHash  $([System.IO.Path]::GetFileName($archivePath))`n",
        $encoding
    )

    $payloadFiles = @(Get-ChildItem -LiteralPath $packageDirectory -Recurse -File)
    Write-Output "PORTABLE_DIRECTORY=$packageDirectory"
    Write-Output "PORTABLE_ARCHIVE=$archivePath"
    Write-Output "PORTABLE_FILES=$($payloadFiles.Count)"
    Write-Output "PORTABLE_BYTES=$(($payloadFiles | Measure-Object -Property Length -Sum).Sum)"
    Write-Output "PORTABLE_SHA256=$archiveHash"
} finally {
    if (Test-Path -LiteralPath $stageRoot) {
        Assert-DirectChildPath -Child $stageRoot -Parent $outputRoot
        Remove-Item -LiteralPath $stageRoot -Recurse -Force
    }
}
