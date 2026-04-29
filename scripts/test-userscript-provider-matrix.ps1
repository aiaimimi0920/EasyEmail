param(
    [string]$BaseUrl = "http://127.0.0.1:18091",
    [string]$ConfigPath = ".\config.yaml",
    [string]$ImportCodeFile = ".\.tmp\real-import-code.txt",
    [string]$SenderDomain = "tx-mail.aiaimimi.com",
    [string[]]$Providers = @(
        "cloudflare_temp_email",
        "mailtm",
        "duckmail",
        "guerrillamail",
        "etempmail",
        "moemail",
        "mail2925",
        "im215"
    ),
    [string]$GptmailApiKey = "",
    [int]$ProviderRetryCount = 1,
    [int]$ProviderRetryDelaySeconds = 10
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot 'lib/easyemail-config.ps1')

$config = Read-EasyEmailConfig -ConfigPath $ConfigPath
$serviceBase = Get-EasyEmailSection -Config $config -Name 'serviceBase'
if ($null -ne $serviceBase) {
    $server = Get-EasyEmailSection -Config (Get-EasyEmailSection -Config $serviceBase -Name 'runtime') -Name 'server'
} else {
    $server = Get-EasyEmailSection -Config $config -Name 'server'
}
$apiKey = [string](Get-EasyEmailConfigValue -Object $server -Name 'apiKey' -Default '')
if ([string]::IsNullOrWhiteSpace($apiKey)) {
    throw "Missing serviceBase.runtime.server.apiKey in $ConfigPath"
}

$providerCsv = ($Providers | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) -join ','
$scriptPath = Join-Path $PSScriptRoot 'test-userscript-provider-matrix.js'
$userscript = Get-EasyEmailSection -Config $config -Name 'userscript'
$userscriptSecrets = if ($null -ne $userscript) { Get-EasyEmailSection -Config $userscript -Name 'secrets' } else { @{} }
$serviceBaseRoot = Get-EasyEmailSection -Config $config -Name 'serviceBase'
$runtimeRoot = if ($null -ne $serviceBaseRoot) { Get-EasyEmailSection -Config $serviceBaseRoot -Name 'runtime' } else { $null }
$providerRoot = if ($null -ne $runtimeRoot) { Get-EasyEmailSection -Config $runtimeRoot -Name 'providers' } else { Get-EasyEmailSection -Config $config -Name 'providers' }
$gptmail = Get-EasyEmailSection -Config $providerRoot -Name 'gptmail'
$mail2925 = Get-EasyEmailSection -Config $providerRoot -Name 'mail2925'
$resolvedGptmailApiKey = if (-not [string]::IsNullOrWhiteSpace($GptmailApiKey)) {
    $GptmailApiKey
} else {
    [string](Get-EasyEmailConfigValue -Object $userscriptSecrets -Name 'gptmail_apiKey' -Default (Get-EasyEmailConfigValue -Object $gptmail -Name 'keysText' -Default (Get-EasyEmailConfigValue -Object $gptmail -Name 'apiKey' -Default '')))
}
$mail2925Account = [string](Get-EasyEmailConfigValue -Object $userscriptSecrets -Name 'mail2925_account' -Default (Get-EasyEmailConfigValue -Object $mail2925 -Name 'account' -Default ''))
$mail2925JwtToken = [string](Get-EasyEmailConfigValue -Object $userscriptSecrets -Name 'mail2925_jwtToken' -Default (Get-EasyEmailConfigValue -Object $mail2925 -Name 'jwtToken' -Default ''))
$mail2925DeviceUid = [string](Get-EasyEmailConfigValue -Object $userscriptSecrets -Name 'mail2925_deviceUid' -Default (Get-EasyEmailConfigValue -Object $mail2925 -Name 'deviceUid' -Default ''))
$mail2925CookieHeader = [string](Get-EasyEmailConfigValue -Object $userscriptSecrets -Name 'mail2925_cookieHeader' -Default (Get-EasyEmailConfigValue -Object $mail2925 -Name 'cookieHeader' -Default ''))

& node $scriptPath `
    --base-url $BaseUrl `
    --api-key $apiKey `
    --import-code-file $ImportCodeFile `
    --sender-domain $SenderDomain `
    --providers $providerCsv `
    --provider-retry-count $ProviderRetryCount `
    --provider-retry-delay-seconds $ProviderRetryDelaySeconds `
    --gptmail-api-key $resolvedGptmailApiKey `
    --mail2925-account $mail2925Account `
    --mail2925-jwt-token $mail2925JwtToken `
    --mail2925-device-uid $mail2925DeviceUid `
    --mail2925-cookie-header $mail2925CookieHeader

if ($LASTEXITCODE -ne 0) {
    throw "Userscript provider matrix failed with exit code $LASTEXITCODE"
}
