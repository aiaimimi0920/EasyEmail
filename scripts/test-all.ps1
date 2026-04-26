Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$minimumNodeVersion = [Version]'20.19.0'

. (Join-Path $PSScriptRoot 'lib/easyemail-config.ps1')

$powerShellCommand = Get-EasyEmailPowerShellCommand
$serviceBaseDir = Join-Path $repoRoot 'service/base'
$workerDir = Join-Path $repoRoot 'upstreams/cloudflare_temp_email/worker'
$frontendDir = Join-Path $repoRoot 'upstreams/cloudflare_temp_email/frontend'
$serviceTsc = Resolve-EasyEmailLocalNodeTool -PackageDirectory $serviceBaseDir -ToolName 'tsc'
$serviceVitest = Resolve-EasyEmailLocalNodeTool -PackageDirectory $serviceBaseDir -ToolName 'vitest'
$workerEslint = Resolve-EasyEmailLocalNodeTool -PackageDirectory $workerDir -ToolName 'eslint'
$frontendVitest = Resolve-EasyEmailLocalNodeTool -PackageDirectory $frontendDir -ToolName 'vitest'
$frontendVite = Resolve-EasyEmailLocalNodeTool -PackageDirectory $frontendDir -ToolName 'vite'

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

    Write-Host "Using Node.js $currentNodeVersion"
}

Assert-MinimumNodeVersion -MinimumVersion $minimumNodeVersion

Write-Host "Validating userscript runtime..."
Invoke-InDirectory $repoRoot { & $powerShellCommand -ExecutionPolicy Bypass -File (Join-Path $repoRoot 'scripts/validate-userscript.ps1') }

Write-Host "Validating service/base..."
Invoke-InDirectory $serviceBaseDir { & $serviceTsc -p tsconfig.json --noEmit }
Invoke-InDirectory $serviceBaseDir { & $serviceVitest run }
Invoke-InDirectory $serviceBaseDir { & $serviceTsc -p tsconfig.json }

Write-Host "Validating upstream worker..."
Invoke-InDirectory $workerDir { & $workerEslint src }
Invoke-InDirectory $workerDir { & node ./scripts/run-with-root-config.mjs build }

Write-Host "Validating upstream frontend..."
Invoke-InDirectory $frontendDir { & $frontendVitest run --passWithNoTests }
Invoke-InDirectory $frontendDir { & $frontendVite build -m prod --emptyOutDir }

Write-Host "Validating release automation scripts..."
& python -m py_compile `
    (Join-Path $repoRoot 'scripts/render-release-template.py') `
    (Join-Path $repoRoot 'scripts/upsert-release-notes-section.py') `
    (Join-Path $repoRoot 'scripts/validate-release-tag.py')
if ($LASTEXITCODE -ne 0) {
    throw "Release automation script validation failed with exit code $LASTEXITCODE"
}

$releaseAutomationTempRoot = Resolve-EasyEmailPath -Path '.tmp/release-script-validation'
New-Item -ItemType Directory -Force -Path $releaseAutomationTempRoot | Out-Null

$sampleManifestPath = Join-Path $releaseAutomationTempRoot 'sample-manifest.json'
$sampleNotesPath = Join-Path $releaseAutomationTempRoot 'sample-service-notes.md'
$sampleCloudflareNotesPath = Join-Path $releaseAutomationTempRoot 'sample-cloudflare-notes.md'
$sampleMergedNotesPath = Join-Path $releaseAutomationTempRoot 'sample-merged-notes.md'
$sampleExistingReleaseBodyPath = Join-Path $releaseAutomationTempRoot 'sample-existing-release-body.md'
$sampleScopeSummary = @'
### Scope Summary

- 1 file changed across 1 area.

- **Service Base**: 1 file
  - `service/base/src/index.ts`
'@

$sampleManifest = [ordered]@{
    schemaVersion = 1
    workflow = [ordered]@{
        runNumber = '42'
        url = 'https://example.com/run/42'
    }
    source = [ordered]@{
        eventName = 'push'
        actor = 'tester'
    }
    release = [ordered]@{
        imageRef = 'ghcr.io/example/easy-email-service'
        version = 'v1.2.3'
        channel = 'public-semver'
        digest = 'sha256:abc'
        platform = 'linux/amd64'
    }
    deployment = [ordered]@{
        result = 'deployed'
        channel = 'public-semver'
        baseUrl = 'https://mail.example.com'
        version = 'v1.2.3'
    }
    validation = [ordered]@{
        smoke = 'passed'
        sbom = 'enabled'
        provenance = 'mode=max'
        healthCheck = 'passed'
        routingSync = 'disabled'
        configSource = 'secret'
    }
    markdown = [ordered]@{
        tags = '- `ghcr.io/example/easy-email-service:v1.2.3`'
        matchedFiles = '- `service/base/src/index.ts`'
        scopeSummary = $sampleScopeSummary
    }
}

$sampleManifest | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $sampleManifestPath -Encoding UTF8
Set-Content -LiteralPath $sampleExistingReleaseBodyPath -Value '## Existing Release Notes' -Encoding UTF8

& python (Join-Path $repoRoot 'scripts/render-release-template.py') `
    --template (Join-Path $repoRoot '.github/release-notes/service-base-ghcr.md.tmpl') `
    --context $sampleManifestPath `
    --output $sampleNotesPath
if ($LASTEXITCODE -ne 0) {
    throw "Service release note template rendering failed with exit code $LASTEXITCODE"
}

& python (Join-Path $repoRoot 'scripts/render-release-template.py') `
    --template (Join-Path $repoRoot '.github/release-notes/cloudflare-email-run.md.tmpl') `
    --context $sampleManifestPath `
    --output $sampleCloudflareNotesPath
if ($LASTEXITCODE -ne 0) {
    throw "Cloudflare release note template rendering failed with exit code $LASTEXITCODE"
}

& python (Join-Path $repoRoot 'scripts/upsert-release-notes-section.py') `
    --section-id service-base-ghcr `
    --section-file $sampleNotesPath `
    --existing $sampleExistingReleaseBodyPath `
    --output $sampleMergedNotesPath
if ($LASTEXITCODE -ne 0) {
    throw "Release notes section upsert failed with exit code $LASTEXITCODE"
}

& python (Join-Path $repoRoot 'scripts/validate-release-tag.py') --mode service-base --tag release-20260427-001 | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw "Service-base release tag validation smoke check failed with exit code $LASTEXITCODE"
}

& python (Join-Path $repoRoot 'scripts/validate-release-tag.py') --mode cloudflare --tag v1.2.3 | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw "Cloudflare release tag validation smoke check failed with exit code $LASTEXITCODE"
}
