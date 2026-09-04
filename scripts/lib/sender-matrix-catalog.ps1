function New-TemplateCatalog {
    return @(
        [pscustomobject]@{
            key = 'numeric_plain'
            expectedCode = '135790'
            subject = 'Numeric verification sample'
            textBody = 'Your verification code is 135790. Keep it for 10 minutes.'
            htmlBody = $null
        },
        [pscustomobject]@{
            key = 'numeric_colored_html'
            expectedCode = '246810'
            subject = 'Numeric html verification sample'
            textBody = 'Alert: order 998877 is separate. Your login code is 246810.'
            htmlBody = '<html><body><div style="font-family:Arial;background:#fff7ed;border:1px solid #fdba74;padding:16px"><p style="color:#9a3412">Security review notice</p><p>Ignore order <strong>998877</strong>.</p><p>Your login code is <span style="color:#2563eb;font-size:24px;font-weight:700">246810</span>.</p></div></body></html>'
        },
        [pscustomobject]@{
            key = 'alpha_html'
            expectedCode = 'QWERTY'
            subject = 'Alphabetic verification sample'
            textBody = 'Use code QWERTY to continue.'
            htmlBody = '<html><body><div style="font-family:Arial"><h2 style="color:#d14a4a">Verification</h2><p>Your code is <strong style="color:#1b6ef3">QWERTY</strong>.</p></div></body></html>'
        },
        [pscustomobject]@{
            key = 'mixed_html'
            expectedCode = 'A1B2C3'
            subject = 'Mixed verification sample'
            textBody = 'Use code A1B2C3 to continue.'
            htmlBody = '<html><body><div style="background:#0f172a;color:#e2e8f0;padding:16px"><p>Order #20260428</p><p>Primary code: <span style="color:#22c55e;font-size:20px;font-weight:700">A1B2C3</span></p><p>Ignore backup id 998877.</p></div></body></html>'
        },
        [pscustomobject]@{
            key = 'mixed_text_noise'
            expectedCode = 'ZX-41Q8-PLM7'
            subject = 'Long mixed verification sample'
            textBody = 'Account 220044 requires confirmation. Use verification code ZX-41Q8-PLM7 to continue. Ignore ticket 771199.'
            htmlBody = '<html><body><table style="font-family:Arial;border-collapse:collapse"><tr><td style="padding:8px;color:#475569">Account 220044 requires confirmation.</td></tr><tr><td style="padding:8px;background:#eff6ff;border:1px solid #93c5fd">Verification code: <strong style="font-size:18px;color:#1d4ed8">ZX-41Q8-PLM7</strong></td></tr><tr><td style="padding:8px;color:#64748b">Ignore ticket 771199.</td></tr></table></body></html>'
        }
    )
}

function Resolve-DefaultSenderDomain {
    param(
        [Parameter(Mandatory = $true)]
        [object]$CloudflareSection
    )

    $publicDomain = [string](Get-ConfigSectionValue -Object $CloudflareSection -Name 'publicDomain' -Default '')
    $publicZone = [string](Get-ConfigSectionValue -Object $CloudflareSection -Name 'publicZone' -Default '')

    if (-not [string]::IsNullOrWhiteSpace($publicDomain)) {
        $normalizedPublicDomain = $publicDomain.Trim().ToLowerInvariant()
        if ($normalizedPublicDomain.StartsWith('mail.')) {
            return ('tx-mail.' + $normalizedPublicDomain.Substring(5))
        }
        return ('tx-mail.' + $normalizedPublicDomain)
    }

    if (-not [string]::IsNullOrWhiteSpace($publicZone)) {
        return ('tx-mail.' + $publicZone.Trim().ToLowerInvariant())
    }

    return ''
}
