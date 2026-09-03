use super::authentication::*;
use super::network::*;
use super::storage::*;
use super::*;

/// Resolves sender avatars while holding the database lock for the whole call,
/// including any remote fetches.
///
/// Prefer [`resolve_sender_avatars_phased`] from command handlers: on a cold
/// cache this can spend tens of seconds in HTTP, and the caller's lock would be
/// held for all of it. This entry point remains for callers that already own an
/// exclusive connection and do not contend with other commands.
pub fn resolve_sender_avatars(
    connection: &Connection,
    senders: Vec<String>,
) -> Result<Vec<SenderAvatarDto>, AppError> {
    let plan = plan_sender_avatar_resolution(connection, senders)?;
    let fetched = fetch_pending_avatars(&plan);
    persist_fetched_avatars(connection, plan, fetched)
}

/// Phase 1: everything that needs the database, and nothing that needs the
/// network. The returned plan borrows no connection, so the caller can drop its
/// lock before calling [`fetch_pending_avatars`].
pub fn plan_sender_avatar_resolution(
    connection: &Connection,
    senders: Vec<String>,
) -> Result<AvatarResolutionPlan, AppError> {
    let settings = load_avatar_settings(connection)?;
    let mut seen = HashSet::new();
    let mut resolved_by_sender = HashMap::new();
    let mut pending = Vec::new();

    for sender in senders
        .into_iter()
        .filter(|sender| !sender.trim().is_empty())
        .take(MAX_UNIQUE_SENDERS_PER_REQUEST * 3)
    {
        let identity = normalize_sender_identity(&sender);
        if !seen.insert(identity.cache_key.clone()) {
            continue;
        }
        if seen.len() > MAX_UNIQUE_SENDERS_PER_REQUEST {
            break;
        }

        if let Some(contact) = load_contact_avatar(connection, &identity)? {
            resolved_by_sender.insert(sender, contact);
            continue;
        }

        let now = now_rfc3339();
        if let Some(cached) = load_cached_avatar(connection, &identity.cache_key)? {
            if !is_expired(&cached.expires_at, &now)
                && cached_avatar_satisfies_provider_policy(&identity, &cached, &settings)
            {
                resolved_by_sender.insert(sender, cached_avatar_to_dto(&identity, cached));
                continue;
            }
        }

        if !settings.remote_enabled {
            resolved_by_sender.insert(sender, fallback_avatar(&identity, "builtin"));
            continue;
        }

        let message_auth_headers = load_latest_message_auth_headers(connection, &identity)?;
        pending.push(PendingAvatarFetch {
            sender,
            identity,
            message_auth_headers,
        });
    }

    Ok(AvatarResolutionPlan {
        settings,
        resolved: resolved_by_sender.into_values().collect(),
        pending,
    })
}

/// Phase 2: the network work. Takes no connection so it cannot hold the lock.
pub fn fetch_pending_avatars(plan: &AvatarResolutionPlan) -> Vec<FetchedAvatar> {
    plan.pending
        .iter()
        .map(|entry| {
            let outcome = fetch_remote_avatar(
                &entry.identity,
                &plan.settings,
                entry.message_auth_headers.as_ref(),
            );
            // Sender auth is only reported on the failure path, and resolving it
            // also performs DNS-over-HTTPS lookups, so it belongs out here.
            let auth = match (&outcome, plan.settings.auth_enabled) {
                (Err(_), true) => resolve_sender_auth(
                    &entry.identity.domain,
                    entry
                        .message_auth_headers
                        .as_ref()
                        .and_then(|headers| headers.authentication_results.as_deref()),
                    entry
                        .message_auth_headers
                        .as_ref()
                        .and_then(|headers| headers.received_spf.as_deref()),
                    entry
                        .message_auth_headers
                        .as_ref()
                        .and_then(|headers| headers.dkim_signature.as_deref()),
                ),
                _ => SenderAuthDto::default(),
            };
            FetchedAvatar {
                sender: entry.sender.clone(),
                identity: entry.identity.clone(),
                outcome,
                auth,
            }
        })
        .collect()
}

/// Phase 3: persist the fetch results and assemble the final list.
pub fn persist_fetched_avatars(
    connection: &Connection,
    plan: AvatarResolutionPlan,
    fetched: Vec<FetchedAvatar>,
) -> Result<Vec<SenderAvatarDto>, AppError> {
    let mut resolved_by_sender: HashMap<String, SenderAvatarDto> = HashMap::new();
    for avatar in plan.resolved {
        resolved_by_sender.insert(avatar.sender.clone(), avatar);
    }

    for entry in fetched {
        let avatar = match entry.outcome {
            Ok(remote) => {
                save_cached_avatar(connection, &entry.identity, &remote, None)?;
                remote_avatar_to_dto(&entry.identity, remote)
            }
            Err(error) => {
                save_failed_cache(connection, &entry.identity, &entry.auth, &error)?;
                let mut fallback = fallback_avatar(&entry.identity, "failed");
                fallback.auth = entry.auth;
                fallback
            }
        };
        resolved_by_sender.insert(entry.sender, avatar);
    }

    Ok(resolved_by_sender.into_values().collect())
}

pub(super) fn cached_avatar_to_dto(
    identity: &SenderIdentity,
    cached: CachedAvatar,
) -> SenderAvatarDto {
    SenderAvatarDto {
        sender: identity.raw.clone(),
        cache_key: identity.cache_key.clone(),
        domain: identity.domain.clone(),
        display_name: identity.display_name.clone(),
        source_kind: cached.source_kind.clone(),
        image_data_url: cached
            .image_mime
            .zip(cached.image_bytes)
            .map(|(mime, bytes)| data_url(&mime, &bytes)),
        builtin_kind: identity.builtin_kind.clone(),
        fallback_text: cached.fallback_text,
        remote_url: cached.remote_url,
        auth: cached.auth,
        fetched_at: Some(cached.fetched_at),
        expires_at: Some(cached.expires_at),
    }
}

pub(super) fn remote_avatar_to_dto(
    identity: &SenderIdentity,
    remote: RemoteAvatar,
) -> SenderAvatarDto {
    SenderAvatarDto {
        sender: identity.raw.clone(),
        cache_key: identity.cache_key.clone(),
        domain: identity.domain.clone(),
        display_name: identity.display_name.clone(),
        source_kind: remote.source_kind,
        image_data_url: Some(data_url(&remote.image_mime, &remote.image_bytes)),
        builtin_kind: identity.builtin_kind.clone(),
        fallback_text: identity.fallback_text.clone(),
        remote_url: Some(remote.remote_url),
        auth: remote.auth,
        fetched_at: Some(now_rfc3339()),
        expires_at: Some((Utc::now() + chrono::Duration::days(SUCCESS_TTL_DAYS)).to_rfc3339()),
    }
}

pub(super) fn fallback_avatar(identity: &SenderIdentity, source_kind: &str) -> SenderAvatarDto {
    SenderAvatarDto {
        sender: identity.raw.clone(),
        cache_key: identity.cache_key.clone(),
        domain: identity.domain.clone(),
        display_name: identity.display_name.clone(),
        source_kind: source_kind.to_string(),
        image_data_url: None,
        builtin_kind: identity.builtin_kind.clone(),
        fallback_text: identity.fallback_text.clone(),
        remote_url: None,
        auth: SenderAuthDto::default(),
        fetched_at: None,
        expires_at: None,
    }
}

pub(super) fn normalize_sender_identity(sender: &str) -> SenderIdentity {
    let raw = sender.trim().to_string();
    let display_name = display_name_from_address(&raw);
    let normalized_sender = extract_email_address(&raw).to_ascii_lowercase();
    let domain = normalized_sender
        .split('@')
        .nth(1)
        .unwrap_or("")
        .trim()
        .trim_matches('>')
        .to_ascii_lowercase();
    let fallback_text = fallback_text(&display_name, &normalized_sender, &domain);
    let builtin_kind = builtin_kind(&display_name, &normalized_sender, &domain);
    let cache_key = if !normalized_sender.is_empty() && normalized_sender.contains('@') {
        format!("sender:{normalized_sender}")
    } else {
        format!("domain:{domain}")
    };
    SenderIdentity {
        raw,
        normalized_sender,
        display_name,
        domain,
        cache_key,
        fallback_text,
        builtin_kind,
    }
}

pub(super) fn extract_email_address(value: &str) -> String {
    let trimmed = value.trim();
    if let Some((_, rest)) = trimmed.split_once('<') {
        return rest.split('>').next().unwrap_or(rest).trim().to_string();
    }
    trimmed.to_string()
}

pub(super) fn display_name_from_address(value: &str) -> String {
    let trimmed = value.trim();
    if let Some((name, _)) = trimmed.split_once('<') {
        let name = name.trim().trim_matches('"').trim();
        if !name.is_empty() {
            return name.to_string();
        }
    }
    extract_email_address(trimmed)
        .split('@')
        .next()
        .unwrap_or("Unknown sender")
        .to_string()
}

pub(super) fn fallback_text(display_name: &str, email: &str, domain: &str) -> String {
    let token = display_name
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .take(4)
        .collect::<String>();
    if !token.is_empty() {
        return token.to_ascii_uppercase();
    }
    domain
        .split('.')
        .next()
        .or_else(|| email.split('@').next())
        .unwrap_or("MAIL")
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .take(4)
        .collect::<String>()
        .to_ascii_uppercase()
}

pub(super) fn builtin_kind(display_name: &str, email: &str, domain: &str) -> Option<String> {
    let display_name = display_name.to_ascii_lowercase();
    if domain == "qq.com" || email == "10000@qq.com" || display_name.contains("qq邮箱") {
        Some("qq-mail".to_string())
    } else if domain == "openai.com"
        || domain.ends_with(".openai.com")
        || display_name.contains("openai")
        || display_name.contains("chatgpt")
    {
        Some("openai".to_string())
    } else if email.starts_with("12306@")
        || domain == "rails.com.cn"
        || display_name.contains("12306")
    {
        Some("railway-12306".to_string())
    } else if domain.contains("github") || display_name.contains("github") {
        Some("github".to_string())
    } else if domain.contains("google")
        || domain.contains("gmail")
        || display_name.contains("google")
    {
        Some("google".to_string())
    } else {
        None
    }
}

pub(super) fn domain_candidates(domain: &str) -> Vec<String> {
    let domain = domain.trim().trim_end_matches('.').to_ascii_lowercase();
    if domain.is_empty() {
        return Vec::new();
    }
    let mut candidates = vec![domain.clone()];
    let parts = domain.split('.').collect::<Vec<_>>();
    if parts.len() > 2 {
        let registered = if parts.len() > 3
            && matches!(
                parts[parts.len() - 2..].join(".").as_str(),
                "com.cn" | "net.cn" | "org.cn" | "gov.cn"
            ) {
            parts[parts.len() - 3..].join(".")
        } else {
            parts[parts.len() - 2..].join(".")
        };
        if registered != domain {
            candidates.push(registered);
        }
    }
    candidates
}
