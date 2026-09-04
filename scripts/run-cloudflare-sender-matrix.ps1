param(
    [string]$BaseUrl = $env:EASYEMAIL_SENDER_MATRIX_BASE_URL,
    [string]$ConfigPath = '.\config.yaml',
    [string]$ResultOutputPath = (Join-Path $PWD 'cloudflare-sender-matrix-smoke.json'),
    [string]$SummaryOutputPath = (Join-Path $PWD 'cloudflare-sender-matrix-smoke-summary.md'),
    [string]$GitHubOutputPath = $env:GITHUB_OUTPUT,
    [string]$GitHubStepSummaryPath = $env:GITHUB_STEP_SUMMARY
)

$ErrorActionPreference = 'Stop'

& (Join-Path $PSScriptRoot 'test-easyemail-cloudflare-sender-matrix.ps1') `
    -BaseUrl $BaseUrl `
    -ConfigPath $ConfigPath `
    -Providers 'cloudflare_temp_email','mailtm','m2u' `
    -CodeTimeoutSeconds 300 `
    -ProviderRetryCount 2 `
    -RecipientRetryCount 4 `
    -NonBlockingTransientProviders 'm2u' `
    -ResultOutputPath $ResultOutputPath

$results = Get-Content -Raw -LiteralPath $ResultOutputPath | ConvertFrom-Json
$failed = @($results | Where-Object { -not $_.ok -and $_.degraded -ne $true })
$degraded = @($results | Where-Object { $_.degraded -eq $true })
$matrixResult = if ($failed.Count -gt 0) { 'failed' } elseif ($degraded.Count -gt 0) { 'degraded' } else { 'passed' }

$summaryLines = @(
    '## Cloudflare Sender Matrix Smoke'
    ''
    '- Providers: `cloudflare_temp_email`, `mailtm`, `m2u`'
    ('- Base URL: `' + $BaseUrl + '`')
    ('- Result: ' + $matrixResult)
    ''
)

foreach ($entry in $results) {
    if ($entry.ok) {
        $summaryLines += ('- `'+$entry.provider+'`: passed')
    } elseif ($entry.degraded -eq $true) {
        $summaryLines += ('- `'+$entry.provider+'`: degraded after upstream-transient retries')
    } else {
        $summaryLines += ('- `'+$entry.provider+'`: failed')
        if ($entry.detail) {
            $summaryLines += ('  detail: ' + [string]$entry.detail)
        }
    }
}

Set-Content -LiteralPath $SummaryOutputPath -Value ($summaryLines -join "`n") -Encoding UTF8
if (-not [string]::IsNullOrWhiteSpace($GitHubStepSummaryPath)) {
    Get-Content -LiteralPath $SummaryOutputPath | Add-Content -LiteralPath $GitHubStepSummaryPath -Encoding UTF8
}

if (-not [string]::IsNullOrWhiteSpace($GitHubOutputPath)) {
    @(
        "result_path=$ResultOutputPath"
        "summary_path=$SummaryOutputPath"
        "result=$matrixResult"
    ) | Add-Content -LiteralPath $GitHubOutputPath -Encoding UTF8
}

if ($failed.Count -gt 0) {
    throw ('Sender matrix smoke failed for providers: ' + (($failed | ForEach-Object { $_.provider }) -join ', '))
}
if ($degraded.Count -gt 0) {
    Write-Warning ('Sender matrix completed with upstream-transient degradation for providers: ' + (($degraded | ForEach-Object { $_.provider }) -join ', '))
}
