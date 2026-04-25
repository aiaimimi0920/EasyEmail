Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot

function Invoke-InDirectory {
    param(
        [string]$Path,
        [scriptblock]$Action
    )

    Push-Location $Path
    try {
        & $Action
    } finally {
        Pop-Location
    }
}

Write-Host "Installing service/base dependencies..."
Invoke-InDirectory (Join-Path $repoRoot "service\\base") { npm install }

Write-Host "Installing upstream worker dependencies..."
Invoke-InDirectory (Join-Path $repoRoot "upstreams\\cloudflare_temp_email\\worker") { corepack pnpm install }

Write-Host "Installing upstream frontend dependencies..."
Invoke-InDirectory (Join-Path $repoRoot "upstreams\\cloudflare_temp_email\\frontend") { corepack pnpm install }

Write-Host "Userscript runtime does not require package installation."

