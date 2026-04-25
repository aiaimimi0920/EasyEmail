param(
    [string]$PlanPath = (Join-Path $PSScriptRoot '..\config\subdomain_pool_plan_20260402.toml'),
    [ValidateSet('exact', 'wildcard')]
    [string]$Mode = 'exact',
    [string]$ApiToken = $env:CLOUDFLARE_API_TOKEN,
    [switch]$DryRun,
    [switch]$ShowHosts
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$MailMxTemplates = @(
    [pscustomobject]@{ Type = 'MX'; Content = 'route1.mx.cloudflare.net'; Priority = 10 },
    [pscustomobject]@{ Type = 'MX'; Content = 'route2.mx.cloudflare.net'; Priority = 20 },
    [pscustomobject]@{ Type = 'MX'; Content = 'route3.mx.cloudflare.net'; Priority = 30 },
    [pscustomobject]@{ Type = 'TXT'; Content = 'v=spf1 include:_spf.mx.cloudflare.net ~all'; Priority = $null }
)

function Write-Step {
    param([string]$Message)
    Write-Host "`n==== $Message ====" -ForegroundColor Cyan
}

function Assert-ApiToken {
    param([string]$Token)

    if ([string]::IsNullOrWhiteSpace($Token)) {
        throw 'Missing Cloudflare API token. Set CLOUDFLARE_API_TOKEN or pass -ApiToken. Required scopes: Zone Read + DNS Read/Edit.'
    }
}

function Get-TomlStringArray {
    param(
        [string]$Content,
        [string]$Key
    )

    $match = [regex]::Match($Content, "(?ms)^\s*$([regex]::Escape($Key))\s*=\s*\[(.*?)\]")
    if (-not $match.Success) {
        throw "Failed to read TOML array: $Key"
    }

    $values = New-Object System.Collections.Generic.List[string]
    $itemMatches = [regex]::Matches($match.Groups[1].Value, '"([^"]*)"')
    foreach ($item in $itemMatches) {
        $values.Add($item.Groups[1].Value)
    }
    return $values.ToArray()
}

function Get-PlanConfig {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        throw "Plan file not found: $Path"
    }

    $content = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
    $labels = Get-TomlStringArray -Content $content -Key 'SUBDOMAIN_LABEL_POOL'
    $domains = Get-TomlStringArray -Content $content -Key 'DOMAINS'

    $wildcardRoots = New-Object System.Collections.Specialized.OrderedDictionary
    $exactDomains = New-Object System.Collections.Specialized.OrderedDictionary
    foreach ($domain in $domains) {
        if (-not $domain.StartsWith('*.')) {
            if (-not $exactDomains.Contains($domain)) {
                $exactDomains.Add($domain, $true)
            }
        }
        if ($domain.StartsWith('*.')) {
            $root = $domain.Substring(2)
            if (-not $wildcardRoots.Contains($root)) {
                $wildcardRoots.Add($root, $true)
            }
        }
    }

    return [pscustomobject]@{
        Labels = @($labels)
        PoolRoots = @($wildcardRoots.Keys)
        ExactDomains = @($exactDomains.Keys)
    }
}

function Invoke-CfApi {
    param(
        [ValidateSet('GET', 'POST')]
        [string]$Method,
        [string]$Path,
        [object]$Body = $null,
        [string]$Token
    )

    $env:ALL_PROXY = ''
    $env:http_proxy = ''
    $env:https_proxy = ''

    $uri = "https://api.cloudflare.com/client/v4/$Path"
    $arguments = @(
        '-s',
        '-X', $Method,
        '-H', "Authorization: Bearer $Token"
    )

    if ($null -ne $Body) {
        $arguments += @(
            '-H', 'Content-Type: application/json',
            '--data-raw', ($Body | ConvertTo-Json -Depth 20 -Compress)
        )
    }

    $arguments += $uri
    $rawResponse = & curl.exe @arguments
    if ($LASTEXITCODE -ne 0) {
        throw "curl.exe failed for $Path with exit code $LASTEXITCODE"
    }

    $response = $rawResponse | ConvertFrom-Json
    if (-not $response.success) {
        $errors = @($response.errors | ForEach-Object { "[{0}] {1}" -f $_.code, $_.message }) -join '; '
        throw "Cloudflare API failed: $Path :: $errors"
    }
    return $response
}

function Get-ZoneCatalog {
    param([string]$Token)

    $page = 1
    $zones = New-Object System.Collections.Generic.List[object]

    do {
        $response = Invoke-CfApi -Method GET -Path ("zones?page={0}&per_page=200&status=active" -f $page) -Token $Token
        foreach ($zone in $response.result) {
            $zones.Add($zone)
        }
        $totalPages = [int]$response.result_info.total_pages
        $page += 1
    } while ($page -le $totalPages)

    return $zones.ToArray()
}

function Resolve-ZoneForHost {
    param(
        [string]$HostName,
        [object[]]$Zones
    )

    $zone = $Zones |
        Sort-Object { $_.name.Length } -Descending |
        Where-Object { $HostName -eq $_.name -or $HostName.EndsWith(".$($_.name)") } |
        Select-Object -First 1

    if (-not $zone) {
        throw "No Cloudflare zone found for host: $HostName"
    }

    return $zone
}

function Get-TargetHosts {
    param(
        [pscustomobject]$Plan,
        [string]$SelectedMode
    )

    $targets = New-Object System.Collections.Generic.List[object]

    foreach ($targetHost in $Plan.ExactDomains) {
        $targets.Add([pscustomobject]@{
            Host = $targetHost
            Source = 'exact-domain'
        })
    }

    foreach ($root in $Plan.PoolRoots) {
        if ($SelectedMode -eq 'wildcard') {
            $targets.Add([pscustomobject]@{
                Host = "*.$root"
                Source = 'wildcard-pool'
            })
            continue
        }

        foreach ($label in $Plan.Labels) {
            $targets.Add([pscustomobject]@{
                Host = "$label.$root"
                Source = 'exact-pool'
            })
        }
    }

    return $targets.ToArray()
}

function Get-RecordIdentity {
    param([object]$Record)

    $type = if ($null -ne $Record.Type) { $Record.Type } else { $Record.type }
    $name = if ($null -ne $Record.Name) { $Record.Name } else { $Record.name }
    $content = if ($null -ne $Record.Content) { $Record.Content } else { $Record.content }
    if ($type -eq 'TXT') {
        $content = $content.Trim('"')
    }

    return ('{0}|{1}|{2}' -f $type, $name, $content)
}

function Get-ZoneDnsRecords {
    param(
        [object]$Zone,
        [string]$Token
    )

    $page = 1
    $records = New-Object System.Collections.Generic.List[object]
    do {
        $response = Invoke-CfApi -Method GET -Path ("zones/{0}/dns_records?page={1}&per_page=5000" -f $Zone.id, $page) -Token $Token
        foreach ($record in $response.result) {
            if ($record.type -in @('MX', 'TXT')) {
                $records.Add($record)
            }
        }
        $totalPages = [int]$response.result_info.total_pages
        $page += 1
    } while ($page -le $totalPages)

    return $records.ToArray()
}

function New-BindZoneLine {
    param(
        [object]$Zone,
        [object]$Record
    )

    $ttl = 300
    if ($Record.Type -eq 'MX') {
        return ('{0}. {1} IN MX {2} {3}.' -f $Record.Name, $ttl, $Record.Priority, $Record.Content.TrimEnd('.'))
    }

    if ($Record.Type -eq 'TXT') {
        return ('{0}. {1} IN TXT "{2}"' -f $Record.Name, $ttl, $Record.Content.Trim('"'))
    }

    throw "Unsupported record type for BIND export: $($Record.Type)"
}

function Invoke-ImportDnsRecords {
    param(
        [object]$Zone,
        [object[]]$Records,
        [string]$Token
    )

    if ($Records.Count -eq 0) {
        return 0
    }

    $zoneFilePath = Join-Path $env:TEMP ("cf-dns-import-{0}.zone" -f $Zone.id)
    try {
        $lines = @(
            ('$ORIGIN {0}.' -f $Zone.name),
            '$TTL 300'
        )
        foreach ($record in $Records) {
            $lines += (New-BindZoneLine -Zone $Zone -Record $record)
        }
        Set-Content -LiteralPath $zoneFilePath -Value $lines -Encoding UTF8

        $uri = "https://api.cloudflare.com/client/v4/zones/$($Zone.id)/dns_records/import"
        $arguments = @(
            '-s',
            '-X', 'POST',
            '-H', "Authorization: Bearer $Token",
            '-F', ("file=@{0}" -f $zoneFilePath),
            '-F', 'proxied=false',
            $uri
        )
        $rawResponse = & curl.exe @arguments
        if ($LASTEXITCODE -ne 0) {
            throw "curl.exe failed for dns_records/import on zone $($Zone.name) with exit code $LASTEXITCODE"
        }
        $response = $rawResponse | ConvertFrom-Json
        if (-not $response.success) {
            $errors = @($response.errors | ForEach-Object { "[{0}] {1}" -f $_.code, $_.message }) -join '; '
            throw "Cloudflare API failed: zones/$($Zone.id)/dns_records/import :: $errors"
        }
        return [int]$response.result.recs_added
    }
    finally {
        Remove-Item -LiteralPath $zoneFilePath -Force -ErrorAction SilentlyContinue
    }
}

function Test-RecordMatch {
    param(
        [object]$ExistingRecord,
        [pscustomobject]$DesiredRecord
    )

    if ($ExistingRecord.type -ne $DesiredRecord.Type) {
        return $false
    }
    if ($ExistingRecord.name -ne $DesiredRecord.Name) {
        return $false
    }
    if ($ExistingRecord.content -ne $DesiredRecord.Content) {
        return $false
    }
    if ($DesiredRecord.Type -eq 'MX' -and [int]$ExistingRecord.priority -ne [int]$DesiredRecord.Priority) {
        return $false
    }
    return $true
}

function Ensure-DnsRecord {
    param(
        [object]$Zone,
        [pscustomobject]$DesiredRecord,
        [string]$Token,
        [switch]$NoWrite
    )

    $encodedName = [uri]::EscapeDataString($DesiredRecord.Name)
    $response = Invoke-CfApi -Method GET -Path ("zones/{0}/dns_records?type={1}&name={2}&page=1&per_page=100" -f $Zone.id, $DesiredRecord.Type, $encodedName) -Token $Token
    $existing = @($response.result)

    foreach ($record in $existing) {
        if (Test-RecordMatch -ExistingRecord $record -DesiredRecord $DesiredRecord) {
            return 'exists'
        }
    }

    if ($NoWrite) {
        return 'dry-run'
    }

    $body = @{
        type = $DesiredRecord.Type
        name = $DesiredRecord.Name
        content = $DesiredRecord.Content
        ttl = 300
    }
    if ($DesiredRecord.Type -eq 'MX') {
        $body.priority = $DesiredRecord.Priority
    }

    $null = Invoke-CfApi -Method POST -Path ("zones/{0}/dns_records" -f $Zone.id) -Body $body -Token $Token
    return 'created'
}

function New-DesiredRecordSet {
    param([string]$HostName)

    $records = New-Object System.Collections.Generic.List[object]
    foreach ($template in $MailMxTemplates) {
        $records.Add([pscustomobject]@{
            Type = $template.Type
            Name = $HostName
            Content = $template.Content
            Priority = $template.Priority
        })
    }
    return $records.ToArray()
}

Assert-ApiToken -Token $ApiToken

$plan = Get-PlanConfig -Path $PlanPath
$targets = Get-TargetHosts -Plan $plan -SelectedMode $Mode

Write-Step 'Load Cloudflare zones'
$zones = Get-ZoneCatalog -Token $ApiToken
Write-Host ("Loaded {0} active zones from Cloudflare." -f $zones.Count) -ForegroundColor Green

$created = 0
$exists = 0
$dryRunCount = 0

Write-Step ("Prepare DNS sync ({0})" -f $Mode)
Write-Host ("Target hosts: {0}" -f $targets.Count) -ForegroundColor Yellow
Write-Host ("Planned records: {0}" -f ($targets.Count * $MailMxTemplates.Count)) -ForegroundColor Yellow

$targetsByZone = New-Object System.Collections.Specialized.OrderedDictionary
foreach ($target in $targets) {
    $zone = Resolve-ZoneForHost -HostName $target.Host -Zones $zones
    if (-not $targetsByZone.Contains($zone.id)) {
        $targetsByZone.Add($zone.id, [pscustomobject]@{
            Zone = $zone
            Hosts = New-Object System.Collections.Generic.List[string]
        })
    }
    $targetsByZone[$zone.id].Hosts.Add($target.Host) | Out-Null
}

foreach ($zoneEntry in $targetsByZone.Values) {
    $zone = $zoneEntry.Zone
    $hosts = New-Object System.Collections.Specialized.OrderedDictionary
    foreach ($hostName in $zoneEntry.Hosts) {
        if (-not $hosts.Contains($hostName)) {
            $hosts.Add($hostName, $true)
        }
    }

    if ($ShowHosts) {
        foreach ($hostName in $hosts.Keys) {
            Write-Host ("[{0}] {1}" -f $zone.name, $hostName) -ForegroundColor DarkGray
        }
    }

    $desiredRecords = New-Object System.Collections.Generic.List[object]
    foreach ($hostName in $hosts.Keys) {
        foreach ($record in (New-DesiredRecordSet -HostName $hostName)) {
            $desiredRecords.Add($record) | Out-Null
        }
    }

    $existingRecords = Get-ZoneDnsRecords -Zone $zone -Token $ApiToken
    $existingIndex = New-Object System.Collections.Generic.HashSet[string]
    foreach ($existingRecord in $existingRecords) {
        $null = $existingIndex.Add((Get-RecordIdentity -Record $existingRecord))
    }

    $missingRecords = New-Object System.Collections.Generic.List[object]
    foreach ($desiredRecord in $desiredRecords) {
        $identity = Get-RecordIdentity -Record $desiredRecord
        if ($existingIndex.Contains($identity)) {
            $exists += 1
            continue
        }
        $missingRecords.Add($desiredRecord) | Out-Null
    }

    if ($DryRun) {
        $dryRunCount += $missingRecords.Count
        continue
    }

    if ($missingRecords.Count -gt 0) {
        $created += Invoke-ImportDnsRecords -Zone $zone -Records $missingRecords.ToArray() -Token $ApiToken
    }
}

Write-Step 'Summary'
Write-Host ("Mode: {0}" -f $Mode) -ForegroundColor Green
Write-Host ("Created: {0}" -f $created) -ForegroundColor Green
Write-Host ("Already exists: {0}" -f $exists) -ForegroundColor Green
Write-Host ("Dry-run planned: {0}" -f $dryRunCount) -ForegroundColor Green
