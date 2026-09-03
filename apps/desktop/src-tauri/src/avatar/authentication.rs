use super::network::*;
use super::resolution::*;
use super::*;

pub(super) fn resolve_sender_auth(
    domain: &str,
    authentication_results: Option<&str>,
    received_spf: Option<&str>,
    dkim_signature: Option<&str>,
) -> SenderAuthDto {
    let auth_results = authentication_results.unwrap_or("").to_ascii_lowercase();
    let spf_header = received_spf.unwrap_or("").to_ascii_lowercase();
    let dkim_header = dkim_signature.unwrap_or("");

    let spf = if authentication_result_is(&auth_results, "spf", "pass")
        || received_spf_result_is(&spf_header, "pass")
    {
        AuthSignalDto::pass("SPF pass from message authentication headers")
    } else if authentication_result_is(&auth_results, "spf", "fail")
        || received_spf_result_is(&spf_header, "fail")
    {
        AuthSignalDto::fail("SPF fail from message authentication headers")
    } else if has_spf_policy(domain) {
        AuthSignalDto::published("SPF policy is published for sender domain")
    } else {
        AuthSignalDto::missing("No SPF policy was found for sender domain")
    };

    let dmarc = if authentication_result_is(&auth_results, "dmarc", "pass") {
        AuthSignalDto::pass("DMARC pass from message authentication headers")
    } else if authentication_result_is(&auth_results, "dmarc", "fail") {
        AuthSignalDto::fail("DMARC fail from message authentication headers")
    } else if has_dmarc_policy(domain) {
        AuthSignalDto::published("DMARC policy is published for sender domain")
    } else {
        AuthSignalDto::missing("No DMARC policy was found for sender domain")
    };

    let dkim = if authentication_result_is(&auth_results, "dkim", "pass") {
        AuthSignalDto::pass("DKIM pass from message authentication headers")
    } else if authentication_result_is(&auth_results, "dkim", "fail") {
        AuthSignalDto::fail("DKIM fail from message authentication headers")
    } else if !dkim_header.trim().is_empty() {
        AuthSignalDto::published(
            "DKIM-Signature header is present; cryptographic verification is pending",
        )
    } else {
        AuthSignalDto::unknown("No DKIM result or signature header was available")
    };

    let mut bimi = AuthSignalDto::missing("No BIMI record was found for sender domain");
    let mut certificate = AuthSignalDto::missing("No BIMI certificate URL was found");
    if let Ok((record, bimi_domain)) = find_bimi_record(domain) {
        bimi = AuthSignalDto::published(format!("BIMI record is published at {bimi_domain}"));
        certificate = record
            .certificate_url
            .as_deref()
            .map(verify_bimi_certificate)
            .unwrap_or_else(|| AuthSignalDto::missing("BIMI record has no certificate URL"));
    }

    SenderAuthDto {
        spf,
        dkim,
        dmarc,
        bimi,
        certificate,
    }
}

pub(super) fn authentication_result_is(value: &str, method: &str, expected: &str) -> bool {
    value
        .split(|character: char| character.is_ascii_whitespace() || character == ';')
        .filter_map(|token| token.split_once('='))
        .any(|(name, result)| name == method && result == expected)
}

pub(super) fn received_spf_result_is(value: &str, expected: &str) -> bool {
    value
        .split_ascii_whitespace()
        .next()
        .is_some_and(|result| result.trim_matches([';', ':']) == expected)
}

pub(super) fn verify_bimi_certificate(url: &str) -> AuthSignalDto {
    if !is_safe_https_url(url) {
        return AuthSignalDto::fail("BIMI certificate URL is not a safe HTTPS URL");
    }
    match download_limited(url, 256 * 1024) {
        Ok((mime, bytes)) if !bytes.is_empty() => AuthSignalDto::published(format!(
            "BIMI certificate evidence fetched with TLS ({mime}, {} bytes)",
            bytes.len()
        )),
        Ok(_) => AuthSignalDto::fail("BIMI certificate evidence was empty"),
        Err(error) => {
            AuthSignalDto::fail(format!("BIMI certificate evidence fetch failed: {error}"))
        }
    }
}

pub(super) fn provider_avatar_urls(identity: &SenderIdentity) -> Vec<String> {
    let mut urls = Vec::new();
    urls.extend(
        provider_official_avatar_urls(identity)
            .iter()
            .map(|url| (*url).to_string()),
    );

    for domain in domain_candidates(&identity.domain) {
        urls.push(format!("https://{domain}/favicon.ico"));
        urls.push(format!("https://{domain}/apple-touch-icon.png"));
    }

    let mut seen = HashSet::new();
    urls.into_iter()
        .filter(|url| seen.insert(url.clone()))
        .collect()
}

pub(super) fn provider_official_avatar_urls(identity: &SenderIdentity) -> &'static [&'static str] {
    match identity.builtin_kind.as_deref() {
        Some("qq-mail") => QQ_MAIL_OFFICIAL_ICON_URLS,
        Some("openai") => OPENAI_OFFICIAL_ICON_URLS,
        Some("github") => GITHUB_OFFICIAL_ICON_URLS,
        Some("google") => GOOGLE_MAIL_OFFICIAL_ICON_URLS,
        Some("railway-12306") => RAILWAY_12306_OFFICIAL_ICON_URLS,
        _ if identity.domain == "qq.com" => QQ_MAIL_OFFICIAL_ICON_URLS,
        _ => &[],
    }
}

pub(super) fn provider_has_official_icon(identity: &SenderIdentity) -> bool {
    !provider_official_avatar_urls(identity).is_empty()
}

pub(super) fn provider_official_icon_url(identity: &SenderIdentity, url: &str) -> bool {
    provider_official_avatar_urls(identity).contains(&url)
}

pub(super) fn find_bimi_record(domain: &str) -> Result<(BimiRecord, String), String> {
    for candidate in domain_candidates(domain) {
        let name = format!("default._bimi.{candidate}");
        let txt_records = doh_txt_lookup(&name)?;
        for record in txt_records {
            if let Some(bimi) = parse_bimi_record(&record) {
                return Ok((bimi, name));
            }
        }
    }
    Err("no BIMI record found".to_string())
}

pub(super) fn has_spf_policy(domain: &str) -> bool {
    domain_candidates(domain).into_iter().any(|candidate| {
        doh_txt_lookup(&candidate)
            .unwrap_or_default()
            .iter()
            .any(|record| record.trim().to_ascii_lowercase().starts_with("v=spf1"))
    })
}

pub(super) fn has_dmarc_policy(domain: &str) -> bool {
    domain_candidates(domain).into_iter().any(|candidate| {
        let name = format!("_dmarc.{candidate}");
        doh_txt_lookup(&name)
            .unwrap_or_default()
            .iter()
            .any(|record| record.trim().to_ascii_lowercase().starts_with("v=dmarc1"))
    })
}

pub(super) fn doh_txt_lookup(name: &str) -> Result<Vec<String>, String> {
    let url = format!("https://cloudflare-dns.com/dns-query?name={name}&type=TXT");
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(2))
        .build();
    let response = agent
        .get(&url)
        .set("accept", "application/dns-json")
        .call()
        .map_err(|error| format!("DNS TXT lookup failed: {error}"))?;
    let value: Value = response
        .into_json()
        .map_err(|error| format!("DNS TXT response parse failed: {error}"))?;
    let records = value
        .get("Answer")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|answer| answer.get("data").and_then(Value::as_str))
        .map(normalize_dns_txt_record)
        .collect::<Vec<_>>();
    Ok(records)
}

pub(super) fn parse_bimi_record(record: &str) -> Option<BimiRecord> {
    let mut logo_url = None;
    let mut certificate_url = None;
    let mut has_bimi_version = false;
    for part in record.split(';') {
        let trimmed = part.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Some((key, value)) = trimmed.split_once('=') else {
            continue;
        };
        match key.trim().to_ascii_lowercase().as_str() {
            "v" => has_bimi_version = value.trim().eq_ignore_ascii_case("BIMI1"),
            "l" => {
                let value = value.trim();
                if !value.is_empty() {
                    logo_url = Some(value.to_string());
                }
            }
            "a" => {
                let value = value.trim();
                if !value.is_empty() {
                    certificate_url = Some(value.to_string());
                }
            }
            _ => {}
        }
    }
    has_bimi_version.then_some(BimiRecord {
        logo_url,
        certificate_url,
        raw: record.to_string(),
    })
}
