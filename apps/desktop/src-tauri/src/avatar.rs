use std::collections::{HashMap, HashSet};
use std::io::{self, Read};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, ToSocketAddrs};
use std::time::Duration;

use base64::{engine::general_purpose, Engine as _};
use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use url::{Host, Url};

use crate::error::{ActionRequired, AppError, ErrorCategory};
use crate::time::now_rfc3339;

const AVATAR_SETTINGS_KEY: &str = "sender_avatar.settings";
const SUCCESS_TTL_DAYS: i64 = 14;
const FAILURE_TTL_HOURS: i64 = 24;
const MAX_BIMI_BYTES: u64 = 128 * 1024;
const MAX_FAVICON_BYTES: u64 = 256 * 1024;
const MAX_CONTACT_BYTES: usize = 512 * 1024;
const MAX_UNIQUE_SENDERS_PER_REQUEST: usize = 16;
const MAX_AVATAR_REDIRECTS: usize = 3;

const QQ_MAIL_OFFICIAL_ICON_URLS: &[&str] = &[
    "https://res.wx.qq.com/t/webmail/webmail/res/static/images/base/style/favicon/qqmail_favicon_96h.8d124a7.png",
    "https://res.wx.qq.com/t/webmail/webmail/res/static/images/base/style/favicon/qqmail_favicon_48h.4e79647.png",
    "https://res.wx.qq.com/t/webmail/webmail/res/static/images/base/style/favicon/qqmail_favicon_32h.65f829f.png",
    "https://res.wx.qq.com/t/webmail/webmail/res/static/images/base/style/favicon/qqmail_favicon_16h.bc34dcb.png",
    "https://mail.qq.com/favicon.ico",
];
const OPENAI_OFFICIAL_ICON_URLS: &[&str] = &[
    "https://images.ctfassets.net/kftzwdyauwt9/3hUGLn3ypllZ0oa01qOYVq/28e8188e6f11b84c3e876569d492734f/Blossom_Light.svg?q=90&w=3840",
    "https://images.ctfassets.net/kftzwdyauwt9/2fkAIT3PbTRytKTBx9cx8o/229bc28cb338565fe735d8935abc801f/OpenAI_Wordmark_Gif.gif?fm=png&q=90&w=512",
];
const GITHUB_OFFICIAL_ICON_URLS: &[&str] = &[
    "https://github.githubassets.com/favicons/favicon.svg",
    "https://github.githubassets.com/favicons/favicon.png",
    "https://github.com/fluidicon.png",
];
const GOOGLE_MAIL_OFFICIAL_ICON_URLS: &[&str] =
    &["https://ssl.gstatic.com/ui/v1/icons/mail/rfr/gmail.ico"];
const RAILWAY_12306_OFFICIAL_ICON_URLS: &[&str] =
    &["https://www.12306.cn/index/images/favicon.ico"];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AvatarSettingsDto {
    pub remote_enabled: bool,
    pub bimi_enabled: bool,
    pub favicon_enabled: bool,
    pub auth_enabled: bool,
}

impl Default for AvatarSettingsDto {
    fn default() -> Self {
        Self {
            remote_enabled: true,
            bimi_enabled: true,
            favicon_enabled: true,
            auth_enabled: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SenderAvatarDto {
    pub sender: String,
    pub cache_key: String,
    pub domain: String,
    pub display_name: String,
    pub source_kind: String,
    pub image_data_url: Option<String>,
    pub builtin_kind: Option<String>,
    pub fallback_text: String,
    pub remote_url: Option<String>,
    pub auth: SenderAuthDto,
    pub fetched_at: Option<String>,
    pub expires_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SenderAuthDto {
    pub spf: AuthSignalDto,
    pub dkim: AuthSignalDto,
    pub dmarc: AuthSignalDto,
    pub bimi: AuthSignalDto,
    pub certificate: AuthSignalDto,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AuthSignalDto {
    pub status: String,
    pub detail: String,
}

impl Default for SenderAuthDto {
    fn default() -> Self {
        Self {
            spf: AuthSignalDto::unknown("SPF not checked"),
            dkim: AuthSignalDto::unknown("DKIM requires Authentication-Results or DKIM headers"),
            dmarc: AuthSignalDto::unknown("DMARC not checked"),
            bimi: AuthSignalDto::unknown("BIMI not checked"),
            certificate: AuthSignalDto::unknown("BIMI certificate not checked"),
        }
    }
}

impl AuthSignalDto {
    fn pass(detail: impl Into<String>) -> Self {
        Self {
            status: "pass".to_string(),
            detail: detail.into(),
        }
    }

    fn fail(detail: impl Into<String>) -> Self {
        Self {
            status: "fail".to_string(),
            detail: detail.into(),
        }
    }

    fn published(detail: impl Into<String>) -> Self {
        Self {
            status: "published".to_string(),
            detail: detail.into(),
        }
    }

    fn missing(detail: impl Into<String>) -> Self {
        Self {
            status: "missing".to_string(),
            detail: detail.into(),
        }
    }

    fn unknown(detail: impl Into<String>) -> Self {
        Self {
            status: "unknown".to_string(),
            detail: detail.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SenderIdentity {
    raw: String,
    normalized_sender: String,
    display_name: String,
    domain: String,
    cache_key: String,
    fallback_text: String,
    builtin_kind: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct BimiRecord {
    logo_url: Option<String>,
    certificate_url: Option<String>,
    raw: String,
}

#[derive(Debug, Clone)]
struct RemoteAvatar {
    source_kind: String,
    image_mime: String,
    image_bytes: Vec<u8>,
    remote_url: String,
    auth: SenderAuthDto,
}

#[derive(Debug, Clone, Default)]
struct MessageAuthHeaders {
    authentication_results: Option<String>,
    received_spf: Option<String>,
    dkim_signature: Option<String>,
}

#[derive(Debug, Clone)]
struct CachedAvatar {
    source_kind: String,
    image_mime: Option<String>,
    image_bytes: Option<Vec<u8>>,
    remote_url: Option<String>,
    fallback_text: String,
    auth: SenderAuthDto,
    fetched_at: String,
    expires_at: String,
}

pub fn load_avatar_settings(connection: &Connection) -> Result<AvatarSettingsDto, AppError> {
    let value_json: Option<String> = connection
        .query_row(
            "SELECT value_json FROM app_settings WHERE key = ?1",
            params![AVATAR_SETTINGS_KEY],
            |row| row.get(0),
        )
        .optional()
        .map_err(storage_error)?;

    Ok(value_json
        .and_then(|value| serde_json::from_str::<AvatarSettingsDto>(&value).ok())
        .unwrap_or_default())
}

pub fn save_avatar_settings(
    connection: &Connection,
    settings: AvatarSettingsDto,
) -> Result<AvatarSettingsDto, AppError> {
    let now = now_rfc3339();
    let value_json = serde_json::to_string(&settings).expect("serialize avatar settings");
    connection
        .execute(
            "INSERT INTO app_settings (key, value_json, updated_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET
               value_json = excluded.value_json,
               updated_at = excluded.updated_at",
            params![AVATAR_SETTINGS_KEY, value_json, now],
        )
        .map_err(storage_error)?;
    Ok(settings)
}

pub fn clear_avatar_cache(
    connection: &Connection,
    include_contacts: bool,
) -> Result<usize, AppError> {
    let mut deleted = connection
        .execute("DELETE FROM sender_avatar_cache", [])
        .map_err(storage_error)?;
    if include_contacts {
        deleted += connection
            .execute("DELETE FROM contact_avatar_overrides", [])
            .map_err(storage_error)?;
    }
    Ok(deleted)
}

pub fn set_contact_avatar(
    connection: &Connection,
    sender: &str,
    image_data_url: &str,
) -> Result<SenderAvatarDto, AppError> {
    let identity = normalize_sender_identity(sender);
    let (mime, bytes) = parse_image_data_url(image_data_url, MAX_CONTACT_BYTES)?;
    let now = now_rfc3339();
    connection
        .execute(
            "INSERT INTO contact_avatar_overrides (
               sender_key, normalized_sender, sender_domain, image_mime, image_bytes, display_name,
               created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
             ON CONFLICT(sender_key) DO UPDATE SET
               normalized_sender = excluded.normalized_sender,
               sender_domain = excluded.sender_domain,
               image_mime = excluded.image_mime,
               image_bytes = excluded.image_bytes,
               display_name = excluded.display_name,
               updated_at = excluded.updated_at",
            params![
                identity.cache_key,
                identity.normalized_sender,
                identity.domain,
                mime,
                bytes,
                identity.display_name,
                now,
            ],
        )
        .map_err(storage_error)?;

    Ok(SenderAvatarDto {
        sender: sender.to_string(),
        cache_key: identity.cache_key,
        domain: identity.domain,
        display_name: identity.display_name,
        source_kind: "contact".to_string(),
        image_data_url: Some(data_url(&mime, &bytes)),
        builtin_kind: identity.builtin_kind,
        fallback_text: identity.fallback_text,
        remote_url: None,
        auth: SenderAuthDto::default(),
        fetched_at: Some(now.clone()),
        expires_at: None,
    })
}

pub fn clear_contact_avatar(connection: &Connection, sender: &str) -> Result<bool, AppError> {
    let identity = normalize_sender_identity(sender);
    let deleted = connection
        .execute(
            "DELETE FROM contact_avatar_overrides WHERE sender_key = ?1",
            params![identity.cache_key],
        )
        .map_err(storage_error)?;
    Ok(deleted > 0)
}

/// A sender that needs a remote fetch, carried between the read and write
/// phases of [`resolve_sender_avatars_phased`].
pub struct PendingAvatarFetch {
    sender: String,
    identity: SenderIdentity,
    message_auth_headers: Option<MessageAuthHeaders>,
}

/// The outcome of a lock-free fetch, ready to be persisted.
pub struct FetchedAvatar {
    sender: String,
    identity: SenderIdentity,
    outcome: Result<RemoteAvatar, String>,
    auth: SenderAuthDto,
}

/// What the read phase resolved without touching the network, plus the work
/// still outstanding.
pub struct AvatarResolutionPlan {
    settings: AvatarSettingsDto,
    resolved: Vec<SenderAvatarDto>,
    pending: Vec<PendingAvatarFetch>,
}

impl AvatarResolutionPlan {
    pub fn has_pending(&self) -> bool {
        !self.pending.is_empty()
    }
}

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

fn load_contact_avatar(
    connection: &Connection,
    identity: &SenderIdentity,
) -> Result<Option<SenderAvatarDto>, AppError> {
    connection
        .query_row(
            "SELECT image_mime, image_bytes, updated_at
             FROM contact_avatar_overrides
             WHERE sender_key = ?1",
            params![identity.cache_key],
            |row| {
                let mime: String = row.get(0)?;
                let bytes: Vec<u8> = row.get(1)?;
                let updated_at: String = row.get(2)?;
                Ok(SenderAvatarDto {
                    sender: identity.raw.clone(),
                    cache_key: identity.cache_key.clone(),
                    domain: identity.domain.clone(),
                    display_name: identity.display_name.clone(),
                    source_kind: "contact".to_string(),
                    image_data_url: Some(data_url(&mime, &bytes)),
                    builtin_kind: identity.builtin_kind.clone(),
                    fallback_text: identity.fallback_text.clone(),
                    remote_url: None,
                    auth: SenderAuthDto::default(),
                    fetched_at: Some(updated_at),
                    expires_at: None,
                })
            },
        )
        .optional()
        .map_err(storage_error)
}

fn load_cached_avatar(
    connection: &Connection,
    cache_key: &str,
) -> Result<Option<CachedAvatar>, AppError> {
    connection
        .query_row(
            "SELECT source_kind, image_mime, image_bytes, remote_url, fallback_text, auth_json,
                    fetched_at, expires_at
             FROM sender_avatar_cache
             WHERE cache_key = ?1",
            params![cache_key],
            |row| {
                let auth_json: String = row.get(5)?;
                let auth = serde_json::from_str::<SenderAuthDto>(&auth_json).unwrap_or_default();
                Ok(CachedAvatar {
                    source_kind: row.get(0)?,
                    image_mime: row.get(1)?,
                    image_bytes: row.get(2)?,
                    remote_url: row.get(3)?,
                    fallback_text: row.get(4)?,
                    auth,
                    fetched_at: row.get(6)?,
                    expires_at: row.get(7)?,
                })
            },
        )
        .optional()
        .map_err(storage_error)
}

fn cached_avatar_satisfies_provider_policy(
    identity: &SenderIdentity,
    cached: &CachedAvatar,
    settings: &AvatarSettingsDto,
) -> bool {
    if !settings.remote_enabled
        || !settings.favicon_enabled
        || !provider_has_official_icon(identity)
    {
        return true;
    }

    cached.source_kind == "bimi"
        || cached
            .remote_url
            .as_deref()
            .is_some_and(|url| provider_official_icon_url(identity, url))
}

fn load_latest_message_auth_headers(
    connection: &Connection,
    identity: &SenderIdentity,
) -> Result<Option<MessageAuthHeaders>, AppError> {
    let pattern = if identity.normalized_sender.contains('@') {
        format!("%{}%", identity.normalized_sender)
    } else {
        format!("%{}%", identity.domain)
    };
    let security_flags: Option<String> = connection
        .query_row(
            "SELECT security_flags
             FROM messages
             WHERE lower(from_address) LIKE ?1
               AND deleted_at IS NULL
             ORDER BY COALESCE(date_received, updated_at, created_at) DESC
             LIMIT 1",
            params![pattern],
            |row| row.get(0),
        )
        .optional()
        .map_err(storage_error)?;

    let Some(security_flags) = security_flags else {
        return Ok(None);
    };
    let value = serde_json::from_str::<Value>(&security_flags).unwrap_or_else(|_| json!({}));
    Ok(Some(MessageAuthHeaders {
        authentication_results: value
            .get("authentication_results")
            .and_then(Value::as_str)
            .map(str::to_string),
        received_spf: value
            .get("received_spf")
            .and_then(Value::as_str)
            .map(str::to_string),
        dkim_signature: value
            .get("dkim_signature")
            .and_then(Value::as_str)
            .map(str::to_string),
    }))
}

fn save_cached_avatar(
    connection: &Connection,
    identity: &SenderIdentity,
    avatar: &RemoteAvatar,
    last_error: Option<&str>,
) -> Result<(), AppError> {
    let now = now_rfc3339();
    let expires_at = (Utc::now() + chrono::Duration::days(SUCCESS_TTL_DAYS)).to_rfc3339();
    let auth_json = serde_json::to_string(&avatar.auth).expect("serialize auth");
    connection
        .execute(
            "INSERT INTO sender_avatar_cache (
               cache_key, sender_domain, normalized_sender, source_kind, image_mime, image_bytes,
               remote_url, fallback_text, status, auth_json, last_error, fetched_at, expires_at,
               created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'ok', ?9, ?10, ?11, ?12, ?11, ?11)
             ON CONFLICT(cache_key) DO UPDATE SET
               sender_domain = excluded.sender_domain,
               normalized_sender = excluded.normalized_sender,
               source_kind = excluded.source_kind,
               image_mime = excluded.image_mime,
               image_bytes = excluded.image_bytes,
               remote_url = excluded.remote_url,
               fallback_text = excluded.fallback_text,
               status = excluded.status,
               auth_json = excluded.auth_json,
               last_error = excluded.last_error,
               fetched_at = excluded.fetched_at,
               expires_at = excluded.expires_at,
               updated_at = excluded.updated_at",
            params![
                identity.cache_key,
                identity.domain,
                identity.normalized_sender,
                avatar.source_kind,
                avatar.image_mime,
                avatar.image_bytes,
                avatar.remote_url,
                identity.fallback_text,
                auth_json,
                last_error,
                now,
                expires_at,
            ],
        )
        .map_err(storage_error)?;
    Ok(())
}

fn save_failed_cache(
    connection: &Connection,
    identity: &SenderIdentity,
    auth: &SenderAuthDto,
    last_error: &str,
) -> Result<(), AppError> {
    let now = now_rfc3339();
    let expires_at = (Utc::now() + chrono::Duration::hours(FAILURE_TTL_HOURS)).to_rfc3339();
    let auth_json = serde_json::to_string(auth).expect("serialize auth");
    connection
        .execute(
            "INSERT INTO sender_avatar_cache (
               cache_key, sender_domain, normalized_sender, source_kind, image_mime, image_bytes,
               remote_url, fallback_text, status, auth_json, last_error, fetched_at, expires_at,
               created_at, updated_at
             ) VALUES (?1, ?2, ?3, 'failed', NULL, NULL, NULL, ?4, 'failed', ?5, ?6, ?7, ?8, ?7, ?7)
             ON CONFLICT(cache_key) DO UPDATE SET
               source_kind = 'failed',
               image_mime = NULL,
               image_bytes = NULL,
               remote_url = NULL,
               fallback_text = excluded.fallback_text,
               status = 'failed',
               auth_json = excluded.auth_json,
               last_error = excluded.last_error,
               fetched_at = excluded.fetched_at,
               expires_at = excluded.expires_at,
               updated_at = excluded.updated_at",
            params![
                identity.cache_key,
                identity.domain,
                identity.normalized_sender,
                identity.fallback_text,
                auth_json,
                last_error,
                now,
                expires_at,
            ],
        )
        .map_err(storage_error)?;
    Ok(())
}

fn fetch_remote_avatar(
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

fn resolve_sender_auth(
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

fn authentication_result_is(value: &str, method: &str, expected: &str) -> bool {
    value
        .split(|character: char| character.is_ascii_whitespace() || character == ';')
        .filter_map(|token| token.split_once('='))
        .any(|(name, result)| name == method && result == expected)
}

fn received_spf_result_is(value: &str, expected: &str) -> bool {
    value
        .split_ascii_whitespace()
        .next()
        .is_some_and(|result| result.trim_matches([';', ':']) == expected)
}

fn verify_bimi_certificate(url: &str) -> AuthSignalDto {
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

fn provider_avatar_urls(identity: &SenderIdentity) -> Vec<String> {
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

fn provider_official_avatar_urls(identity: &SenderIdentity) -> &'static [&'static str] {
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

fn provider_has_official_icon(identity: &SenderIdentity) -> bool {
    !provider_official_avatar_urls(identity).is_empty()
}

fn provider_official_icon_url(identity: &SenderIdentity, url: &str) -> bool {
    provider_official_avatar_urls(identity).contains(&url)
}

fn find_bimi_record(domain: &str) -> Result<(BimiRecord, String), String> {
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

fn has_spf_policy(domain: &str) -> bool {
    domain_candidates(domain).into_iter().any(|candidate| {
        doh_txt_lookup(&candidate)
            .unwrap_or_default()
            .iter()
            .any(|record| record.trim().to_ascii_lowercase().starts_with("v=spf1"))
    })
}

fn has_dmarc_policy(domain: &str) -> bool {
    domain_candidates(domain).into_iter().any(|candidate| {
        let name = format!("_dmarc.{candidate}");
        doh_txt_lookup(&name)
            .unwrap_or_default()
            .iter()
            .any(|record| record.trim().to_ascii_lowercase().starts_with("v=dmarc1"))
    })
}

fn doh_txt_lookup(name: &str) -> Result<Vec<String>, String> {
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

fn parse_bimi_record(record: &str) -> Option<BimiRecord> {
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

fn download_image(url: &str, max_bytes: u64) -> Result<(String, Vec<u8>), String> {
    let (mime, bytes) = download_limited(url, max_bytes)?;
    let normalized_mime = normalize_image_mime(&mime, url)?;
    Ok((normalized_mime, bytes))
}

fn download_limited(url: &str, max_bytes: u64) -> Result<(String, Vec<u8>), String> {
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

fn parse_image_data_url(value: &str, max_bytes: usize) -> Result<(String, Vec<u8>), AppError> {
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

fn normalize_image_mime(mime: &str, url: &str) -> Result<String, String> {
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

fn data_url(mime: &str, bytes: &[u8]) -> String {
    format!(
        "data:{mime};base64,{}",
        general_purpose::STANDARD.encode(bytes)
    )
}

fn cached_avatar_to_dto(identity: &SenderIdentity, cached: CachedAvatar) -> SenderAvatarDto {
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

fn remote_avatar_to_dto(identity: &SenderIdentity, remote: RemoteAvatar) -> SenderAvatarDto {
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

fn fallback_avatar(identity: &SenderIdentity, source_kind: &str) -> SenderAvatarDto {
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

fn normalize_sender_identity(sender: &str) -> SenderIdentity {
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

fn extract_email_address(value: &str) -> String {
    let trimmed = value.trim();
    if let Some((_, rest)) = trimmed.split_once('<') {
        return rest.split('>').next().unwrap_or(rest).trim().to_string();
    }
    trimmed.to_string()
}

fn display_name_from_address(value: &str) -> String {
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

fn fallback_text(display_name: &str, email: &str, domain: &str) -> String {
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

fn builtin_kind(display_name: &str, email: &str, domain: &str) -> Option<String> {
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

fn domain_candidates(domain: &str) -> Vec<String> {
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

fn is_public_dns_name(domain: &str) -> bool {
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

fn is_safe_https_url(url: &str) -> bool {
    let Ok(url) = Url::parse(url) else {
        return false;
    };
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return false;
    }

    matches!(url.host(), Some(Host::Domain(host)) if is_public_dns_name(host))
}

fn resolve_public_https_target(url: &str) -> Result<(String, Vec<SocketAddr>), String> {
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

fn is_public_ip(address: IpAddr) -> bool {
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

fn is_public_ipv4(address: Ipv4Addr) -> bool {
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

fn resolve_safe_redirect(current_url: &str, location: &str) -> Result<String, String> {
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

fn normalize_dns_txt_record(value: &str) -> String {
    value
        .split("\" \"")
        .collect::<Vec<_>>()
        .join("")
        .trim()
        .trim_matches('"')
        .replace("\\\"", "\"")
}

fn is_expired(expires_at: &str, now: &str) -> bool {
    match (
        DateTime::parse_from_rfc3339(expires_at),
        DateTime::parse_from_rfc3339(now),
    ) {
        (Ok(expires), Ok(now)) => expires <= now,
        _ => true,
    }
}

fn storage_error(error: rusqlite::Error) -> AppError {
    AppError {
        code: "sender_avatar_storage_failed".to_string(),
        category: ErrorCategory::Storage,
        user_message: "Sender avatar data could not be read or saved.".to_string(),
        technical_message: Some(error.to_string()),
        retryable: false,
        action_required: ActionRequired::None,
        correlation_id: uuid::Uuid::new_v4().to_string(),
        metadata: Box::new(json!({})),
    }
}

fn validation_error(code: impl Into<String>, message: impl Into<String>) -> AppError {
    AppError {
        code: code.into(),
        category: ErrorCategory::Validation,
        user_message: message.into(),
        technical_message: None,
        retryable: false,
        action_required: ActionRequired::None,
        correlation_id: uuid::Uuid::new_v4().to_string(),
        metadata: Box::new(json!({})),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::db::open_in_memory_database;
    use crate::storage::migrations::run_migrations;

    #[test]
    fn authentication_results_require_exact_method_result_tokens() {
        let headers =
            "mx.example; spf=passfoo smtp.mailfrom=attacker.test; dkim=failish; dmarc=pass";

        assert!(!authentication_result_is(headers, "spf", "pass"));
        assert!(!authentication_result_is(headers, "dkim", "fail"));
        assert!(authentication_result_is(headers, "dmarc", "pass"));
        assert!(!received_spf_result_is("notpass (sender SPF)", "pass"));
        assert!(received_spf_result_is("pass (sender SPF)", "pass"));
    }

    #[test]
    fn avatar_redirects_are_revalidated_before_following() {
        assert_eq!(
            resolve_safe_redirect("https://assets.example.com/icon", "/mail/icon.png")
                .expect("safe relative redirect"),
            "https://assets.example.com/mail/icon.png"
        );
        for location in [
            "http://assets.example.com/icon.png",
            "https://127.0.0.1/icon.png",
            "//localhost/icon.png",
            "file:///etc/passwd",
        ] {
            assert!(
                resolve_safe_redirect("https://assets.example.com/icon", location).is_err(),
                "unsafe redirect should fail: {location}"
            );
        }
    }

    #[test]
    fn avatar_targets_reject_non_public_resolved_addresses() {
        for address in [
            "0.0.0.0",
            "10.0.0.1",
            "100.64.0.1",
            "127.0.0.1",
            "169.254.1.1",
            "172.16.0.1",
            "192.168.0.1",
            "198.18.0.1",
            "224.0.0.1",
            "::1",
            "fc00::1",
            "fe80::1",
            "2001:db8::1",
            "::ffff:127.0.0.1",
        ] {
            assert!(
                !is_public_ip(address.parse().expect("parse non-public address")),
                "non-public address must be rejected: {address}"
            );
        }

        for address in ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"] {
            assert!(
                is_public_ip(address.parse().expect("parse public address")),
                "public address should be accepted: {address}"
            );
        }
    }

    #[test]
    fn bimi_record_parser_extracts_logo_and_certificate() {
        let record = parse_bimi_record(
            "v=BIMI1; l=https://example.com/logo.svg; a=https://example.com/vmc.pem;",
        )
        .expect("parse BIMI");

        assert_eq!(
            record.logo_url.as_deref(),
            Some("https://example.com/logo.svg")
        );
        assert_eq!(
            record.certificate_url.as_deref(),
            Some("https://example.com/vmc.pem")
        );
    }

    #[test]
    fn domain_candidates_preserve_chinese_registered_domain() {
        assert_eq!(
            domain_candidates("mail.rails.com.cn"),
            vec!["mail.rails.com.cn".to_string(), "rails.com.cn".to_string()]
        );
        assert_eq!(
            domain_candidates("tm.openai.com"),
            vec!["tm.openai.com".to_string(), "openai.com".to_string()]
        );
    }

    #[test]
    fn contact_avatar_resolution_plan_requires_no_network_phase() {
        let connection = open_in_memory_database().expect("open database");
        run_migrations(&connection).expect("run migrations");
        let image = "data:image/png;base64,iVBORw0KGgo=";
        set_contact_avatar(&connection, "ChatGPT <noreply@tm.openai.com>", image)
            .expect("save contact avatar");

        let plan = plan_sender_avatar_resolution(
            &connection,
            vec!["ChatGPT <noreply@tm.openai.com>".to_string()],
        )
        .expect("plan resolution");

        // A contact override is a pure database hit, so the caller can finish
        // without ever releasing its lock for a fetch.
        assert!(!plan.has_pending());
        let resolved = persist_fetched_avatars(&connection, plan, Vec::new()).expect("persist");
        assert_eq!(resolved.len(), 1);
        assert_eq!(resolved[0].source_kind, "contact");
        assert_eq!(resolved[0].image_data_url.as_deref(), Some(image));
    }

    #[test]
    fn oversized_avatar_data_url_is_rejected_before_base64_decoding() {
        let error = parse_image_data_url("data:image/png;base64,!!!!!", 3)
            .expect_err("oversized payload must be rejected");

        assert_eq!(error.code, "avatar_image_too_large");
    }

    #[test]
    fn disabled_remote_lookups_never_schedule_a_fetch() {
        let connection = open_in_memory_database().expect("open database");
        run_migrations(&connection).expect("run migrations");
        save_avatar_settings(
            &connection,
            AvatarSettingsDto {
                remote_enabled: false,
                bimi_enabled: false,
                favicon_enabled: false,
                auth_enabled: false,
            },
        )
        .expect("disable remote avatar lookups");

        let plan = plan_sender_avatar_resolution(
            &connection,
            vec!["Someone <someone@example.test>".to_string()],
        )
        .expect("plan resolution");

        assert!(!plan.has_pending());
        let resolved = persist_fetched_avatars(&connection, plan, Vec::new()).expect("persist");
        assert_eq!(resolved.len(), 1);
        assert_eq!(resolved[0].source_kind, "builtin");
    }

    #[test]
    fn unresolved_senders_are_deferred_to_the_lock_free_fetch_phase() {
        let connection = open_in_memory_database().expect("open database");
        run_migrations(&connection).expect("run migrations");

        let plan = plan_sender_avatar_resolution(
            &connection,
            vec!["Someone <someone@example.test>".to_string()],
        )
        .expect("plan resolution");

        // Nothing is cached and remote lookups are enabled by default, so this
        // sender must be handed to the phase that runs without the lock rather
        // than fetched inline.
        assert!(plan.has_pending());
        assert!(plan.resolved.is_empty());
        assert_eq!(plan.pending.len(), 1);
        assert_eq!(plan.pending[0].sender, "Someone <someone@example.test>");
    }

    #[test]
    fn contact_avatar_round_trips_as_data_url() {
        let connection = open_in_memory_database().expect("open database");
        run_migrations(&connection).expect("run migrations");
        let image = "data:image/png;base64,iVBORw0KGgo=";

        let row = set_contact_avatar(&connection, "ChatGPT <noreply@tm.openai.com>", image)
            .expect("save contact avatar");

        assert_eq!(row.source_kind, "contact");
        assert_eq!(row.builtin_kind.as_deref(), Some("openai"));
        assert_eq!(row.image_data_url.as_deref(), Some(image));
    }

    #[test]
    fn avatar_settings_default_to_remote_enabled() {
        let connection = open_in_memory_database().expect("open database");
        run_migrations(&connection).expect("run migrations");

        let settings = load_avatar_settings(&connection).expect("load settings");

        assert!(settings.remote_enabled);
        assert!(settings.bimi_enabled);
        assert!(settings.favicon_enabled);
        assert!(settings.auth_enabled);
    }

    #[test]
    fn qq_mail_uses_official_qqmail_icon_candidates_before_domain_favicon() {
        let identity = normalize_sender_identity("QQ邮箱团队 <10000@qq.com>");

        let urls = provider_avatar_urls(&identity);

        assert_eq!(
            urls.first().map(String::as_str),
            Some("https://res.wx.qq.com/t/webmail/webmail/res/static/images/base/style/favicon/qqmail_favicon_96h.8d124a7.png")
        );
        assert!(urls.iter().any(|url| url.contains("qqmail_favicon_32h")));
        assert!(
            urls.iter()
                .position(|url| url.contains("qqmail_favicon_96h"))
                .unwrap()
                < urls
                    .iter()
                    .position(|url| url == "https://qq.com/favicon.ico")
                    .unwrap()
        );
    }

    #[test]
    fn openai_uses_official_brand_icon_before_domain_favicon() {
        let identity = normalize_sender_identity("OpenAI <noreply@tm.openai.com>");

        let urls = provider_avatar_urls(&identity);

        assert!(
            urls.first()
                .is_some_and(|url| url.contains("Blossom_Light.svg")),
            "OpenAI should prefer the official brand icon first, got {urls:?}"
        );
        assert!({
            let official = urls
                .iter()
                .position(|url| url.contains("Blossom_Light.svg"))
                .unwrap();
            let generic = urls
                .iter()
                .position(|url| url == "https://openai.com/favicon.ico")
                .unwrap();
            official < generic
        });
        assert!(provider_official_icon_url(&identity, &urls[0]));
    }

    #[test]
    fn github_google_and_12306_use_official_icon_candidates_before_root_favicon() {
        let github = normalize_sender_identity("GitHub <noreply@github.com>");
        let github_urls = provider_avatar_urls(&github);
        assert_eq!(
            github_urls.first().map(String::as_str),
            Some("https://github.githubassets.com/favicons/favicon.svg")
        );
        assert!(provider_official_icon_url(&github, &github_urls[0]));

        let google = normalize_sender_identity("Google <no-reply@accounts.google.com>");
        let google_urls = provider_avatar_urls(&google);
        assert_eq!(
            google_urls.first().map(String::as_str),
            Some("https://ssl.gstatic.com/ui/v1/icons/mail/rfr/gmail.ico")
        );
        assert!(provider_official_icon_url(&google, &google_urls[0]));

        let railway = normalize_sender_identity("12306 <12306@rails.com.cn>");
        let railway_urls = provider_avatar_urls(&railway);
        assert_eq!(
            railway_urls.first().map(String::as_str),
            Some("https://www.12306.cn/index/images/favicon.ico")
        );
        assert!(provider_official_icon_url(&railway, &railway_urls[0]));
    }

    #[test]
    fn google_mail_official_icon_candidates_do_not_include_lockup_wordmarks() {
        let identity = normalize_sender_identity("Gmail <mail-noreply@google.com>");
        let urls = provider_official_avatar_urls(&identity);

        assert!(
            urls.iter().all(|url| !url.contains("lockup")),
            "Gmail sender avatars should use square icon assets, not horizontal wordmark lockups: {urls:?}"
        );
    }

    #[test]
    fn google_mail_rejects_cached_lockup_wordmark_official_icon() {
        let identity = normalize_sender_identity("Gmail <mail-noreply@google.com>");
        let cached = CachedAvatar {
            source_kind: "official-icon".to_string(),
            image_mime: Some("image/png".to_string()),
            image_bytes: Some(vec![1, 2, 3]),
            remote_url: Some(
                "https://ssl.gstatic.com/ui/v1/icons/mail/rfr/logo_gmail_lockup_default_1x_r5.png"
                    .to_string(),
            ),
            fallback_text: identity.fallback_text.clone(),
            auth: SenderAuthDto::default(),
            fetched_at: now_rfc3339(),
            expires_at: (Utc::now() + chrono::Duration::days(1)).to_rfc3339(),
        };

        assert!(!cached_avatar_satisfies_provider_policy(
            &identity,
            &cached,
            &AvatarSettingsDto::default(),
        ));
    }

    #[test]
    fn qq_mail_rejects_cached_generic_favicon_to_refresh_official_icon() {
        let identity = normalize_sender_identity("QQ邮箱团队 <10000@qq.com>");
        let cached = CachedAvatar {
            source_kind: "favicon".to_string(),
            image_mime: Some("image/png".to_string()),
            image_bytes: Some(vec![1, 2, 3]),
            remote_url: Some("https://qq.com/favicon.ico".to_string()),
            fallback_text: identity.fallback_text.clone(),
            auth: SenderAuthDto::default(),
            fetched_at: now_rfc3339(),
            expires_at: (Utc::now() + chrono::Duration::days(1)).to_rfc3339(),
        };

        assert!(!cached_avatar_satisfies_provider_policy(
            &identity,
            &cached,
            &AvatarSettingsDto::default(),
        ));
    }

    #[test]
    fn openai_rejects_cached_subdomain_favicon_to_refresh_official_icon() {
        let identity = normalize_sender_identity("OpenAI <noreply@tm.openai.com>");
        let cached = CachedAvatar {
            source_kind: "favicon".to_string(),
            image_mime: Some("image/x-icon".to_string()),
            image_bytes: Some(vec![1, 2, 3]),
            remote_url: Some("https://tm.openai.com/favicon.ico".to_string()),
            fallback_text: identity.fallback_text.clone(),
            auth: SenderAuthDto::default(),
            fetched_at: now_rfc3339(),
            expires_at: (Utc::now() + chrono::Duration::days(1)).to_rfc3339(),
        };

        assert!(!cached_avatar_satisfies_provider_policy(
            &identity,
            &cached,
            &AvatarSettingsDto::default(),
        ));
    }

    #[test]
    fn qq_mail_keeps_cached_official_icon_url() {
        let identity = normalize_sender_identity("QQ邮箱团队 <10000@qq.com>");
        let cached = CachedAvatar {
            source_kind: "favicon".to_string(),
            image_mime: Some("image/x-icon".to_string()),
            image_bytes: Some(vec![1, 2, 3]),
            remote_url: Some("https://mail.qq.com/favicon.ico".to_string()),
            fallback_text: identity.fallback_text.clone(),
            auth: SenderAuthDto::default(),
            fetched_at: now_rfc3339(),
            expires_at: (Utc::now() + chrono::Duration::days(1)).to_rfc3339(),
        };

        assert!(cached_avatar_satisfies_provider_policy(
            &identity,
            &cached,
            &AvatarSettingsDto::default(),
        ));
    }
}
