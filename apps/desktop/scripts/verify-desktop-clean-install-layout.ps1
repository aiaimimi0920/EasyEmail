param(
    [string]$ExecutablePath = (Join-Path $PSScriptRoot '../src-tauri/target/release/easyemailam.exe'),
    [string]$CoreDirectory = (Join-Path $PSScriptRoot '../src-tauri/resources/core'),
    [string]$BundleDirectory = (Join-Path $PSScriptRoot '../src-tauri/target/release/bundle'),
    [switch]$SkipInstallerPackages,
    [int]$StartupTimeoutSeconds = 55
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'lib/desktop-credential-smoke-support.ps1')

function Set-InstallTreeReadOnly {
    param(
        [Parameter(Mandatory = $true)][string]$InstallRoot,
        [Parameter(Mandatory = $true)][string]$Identity
    )

    Get-ChildItem -LiteralPath $InstallRoot -Recurse -File | ForEach-Object {
        $_.IsReadOnly = $true
    }
    $null = & icacls $InstallRoot /inheritance:r /grant:r "${Identity}:(OI)(CI)(RX)" "SYSTEM:(OI)(CI)(F)"
    if ($LASTEXITCODE -ne 0) {
        throw 'Could not apply Program-Files-equivalent read-and-execute ACL to simulated installation directory.'
    }
}

function Clear-InstallTreeReadOnly {
    param(
        [Parameter(Mandatory = $true)][string]$InstallRoot,
        [Parameter(Mandatory = $true)][string]$Identity
    )

    if (-not (Test-Path -LiteralPath $InstallRoot)) {
        return
    }
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $null = & icacls $InstallRoot /grant:r "${Identity}:(OI)(CI)(F)" /T /C
    } finally {
        $ErrorActionPreference = $prevEap
    }
    Get-ChildItem -LiteralPath $InstallRoot -Recurse -File -Force -ErrorAction SilentlyContinue | ForEach-Object {
        $_.IsReadOnly = $false
    }
}

function Assert-ReadOnlyCleanInstallRuntime {
    param(
        [Parameter(Mandatory = $true)][string]$InstallDir,
        [Parameter(Mandatory = $true)][string]$InstalledExecutable,
        [Parameter(Mandatory = $true)][string]$AppDataDir,
        [Parameter(Mandatory = $true)][string]$CurrentUser,
        [Parameter(Mandatory = $true)][string]$Label
    )

    if (-not (Test-Path -LiteralPath $InstalledExecutable -PathType Leaf)) {
        throw "[$Label] Installed desktop executable is missing: $InstalledExecutable"
    }
    $installedCoreNode = Join-Path (Split-Path -Parent $InstalledExecutable) 'core\node.exe'
    if (-not (Test-Path -LiteralPath $installedCoreNode -PathType Leaf)) {
        throw "[$Label] Bundled private core\node.exe is missing next to installed executable: $installedCoreNode"
    }

    $filesBefore = @(
        Get-ChildItem -LiteralPath $InstallDir -Recurse -File |
            Sort-Object FullName |
            ForEach-Object { "$($_.FullName.Substring($InstallDir.Length)):$($_.Length)" }
    )

    Set-InstallTreeReadOnly -InstallRoot $InstallDir -Identity $CurrentUser

    $writeBlocked = $false
    try {
        [System.IO.File]::WriteAllText((Join-Path $InstallDir 'forbidden-write.tmp'), 'nope')
    } catch {
        $writeBlocked = $true
    }
    if (-not $writeBlocked) {
        throw "[$Label] Read-only installation directory unexpectedly permitted file creation."
    }

    $prevPath = $env:PATH
    $prevDataDir = $env:EASYEMAILAM_DATA_DIR
    $desktopProc = $null
    $corePid = $null
    try {
        $cleanSystemPath = @(
            (Join-Path $env:SystemRoot 'System32'),
            $env:SystemRoot,
            (Join-Path $env:SystemRoot 'System32\Wbem'),
            (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0')
        ) -join ';'
        $env:PATH = $cleanSystemPath
        if ((Get-Command node -ErrorAction SilentlyContinue) -or (Get-Command docker -ErrorAction SilentlyContinue)) {
            throw "[$Label] Clean PATH unexpectedly still resolved external node or docker."
        }

        New-Item -ItemType Directory -Path $AppDataDir -Force | Out-Null
        $env:EASYEMAILAM_DATA_DIR = $AppDataDir
        $desktopProc = Start-Process -FilePath $InstalledExecutable `
            -WorkingDirectory (Split-Path -Parent $InstalledExecutable) -PassThru -WindowStyle Hidden

        $deadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
        $corePort = $null
        $brokerPort = $null
        do {
            Start-Sleep -Milliseconds 250
            $desktopProc.Refresh()
            if ($desktopProc.HasExited) {
                throw "[$Label] Installed desktop exited prematurely with code $($desktopProc.ExitCode)."
            }
            $child = Get-CimInstance Win32_Process -Filter "ParentProcessId=$($desktopProc.Id)" -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -ieq 'node.exe' } |
                Select-Object -First 1
            if ($child) {
                $corePid = [int]$child.ProcessId
                $listener = Get-NetTCPConnection -OwningProcess $corePid -State Listen -ErrorAction SilentlyContinue |
                    Where-Object { $_.LocalAddress -eq '127.0.0.1' } |
                    Select-Object -First 1
                if ($listener) { $corePort = [int]$listener.LocalPort }
            }
            $broker = Get-NetTCPConnection -OwningProcess $desktopProc.Id -State Listen -ErrorAction SilentlyContinue |
                Where-Object { $_.LocalAddress -eq '127.0.0.1' } |
                Select-Object -First 1
            if ($broker) { $brokerPort = [int]$broker.LocalPort }
            if ($corePort -and $brokerPort) { break }
        } while ((Get-Date) -lt $deadline)

        if (-not $corePid -or -not $corePort -or -not $brokerPort) {
            throw "[$Label] Installed desktop did not reach loopback readiness from read-only install directory."
        }

        if (-not (Request-EasyEmailDesktopClose -Process $desktopProc)) {
            throw "[$Label] Installed desktop did not accept a normal close request."
        }
        if (-not $desktopProc.WaitForExit(10000)) {
            throw "[$Label] Installed desktop did not exit within 10 seconds."
        }
        $desktopProc = $null

        $reaped = $false
        $reapDeadline = (Get-Date).AddSeconds(5)
        do {
            if (-not (Get-Process -Id $corePid -ErrorAction SilentlyContinue)) {
                $reaped = $true
                break
            }
            Start-Sleep -Milliseconds 150
        } while ((Get-Date) -lt $reapDeadline)
        if (-not $reaped) {
            throw "[$Label] Bundled core child remained alive after UI close."
        }
        $corePid = $null

        $coreLogPath = Join-Path $AppDataDir 'core/logs/core.log'
        $statePath = Join-Path $AppDataDir 'core/state/easy-email-state.json'
        if (-not (Test-Path -LiteralPath $coreLogPath -PathType Leaf) -or
            -not (Test-Path -LiteralPath $statePath -PathType Leaf)) {
            throw "[$Label] Writable runtime state or logs were not persisted under AppData."
        }
        if ((Get-Content -LiteralPath $coreLogPath -Raw) -notmatch 'event=core_graceful_stop') {
            throw "[$Label] Desktop close did not complete via graceful shutdown."
        }

        $filesAfter = @(
            Get-ChildItem -LiteralPath $InstallDir -Recurse -File |
                Sort-Object FullName |
                ForEach-Object { "$($_.FullName.Substring($InstallDir.Length)):$($_.Length)" }
        )
        if (($filesBefore -join "`n") -ne ($filesAfter -join "`n")) {
            throw "[$Label] Installation directory file inventory mutated during runtime execution."
        }
    } finally {
        $env:PATH = $prevPath
        if ($null -eq $prevDataDir) {
            Remove-Item Env:EASYEMAILAM_DATA_DIR -ErrorAction SilentlyContinue
        } else {
            $env:EASYEMAILAM_DATA_DIR = $prevDataDir
        }
        if ($desktopProc -and -not $desktopProc.HasExited) {
            Stop-Process -Id $desktopProc.Id -Force -ErrorAction SilentlyContinue
        }
        if ($corePid) {
            Stop-Process -Id $corePid -Force -ErrorAction SilentlyContinue
        }
        Stop-IsolatedEasyEmailWebViewProcesses -WebViewDirectory (Join-Path $AppDataDir 'webview2')
        Clear-InstallTreeReadOnly -InstallRoot $InstallDir -Identity $CurrentUser
    }
}

$sourceExe = [System.IO.Path]::GetFullPath($ExecutablePath)
$sourceCore = [System.IO.Path]::GetFullPath($CoreDirectory)
$bundleRoot = [System.IO.Path]::GetFullPath($BundleDirectory)
if (-not (Test-Path -LiteralPath $sourceExe -PathType Leaf)) {
    throw "Desktop executable is missing for clean-install smoke: $sourceExe"
}
if (-not (Test-Path -LiteralPath (Join-Path $sourceCore 'node.exe') -PathType Leaf)) {
    throw "Bundled core/node.exe is missing for clean-install smoke: $sourceCore"
}

$smokeRoot = [System.IO.Path]::GetFullPath((Join-Path ([System.IO.Path]::GetTempPath()) 'easyemail-clean-install-smoke'))
$runRoot = Join-Path $smokeRoot ([Guid]::NewGuid().ToString('N'))
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

try {
    $portableInstallDir = Join-Path $runRoot 'ProgramFiles-Portable'
    New-Item -ItemType Directory -Path $portableInstallDir -Force | Out-Null
    Copy-Item -LiteralPath $sourceExe -Destination (Join-Path $portableInstallDir 'EasyEmail.exe') -Force
    Copy-Item -LiteralPath $sourceCore -Destination (Join-Path $portableInstallDir 'core') -Recurse -Force

    Assert-ReadOnlyCleanInstallRuntime `
        -InstallDir $portableInstallDir `
        -InstalledExecutable (Join-Path $portableInstallDir 'EasyEmail.exe') `
        -AppDataDir (Join-Path $runRoot 'AppData-Portable') `
        -CurrentUser $currentUser `
        -Label 'PortableLayout'

    Write-Output 'EXTERNAL_NODE_ABSENT=True'
    Write-Output 'DOCKER_ABSENT=True'
    Write-Output 'READONLY_INSTALL_DIR_ENFORCED=True'
    Write-Output 'WRITABLE_STATE_IN_APPDATA_ONLY=True'
    Write-Output 'CLEAN_INSTALL_GRACEFUL_CLOSE=True'

    if (-not $SkipInstallerPackages -and (Test-Path -LiteralPath $bundleRoot -PathType Container)) {
        $nsisInstaller = Get-ChildItem -LiteralPath (Join-Path $bundleRoot 'nsis') -Filter '*-setup.exe' -File -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($nsisInstaller) {
            $nsisTargetDir = Join-Path $runRoot 'NSIS-PerUser-Install'
            New-Item -ItemType Directory -Path $nsisTargetDir -Force | Out-Null
            # NSIS /D= must be the last parameter and unquoted
            $nsisProc = Start-Process -FilePath $nsisInstaller.FullName `
                -ArgumentList "/S /D=$nsisTargetDir" -PassThru -WindowStyle Hidden
            if (-not $nsisProc.WaitForExit(60000) -or $nsisProc.ExitCode -ne 0) {
                throw "NSIS silent per-user install failed (exit=$($nsisProc.ExitCode))."
            }
            $nsisExe = Get-ChildItem -LiteralPath $nsisTargetDir -Filter '*.exe' -File |
                Where-Object { $_.Name -notmatch '^(?i)uninstall' } |
                Select-Object -First 1
            if (-not $nsisExe) {
                throw 'NSIS installer did not place main application executable in target directory.'
            }
            Assert-ReadOnlyCleanInstallRuntime `
                -InstallDir $nsisTargetDir `
                -InstalledExecutable $nsisExe.FullName `
                -AppDataDir (Join-Path $runRoot 'AppData-NSIS') `
                -CurrentUser $currentUser `
                -Label 'NSISInstaller'
            Write-Output 'NSIS_INSTALLER_RUNTIME_VERIFIED=True'

            $uninstaller = Join-Path $nsisTargetDir 'uninstall.exe'
            if (Test-Path -LiteralPath $uninstaller -PathType Leaf) {
                $uninstProc = Start-Process -FilePath $uninstaller `
                    -ArgumentList "/S _?=$nsisTargetDir" -PassThru -WindowStyle Hidden
                $null = $uninstProc.WaitForExit(30000)
                Write-Output 'NSIS_UNINSTALLER_VERIFIED=True'
            }
        }

        $msiInstaller = Get-ChildItem -LiteralPath (Join-Path $bundleRoot 'msi') -Filter '*.msi' -File -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($msiInstaller) {
            $msiAdminDir = Join-Path $runRoot 'MSI-AdminExtract'
            New-Item -ItemType Directory -Path $msiAdminDir -Force | Out-Null
            $msiProc = Start-Process -FilePath 'msiexec.exe' `
                -ArgumentList @('/a', "`"$($msiInstaller.FullName)`"", '/qn', "TARGETDIR=`"$msiAdminDir`"") `
                -PassThru -WindowStyle Hidden
            if (-not $msiProc.WaitForExit(60000) -or $msiProc.ExitCode -ne 0) {
                throw "MSI non-elevated administrative extraction failed (exit=$($msiProc.ExitCode))."
            }
            $msiExe = Get-ChildItem -LiteralPath $msiAdminDir -Recurse -File |
                Where-Object {
                    $_.Extension -ieq '.exe' -and
                    $_.Name -notmatch '^(?i)node\.exe$' -and
                    (Test-Path -LiteralPath (Join-Path $_.DirectoryName 'core\node.exe') -PathType Leaf)
                } |
                Select-Object -First 1
            if (-not $msiExe) {
                throw 'MSI package did not unpack an application executable paired with core\node.exe.'
            }
            Assert-ReadOnlyCleanInstallRuntime `
                -InstallDir $msiExe.DirectoryName `
                -InstalledExecutable $msiExe.FullName `
                -AppDataDir (Join-Path $runRoot 'AppData-MSI') `
                -CurrentUser $currentUser `
                -Label 'MSIPackage'
            Write-Output 'MSI_PACKAGE_RUNTIME_VERIFIED=True'
        }
    }
} finally {
    if (Test-Path -LiteralPath $runRoot) {
        Get-ChildItem -LiteralPath $runRoot -Directory -Force -ErrorAction SilentlyContinue | ForEach-Object {
            Clear-InstallTreeReadOnly -InstallRoot $_.FullName -Identity $currentUser
        }
        $resolvedRun = [System.IO.Path]::GetFullPath($runRoot)
        if ($resolvedRun.StartsWith($smokeRoot + [System.IO.Path]::DirectorySeparatorChar)) {
            Remove-Item -LiteralPath $resolvedRun -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}
