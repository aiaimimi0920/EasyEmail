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

Write-Host "Validating service/base..."
Invoke-InDirectory (Join-Path $repoRoot "service\\base") { npm run typecheck }
Invoke-InDirectory (Join-Path $repoRoot "service\\base") { npm run test }
Invoke-InDirectory (Join-Path $repoRoot "service\\base") { npm run build }

Write-Host "Validating upstream worker..."
Invoke-InDirectory (Join-Path $repoRoot "upstreams\\cloudflare_temp_email\\worker") { corepack pnpm lint }
Invoke-InDirectory (Join-Path $repoRoot "upstreams\\cloudflare_temp_email\\worker") { corepack pnpm build }

Write-Host "Validating upstream frontend..."
Invoke-InDirectory (Join-Path $repoRoot "upstreams\\cloudflare_temp_email\\frontend") { corepack pnpm test }
Invoke-InDirectory (Join-Path $repoRoot "upstreams\\cloudflare_temp_email\\frontend") { corepack pnpm build }

Write-Host "Userscript runtime validation is manual by design."

