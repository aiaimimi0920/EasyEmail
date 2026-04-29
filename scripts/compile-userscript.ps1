param(
    [string]$ConfigPath = 'config.yaml',
    [string]$SourcePath,
    [string]$OutputPath,
    [switch]$CopyToClipboard
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot 'lib/easyemail-config.ps1')

function Get-SecretText {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Secrets,
        [Parameter(Mandatory = $true)]
        [string]$Name
    )

    if ($null -eq $Secrets) {
        return ''
    }

    $property = $Secrets.PSObject.Properties[$Name]
    if ($null -eq $property -or [string]::IsNullOrWhiteSpace([string]$property.Value)) {
        return ''
    }

    return [string]$property.Value
}

$config = Read-EasyEmailConfig -ConfigPath $ConfigPath
$userscript = Get-EasyEmailSection -Config $config -Name 'userscript'

if ($null -eq $userscript) {
    throw 'Missing userscript section in config.yaml.'
}

$sourcePath = if (
    $PSBoundParameters.ContainsKey('SourcePath') -and
    -not [string]::IsNullOrWhiteSpace($SourcePath)
) {
    Resolve-EasyEmailPath -Path $SourcePath
} else {
    Resolve-EasyEmailPath -Path (Get-EasyEmailConfigValue -Object $userscript -Name 'sourcePath' -Default 'runtimes/userscript/easy_email_proxy.user.js')
}

$outputPath = if (
    $PSBoundParameters.ContainsKey('OutputPath') -and
    -not [string]::IsNullOrWhiteSpace($OutputPath)
) {
    Resolve-EasyEmailPath -Path $OutputPath
} else {
    Resolve-EasyEmailPath -Path (Get-EasyEmailConfigValue -Object $userscript -Name 'outputPath' -Default 'runtimes/userscript/easy_email_proxy.local.user.js')
}

$shouldCopyToClipboard = $CopyToClipboard -or [bool](Get-EasyEmailConfigValue -Object $userscript -Name 'copyToClipboard' -Default $false)
$secrets = Get-EasyEmailSection -Config $userscript -Name 'secrets'

if (-not (Test-Path -LiteralPath $sourcePath)) {
    throw "Source userscript not found: $sourcePath"
}

$source = Get-Content -Raw -LiteralPath $sourcePath
$secretMap = @{
    cloudflare_customAuth = Get-SecretText -Secrets $secrets -Name 'cloudflare_customAuth'
    cloudflare_adminAuth  = Get-SecretText -Secrets $secrets -Name 'cloudflare_adminAuth'
    moemail_apiKey        = Get-SecretText -Secrets $secrets -Name 'moemail_apiKey'
    gptmail_apiKey        = Get-SecretText -Secrets $secrets -Name 'gptmail_apiKey'
    im215_apiKey          = Get-SecretText -Secrets $secrets -Name 'im215_apiKey'
    mail2925_account      = Get-SecretText -Secrets $secrets -Name 'mail2925_account'
    mail2925_jwtToken     = Get-SecretText -Secrets $secrets -Name 'mail2925_jwtToken'
    mail2925_deviceUid    = Get-SecretText -Secrets $secrets -Name 'mail2925_deviceUid'
    mail2925_cookieHeader = Get-SecretText -Secrets $secrets -Name 'mail2925_cookieHeader'
}

$tokenMap = @{
    '__LOCAL_SECRET_CLOUDFLARE_CUSTOM_AUTH__' = $secretMap.cloudflare_customAuth
    '__LOCAL_SECRET_CLOUDFLARE_ADMIN_AUTH__'  = $secretMap.cloudflare_adminAuth
    '__LOCAL_SECRET_MOEMAIL_API_KEY__'        = $secretMap.moemail_apiKey
    '__LOCAL_SECRET_IM215_API_KEY__'          = $secretMap.im215_apiKey
    '__LOCAL_SECRET_MAIL2925_ACCOUNT__'       = $secretMap.mail2925_account
    '__LOCAL_SECRET_MAIL2925_JWT_TOKEN__'     = $secretMap.mail2925_jwtToken
    '__LOCAL_SECRET_MAIL2925_DEVICE_UID__'    = $secretMap.mail2925_deviceUid
    '__LOCAL_SECRET_MAIL2925_COOKIE_HEADER__' = $secretMap.mail2925_cookieHeader
}

$escapedGptmailApiKey = $secretMap.gptmail_apiKey.Replace('\', '\\').Replace("'", "\'")
$source = [regex]::Replace(
    $source,
    "gptmail_apiKey:\s*'[^']*'",
    "gptmail_apiKey: '$escapedGptmailApiKey'"
)

foreach ($token in $tokenMap.Keys) {
    $replacement = [string]$tokenMap[$token]
    $escaped = $replacement.Replace('\', '\\').Replace("'", "\'")
    $source = $source.Replace($token, $escaped)
}

$unreplacedSecretTokens = @(
    [regex]::Matches($source, '__LOCAL_SECRET_[A-Z0-9_]+__') |
        ForEach-Object { $_.Value } |
        Select-Object -Unique
)

if ($unreplacedSecretTokens.Count -gt 0) {
    throw "Userscript still contains unreplaced local secret placeholders: $($unreplacedSecretTokens -join ', ')"
}

$banner = @(
    '// LOCAL DEV BUILD',
    '// Generated from config.yaml + userscript secrets',
    '// Do not commit this file.'
) -join "`r`n"

$output = $banner + "`r`n" + $source
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $outputPath) | Out-Null
Set-Content -LiteralPath $outputPath -Value $output -Encoding UTF8

if ($shouldCopyToClipboard) {
    Set-Clipboard -Value $output
    Write-Host "Generated and copied to clipboard: $outputPath"
} else {
    Write-Host "Generated local userscript: $outputPath"
}
