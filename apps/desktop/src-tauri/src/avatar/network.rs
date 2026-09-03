use super::authentication::*;
use super::*;

pub(super) fn fetch_remote_avatar(
    identity: &SenderIdentity,
    settings: &AvatarSettingsDto,
    message_auth_headers: Option<&MessageAuthHeaders>,
) -> Result<RemoteAvatar, String> {
    if !is_public_dns_name(&identity.domain) {
        return Err("sender domain is not eligible for remote avatar fetch".to_string());
    }

    let auth = if settings.auth_enabled {
        resolve_sender_auth(
            &identity.domain,
            message_auth_headers.and_then(|headers| headers.authentication_results.as_deref()),
            message_auth_headers.and_then(|headers| headers.received_spf.as_deref()),
            message_auth_headers.and_then(|headers| headers.dkim_signature.as_deref()),
        )
    } else {
        SenderAuthDto::default()
    };

    if settings.bimi_enabled {
        if let Ok((record, logo_domain)) = find_bimi_record(&identity.domain) {
            if let Some(logo_url) = record.logo_url.as_deref() {
                if is_safe_https_url(logo_url) {
                    if let Ok((mime, bytes)) = download_image(logo_url, MAX_BIMI_BYTES) {
                        let mut auth = auth.clone();
                        auth.bimi =
                            AuthSignalDto::pass(format!("BIMI record found at {logo_domain}"));
                        auth.certificate = record
                            .certificate_url
                            .as_deref()
                            .map(verify_bimi_certificate)
                            .unwrap_or_else(|| {
                                AuthSignalDto::missing("BIMI record has no certificate URL")
                            });
                        return Ok(RemoteAvatar {
                            source_kind: "bimi".to_string(),
                            image_mime: mime,
                            image_bytes: bytes,
                            remote_url: logo_url.to_string(),
                            auth,
                        });
                    }
                }
            }
        }
    }

    if settings.favicon_enabled {
        for url in provider_avatar_urls(identity) {
            if let Ok((mime, bytes)) = download_image(&url, MAX_FAVICON_BYTES) {
                let source_kind = if provider_official_icon_url(identity, &url) {
                    "official-icon"
                } else {
                    "favicon"
                };
                return Ok(RemoteAvatar {
                    source_kind: source_kind.to_string(),
                    image_mime: mime,
                    image_bytes: bytes,
                    remote_url: url,
                    auth: auth.clone(),
                });
            }
        }
    }

    Err("no BIMI or favicon avatar was available".to_string())
}

pub(super) fn download_image(url: &str, max_bytes: u64) -> Result<(String, Vec<u8>), String> {
    let (mime, bytes) = download_limited(url, max_bytes)?;
    let normalized_mime = normalize_image_mime(&mime, url)?;
    Ok((normalized_mime, bytes))
}

pub(super) fn download_limited(url: &str, max_bytes: u64) -> Result<(String, Vec<u8>), String> {
    if !is_safe_https_url(url) {
        return Err("URL is not safe HTTPS".to_string());
    }
    let mut current_url = url.to_string();
    let mut redirect_count = 0;
    loop {
        let (expected_netloc, resolved_addresses) = resolve_public_https_target(&current_url)?;
        let agent = ureq::AgentBuilder::new()
            .timeout(Duration::from_secs(3))
            .redirects(0)
            .try_proxy_from_env(false)
            .resolver(move |requested_netloc: &str| {
                if requested_netloc == expected_netloc {
                    Ok(resolved_addresses.clone())
                } else {
                    Err(io::Error::new(
                        io::ErrorKind::PermissionDenied,
                        "resolver target changed after validation",
                    ))
                }
            })
            .build();
        let response = agent
            .get(&current_url)
            .set("user-agent", "EasyEmailAM/0.1 sender-avatar-fetcher")
            .call()
            .map_err(|error| format!("download failed: {error}"))?;

        if (300..400).contains(&response.status()) {
            if redirect_count >= MAX_AVATAR_REDIRECTS {
                return Err("download exceeded safe redirect limit".to_string());
            }
            let location = response
                .header("location")
                .ok_or_else(|| "redirect response omitted Location".to_string())?;
            current_url = resolve_safe_redirect(&current_url, location)?;
            redirect_count += 1;
            continue;
        }

        let mime = response
            .header("content-type")
            .unwrap_or("application/octet-stream")
            .split(';')
            .next()
            .unwrap_or("application/octet-stream")
            .trim()
            .to_ascii_lowercase();
        let mut reader = response.into_reader().take(max_bytes + 1);
        let mut bytes = Vec::new();
        reader
            .read_to_end(&mut bytes)
            .map_err(|error| format!("download read failed: {error}"))?;
        if bytes.len() as u64 > max_bytes {
            return Err("download exceeded maximum size".to_string());
        }
        return Ok((mime, bytes));
    }
}

pub(super) fn parse_image_data_url(
    value: &str,
    max_bytes: usize,
) -> Result<(String, Vec<u8>), AppError> {
    let (meta, payload) = value.split_once(',').ok_or_else(|| {
        validation_error(
            "avatar_data_url_invalid",
            "Avatar image must be a data URL.",
        )
    })?;
    if !meta.starts_with("data:") || !meta.ends_with(";base64") {
        return Err(validation_error(
            "avatar_data_url_invalid",
            "Avatar image must be a base64 data URL.",
        ));
    }
    let mime = meta
        .trim_start_matches("data:")
        .trim_end_matches(";base64")
        .to_ascii_lowercase();
    let mime = normalize_image_mime(&mime, "")
        .map_err(|message| validation_error("avatar_mime_unsupported", message))?;
    let max_payload_len = max_bytes
        .checked_add(2)
        .and_then(|value| value.checked_div(3))
        .and_then(|value| value.checked_mul(4))
        .unwrap_or(usize::MAX);
    if payload.len() > max_payload_len {
        return Err(validation_error(
            "avatar_image_too_large",
            "Avatar image is larger than the supported size.",
        ));
    }
    let bytes = general_purpose::STANDARD.decode(payload).map_err(|_| {
        validation_error(
            "avatar_data_url_invalid",
            "Avatar image data is not valid base64.",
        )
    })?;
    if bytes.len() > max_bytes {
        return Err(validation_error(
            "avatar_image_too_large",
            "Avatar image is larger than the supported size.",
        ));
    }
    Ok((mime, bytes))
}

pub(super) fn normalize_image_mime(mime: &str, url: &str) -> Result<String, String> {
    let mime = match mime {
        "image/svg" | "image/svg+xml" => "image/svg+xml",
        "image/png" => "image/png",
        "image/jpeg" | "image/jpg" => "image/jpeg",
        "image/x-icon" | "image/vnd.microsoft.icon" => "image/x-icon",
        "application/octet-stream" if url.ends_with(".ico") => "image/x-icon",
        "application/octet-stream" if url.ends_with(".png") => "image/png",
        _ => return Err(format!("unsupported image MIME type: {mime}")),
    };
    Ok(mime.to_string())
}

pub(super) fn data_url(mime: &str, bytes: &[u8]) -> String {
    format!(
        "data:{mime};base64,{}",
        general_purpose::STANDARD.encode(bytes)
    )
}

pub(super) fn is_public_dns_name(domain: &str) -> bool {
    if domain.is_empty()
        || domain.len() > 253
        || domain.eq_ignore_ascii_case("localhost")
        || domain.ends_with(".localhost")
        || domain.ends_with(".local")
        || domain.ends_with(".internal")
        || domain.ends_with(".home.arpa")
        || domain.parse::<IpAddr>().is_ok()
    {
        return false;
    }

    domain.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '-')
    })
}

pub(super) fn is_safe_https_url(url: &str) -> bool {
    let Ok(url) = Url::parse(url) else {
        return false;
    };
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return false;
    }

    matches!(url.host(), Some(Host::Domain(host)) if is_public_dns_name(host))
}

pub(super) fn resolve_public_https_target(url: &str) -> Result<(String, Vec<SocketAddr>), String> {
    let parsed = Url::parse(url).map_err(|error| format!("invalid HTTPS URL: {error}"))?;
    if !is_safe_https_url(parsed.as_str()) {
        return Err("URL is not safe HTTPS".to_string());
    }
    let host = match parsed.host() {
        Some(Host::Domain(host)) => host,
        _ => return Err("URL host must be a public DNS name".to_string()),
    };
    let port = parsed
        .port_or_known_default()
        .ok_or_else(|| "HTTPS URL has no usable port".to_string())?;
    let addresses = (host, port)
        .to_socket_addrs()
        .map_err(|error| format!("avatar host DNS lookup failed: {error}"))?
        .collect::<Vec<_>>();
    if addresses.is_empty() {
        return Err("avatar host DNS lookup returned no addresses".to_string());
    }
    if addresses.iter().any(|address| !is_public_ip(address.ip())) {
        return Err("avatar host resolved to a non-public address".to_string());
    }

    Ok((format!("{host}:{port}"), addresses))
}

pub(super) fn is_public_ip(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => is_public_ipv4(address),
        IpAddr::V6(address) => {
            if let Some(mapped) = address.to_ipv4_mapped() {
                return is_public_ipv4(mapped);
            }
            let segments = address.segments();
            (0x2000..=0x3fff).contains(&segments[0])
                && !(segments[0] == 0x2001 && segments[1] == 0x0db8)
                && !(segments[0] == 0x2001 && segments[1] == 0x0000)
                && !(segments[0] == 0x2001 && (segments[1] & 0xfff0) == 0x0010)
                && !(segments[0] == 0x2001 && (segments[1] & 0xfff0) == 0x0020)
        }
    }
}

pub(super) fn is_public_ipv4(address: Ipv4Addr) -> bool {
    let [first, second, _, _] = address.octets();
    !address.is_private()
        && !address.is_loopback()
        && !address.is_link_local()
        && !address.is_broadcast()
        && !address.is_documentation()
        && !address.is_unspecified()
        && !address.is_multicast()
        && first != 0
        && !(first == 100 && (64..=127).contains(&second))
        && !(first == 192 && second == 0)
        && !(first == 192 && second == 88)
        && !(first == 198 && (18..=19).contains(&second))
        && first < 240
}

pub(super) fn resolve_safe_redirect(current_url: &str, location: &str) -> Result<String, String> {
    let base =
        Url::parse(current_url).map_err(|error| format!("invalid redirect base: {error}"))?;
    let redirected = base
        .join(location)
        .map_err(|error| format!("invalid redirect location: {error}"))?;
    if !is_safe_https_url(redirected.as_str()) {
        return Err("redirect target is not safe HTTPS".to_string());
    }
    Ok(redirected.to_string())
}

pub(super) fn normalize_dns_txt_record(value: &str) -> String {
    value
        .split("\" \"")
        .collect::<Vec<_>>()
        .join("")
        .trim()
        .trim_matches('"')
        .replace("\\\"", "\"")
}
