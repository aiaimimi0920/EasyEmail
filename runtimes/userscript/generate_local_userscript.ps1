param(
  [string]$SourcePath = (Join-Path $PSScriptRoot 'easy_email_proxy.user.js'),
  [string]$SecretsPath = (Join-Path $PSScriptRoot 'easy_email_proxy.secrets.local.json'),
  [string]$OutputPath = (Join-Path $PSScriptRoot 'easy_email_proxy.local.user.js'),
  [switch]$CopyToClipboard
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $SourcePath)) {
  throw "Source userscript not found: $SourcePath"
}

if (-not (Test-Path -LiteralPath $SecretsPath)) {
  throw "Local secrets file not found: $SecretsPath"
}

$source = Get-Content -Raw -LiteralPath $SourcePath
$secrets = Get-Content -Raw -LiteralPath $SecretsPath | ConvertFrom-Json
$secretMap = @{
  "cloudflare_customAuth" = [string]$secrets.cloudflare_customAuth
  "cloudflare_adminAuth" = [string]$secrets.cloudflare_adminAuth
  "moemail_apiKey" = [string]$secrets.moemail_apiKey
  "gptmail_apiKey" = [string]$secrets.gptmail_apiKey
  "im215_apiKey" = [string]$secrets.im215_apiKey
}

$tokenMap = @{
  "__LOCAL_SECRET_CLOUDFLARE_CUSTOM_AUTH__" = $secretMap["cloudflare_customAuth"]
  "__LOCAL_SECRET_CLOUDFLARE_ADMIN_AUTH__"  = $secretMap["cloudflare_adminAuth"]
  "__LOCAL_SECRET_MOEMAIL_API_KEY__"        = $secretMap["moemail_apiKey"]
  "__LOCAL_SECRET_IM215_API_KEY__"          = $secretMap["im215_apiKey"]
}

if ($secretMap["gptmail_apiKey"] -ne $null) {
  $gptReplacement = [string]$secretMap["gptmail_apiKey"]
  $escaped = $gptReplacement.Replace('\', '\\').Replace("'", "\'")
  $source = [regex]::Replace(
    $source,
    "gptmail_apiKey:\s*'[^']*'",
    "gptmail_apiKey: '$escaped'"
  )
}

foreach ($token in $tokenMap.Keys) {
  $replacement = [string]$tokenMap[$token]
  $escaped = $replacement.Replace('\', '\\').Replace("'", "\'")
  $source = $source.Replace($token, $escaped)
}

$banner = @(
  "// LOCAL DEV BUILD",
  "// Generated from easy_email_proxy.user.js + easy_email_proxy.secrets.local.json",
  "// Do not commit this file."
) -join "`r`n"

$output = $banner + "`r`n" + $source
Set-Content -LiteralPath $OutputPath -Value $output -Encoding UTF8

if ($CopyToClipboard) {
  Set-Clipboard -Value $output
  Write-Host "Generated and copied to clipboard: $OutputPath"
} else {
  Write-Host "Generated local userscript: $OutputPath"
}
