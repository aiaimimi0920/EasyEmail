param(
    [string]$ConfigPath = '.\config.yaml',
    [string]$OutputPath = (Join-Path $PWD 'cloudflare-email-release-manifest.json'),
    [string]$GitHubOutputPath = $env:GITHUB_OUTPUT
)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'lib/easyemail-config.ps1')

$config = Read-EasyEmailConfig -ConfigPath $ConfigPath
$cloudflare = Get-EasyEmailSection -Config $config -Name 'cloudflareMail'
$routing = Get-EasyEmailSection -Config $cloudflare -Name 'routing'
$baseUrl = [string](Get-EasyEmailConfigValue -Object $cloudflare -Name 'publicBaseUrl' -Default '')
$tagOrRefName = [string]$env:EASYEMAIL_RELEASE_TAG
$useWorkflowInputs = (($env:GITHUB_EVENT_NAME -eq 'workflow_dispatch') -or ($env:EASYEMAIL_COORDINATED_RELEASE -eq 'true'))
$isDryRun = ($useWorkflowInputs -and $env:EASYEMAIL_INPUT_DRY_RUN -eq 'true')
$shouldRunHealthCheck = -not ($useWorkflowInputs -and $env:EASYEMAIL_INPUT_RUN_HEALTH_CHECK -eq 'false')
$result = if ($isDryRun) { 'validated' } else { 'deployed' }
$channel = Get-EasyEmailReleaseChannel -Tag $tagOrRefName

$matchedFiles = @(
    [string]$env:EASYEMAIL_MATCHED_FILES -split "`r?`n" |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
)
if ($matchedFiles.Count -eq 0) {
    $matchedFiles = @('(manual or forced run)')
}

$runtimeReadback = $null
$runtimePath = [string]$env:EASYEMAIL_RUNTIME_PATH
if (-not [string]::IsNullOrWhiteSpace($runtimePath)) {
    $runtimeReadback = Get-Content -Raw -LiteralPath $runtimePath | ConvertFrom-Json
}

$routingSyncEnabled = if ($useWorkflowInputs -and $env:EASYEMAIL_INPUT_NO_ROUTING_SYNC -eq 'true') {
    $false
} else {
    [bool](Get-EasyEmailConfigValue -Object $cloudflare -Name 'syncRouting' -Default $false)
}

$scopeSummary = Get-EasyEmailReleaseScopeSummary -Files $matchedFiles
$manifest = [ordered]@{
    schemaVersion = 1
    generatedAtUtc = [DateTime]::UtcNow.ToString('o')
    repository = [string]$env:GITHUB_REPOSITORY
    workflow = [ordered]@{
        name = [string]$env:GITHUB_WORKFLOW
        runId = [string]$env:GITHUB_RUN_ID
        runNumber = [string]$env:GITHUB_RUN_NUMBER
        runAttempt = [string]$env:GITHUB_RUN_ATTEMPT
        url = 'https://github.com/{0}/actions/runs/{1}' -f $env:GITHUB_REPOSITORY, $env:GITHUB_RUN_ID
    }
    source = [ordered]@{
        eventName = [string]$env:GITHUB_EVENT_NAME
        actor = [string]$env:GITHUB_ACTOR
        ref = [string]$env:GITHUB_REF
        sha = [string]$env:GITHUB_SHA
        changeReason = [string]$env:EASYEMAIL_CHANGE_REASON
        matchedFiles = $matchedFiles
    }
    audit = [ordered]@{
        scopeSummary = $scopeSummary.summary
        scopeGroups = $scopeSummary.groups
    }
    deployment = [ordered]@{
        kind = 'cloudflare-email'
        channel = $channel
        result = $result
        dryRun = $isDryRun
        baseUrl = $baseUrl
        version = if ($runtimeReadback) { [string]$runtimeReadback.version } else { 'n/a' }
        bootstrap = ($useWorkflowInputs -and $env:EASYEMAIL_INPUT_BOOTSTRAP -eq 'true')
        syncMode = if ($useWorkflowInputs) { [string]$env:EASYEMAIL_INPUT_SYNC_MODE } else { [string](Get-EasyEmailConfigValue -Object $routing -Name 'mode' -Default 'exact') }
        routingSyncEnabled = $routingSyncEnabled
        domains = if ($runtimeReadback) { @($runtimeReadback.domains) } else { @() }
        randomSubdomainDomains = if ($runtimeReadback) { @($runtimeReadback.randomSubdomainDomains) } else { @() }
        needAuth = if ($runtimeReadback) { [bool]$runtimeReadback.needAuth } else { $false }
    }
    validation = [ordered]@{
        healthCheck = if ($isDryRun) { 'skipped' } elseif ($shouldRunHealthCheck) { 'passed' } else { 'skipped' }
        routingSync = if ($routingSyncEnabled) { 'enabled' } else { 'disabled' }
        configSource = [string]$env:EASYEMAIL_CONFIG_SOURCE
        runtimeReadback = if ($runtimeReadback) { 'captured' } else { 'pending' }
        senderMatrix = if ($isDryRun -or $env:EASYEMAIL_INPUT_RUN_SENDER_MATRIX -eq 'false') {
            'skipped'
        } elseif (-not [string]::IsNullOrWhiteSpace([string]$env:EASYEMAIL_SENDER_MATRIX_RESULT)) {
            [string]$env:EASYEMAIL_SENDER_MATRIX_RESULT
        } else {
            'pending'
        }
    }
    markdown = [ordered]@{
        matchedFiles = (($matchedFiles | ForEach-Object { '- `' + $_ + '`' }) -join "`n")
        scopeSummary = $scopeSummary.markdown
    }
}

$manifest | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $OutputPath -Encoding UTF8
if (-not [string]::IsNullOrWhiteSpace($GitHubOutputPath)) {
    "path=$OutputPath" | Add-Content -LiteralPath $GitHubOutputPath -Encoding UTF8
}
