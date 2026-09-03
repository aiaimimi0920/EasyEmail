use super::authentication::*;
use super::network::*;
use super::resolution::*;
use super::*;

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

pub(super) fn load_contact_avatar(
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

pub(super) fn load_cached_avatar(
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

pub(super) fn cached_avatar_satisfies_provider_policy(
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

pub(super) fn load_latest_message_auth_headers(
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

pub(super) fn save_cached_avatar(
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

pub(super) fn save_failed_cache(
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
