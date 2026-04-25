Set-StrictMode -Version Latest

$script:EasyEmailRepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path

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

    if ([System.IO.Path]::IsPathRooted($Path)) {
        return $Path
    }

    return [System.IO.Path]::GetFullPath((Join-Path $BasePath $Path))
}

function Read-EasyEmailConfig {
    param(
        [string]$ConfigPath = (Join-Path $script:EasyEmailRepoRoot 'config.yaml')
    )

    $resolvedConfigPath = Resolve-EasyEmailPath -Path $ConfigPath
    if (-not (Test-Path -LiteralPath $resolvedConfigPath)) {
        throw "Config file not found: $resolvedConfigPath. Copy config.example.yaml to config.yaml first."
    }

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
