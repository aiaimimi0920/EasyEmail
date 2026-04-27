Set-StrictMode -Version Latest

$script:EasyEmailRepoRoot = (Resolve-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))).Path

function Get-EasyEmailRepoRoot {
    return $script:EasyEmailRepoRoot
}

function Resolve-EasyEmailPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [string]$BasePath = $script:EasyEmailRepoRoot
    )

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return $null
    }

    $normalizedPath = $Path -replace '\\', '/'

    if ([System.IO.Path]::IsPathRooted($normalizedPath)) {
        return $normalizedPath
    }

    return [System.IO.Path]::GetFullPath((Join-Path $BasePath $normalizedPath))
}

function Test-EasyEmailIsWindows {
    return [System.IO.Path]::DirectorySeparatorChar -eq '\'
}

function Get-EasyEmailPowerShellCommand {
    foreach ($candidate in @('pwsh', 'powershell')) {
        $command = Get-Command $candidate -ErrorAction SilentlyContinue
        if ($command) {
            return $command.Source
        }
    }

    throw 'PowerShell executable not found. Install pwsh or powershell and ensure it is available in PATH.'
}

function Resolve-EasyEmailLocalNodeTool {
    param(
        [Parameter(Mandatory = $true)]
        [string]$PackageDirectory,
        [Parameter(Mandatory = $true)]
        [string]$ToolName
    )

    $binDirectory = Join-Path $PackageDirectory 'node_modules/.bin'
    if (-not (Test-Path -LiteralPath $binDirectory)) {
        throw "Missing local node bin directory: $binDirectory"
    }

    $candidates = if (Test-EasyEmailIsWindows) {
        @("$ToolName.cmd", "$ToolName.exe", $ToolName)
    } else {
        @($ToolName, "$ToolName.cmd")
    }

    foreach ($candidate in $candidates) {
        $candidatePath = Join-Path $binDirectory $candidate
        if (Test-Path -LiteralPath $candidatePath) {
            return (Resolve-Path -LiteralPath $candidatePath).Path
        }
    }

    throw "Local node tool '$ToolName' not found under $binDirectory"
}

function Get-EasyEmailReleaseChannel {
    param(
        [string]$Tag
    )

    if ([string]::IsNullOrWhiteSpace($Tag)) {
        return 'manual'
    }

    if ($Tag -match '^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$') {
        return 'public-semver'
    }

    if ($Tag -match '^release-\d{8}-\d{3}$') {
        return 'operational'
    }

    if ($Tag -match '^service-base-\d{8}-\d{3}$') {
        return 'service-base-only'
    }

    return 'manual'
}

function Get-EasyEmailReleaseScopeGroup {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath
    )

    $normalized = $FilePath -replace '\\', '/'

    if ($normalized.StartsWith('service/base/')) {
        return [pscustomobject]@{ key = 'service-base'; label = 'Service Base'; order = 10 }
    }

    if ($normalized.StartsWith('deploy/service/base/')) {
        return [pscustomobject]@{ key = 'service-base-deploy'; label = 'Service Base Deploy'; order = 15 }
    }

    if ($normalized.StartsWith('upstreams/cloudflare_temp_email/worker/')) {
        return [pscustomobject]@{ key = 'cloudflare-worker'; label = 'Cloudflare Worker'; order = 20 }
    }

    if ($normalized.StartsWith('upstreams/cloudflare_temp_email/frontend/')) {
        return [pscustomobject]@{ key = 'cloudflare-frontend'; label = 'Cloudflare Frontend'; order = 30 }
    }

    if ($normalized.StartsWith('deploy/upstreams/cloudflare_temp_email/')) {
        return [pscustomobject]@{ key = 'cloudflare-deploy'; label = 'Cloudflare Deploy'; order = 25 }
    }

    if ($normalized.StartsWith('scripts/')) {
        return [pscustomobject]@{ key = 'scripts'; label = 'Operator Scripts'; order = 40 }
    }

    if ($normalized.StartsWith('docs/')) {
        return [pscustomobject]@{ key = 'docs'; label = 'Docs'; order = 50 }
    }

    if ($normalized.StartsWith('.github/workflows/')) {
        return [pscustomobject]@{ key = 'github-actions'; label = 'GitHub Actions'; order = 45 }
    }

    if ($normalized.StartsWith('runtimes/userscript/')) {
        return [pscustomobject]@{ key = 'userscript'; label = 'Userscript'; order = 35 }
    }

    if ($normalized.StartsWith('upstreams/cloudflare_temp_email/')) {
        return [pscustomobject]@{ key = 'cloudflare-upstream'; label = 'Cloudflare Upstream'; order = 32 }
    }

    return [pscustomobject]@{ key = 'other'; label = 'Other'; order = 90 }
}

function Get-EasyEmailReleaseScopeSummary {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Files
    )

    $cleanedFiles = @(
        $Files |
            ForEach-Object { [string]$_ } |
            Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
            ForEach-Object { $_.Trim() } |
            Select-Object -Unique
    )

    $groups = New-Object System.Collections.Generic.List[object]
    $lookup = @{}

    foreach ($filePath in $cleanedFiles) {
        $group = Get-EasyEmailReleaseScopeGroup -FilePath $filePath
        if (-not $lookup.ContainsKey($group.key)) {
            $entry = [ordered]@{
                key = $group.key
                label = $group.label
                order = $group.order
                files = New-Object System.Collections.Generic.List[string]
            }
            $lookup[$group.key] = $entry
            $groups.Add($entry) | Out-Null
        }

        $lookup[$group.key].files.Add($filePath) | Out-Null
    }

    $orderedGroups = @(
        $groups | Sort-Object order, label | ForEach-Object {
            [pscustomobject]@{
                key = $_.key
                label = $_.label
                order = $_.order
                count = $_.files.Count
                files = @($_.files | Sort-Object)
            }
        }
    )

    $totalFiles = $cleanedFiles.Count
    $groupCount = $orderedGroups.Count
    $headline = if ($totalFiles -eq 0) {
        'No changed files recorded.'
    } elseif ($totalFiles -eq 1) {
        '1 file changed across 1 area.'
    } else {
        '{0} files changed across {1} areas.' -f $totalFiles, $groupCount
    }

    $markdownLines = @(
        '### Scope Summary',
        '',
        "- $headline"
    )

    foreach ($group in $orderedGroups) {
        $fileCountLabel = if ($group.count -eq 1) { '1 file' } else { "{0} files" -f $group.count }
        $markdownLines += ''
        $markdownLines += "- **$($group.label)**: $fileCountLabel"
        foreach ($file in $group.files) {
            $markdownLines += ('  - `{0}`' -f $file)
        }
    }

    if ($orderedGroups.Count -eq 0) {
        $markdownLines += ''
        $markdownLines += '- No relevant files matched the release scope.'
    }

    return [pscustomobject]@{
        totalFiles = $totalFiles
        totalGroups = $groupCount
        summary = $headline
        markdown = ($markdownLines -join "`n")
        groups = $orderedGroups
    }
}

function Assert-EasyEmailPythonModule {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ModuleName,
        [string]$PackageName = ''
    )

    $effectivePackageName = if ([string]::IsNullOrWhiteSpace($PackageName)) {
        $ModuleName
    } else {
        $PackageName
    }

    & python -c "import $ModuleName"
    if ($LASTEXITCODE -eq 0) {
        return
    }

    Write-Host "Installing missing Python module: $effectivePackageName" -ForegroundColor Cyan
    & python -m pip install --disable-pip-version-check $effectivePackageName
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to install required Python module: $effectivePackageName"
    }
}

function Read-EasyEmailConfig {
    param(
        [string]$ConfigPath = (Join-Path $script:EasyEmailRepoRoot 'config.yaml')
    )

    $resolvedConfigPath = Resolve-EasyEmailPath -Path $ConfigPath
    if (-not (Test-Path -LiteralPath $resolvedConfigPath)) {
        throw "Config file not found: $resolvedConfigPath. Copy config.example.yaml to config.yaml first."
    }

    Assert-EasyEmailPythonModule -ModuleName 'yaml' -PackageName 'pyyaml'

    $python = @'
import json
import pathlib
import sys
import yaml

config_path = pathlib.Path(sys.argv[1])
payload = yaml.safe_load(config_path.read_text(encoding="utf-8")) or {}
print(json.dumps(payload, ensure_ascii=False))
'@

    $json = $python | python - $resolvedConfigPath
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to parse YAML config: $resolvedConfigPath"
    }

    if ([string]::IsNullOrWhiteSpace($json)) {
        return [pscustomobject]@{}
    }

    return $json | ConvertFrom-Json
}

function Get-EasyEmailSection {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Config,
        [Parameter(Mandatory = $true)]
        [string]$Name
    )

    $property = $Config.PSObject.Properties[$Name]
    if ($null -eq $property) {
        return $null
    }

    return $Config.$Name
}

function Get-EasyEmailConfigValue {
    param(
        [object]$Object,
        [Parameter(Mandatory = $true)]
        [string]$Name,
        $Default = $null
    )

    if ($null -eq $Object) {
        return $Default
    }

    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) {
        return $Default
    }

    $value = $Object.$Name
    if ($null -eq $value) {
        return $Default
    }

    if ($value -is [string] -and [string]::IsNullOrWhiteSpace($value)) {
        return $Default
    }

    return $value
}

function New-EasyEmailTempFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Prefix,
        [Parameter(Mandatory = $true)]
        [string]$Extension
    )

    $tempRoot = Join-Path $script:EasyEmailRepoRoot '.tmp'
    New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null
    $fileName = '{0}-{1}{2}' -f $Prefix, ([guid]::NewGuid().ToString('N')), $Extension
    return Join-Path $tempRoot $fileName
}

function Write-EasyEmailJsonFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [Parameter(Mandatory = $true)]
        [object]$Value
    )

    $json = $Value | ConvertTo-Json -Depth 20
    Set-Content -LiteralPath $Path -Value $json -Encoding UTF8
    return $Path
}
