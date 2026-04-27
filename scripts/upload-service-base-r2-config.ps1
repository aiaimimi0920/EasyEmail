param(
    [string]$ConfigPath = 'config.yaml',
    [string]$AccountId = '',
    [string]$Bucket = '',
    [string]$AccessKeyId = '',
    [string]$SecretAccessKey = '',
    [string]$ConfigObjectKey = '',
    [string]$RuntimeEnvObjectKey = '',
    [string]$UserscriptSettingsObjectKey = '',
    [string]$ManifestObjectKey = '',
    [string]$Endpoint = '',
    [string]$ReleaseVersion = '',
    [string]$ManifestOutput = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot 'lib/easyemail-config.ps1')

if ([string]::IsNullOrWhiteSpace($AccountId)) {
    throw 'AccountId is required.'
}
if ([string]::IsNullOrWhiteSpace($Bucket)) {
    throw 'Bucket is required.'
}
if ([string]::IsNullOrWhiteSpace($AccessKeyId)) {
    throw 'AccessKeyId is required.'
}
if ([string]::IsNullOrWhiteSpace($SecretAccessKey)) {
    throw 'SecretAccessKey is required.'
}
if ([string]::IsNullOrWhiteSpace($ConfigObjectKey)) {
    throw 'ConfigObjectKey is required.'
}
if ([string]::IsNullOrWhiteSpace($RuntimeEnvObjectKey)) {
    throw 'RuntimeEnvObjectKey is required.'
}
if ([string]::IsNullOrWhiteSpace($UserscriptSettingsObjectKey)) {
    throw 'UserscriptSettingsObjectKey is required.'
}
if ([string]::IsNullOrWhiteSpace($ManifestObjectKey)) {
    throw 'ManifestObjectKey is required.'
}

$resolvedConfigPath = Resolve-EasyEmailPath -Path $ConfigPath
$renderServiceOutput = New-EasyEmailTempFile -Prefix 'service-base-runtime-config' -Extension '.yaml'
$renderEnvOutput = New-EasyEmailTempFile -Prefix 'service-base-runtime-env' -Extension '.env'
$renderUserscriptOutput = New-EasyEmailTempFile -Prefix 'userscript-runtime-settings' -Extension '.json'

try {
    & (Join-Path $PSScriptRoot 'render-derived-configs.ps1') `
        -ConfigPath $resolvedConfigPath `
        -ServiceBase `
        -ServiceOutput $renderServiceOutput `
        -ServiceEnvOutput $renderEnvOutput

    if ($LASTEXITCODE -ne 0) {
        throw "Failed to render service/base runtime config with exit code $LASTEXITCODE"
    }

    & python (Join-Path $PSScriptRoot 'render-userscript-remote-config.py') `
        --config $resolvedConfigPath `
        --output $renderUserscriptOutput
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to render userscript remote settings with exit code $LASTEXITCODE"
    }

    $pythonScript = Join-Path $PSScriptRoot 'upload-service-base-r2-config.py'
    $pythonArgs = @(
        $pythonScript,
        '--account-id', $AccountId,
        '--bucket', $Bucket,
        '--access-key-id', $AccessKeyId,
        '--secret-access-key', $SecretAccessKey,
        '--config-path', $renderServiceOutput,
        '--config-object-key', $ConfigObjectKey,
        '--runtime-env-path', $renderEnvOutput,
        '--runtime-env-object-key', $RuntimeEnvObjectKey,
        '--userscript-settings-path', $renderUserscriptOutput,
        '--userscript-settings-object-key', $UserscriptSettingsObjectKey,
        '--manifest-object-key', $ManifestObjectKey
    )
    if (-not [string]::IsNullOrWhiteSpace($Endpoint)) {
        $pythonArgs += @('--endpoint', $Endpoint)
    }
    if (-not [string]::IsNullOrWhiteSpace($ReleaseVersion)) {
        $pythonArgs += @('--release-version', $ReleaseVersion)
    }
    if (-not [string]::IsNullOrWhiteSpace($ManifestOutput)) {
        $pythonArgs += @('--manifest-output', (Resolve-EasyEmailPath -Path $ManifestOutput))
    }

    Assert-EasyEmailPythonModule -ModuleName 'boto3' -PackageName 'boto3'
    Assert-EasyEmailPythonModule -ModuleName 'yaml' -PackageName 'pyyaml'
    & python @pythonArgs
    if ($LASTEXITCODE -ne 0) {
        throw "R2 upload failed with exit code $LASTEXITCODE"
    }
} finally {
    Remove-Item -LiteralPath $renderServiceOutput -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $renderEnvOutput -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $renderUserscriptOutput -ErrorAction SilentlyContinue
}
