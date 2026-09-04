function Wait-PersistedLifecycleState {
    param(
        [Parameter(Mandatory = $true)]
        [string]$SessionId,
        [Parameter(Mandatory = $true)]
        [string]$Marker,
        [Parameter(Mandatory = $true)]
        [string]$ExpectedCode
    )

    $stateFilePath = Join-Path $runtimeRoot 'data/state/easy-email-state.json'
    $deadline = [DateTime]::UtcNow.AddMilliseconds([Math]::Max(30000, $persistenceIntervalMs + 30000))
    do {
        if (Test-Path -LiteralPath $stateFilePath -PathType Leaf) {
            try {
                $persistedSnapshot = Get-Content -LiteralPath $stateFilePath -Raw | ConvertFrom-Json
                $persistedSession = @($persistedSnapshot.sessions | Where-Object {
                    [string](Get-EasyEmailConfigValue -Object $_ -Name 'id' -Default '') -eq $SessionId
                }) | Select-Object -First 1
                $persistedMessage = @($persistedSnapshot.messages | Where-Object {
                    $messageSessionId = [string](Get-EasyEmailConfigValue -Object $_ -Name 'sessionId' -Default '')
                    $messageSubject = [string](Get-EasyEmailConfigValue -Object $_ -Name 'subject' -Default '')
                    $messageTextBody = [string](Get-EasyEmailConfigValue -Object $_ -Name 'textBody' -Default '')
                    $messageHtmlBody = [string](Get-EasyEmailConfigValue -Object $_ -Name 'htmlBody' -Default '')
                    $messageSessionId -eq $SessionId -and
                    $messageSubject.Contains($Marker) -and
                    ($messageTextBody.Contains($ExpectedCode) -or $messageHtmlBody.Contains($ExpectedCode))
                }) | Select-Object -First 1
                $releaseStatus = [string](Get-EasyEmailConfigValue `
                    -Object (Get-EasyEmailConfigValue -Object $persistedSession -Name 'metadata' -Default $null) `
                    -Name 'releaseStatus' `
                    -Default '')
                if ($null -ne $persistedSession -and $null -ne $persistedMessage -and $releaseStatus -eq 'released') {
                    return
                }
            } catch {
                # The persistence loop writes through a temporary file; retry boundedly while the snapshot settles.
            }
        }
        Start-Sleep -Seconds 1
    } while ([DateTime]::UtcNow -lt $deadline)

    throw 'Timed out waiting for the released mailbox and observed message to reach persistent storage.'
}

function Remove-IsolatedRuntimeRoot {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [Parameter(Mandatory = $true)]
        [string]$CleanupImage
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        return
    }
    $allowedRoot = [System.IO.Path]::GetFullPath((Join-Path $workspaceRoot '.tmp/service-base-real'))
    $resolvedPath = [System.IO.Path]::GetFullPath($Path)
    if (-not $resolvedPath.StartsWith($allowedRoot + [System.IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to remove runtime root outside the isolated validation directory: $resolvedPath"
    }

    try {
        Remove-Item -LiteralPath $resolvedPath -Recurse -Force
        return
    } catch {
        $mountSpec = "${resolvedPath}:/runtime"
        $cleanupScript = 'from pathlib import Path; import shutil; [shutil.rmtree(p) if p.is_dir() and not p.is_symlink() else p.unlink() for p in Path("/runtime").iterdir()]'
        & docker run --rm --pull never --network none --user 0 --entrypoint /usr/bin/python3 -v $mountSpec $CleanupImage -c $cleanupScript *> $null
        if ($LASTEXITCODE -ne 0) {
            throw 'Docker-owned isolated runtime files could not be cleared.'
        }
        Remove-Item -LiteralPath $resolvedPath -Recurse -Force
    }
}
