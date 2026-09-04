function Assert-MinimumNodeVersion {
    param(
        [Parameter(Mandatory = $true)]
        [Version]$MinimumVersion
    )

    $rawNodeVersion = (& node --version).Trim()
    if ($LASTEXITCODE -ne 0) {
        throw 'Node.js is required but was not found in PATH.'
    }

    $currentNodeVersion = [Version]($rawNodeVersion.TrimStart('v'))
    if ($currentNodeVersion -lt $MinimumVersion) {
        throw "Node.js $MinimumVersion or newer is required. Current version: $currentNodeVersion"
    }
}

function Invoke-Tool {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Executable,
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments,
        [Parameter(Mandatory = $true)]
        [string]$WorkingDirectory
    )

    Push-Location $WorkingDirectory
    try {
        & $Executable @Arguments
        if ($LASTEXITCODE -ne 0) {
            throw "Command failed: $Executable $($Arguments -join ' ')"
        }
    } finally {
        Pop-Location
    }
}

function Assert-PythonModule {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ModuleName
    )

    & python -c "import $ModuleName"
    if ($LASTEXITCODE -eq 0) {
        return
    }

    Write-Host "Installing missing Python module: $ModuleName" -ForegroundColor Cyan
    & python -m pip install --disable-pip-version-check $ModuleName
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to install required Python module: $ModuleName"
    }
}

function Invoke-PythonJsonTool {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Executable,
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments,
        [Parameter(Mandatory = $true)]
        [string]$WorkingDirectory
    )

    Push-Location $WorkingDirectory
    try {
        $output = & $Executable @Arguments
        if ($LASTEXITCODE -ne 0) {
            throw "Command failed: $Executable $($Arguments -join ' ')"
        }
        $json = ($output | Out-String).Trim()
        if ([string]::IsNullOrWhiteSpace($json)) {
            throw "Command did not return JSON output: $Executable $($Arguments -join ' ')"
        }
        return $json | ConvertFrom-Json
    } finally {
        Pop-Location
    }
}

function Invoke-LocalNodeTool {
    param(
        [Parameter(Mandatory = $true)]
        [string]$CommandPath,
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments,
        [Parameter(Mandatory = $true)]
        [string]$WorkingDirectory
    )

    if (-not (Test-Path -LiteralPath $CommandPath)) {
        throw "Local command not found: $CommandPath"
    }

    Invoke-Tool -Executable $CommandPath -Arguments $Arguments -WorkingDirectory $WorkingDirectory
}
