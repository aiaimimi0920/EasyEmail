param(
    [string]$OutputPath = (Join-Path $PWD 'service-base-release-manifest.json'),
    [string]$GitHubOutputPath = $env:GITHUB_OUTPUT
)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'lib/easyemail-config.ps1')

$version = [string]$env:EASYEMAIL_RELEASE_VERSION
$imageRef = [string]$env:EASYEMAIL_IMAGE_REF
$shortSha = [string]$env:EASYEMAIL_SHORT_SHA
$tags = @(
    "${imageRef}:${version}"
    "${imageRef}:sha-${shortSha}"
)
if ($env:EASYEMAIL_PUSH_LATEST -eq 'true') {
    $tags += "${imageRef}:latest"
}

$distribution = $null
$distributionPath = [string]$env:EASYEMAIL_DISTRIBUTION_PATH
if (Test-Path -LiteralPath $distributionPath) {
    $distribution = Get-Content -LiteralPath $distributionPath -Raw | ConvertFrom-Json
}

$matchedFiles = @(
    [string]$env:EASYEMAIL_MATCHED_FILES -split "`r?`n" |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
)
if ($matchedFiles.Count -eq 0) {
    $matchedFiles = @('(no matched files recorded)')
}

$scopeSummary = Get-EasyEmailReleaseScopeSummary -Files $matchedFiles
$channel = Get-EasyEmailReleaseChannel -Tag $version
$tagMarkdown = ($tags | ForEach-Object { '- `{0}`' -f $_ }) -join [Environment]::NewLine
$matchedFilesMarkdown = ($matchedFiles | ForEach-Object { '- `{0}`' -f $_ }) -join [Environment]::NewLine

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
        shortSha = $shortSha
        changeReason = [string]$env:EASYEMAIL_CHANGE_REASON
        matchedFiles = $matchedFiles
    }
    audit = [ordered]@{
        scopeSummary = $scopeSummary.summary
        scopeGroups = $scopeSummary.groups
    }
    release = [ordered]@{
        kind = 'service-base-ghcr'
        version = $version
        channel = $channel
        imageRef = $imageRef
        platform = [string]$env:EASYEMAIL_PLATFORM
        digest = [string]$env:EASYEMAIL_IMAGE_DIGEST
        tags = $tags
        publishLatest = ($env:EASYEMAIL_PUSH_LATEST -eq 'true')
    }
    distribution = $distribution
    validation = [ordered]@{
        smoke = [string]$env:EASYEMAIL_SMOKE_LABEL
        sbom = 'enabled'
        provenance = 'mode=max'
    }
    markdown = [ordered]@{
        tags = $tagMarkdown
        matchedFiles = $matchedFilesMarkdown
        scopeSummary = $scopeSummary.markdown
    }
}

$manifest | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $OutputPath -Encoding UTF8
if (-not [string]::IsNullOrWhiteSpace($GitHubOutputPath)) {
    "path=$OutputPath" | Add-Content -LiteralPath $GitHubOutputPath -Encoding UTF8
}
