Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Invoke-PlaywrightCli {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    $sessionArguments = @('-s=default') + $Arguments
    $output = & npx --yes @playwright/cli@latest @sessionArguments
    if ($LASTEXITCODE -ne 0) {
        throw "Playwright CLI failed: $($sessionArguments -join ' ')"
    }

    return ($output | Out-String).Trim()
}

Write-Host 'Opening Cloudflare dashboard in the shared Playwright session...' -ForegroundColor Cyan
Invoke-PlaywrightCli -Arguments @('open', 'https://dash.cloudflare.com/', '--headed') | Out-Null
Write-Host 'Complete any Cloudflare login or challenge in the opened browser window, then keep it open for matrix verification reuse.' -ForegroundColor Yellow
