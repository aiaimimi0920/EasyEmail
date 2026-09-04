param(
    [string]$BaseUrl = "http://127.0.0.1:18090",
    [string]$ConfigPath = "config.yaml",
    [string]$ApiKey = "",
    [string[]]$Providers = @(
        "cloudflare_temp_email",
        "mailtm",
        "duckmail",
        "guerrillamail",
        "tempmail-lol",
        "etempmail",
        "moemail",
        "m2u",
        "gptmail",
        "mail2925",
        "im215"
    ),
    [string]$SenderRequestedDomain = "",
    [string]$SenderRequestedLocalPart = "",
    [switch]$UseRandomSenderSubdomain,
    [switch]$SkipRecipientVerification,
    [switch]$ForceRecipientVerification,
    [int]$SenderRetryCount = 6,
    [int]$AuthLinkTimeoutSeconds = 300,
    [int]$VerificationTimeoutSeconds = 120,
    [int]$PostVerificationSettlingSeconds = 90,
    [int]$CodeTimeoutSeconds = 180,
    [int]$PollIntervalSeconds = 8,
    [int]$RecipientRetryCount = 3,
    [int]$RecipientRetryDelaySeconds = 8,
    [int]$ProviderRetryCount = 1,
    [int]$ProviderRetryDelaySeconds = 10,
    [string[]]$NonBlockingTransientProviders = @(),
    [switch]$IsolateTemplateMailbox,
    [string]$ResultOutputPath = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot 'lib/easyemail-config.ps1')

. (Join-Path $PSScriptRoot 'lib/sender-matrix-common.ps1')
. (Join-Path $PSScriptRoot 'lib/sender-matrix-cloudflare.ps1')
. (Join-Path $PSScriptRoot 'lib/sender-matrix-mail.ps1')
. (Join-Path $PSScriptRoot 'lib/sender-matrix-provider.ps1')
. (Join-Path $PSScriptRoot 'lib/sender-matrix-catalog.ps1')

function Test-ShouldRetryRecipientAddress {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Provider,
        [Parameter(Mandatory = $true)]
        [string]$Message
    )

    $retryableProviders = @('m2u', 'tempmail-lol', 'gptmail')
    if ($retryableProviders -notcontains $Provider.Trim().ToLowerInvariant()) {
        return $false
    }

    return $Message -match 'Timed out waiting for code|Operation failed|MAILBOX_CAPACITY_UNAVAILABLE|MAILBOX_UPSTREAM_TRANSIENT|M2U_TRANSIENT_FAILURE|PROVIDER_INSTANCE_UNAVAILABLE|Access denied|1010|errorcaptcha|fetch failed|daily_limit_exceeded|rate limit|quota'
}

function Test-IsNonBlockingUpstreamTransientFailure {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Provider,
        [Parameter(Mandatory = $true)]
        [string]$Message,
        [string[]]$AllowedProviders = @()
    )

    $normalizedProvider = $Provider.Trim().ToLowerInvariant()
    $normalizedAllowedProviders = @(
        $AllowedProviders |
            ForEach-Object { ([string]$_).Trim().ToLowerInvariant() } |
            Where-Object { $_ }
    )
    if ($normalizedAllowedProviders -notcontains $normalizedProvider) {
        return $false
    }

    return $Message -match 'MAILBOX_UPSTREAM_TRANSIENT|M2U_TRANSIENT_FAILURE'
}

$config = Read-EasyEmailConfig -ConfigPath $ConfigPath
$serviceBase = Get-EasyEmailSection -Config $config -Name 'serviceBase'
$runtime = Get-EasyEmailSection -Config $serviceBase -Name 'runtime'
$server = Get-EasyEmailSection -Config $runtime -Name 'server'

if (-not $ApiKey) {
    $ApiKey = [string](Get-ConfigSectionValue -Object $server -Name 'apiKey' -Default '')
}
if ([string]::IsNullOrWhiteSpace($ApiKey)) {
    throw 'Missing serviceBase.runtime.server.apiKey for service matrix test.'
}

$cloudflare = Get-EasyEmailSection -Config $config -Name 'cloudflareMail'
$sending = if ($null -ne $cloudflare) { Get-EasyEmailSection -Config $cloudflare -Name 'sending' } else { @{} }
$worker = if ($null -ne $cloudflare) { Get-EasyEmailSection -Config $cloudflare -Name 'worker' } else { @{} }
$workerVars = if ($null -ne $worker) { Get-EasyEmailSection -Config $worker -Name 'vars' } else { @{} }
$routing = if ($null -ne $cloudflare) { Get-EasyEmailSection -Config $cloudflare -Name 'routing' } else { @{} }
$globalAuth = if ($null -ne $routing) { Get-EasyEmailSection -Config $routing -Name 'cloudflareGlobalAuth' } else { @{} }
$sendingSection = if ($null -ne $sending) { $sending } else { @{} }
$globalAuthSection = if ($null -ne $globalAuth) { $globalAuth } else { @{} }
$resendToken = [string](Get-ConfigSectionValue -Object $workerVars -Name 'RESEND_TOKEN' -Default '')
$autoSkipRecipientVerification = (-not $ForceRecipientVerification) -and (-not [string]::IsNullOrWhiteSpace($resendToken))
$authEmail = [string](Get-ConfigSectionValue -Object $globalAuthSection -Name 'authEmail' -Default '')
$globalApiKey = [string](Get-ConfigSectionValue -Object $globalAuthSection -Name 'globalApiKey' -Default '')

if ([string]::IsNullOrWhiteSpace($SenderRequestedDomain)) {
    $SenderRequestedDomain = [string](Get-ConfigSectionValue -Object $sendingSection -Name 'preferredSenderDomain' -Default '')
    if ([string]::IsNullOrWhiteSpace($SenderRequestedDomain)) {
        $configuredSendingDomains = @(Convert-ToMatrixStringArray -Value (Get-ConfigSectionValue -Object $sendingSection -Name 'domains' -Default @()))
        if ($configuredSendingDomains.Count -gt 0) {
            $SenderRequestedDomain = [string]$configuredSendingDomains[0]
        }
    }
    if ([string]::IsNullOrWhiteSpace($SenderRequestedDomain)) {
        $cloudflareSection = if ($null -ne $cloudflare) { $cloudflare } else { @{} }
        $SenderRequestedDomain = Resolve-DefaultSenderDomain -CloudflareSection $cloudflareSection
    }
}

if ([string]::IsNullOrWhiteSpace($SenderRequestedLocalPart)) {
    $SenderRequestedLocalPart = [string](Get-ConfigSectionValue -Object $sendingSection -Name 'preferredSenderLocalPart' -Default '')
}

if (-not ($SkipRecipientVerification -or $autoSkipRecipientVerification) -and ([string]::IsNullOrWhiteSpace($authEmail) -or [string]::IsNullOrWhiteSpace($globalApiKey))) {
    throw 'Missing cloudflareMail.routing.cloudflareGlobalAuth credentials for destination verification.'
}

$script:ApiKeyValue = $ApiKey
$script:NormalizedBaseUrl = $BaseUrl.TrimEnd('/')
$script:SkipRecipientVerificationValue = [bool]($SkipRecipientVerification -or $autoSkipRecipientVerification)
$script:CloudflareApiHeaders = if (-not $script:SkipRecipientVerificationValue) {
    @{
        'X-Auth-Email' = $authEmail
        'X-Auth-Key' = $globalApiKey
        'Content-Type' = 'application/json'
    }
} else {
    @{}
}
$script:CloudflareAccountId = ''
$script:SenderRequestedDomainValue = $SenderRequestedDomain.Trim().ToLowerInvariant()
$script:SenderRequestedLocalPartValue = $SenderRequestedLocalPart.Trim()

$templates = New-TemplateCatalog
$senderSession = $null

$results = @()

foreach ($provider in $Providers) {
    Write-Host ("Testing provider: {0}" -f $provider) -ForegroundColor Cyan
    $providerResult = $null
    for ($attempt = 0; $attempt -le $ProviderRetryCount; $attempt += 1) {
        if ($attempt -gt 0) {
            Write-Host ("Retrying provider {0} (attempt {1}/{2})..." -f $provider, ($attempt + 1), ($ProviderRetryCount + 1)) -ForegroundColor Yellow
            Start-Sleep -Seconds $ProviderRetryDelaySeconds
        }
        $providerResult = Test-ProviderMatrixOnce -Provider $provider -Templates $templates -SenderSessionRef ([ref]$senderSession)
        if ($providerResult.ok) {
            break
        }
    }
    $results += $providerResult
}

$resultJson = $results | ConvertTo-Json -Depth 12
if (-not [string]::IsNullOrWhiteSpace($ResultOutputPath)) {
    $resolvedResultOutputPath = Resolve-EasyEmailPath -Path $ResultOutputPath
    $resultDirectory = Split-Path -Parent $resolvedResultOutputPath
    if (-not [string]::IsNullOrWhiteSpace($resultDirectory)) {
        New-Item -ItemType Directory -Force -Path $resultDirectory | Out-Null
    }
    Set-Content -LiteralPath $resolvedResultOutputPath -Value $resultJson -Encoding UTF8
}
$resultJson
