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

mod authentication;
mod network;
mod resolution;
mod storage;

pub use resolution::{
    fetch_pending_avatars, persist_fetched_avatars, plan_sender_avatar_resolution,
    resolve_sender_avatars,
};
pub use storage::{
    clear_avatar_cache, clear_contact_avatar, load_avatar_settings, save_avatar_settings,
    set_contact_avatar,
};

#[cfg(test)]
#[path = "avatar/tests.rs"]
mod tests;
