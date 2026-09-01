use std::collections::{BTreeMap, HashSet};

use chrono::DateTime;
use rusqlite::{params, Connection, OptionalExtension, Result};
use serde_json::json;
use uuid::Uuid;

use crate::domain::message::{Message, MessageSource};
use crate::easyemail::models::EasyEmailObservedMessage;
use crate::imap::models::ImapMessageHeader;
use crate::storage::account_repository::StoredImapConnectionConfig;
use crate::storage::temp_mailbox_repository::TempMailboxRow;

pub fn insert_message(connection: &Connection, message: &Message) -> Result<()> {
    connection.execute(
        "INSERT INTO messages (
            id,
            rfc_message_id,
            subject,
            from_address,
            snippet,
            created_at,
            updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            message.id,
            message.rfc_message_id,
            message.subject,
            message.from_address,
            message.snippet,
            message.created_at,
            message.updated_at,
        ],
    )?;

    Ok(())
}

pub fn insert_message_source(connection: &Connection, source: &MessageSource) -> Result<()> {
    connection.execute(
        "INSERT INTO message_sources (
            id,
            message_id,
            source_id,
            account_id,
            temp_mailbox_id,
            provider_message_id,
            received_address,
            first_seen_at,
            last_seen_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            source.id,
            source.message_id,
            source.source_id,
            source.account_id,
            source.temp_mailbox_id,
            source.provider_message_id,
            source.received_address,
            source.first_seen_at,
            source.last_seen_at,
        ],
    )?;

    Ok(())
}

pub fn create_temp_message_source(
    message_id: String,
    source_id: String,
    temp_mailbox_id: String,
    provider_message_id: String,
    received_address: String,
    now: String,
) -> MessageSource {
    MessageSource {
        id: format!("msrc_{}", Uuid::new_v4()),
        message_id,
        source_id,
        account_id: None,
        temp_mailbox_id: Some(temp_mailbox_id),
        provider_message_id: Some(provider_message_id),
        received_address: Some(received_address),
        first_seen_at: now.clone(),
        last_seen_at: now,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PersistObservedMessagesResult {
    pub fetched_count: usize,
    pub inserted_count: usize,
    pub inserted_message_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MessageLocalState {
    pub is_read: bool,
    pub is_starred: bool,
    pub is_archived: bool,
    pub is_important: bool,
    pub local_folder: String,
    pub labels: Vec<String>,
    pub newsletter_subscription_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AnonymousMessageRow {
    pub message_id: String,
    pub temp_mailbox_id: String,
    pub received_address: String,
    pub provider_label: String,
    pub subject: String,
    pub from_address: String,
    pub snippet: String,
    pub observed_at: String,
    pub lifecycle_state: String,
    pub local_state: MessageLocalState,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromotedAccountMessageRow {
    pub account_id: String,
    pub message_id: String,
    pub temp_mailbox_id: String,
    pub received_address: String,
    pub provider_label: String,
    pub subject: String,
    pub from_address: String,
    pub snippet: String,
    pub observed_at: String,
    pub lifecycle_state: String,
    pub local_state: MessageLocalState,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NormalAccountMessageRow {
    pub account_id: String,
    pub message_id: String,
    pub thread_key: Option<String>,
    pub source_id: String,
    pub folder_id: String,
    pub provider_message_id: String,
    pub received_address: String,
    pub provider_label: String,
    pub subject: String,
    pub from_address: String,
    pub snippet: String,
    pub observed_at: String,
    pub local_state: MessageLocalState,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NormalMessageDetailRow {
    pub message_id: String,
    pub account_id: String,
    pub thread_key: Option<String>,
    pub received_address: String,
    pub subject: String,
    pub from_address: String,
    pub snippet: String,
    pub observed_at: String,
    pub body_text: Option<String>,
    pub body_html: Option<String>,
    pub body_cache_state: String,
    pub draft_cc_addresses: Vec<String>,
    pub draft_bcc_addresses: Vec<String>,
    pub credential_ref_id: Option<String>,
    pub secret_key: Option<String>,
    pub local_state: MessageLocalState,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewsletterSubscriptionRow {
    pub id: String,
    pub list_id: String,
    pub sender_address: String,
    pub name: String,
    pub received_message_count: usize,
    pub unread_message_count: usize,
    pub last_received_at: String,
    pub unsubscribe_methods: Vec<String>,
    pub spam: bool,
    pub hidden: bool,
}

fn message_sort_timestamp(value: &str) -> i64 {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return 0;
    }

    if let Ok(parsed) = DateTime::parse_from_rfc3339(trimmed) {
        return parsed.timestamp_millis();
    }

    let without_timezone_comment = trimmed
        .rfind(" (")
        .and_then(|index| trimmed.ends_with(')').then_some(&trimmed[..index]))
        .unwrap_or(trimmed)
        .trim();

    DateTime::parse_from_rfc2822(without_timezone_comment)
        .map(|parsed| parsed.timestamp_millis())
        .unwrap_or(0)
}

fn compare_message_time_desc(
    left_observed_at: &str,
    left_message_id: &str,
    right_observed_at: &str,
    right_message_id: &str,
) -> std::cmp::Ordering {
    message_sort_timestamp(right_observed_at)
        .cmp(&message_sort_timestamp(left_observed_at))
        .then_with(|| right_observed_at.cmp(left_observed_at))
        .then_with(|| right_message_id.cmp(left_message_id))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImapBodyFetchContextRow {
    pub account_id: String,
    pub source_id: String,
    pub folder_id: String,
    pub folder_provider_id: String,
    pub folder_display_name: String,
    pub folder_path: String,
    pub folder_delimiter: Option<String>,
    pub folder_kind: String,
    pub provider_message_id: String,
    pub config: StoredImapConnectionConfig,
    pub secret_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImapMessageActionContextRow {
    pub account_id: String,
    pub source_id: String,
    pub folder_id: String,
    pub folder_provider_id: String,
    pub folder_display_name: String,
    pub folder_path: String,
    pub folder_delimiter: Option<String>,
    pub folder_kind: String,
    pub provider_message_id: String,
    pub config: StoredImapConnectionConfig,
    pub secret_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentAssociationMessageRow {
    pub message_id: String,
    pub subject: String,
    pub from_address: String,
    pub snippet: String,
    pub body_text: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutgoingMessageRow {
    pub id: String,
    pub account_id: String,
    pub source_id: String,
    pub target_address: String,
    pub subject: String,
    pub body_text: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewOutgoingMessage {
    pub account_id: String,
    pub source_id: String,
    pub from_address: String,
    pub target_address: String,
    pub subject: String,
    pub body_text: String,
    pub now: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewLocalDraftMessage {
    pub draft_id: Option<String>,
    pub account_id: String,
    pub source_id: String,
    pub from_address: String,
    pub target_address: String,
    pub cc_addresses: Vec<String>,
    pub bcc_addresses: Vec<String>,
    pub subject: String,
    pub body_text: String,
    pub body_html: Option<String>,
    pub now: String,
}

fn message_local_state_from_flags(flags_json: &str) -> MessageLocalState {
    let parsed = serde_json::from_str::<serde_json::Value>(flags_json)
        .ok()
        .and_then(|value| match value {
            serde_json::Value::Object(map) => Some(map),
            _ => None,
        })
        .unwrap_or_default();

    let labels = parsed
        .get("labels")
        .and_then(serde_json::Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    MessageLocalState {
        is_read: parsed
            .get("read")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
        is_starred: parsed
            .get("starred")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
        is_archived: parsed
            .get("archived")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
        is_important: parsed
            .get("important")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
        local_folder: parsed
            .get("local_folder")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("inbox")
            .to_string(),
        labels,
        newsletter_subscription_id: newsletter_subscription_id_from_flags(&parsed, None),
    }
}

pub fn ensure_easyemail_temp_source(
    connection: &Connection,
    temp_mailbox: &TempMailboxRow,
    now: &str,
) -> Result<String> {
    if let Some(source_id) = temp_mailbox.source_id.as_ref() {
        return Ok(source_id.clone());
    }

    let source_id = format!("src_{}", Uuid::new_v4());
    let transaction = connection.unchecked_transaction()?;
    transaction.execute(
        "INSERT INTO mailbox_sources (
            id,
            source_kind,
            address,
            provider_id,
            status,
            created_at,
            updated_at
         ) VALUES (?1, 'easyemail_temp', ?2, ?3, 'ready', ?4, ?4)",
        params![
            source_id,
            temp_mailbox.email_address,
            temp_mailbox.provider_id,
            now,
        ],
    )?;
    let changed = transaction.execute(
        "UPDATE temp_mailboxes
         SET source_id = ?1,
             updated_at = ?2
         WHERE id = ?3
           AND source_id IS NULL",
        params![source_id, now, temp_mailbox.id],
    )?;

    if changed == 0 {
        let existing_source_id: String = transaction.query_row(
            "SELECT source_id
             FROM temp_mailboxes
             WHERE id = ?1
               AND source_id IS NOT NULL",
            params![temp_mailbox.id],
            |row| row.get(0),
        )?;
        transaction.execute(
            "DELETE FROM mailbox_sources WHERE id = ?1",
            params![source_id],
        )?;
        transaction.commit()?;
        return Ok(existing_source_id);
    }

    transaction.commit()?;

    Ok(source_id)
}

pub fn persist_observed_messages(
    connection: &Connection,
    temp_mailbox: &TempMailboxRow,
    source_id: &str,
    messages: &[EasyEmailObservedMessage],
    now: &str,
) -> Result<PersistObservedMessagesResult> {
    // One transaction for the whole batch. This loop issues two to three
    // statements per message, and in autocommit each one is a separate commit
    // with its own fsync.
    let transaction = connection.unchecked_transaction()?;
    let connection = &transaction;

    let mut inserted_count = 0;
    let mut inserted_message_ids = Vec::new();

    for observed in messages {
        // A failed lookup must not be treated as "row absent": that would
        // insert a duplicate message instead of updating the existing one.
        let existing: Option<String> = connection
            .query_row(
                "SELECT message_id
                 FROM message_sources
                 WHERE temp_mailbox_id = ?1
                   AND easyemail_message_id = ?2",
                params![temp_mailbox.id, observed.id],
                |row| row.get(0),
            )
            .optional()?;

        if let Some(message_id) = existing {
            connection.execute(
                "UPDATE message_sources
                 SET last_seen_at = ?1
                 WHERE message_id = ?2
                   AND temp_mailbox_id = ?3
                   AND easyemail_message_id = ?4",
                params![now, message_id, temp_mailbox.id, observed.id],
            )?;
            continue;
        }

        let message_id = format!("msg_{}", Uuid::new_v4());
        let subject = observed
            .subject
            .clone()
            .unwrap_or_else(|| "(no subject)".to_string());
        let from_address = observed
            .sender
            .clone()
            .unwrap_or_else(|| "unknown@easyemail.local".to_string());
        let snippet = observed_snippet(observed);

        connection.execute(
            "INSERT INTO messages (
                id,
                rfc_message_id,
                subject,
                from_address,
                date_received,
                snippet,
                body_text_cache,
                body_html_cache,
                body_cache_state,
                created_at,
                updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'cached', ?9, ?9)",
            params![
                message_id,
                observed.id,
                subject,
                from_address,
                observed.observed_at,
                snippet,
                observed.text_body,
                observed.html_body,
                now,
            ],
        )?;

        connection.execute(
            "INSERT INTO message_sources (
                id,
                message_id,
                source_id,
                temp_mailbox_id,
                provider_message_id,
                easyemail_message_id,
                received_address,
                first_seen_at,
                last_seen_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6, ?7, ?7)",
            params![
                format!("msrc_{}", Uuid::new_v4()),
                message_id,
                source_id,
                temp_mailbox.id,
                observed.id,
                temp_mailbox.email_address,
                now,
            ],
        )?;
        inserted_count += 1;
        inserted_message_ids.push(message_id);
    }

    transaction.commit()?;

    Ok(PersistObservedMessagesResult {
        fetched_count: messages.len(),
        inserted_count,
        inserted_message_ids,
    })
}

pub fn list_anonymous_messages(connection: &Connection) -> Result<Vec<AnonymousMessageRow>> {
    list_anonymous_messages_with_options(connection, false)
}

pub fn list_anonymous_messages_with_options(
    connection: &Connection,
    include_archived: bool,
) -> Result<Vec<AnonymousMessageRow>> {
    let mut statement = connection.prepare(
        "SELECT
            messages.id AS message_id,
            temp_mailboxes.id AS temp_mailbox_id,
            COALESCE(message_sources.received_address, temp_mailboxes.email_address) AS received_address,
            temp_mailboxes.provider_label AS provider_label,
            messages.subject AS subject,
            messages.from_address AS from_address,
            messages.snippet AS snippet,
            COALESCE(messages.date_received, message_sources.first_seen_at, messages.created_at) AS observed_at,
            temp_mailboxes.lifecycle_state AS lifecycle_state,
            message_sources.flags_json AS flags_json
         FROM messages
         INNER JOIN message_sources ON message_sources.message_id = messages.id
         INNER JOIN temp_mailboxes ON temp_mailboxes.id = message_sources.temp_mailbox_id
         WHERE temp_mailboxes.visibility_state = 'anonymous'
           AND messages.deleted_at IS NULL
           AND (?1 = 1 OR COALESCE(json_extract(message_sources.flags_json, '$.archived'), 0) = 0)
         ORDER BY observed_at DESC, messages.id DESC",
    )?;

    let mut rows = statement
        .query_map(params![include_archived], |row| {
            Ok(AnonymousMessageRow {
                message_id: row.get("message_id")?,
                temp_mailbox_id: row.get("temp_mailbox_id")?,
                received_address: row.get("received_address")?,
                provider_label: row.get("provider_label")?,
                subject: row.get("subject")?,
                from_address: row.get("from_address")?,
                snippet: row.get("snippet")?,
                observed_at: row.get("observed_at")?,
                lifecycle_state: row.get("lifecycle_state")?,
                local_state: message_local_state_from_flags(&row.get::<_, String>("flags_json")?),
            })
        })?
        .collect::<Result<Vec<_>>>()?;

    rows.sort_by(|left, right| {
        compare_message_time_desc(
            &left.observed_at,
            &left.message_id,
            &right.observed_at,
            &right.message_id,
        )
    });

    Ok(rows)
}

pub fn list_promoted_account_messages(
    connection: &Connection,
    account_id: &str,
) -> Result<Vec<PromotedAccountMessageRow>> {
    list_promoted_account_messages_with_options(connection, account_id, false)
}

pub fn list_promoted_account_messages_with_options(
    connection: &Connection,
    account_id: &str,
    include_archived: bool,
) -> Result<Vec<PromotedAccountMessageRow>> {
    let mut statement = connection.prepare(
        "SELECT
            temp_mailboxes.upgraded_account_id AS account_id,
            messages.id AS message_id,
            temp_mailboxes.id AS temp_mailbox_id,
            COALESCE(message_sources.received_address, temp_mailboxes.email_address) AS received_address,
            temp_mailboxes.provider_label AS provider_label,
            messages.subject AS subject,
            messages.from_address AS from_address,
            messages.snippet AS snippet,
            COALESCE(messages.date_received, message_sources.first_seen_at, messages.created_at) AS observed_at,
            temp_mailboxes.lifecycle_state AS lifecycle_state,
            message_sources.flags_json AS flags_json
         FROM messages
         INNER JOIN message_sources ON message_sources.message_id = messages.id
         INNER JOIN temp_mailboxes ON temp_mailboxes.id = message_sources.temp_mailbox_id
         WHERE temp_mailboxes.visibility_state = 'upgraded'
           AND temp_mailboxes.upgraded_account_id = ?1
           AND messages.deleted_at IS NULL
           AND (?2 = 1 OR COALESCE(json_extract(message_sources.flags_json, '$.archived'), 0) = 0)
         ORDER BY observed_at DESC, messages.id DESC",
    )?;

    let mut rows = statement
        .query_map(params![account_id, include_archived], |row| {
            Ok(PromotedAccountMessageRow {
                account_id: row.get("account_id")?,
                message_id: row.get("message_id")?,
                temp_mailbox_id: row.get("temp_mailbox_id")?,
                received_address: row.get("received_address")?,
                provider_label: row.get("provider_label")?,
                subject: row.get("subject")?,
                from_address: row.get("from_address")?,
                snippet: row.get("snippet")?,
                observed_at: row.get("observed_at")?,
                lifecycle_state: row.get("lifecycle_state")?,
                local_state: message_local_state_from_flags(&row.get::<_, String>("flags_json")?),
            })
        })?
        .collect::<Result<Vec<_>>>()?;

    rows.sort_by(|left, right| {
        compare_message_time_desc(
            &left.observed_at,
            &left.message_id,
            &right.observed_at,
            &right.message_id,
        )
    });

    Ok(rows)
}

pub fn persist_imap_headers(
    connection: &Connection,
    account_id: &str,
    source_id: &str,
    folder_id: &str,
    headers: &[ImapMessageHeader],
    now: &str,
) -> Result<PersistObservedMessagesResult> {
    // One transaction for the whole batch. This loop issues four to six
    // statements per header, and in autocommit each one is a separate commit
    // with its own fsync.
    let transaction = connection.unchecked_transaction()?;
    let connection = &transaction;

    let mut inserted_count = 0;
    let mut inserted_message_ids = Vec::new();

    for header in headers {
        let computed_thread_key = imap_message_thread_key(connection, header)?;
        // A failed lookup must not be treated as "row absent": that would
        // insert a duplicate message instead of updating the existing one.
        let existing_message: Option<(String, Option<String>, Option<String>)> = connection
            .query_row(
                "SELECT message_sources.message_id,
                        messages.rfc_message_id,
                        messages.thread_key
                 FROM message_sources
                 INNER JOIN messages ON messages.id = message_sources.message_id
                 WHERE message_sources.source_id = ?1
                   AND message_sources.folder_id = ?2
                   AND message_sources.imap_uid = ?3",
                params![source_id, folder_id, header.provider_message_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;

        if let Some((message_id, existing_rfc_message_id, existing_thread_key)) = existing_message {
            let security_flags = imap_security_flags(header);
            let rfc_message_id = header.message_id.clone().or(existing_rfc_message_id);
            let thread_key = if header.message_id.is_none()
                && header.in_reply_to.is_none()
                && header.references.is_empty()
            {
                existing_thread_key.or(computed_thread_key)
            } else {
                computed_thread_key.or(existing_thread_key)
            };
            connection.execute(
                "UPDATE messages
                 SET subject = ?1,
                     from_address = ?2,
                     date_received = ?3,
                     snippet = ?4,
                     security_flags = ?5,
                     rfc_message_id = ?6,
                     thread_key = ?7,
                     updated_at = ?8
                 WHERE id = ?9",
                params![
                    header.subject,
                    header.from_address,
                    header.date_received,
                    header.snippet,
                    security_flags,
                    rfc_message_id,
                    thread_key,
                    now,
                    message_id,
                ],
            )?;
            connection.execute(
                "UPDATE message_sources
                 SET last_seen_at = ?1
                 WHERE message_id = ?2
                   AND source_id = ?3
                   AND folder_id = ?4
                   AND imap_uid = ?5",
                params![
                    now,
                    message_id,
                    source_id,
                    folder_id,
                    header.provider_message_id,
                ],
            )?;
            merge_imap_observed_flags(
                connection,
                source_id,
                folder_id,
                &header.provider_message_id,
                header,
                now,
            )?;
            continue;
        }

        let message_id = format!("msg_{}", Uuid::new_v4());
        let security_flags = imap_security_flags(header);
        let flags_json = imap_initial_flags(connection, folder_id, header)?;
        let thread_key = computed_thread_key;
        connection.execute(
            "INSERT INTO messages (
                id,
                rfc_message_id,
                subject,
                from_address,
                date_received,
                snippet,
                security_flags,
                body_cache_state,
                thread_key,
                created_at,
                updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'headers_only', ?8, ?9, ?9)",
            params![
                message_id,
                header.message_id,
                header.subject,
                header.from_address,
                header.date_received,
                header.snippet,
                security_flags,
                thread_key,
                now,
            ],
        )?;

        connection.execute(
            "INSERT INTO message_sources (
                id,
                message_id,
                source_id,
                account_id,
                folder_id,
                provider_message_id,
                imap_uid,
                flags_json,
                first_seen_at,
                last_seen_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7, ?8, ?8)",
            params![
                format!("msrc_{}", Uuid::new_v4()),
                message_id,
                source_id,
                account_id,
                folder_id,
                header.provider_message_id,
                flags_json,
                now,
            ],
        )?;

        inserted_count += 1;
        inserted_message_ids.push(message_id);
    }

    transaction.commit()?;

    Ok(PersistObservedMessagesResult {
        fetched_count: headers.len(),
        inserted_count,
        inserted_message_ids,
    })
}

fn imap_message_thread_key(
    connection: &Connection,
    header: &ImapMessageHeader,
) -> Result<Option<String>> {
    if let Some(root_reference) = header.references.first() {
        return Ok(Some(format!("rfc:{root_reference}")));
    }

    if let Some(parent_id) = header.in_reply_to.as_deref() {
        if let Some(existing_thread_key) =
            existing_thread_key_for_rfc_message_id(connection, parent_id)?
        {
            return Ok(Some(existing_thread_key));
        }
        return Ok(Some(format!("rfc:{parent_id}")));
    }

    if let Some(message_id) = header.message_id.as_deref() {
        return Ok(Some(format!("rfc:{message_id}")));
    }

    let subject = normalize_thread_subject(&header.subject);
    let sender = normalize_thread_address(&header.from_address);
    if subject.is_empty() && sender.is_empty() {
        Ok(None)
    } else {
        Ok(Some(format!("subject:{subject}::from:{sender}")))
    }
}

fn existing_thread_key_for_rfc_message_id(
    connection: &Connection,
    rfc_message_id: &str,
) -> Result<Option<String>> {
    connection
        .query_row(
            "SELECT thread_key
             FROM messages
             WHERE rfc_message_id IS NOT NULL
               AND lower(rfc_message_id) = lower(?1)
               AND thread_key IS NOT NULL
               AND trim(thread_key) <> ''
             ORDER BY created_at ASC
             LIMIT 1",
            params![rfc_message_id],
            |row| row.get(0),
        )
        .optional()
}

fn normalize_thread_subject(subject: &str) -> String {
    let mut normalized = subject.trim().to_ascii_lowercase();
    loop {
        let stripped = ["re:", "fwd:", "fw:", "回复:", "答复:", "转发:"]
            .iter()
            .find_map(|prefix| normalized.strip_prefix(prefix).map(str::trim));
        let Some(stripped) = stripped else {
            break;
        };
        normalized = stripped.to_string();
    }
    normalized.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn normalize_thread_address(address: &str) -> String {
    let trimmed = address.trim().to_ascii_lowercase();
    if let (Some(start), Some(end)) = (trimmed.rfind('<'), trimmed.rfind('>')) {
        if start < end {
            return trimmed[start + 1..end].trim().to_string();
        }
    }
    trimmed
}

fn imap_security_flags(header: &ImapMessageHeader) -> String {
    json!({
        "authentication_results": header.authentication_results,
        "received_spf": header.received_spf,
        "dkim_signature": header.dkim_signature,
    })
    .to_string()
}

fn imap_initial_flags(
    connection: &Connection,
    folder_id: &str,
    header: &ImapMessageHeader,
) -> Result<String> {
    // A failed lookup must not be treated as "row absent": that would drop the
    // spam/trash classification and file the message into the inbox instead.
    let folder_kind: Option<String> = connection
        .query_row(
            "SELECT folder_kind FROM mail_folders WHERE id = ?1",
            params![folder_id],
            |row| row.get(0),
        )
        .optional()?;
    let mut flags = serde_json::Map::new();

    if let Some(kind) = folder_kind
        .as_deref()
        .map(str::trim)
        .filter(|kind| matches!(*kind, "spam" | "trash" | "archive"))
    {
        flags.insert(
            "local_folder".to_string(),
            serde_json::Value::String(kind.to_string()),
        );
    }

    if imap_header_is_newsletter(header) {
        flags.insert(
            "labels".to_string(),
            serde_json::Value::Array(vec![serde_json::Value::String("newsletters".to_string())]),
        );
        if let Some(metadata) = imap_newsletter_metadata(header) {
            flags.insert("newsletter".to_string(), metadata);
        }
    }

    Ok(serde_json::Value::Object(flags).to_string())
}

fn imap_header_is_newsletter(header: &ImapMessageHeader) -> bool {
    header
        .list_unsubscribe
        .as_deref()
        .map(str::trim)
        .is_some_and(|value| !value.is_empty())
        || header
            .list_id
            .as_deref()
            .map(str::trim)
            .is_some_and(|value| !value.is_empty())
        || header
            .list_unsubscribe_post
            .as_deref()
            .map(str::trim)
            .is_some_and(|value| !value.is_empty())
        || header
            .precedence
            .as_deref()
            .map(|value| {
                let normalized = value.trim().to_ascii_lowercase();
                normalized == "bulk" || normalized == "list"
            })
            .unwrap_or(false)
        || header
            .list_post
            .as_deref()
            .map(str::trim)
            .is_some_and(|value| !value.is_empty())
        || header
            .list_help
            .as_deref()
            .map(str::trim)
            .is_some_and(|value| !value.is_empty())
        || header
            .feedback_id
            .as_deref()
            .map(str::trim)
            .is_some_and(|value| !value.is_empty())
}

fn imap_newsletter_metadata(header: &ImapMessageHeader) -> Option<serde_json::Value> {
    if !imap_header_is_newsletter(header) {
        return None;
    }
    let list_id = header
        .list_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("");
    let sender_address = header.from_address.trim();
    let mut unsubscribe_methods = Vec::new();
    for value in [
        header.list_unsubscribe.as_deref(),
        header.list_unsubscribe_post.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        let method = value.trim();
        if !method.is_empty() && !unsubscribe_methods.contains(&method.to_string()) {
            unsubscribe_methods.push(method.to_string());
        }
    }
    Some(json!({
        "list_id": list_id,
        "sender_address": sender_address,
        "name": newsletter_display_name(list_id, sender_address),
        "unsubscribe_methods": unsubscribe_methods,
    }))
}

fn newsletter_display_name(list_id: &str, sender_address: &str) -> String {
    let list_name = list_id
        .split('<')
        .next()
        .unwrap_or(list_id)
        .trim()
        .trim_matches('"');
    if !list_name.is_empty() {
        return list_name.to_string();
    }
    let sender_name = sender_address
        .split('<')
        .next()
        .unwrap_or(sender_address)
        .trim()
        .trim_matches('"');
    if !sender_name.is_empty() {
        return sender_name.to_string();
    }
    sender_address.to_string()
}

fn newsletter_subscription_id_from_flags(
    flags: &serde_json::Map<String, serde_json::Value>,
    fallback_sender_address: Option<&str>,
) -> Option<String> {
    let labels = flags
        .get("labels")
        .and_then(serde_json::Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(serde_json::Value::as_str)
                .any(|label| label.trim().eq_ignore_ascii_case("newsletters"))
        })
        .unwrap_or(false);
    if !labels {
        return None;
    }

    let newsletter = flags
        .get("newsletter")
        .and_then(serde_json::Value::as_object);
    let list_id = newsletter
        .and_then(|value| value.get("list_id"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("");
    let sender_address = newsletter
        .and_then(|value| value.get("sender_address"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| fallback_sender_address.map(str::trim))
        .filter(|value| !value.is_empty())
        .unwrap_or("");

    if !list_id.is_empty() {
        Some(format!("list:{}", list_id.to_ascii_lowercase()))
    } else if !sender_address.is_empty() {
        Some(format!("sender:{}", sender_address.to_ascii_lowercase()))
    } else {
        None
    }
}

fn merge_imap_observed_flags(
    connection: &Connection,
    source_id: &str,
    folder_id: &str,
    imap_uid: &str,
    header: &ImapMessageHeader,
    now: &str,
) -> Result<()> {
    let mut flags = connection.query_row(
        "SELECT flags_json
         FROM message_sources
         WHERE source_id = ?1
           AND folder_id = ?2
           AND imap_uid = ?3",
        params![source_id, folder_id, imap_uid],
        |row| row.get::<_, String>(0),
    )?;
    let mut parsed = serde_json::from_str::<serde_json::Value>(&flags)
        .ok()
        .and_then(|value| match value {
            serde_json::Value::Object(map) => Some(map),
            _ => None,
        })
        .unwrap_or_default();
    let mut changed = false;

    if imap_header_is_newsletter(header) {
        let labels = parsed
            .entry("labels".to_string())
            .or_insert_with(|| serde_json::Value::Array(Vec::new()));
        if let serde_json::Value::Array(items) = labels {
            let has_newsletters = items
                .iter()
                .filter_map(serde_json::Value::as_str)
                .any(|label| label.trim().eq_ignore_ascii_case("newsletters"));
            if !has_newsletters {
                items.push(serde_json::Value::String("newsletters".to_string()));
                changed = true;
            }
        }
        if let Some(metadata) = imap_newsletter_metadata(header) {
            parsed.insert("newsletter".to_string(), metadata);
            changed = true;
        }
    }

    if changed {
        flags = serde_json::Value::Object(parsed).to_string();
        connection.execute(
            "UPDATE message_sources
             SET flags_json = ?1,
                 last_seen_at = ?2
             WHERE source_id = ?3
               AND folder_id = ?4
               AND imap_uid = ?5",
            params![flags, now, source_id, folder_id, imap_uid],
        )?;
    }

    Ok(())
}

pub fn list_normal_account_messages(
    connection: &Connection,
    account_id: &str,
) -> Result<Vec<NormalAccountMessageRow>> {
    list_normal_account_messages_with_options(connection, account_id, false)
}

pub fn list_normal_account_messages_with_options(
    connection: &Connection,
    account_id: &str,
    include_archived: bool,
) -> Result<Vec<NormalAccountMessageRow>> {
    let mut statement = connection.prepare(
        "SELECT
            message_sources.account_id AS account_id,
            messages.id AS message_id,
            messages.thread_key AS thread_key,
            message_sources.source_id AS source_id,
            COALESCE(message_sources.folder_id, '') AS folder_id,
            COALESCE(message_sources.provider_message_id, message_sources.imap_uid, messages.rfc_message_id, '') AS provider_message_id,
            COALESCE(
                CASE WHEN mailbox_sources.source_kind = 'smtp' THEN message_sources.received_address END,
                mailbox_sources.address,
                accounts.primary_address,
                message_sources.account_id,
                ''
            ) AS received_address,
            COALESCE(accounts.provider_label, mailbox_sources.provider_id, 'Manual IMAP') AS provider_label,
            messages.subject AS subject,
            messages.from_address AS from_address,
            messages.snippet AS snippet,
            COALESCE(outgoing_queue.sent_at, outgoing_queue.next_retry_at, messages.date_received, message_sources.last_seen_at, message_sources.first_seen_at, messages.created_at) AS observed_at,
            CASE
                WHEN mailbox_sources.source_kind = 'smtp' AND outgoing_queue.status = 'sent' THEN '{\"local_folder\":\"sent\",\"read\":true}'
                WHEN mailbox_sources.source_kind = 'smtp' AND outgoing_queue.status = 'queued' THEN '{\"local_folder\":\"sent\",\"read\":true,\"labels\":[\"未发送\"]}'
                ELSE message_sources.flags_json
            END AS flags_json
         FROM messages
         INNER JOIN message_sources ON message_sources.message_id = messages.id
         INNER JOIN mailbox_sources ON mailbox_sources.id = message_sources.source_id
         INNER JOIN accounts ON accounts.id = message_sources.account_id
         LEFT JOIN send_queue AS outgoing_queue
           ON outgoing_queue.message_id = messages.id
          AND (
            outgoing_queue.status = 'sent'
            OR (
              outgoing_queue.status = 'queued'
              AND outgoing_queue.next_retry_at IS NOT NULL
            )
          )
         WHERE message_sources.account_id = ?1
           AND (
             mailbox_sources.source_kind = 'imap'
             OR (
               mailbox_sources.source_kind = 'smtp'
               AND messages.classification = 'outgoing'
               AND (
                 outgoing_queue.id IS NOT NULL
                 OR json_extract(message_sources.flags_json, '$.local_folder') = 'drafts'
               )
             )
           )
           AND messages.deleted_at IS NULL
           AND (?2 = 1 OR COALESCE(json_extract(message_sources.flags_json, '$.archived'), 0) = 0)
         ORDER BY observed_at DESC, messages.id DESC",
    )?;

    let mut rows = statement
        .query_map(params![account_id, include_archived], |row| {
            Ok(NormalAccountMessageRow {
                account_id: row.get("account_id")?,
                message_id: row.get("message_id")?,
                thread_key: row.get("thread_key")?,
                source_id: row.get("source_id")?,
                folder_id: row.get("folder_id")?,
                provider_message_id: row.get("provider_message_id")?,
                received_address: row.get("received_address")?,
                provider_label: row.get("provider_label")?,
                subject: row.get("subject")?,
                from_address: row.get("from_address")?,
                snippet: row.get("snippet")?,
                observed_at: row.get("observed_at")?,
                local_state: message_local_state_from_flags(&row.get::<_, String>("flags_json")?),
            })
        })?
        .collect::<Result<Vec<_>>>()?;

    rows.sort_by(|left, right| {
        compare_message_time_desc(
            &left.observed_at,
            &left.message_id,
            &right.observed_at,
            &right.message_id,
        )
    });

    Ok(rows)
}

pub fn list_newsletter_subscriptions(
    connection: &Connection,
    account_id: &str,
) -> Result<Vec<NewsletterSubscriptionRow>> {
    let mut statement = connection.prepare(
        "SELECT
            messages.from_address AS from_address,
            COALESCE(messages.date_received, message_sources.last_seen_at, message_sources.first_seen_at, messages.created_at) AS observed_at,
            message_sources.flags_json AS flags_json
         FROM messages
         INNER JOIN message_sources ON message_sources.message_id = messages.id
         INNER JOIN mailbox_sources ON mailbox_sources.id = message_sources.source_id
         WHERE message_sources.account_id = ?1
           AND mailbox_sources.source_kind = 'imap'
           AND messages.deleted_at IS NULL
           AND EXISTS (
             SELECT 1
             FROM json_each(
               CASE
                 WHEN json_valid(message_sources.flags_json) THEN message_sources.flags_json
                 ELSE '{}'
               END,
               '$.labels'
             ) AS newsletter_labels
             WHERE lower(trim(CAST(newsletter_labels.value AS TEXT))) = 'newsletters'
           )",
    )?;
    let rows = statement
        .query_map(params![account_id], |row| {
            Ok((
                row.get::<_, String>("from_address")?,
                row.get::<_, String>("observed_at")?,
                row.get::<_, String>("flags_json")?,
            ))
        })?
        .collect::<Result<Vec<_>>>()?;
    let mut grouped: BTreeMap<String, NewsletterSubscriptionRow> = BTreeMap::new();

    for (from_address, observed_at, flags_json) in rows {
        let flags = serde_json::from_str::<serde_json::Value>(&flags_json)
            .ok()
            .and_then(|value| match value {
                serde_json::Value::Object(map) => Some(map),
                _ => None,
            })
            .unwrap_or_default();
        let local_state = message_local_state_from_flags(&flags_json);
        if !local_state
            .labels
            .iter()
            .any(|label| label.trim().eq_ignore_ascii_case("newsletters"))
        {
            continue;
        }
        let newsletter = flags
            .get("newsletter")
            .and_then(serde_json::Value::as_object);
        let list_id = newsletter
            .and_then(|value| value.get("list_id"))
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("");
        let sender_address = newsletter
            .and_then(|value| value.get("sender_address"))
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(from_address.trim());
        let group_key = newsletter_subscription_id_from_flags(&flags, Some(sender_address))
            .unwrap_or_else(|| format!("sender:{}", sender_address.to_ascii_lowercase()));
        let name = newsletter
            .and_then(|value| value.get("name"))
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string)
            .unwrap_or_else(|| newsletter_display_name(list_id, sender_address));
        let unsubscribe_methods = newsletter
            .and_then(|value| value.get("unsubscribe_methods"))
            .and_then(serde_json::Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(serde_json::Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(ToString::to_string)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let spam = local_state.local_folder == "spam";

        let entry = grouped
            .entry(group_key.clone())
            .or_insert_with(|| NewsletterSubscriptionRow {
                id: group_key,
                list_id: list_id.to_string(),
                sender_address: sender_address.to_string(),
                name,
                received_message_count: 0,
                unread_message_count: 0,
                last_received_at: observed_at.clone(),
                unsubscribe_methods: Vec::new(),
                spam: false,
                hidden: false,
            });
        entry.received_message_count += 1;
        if !local_state.is_read {
            entry.unread_message_count += 1;
        }
        if compare_message_time_desc(&observed_at, "", &entry.last_received_at, "").is_lt() {
            entry.last_received_at = observed_at;
        }
        entry.spam = entry.spam || spam;
        for method in unsubscribe_methods {
            if !entry.unsubscribe_methods.contains(&method) {
                entry.unsubscribe_methods.push(method);
            }
        }
    }

    let mut subscriptions = grouped.into_values().collect::<Vec<_>>();

    // Fetch every override for the account once rather than issuing one query
    // per subscription.
    let hidden_keys: HashSet<String> = {
        let mut statement = connection.prepare(
            "SELECT subscription_key
             FROM newsletter_subscription_overrides
             WHERE account_id = ?1
               AND hidden <> 0",
        )?;
        let rows = statement.query_map(params![account_id], |row| row.get::<_, String>(0))?;
        rows.collect::<Result<HashSet<String>>>()?
    };
    for subscription in &mut subscriptions {
        subscription.hidden = hidden_keys.contains(&subscription.id);
    }
    subscriptions.sort_by(|left, right| {
        compare_message_time_desc(
            &left.last_received_at,
            &left.id,
            &right.last_received_at,
            &right.id,
        )
    });
    Ok(subscriptions)
}

pub fn set_newsletter_subscription_hidden(
    connection: &Connection,
    account_id: &str,
    subscription_id: &str,
    hidden: bool,
    now: &str,
) -> Result<bool> {
    let trimmed_account_id = account_id.trim();
    let trimmed_subscription_id = subscription_id.trim();
    if trimmed_account_id.is_empty()
        || trimmed_subscription_id.is_empty()
        || trimmed_subscription_id.len() > 1_024
    {
        return Ok(false);
    }
    let subscription_exists = list_newsletter_subscriptions(connection, trimmed_account_id)?
        .iter()
        .any(|subscription| subscription.id == trimmed_subscription_id);
    if !subscription_exists {
        return Ok(false);
    }

    let changed = connection.execute(
        "INSERT INTO newsletter_subscription_overrides (
            account_id,
            subscription_key,
            hidden,
            updated_at
         ) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(account_id, subscription_key) DO UPDATE SET
            hidden = excluded.hidden,
            updated_at = excluded.updated_at",
        params![
            trimmed_account_id,
            trimmed_subscription_id,
            if hidden { 1_i64 } else { 0_i64 },
            now
        ],
    )?;

    Ok(changed > 0)
}

pub fn get_message_detail(
    connection: &Connection,
    message_id: &str,
) -> Result<Option<NormalMessageDetailRow>> {
    connection
        .query_row(
            "SELECT
                messages.id AS message_id,
                COALESCE(message_sources.account_id, '') AS account_id,
                messages.thread_key AS thread_key,
                COALESCE(message_sources.received_address, '') AS received_address,
                messages.subject AS subject,
                messages.from_address AS from_address,
                messages.snippet AS snippet,
                COALESCE(messages.date_received, message_sources.last_seen_at, message_sources.first_seen_at, messages.created_at) AS observed_at,
                messages.body_text_cache AS body_text,
                messages.body_html_cache AS body_html,
                messages.body_cache_state AS body_cache_state,
                credential_refs.id AS credential_ref_id,
                credential_refs.secret_key AS secret_key,
                COALESCE(message_sources.flags_json, '{}') AS flags_json
             FROM messages
             LEFT JOIN message_sources ON message_sources.message_id = messages.id
             LEFT JOIN mailbox_sources ON mailbox_sources.id = message_sources.source_id
             LEFT JOIN credential_refs ON credential_refs.id = mailbox_sources.credential_ref_id
             WHERE messages.id = ?1
               AND messages.deleted_at IS NULL
             ORDER BY message_sources.first_seen_at ASC
             LIMIT 1",
            params![message_id],
            |row| {
                Ok(NormalMessageDetailRow {
                    message_id: row.get("message_id")?,
                    account_id: row.get("account_id")?,
                    thread_key: row.get("thread_key")?,
                    received_address: row.get("received_address")?,
                    subject: row.get("subject")?,
                    from_address: row.get("from_address")?,
                    snippet: row.get("snippet")?,
                    observed_at: row.get("observed_at")?,
                    body_text: row.get("body_text")?,
                    body_html: row.get("body_html")?,
                    body_cache_state: row.get("body_cache_state")?,
                    draft_cc_addresses: draft_address_list_from_flags(
                        &row.get::<_, String>("flags_json")?,
                        "draft_cc_addresses",
                    ),
                    draft_bcc_addresses: draft_address_list_from_flags(
                        &row.get::<_, String>("flags_json")?,
                        "draft_bcc_addresses",
                    ),
                    credential_ref_id: row.get("credential_ref_id")?,
                    secret_key: row.get("secret_key")?,
                    local_state: message_local_state_from_flags(&row.get::<_, String>("flags_json")?),
                })
            },
        )
        .optional()
}

pub fn get_imap_body_fetch_context(
    connection: &Connection,
    message_id: &str,
) -> Result<Option<ImapBodyFetchContextRow>> {
    connection
        .query_row(
            "SELECT
                message_sources.account_id AS account_id,
                message_sources.source_id AS source_id,
                message_sources.folder_id AS folder_id,
                mail_folders.provider_folder_id AS folder_provider_id,
                mail_folders.display_name AS folder_display_name,
                mail_folders.path AS folder_path,
                mail_folders.delimiter AS folder_delimiter,
                mail_folders.folder_kind AS folder_kind,
                COALESCE(message_sources.imap_uid, message_sources.provider_message_id, messages.rfc_message_id, '') AS provider_message_id,
                mailbox_sources.config_json AS config_json,
                credential_refs.secret_key AS secret_key
             FROM messages
             INNER JOIN message_sources ON message_sources.message_id = messages.id
             INNER JOIN mailbox_sources ON mailbox_sources.id = message_sources.source_id
             INNER JOIN mail_folders ON mail_folders.id = message_sources.folder_id
             INNER JOIN credential_refs ON credential_refs.id = mailbox_sources.credential_ref_id
             WHERE messages.id = ?1
               AND messages.deleted_at IS NULL
               AND mailbox_sources.source_kind = 'imap'
               AND COALESCE(message_sources.imap_uid, message_sources.provider_message_id, messages.rfc_message_id, '') <> ''
             ORDER BY message_sources.first_seen_at ASC
             LIMIT 1",
            params![message_id],
            |row| {
                let config_json: String = row.get("config_json")?;
                let config: StoredImapConnectionConfig =
                    serde_json::from_str(&config_json).map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(
                            config_json.len(),
                            rusqlite::types::Type::Text,
                            Box::new(error),
                        )
                    })?;
                Ok(ImapBodyFetchContextRow {
                    account_id: row.get("account_id")?,
                    source_id: row.get("source_id")?,
                    folder_id: row.get("folder_id")?,
                    folder_provider_id: row.get("folder_provider_id")?,
                    folder_display_name: row.get("folder_display_name")?,
                    folder_path: row.get("folder_path")?,
                    folder_delimiter: row.get("folder_delimiter")?,
                    folder_kind: row.get("folder_kind")?,
                    provider_message_id: row.get("provider_message_id")?,
                    config,
                    secret_key: row.get("secret_key")?,
                })
            },
        )
        .optional()
}

pub fn get_imap_message_action_context(
    connection: &Connection,
    message_id: &str,
) -> Result<Option<ImapMessageActionContextRow>> {
    connection
        .query_row(
            "SELECT
                message_sources.account_id AS account_id,
                message_sources.source_id AS source_id,
                message_sources.folder_id AS folder_id,
                mail_folders.provider_folder_id AS folder_provider_id,
                mail_folders.display_name AS folder_display_name,
                mail_folders.path AS folder_path,
                mail_folders.delimiter AS folder_delimiter,
                mail_folders.folder_kind AS folder_kind,
                COALESCE(message_sources.imap_uid, message_sources.provider_message_id, messages.rfc_message_id, '') AS provider_message_id,
                mailbox_sources.config_json AS config_json,
                credential_refs.secret_key AS secret_key
             FROM messages
             INNER JOIN message_sources ON message_sources.message_id = messages.id
             INNER JOIN mailbox_sources ON mailbox_sources.id = message_sources.source_id
             INNER JOIN mail_folders ON mail_folders.id = message_sources.folder_id
             INNER JOIN credential_refs ON credential_refs.id = mailbox_sources.credential_ref_id
             WHERE messages.id = ?1
               AND messages.deleted_at IS NULL
               AND mailbox_sources.source_kind = 'imap'
               AND COALESCE(message_sources.imap_uid, message_sources.provider_message_id, messages.rfc_message_id, '') <> ''
             ORDER BY message_sources.first_seen_at ASC
             LIMIT 1",
            params![message_id],
            |row| {
                let config_json: String = row.get("config_json")?;
                let config: StoredImapConnectionConfig =
                    serde_json::from_str(&config_json).map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(
                            config_json.len(),
                            rusqlite::types::Type::Text,
                            Box::new(error),
                        )
                    })?;
                Ok(ImapMessageActionContextRow {
                    account_id: row.get("account_id")?,
                    source_id: row.get("source_id")?,
                    folder_id: row.get("folder_id")?,
                    folder_provider_id: row.get("folder_provider_id")?,
                    folder_display_name: row.get("folder_display_name")?,
                    folder_path: row.get("folder_path")?,
                    folder_delimiter: row.get("folder_delimiter")?,
                    folder_kind: row.get("folder_kind")?,
                    provider_message_id: row.get("provider_message_id")?,
                    config,
                    secret_key: row.get("secret_key")?,
                })
            },
        )
        .optional()
}

pub fn update_message_body_text_cache(
    connection: &Connection,
    message_id: &str,
    body_text: &str,
    now: &str,
) -> Result<()> {
    update_message_body_cache(connection, message_id, body_text, None, now)
}

pub fn update_message_body_cache(
    connection: &Connection,
    message_id: &str,
    body_text: &str,
    body_html: Option<&str>,
    now: &str,
) -> Result<()> {
    connection.execute(
        "UPDATE messages
         SET body_text_cache = ?1,
             body_html_cache = ?2,
             body_cache_state = 'cached',
             updated_at = ?3
         WHERE id = ?4
           AND deleted_at IS NULL",
        params![body_text, body_html, now, message_id],
    )?;
    Ok(())
}

pub fn soft_delete_message(connection: &Connection, message_id: &str, now: &str) -> Result<bool> {
    let changed = connection.execute(
        "UPDATE messages
         SET deleted_at = ?1,
             updated_at = ?1
         WHERE id = ?2
           AND deleted_at IS NULL",
        params![now, message_id],
    )?;
    Ok(changed > 0)
}

pub fn set_message_source_flag(
    connection: &Connection,
    message_id: &str,
    flag_name: &str,
    enabled: bool,
    now: &str,
) -> Result<bool> {
    update_message_source_flags(connection, message_id, now, |flags| {
        if enabled {
            flags.insert(flag_name.to_string(), serde_json::Value::Bool(true));
        } else {
            flags.remove(flag_name);
        }
    })
}

pub fn set_message_source_folder(
    connection: &Connection,
    message_id: &str,
    folder_name: &str,
    now: &str,
) -> Result<bool> {
    let folder_name = folder_name.trim().to_ascii_lowercase();
    update_message_source_flags(connection, message_id, now, |flags| {
        if folder_name.eq_ignore_ascii_case("inbox") {
            flags.remove("local_folder");
            flags.remove("archived");
        } else {
            flags.insert(
                "local_folder".to_string(),
                serde_json::Value::String(folder_name.to_string()),
            );
            if folder_name == "archive" {
                flags.insert("archived".to_string(), serde_json::Value::Bool(true));
            } else {
                flags.remove("archived");
            }
        }
    })
}

pub fn set_message_source_remote_folder(
    connection: &Connection,
    message_id: &str,
    source_id: &str,
    folder_id: &str,
    provider_message_id: Option<&str>,
    now: &str,
) -> Result<bool> {
    let changed = connection.execute(
        "UPDATE message_sources
         SET folder_id = ?3,
             provider_message_id = COALESCE(?4, provider_message_id),
             imap_uid = COALESCE(?4, imap_uid),
             last_seen_at = ?5
         WHERE message_id = ?1
           AND source_id = ?2
           AND EXISTS (
               SELECT 1
               FROM messages
               WHERE messages.id = message_sources.message_id
                 AND messages.deleted_at IS NULL
           )",
        params![message_id, source_id, folder_id, provider_message_id, now],
    )?;
    Ok(changed > 0)
}

pub fn set_message_source_label(
    connection: &Connection,
    message_id: &str,
    label_name: &str,
    enabled: bool,
    now: &str,
) -> Result<bool> {
    let label_name = label_name.trim();
    update_message_source_flags(connection, message_id, now, |flags| {
        let mut labels = flags
            .get("labels")
            .and_then(serde_json::Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(serde_json::Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(ToString::to_string)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        if enabled {
            if !labels.iter().any(|item| item == label_name) && !label_name.is_empty() {
                labels.push(label_name.to_string());
            }
        } else {
            labels.retain(|item| item != label_name);
        }
        labels.sort();

        if labels.is_empty() {
            flags.remove("labels");
        } else {
            flags.insert(
                "labels".to_string(),
                serde_json::Value::Array(
                    labels
                        .into_iter()
                        .map(serde_json::Value::String)
                        .collect::<Vec<_>>(),
                ),
            );
        }
    })
}

pub fn replace_message_source_folder_name(
    connection: &Connection,
    old_folder_name: &str,
    new_folder_name: &str,
    now: &str,
) -> Result<usize> {
    let old_folder_name = old_folder_name.trim().to_ascii_lowercase();
    let new_folder_name = new_folder_name.trim().to_ascii_lowercase();
    update_all_message_source_flags(connection, now, |flags| {
        let matches = flags
            .get("local_folder")
            .and_then(serde_json::Value::as_str)
            .map(|value| value.trim().eq_ignore_ascii_case(&old_folder_name))
            .unwrap_or(false);
        if !matches {
            return false;
        }
        if new_folder_name == "inbox" || new_folder_name.is_empty() {
            flags.remove("local_folder");
            flags.remove("archived");
        } else {
            flags.insert(
                "local_folder".to_string(),
                serde_json::Value::String(new_folder_name.clone()),
            );
            if new_folder_name == "archive" {
                flags.insert("archived".to_string(), serde_json::Value::Bool(true));
            } else {
                flags.remove("archived");
            }
        }
        true
    })
}

pub fn clear_message_source_folder_name(
    connection: &Connection,
    folder_name: &str,
    now: &str,
) -> Result<usize> {
    let folder_name = folder_name.trim().to_ascii_lowercase();
    update_all_message_source_flags(connection, now, |flags| {
        let matches = flags
            .get("local_folder")
            .and_then(serde_json::Value::as_str)
            .map(|value| value.trim().eq_ignore_ascii_case(&folder_name))
            .unwrap_or(false);
        if !matches {
            return false;
        }
        flags.remove("local_folder");
        flags.remove("archived");
        true
    })
}

pub fn replace_message_source_label_name(
    connection: &Connection,
    old_label_name: &str,
    new_label_name: &str,
    now: &str,
) -> Result<usize> {
    let old_label_name = old_label_name.trim().to_ascii_lowercase();
    let new_label_name = new_label_name.trim();
    update_all_message_source_flags(connection, now, |flags| {
        let mut changed = false;
        let mut normalized_seen = std::collections::HashSet::new();
        let labels = flags
            .get("labels")
            .and_then(serde_json::Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(serde_json::Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .filter_map(|value| {
                        let next_value = if value.eq_ignore_ascii_case(&old_label_name) {
                            changed = true;
                            new_label_name
                        } else {
                            value
                        };
                        if next_value.is_empty() {
                            return None;
                        }
                        let normalized = next_value.to_ascii_lowercase();
                        if normalized_seen.insert(normalized) {
                            Some(next_value.to_string())
                        } else {
                            changed = true;
                            None
                        }
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        if !changed {
            return false;
        }
        if labels.is_empty() {
            flags.remove("labels");
        } else {
            flags.insert(
                "labels".to_string(),
                serde_json::Value::Array(
                    labels
                        .into_iter()
                        .map(serde_json::Value::String)
                        .collect::<Vec<_>>(),
                ),
            );
        }
        true
    })
}

pub fn clear_message_source_label_name(
    connection: &Connection,
    label_name: &str,
    now: &str,
) -> Result<usize> {
    let label_name = label_name.trim().to_ascii_lowercase();
    update_all_message_source_flags(connection, now, |flags| {
        let mut changed = false;
        let labels = flags
            .get("labels")
            .and_then(serde_json::Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(serde_json::Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .filter_map(|value| {
                        if value.eq_ignore_ascii_case(&label_name) {
                            changed = true;
                            None
                        } else {
                            Some(value.to_string())
                        }
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        if !changed {
            return false;
        }
        if labels.is_empty() {
            flags.remove("labels");
        } else {
            flags.insert(
                "labels".to_string(),
                serde_json::Value::Array(
                    labels
                        .into_iter()
                        .map(serde_json::Value::String)
                        .collect::<Vec<_>>(),
                ),
            );
        }
        true
    })
}

fn update_all_message_source_flags<F>(
    connection: &Connection,
    now: &str,
    mut update: F,
) -> Result<usize>
where
    F: FnMut(&mut serde_json::Map<String, serde_json::Value>) -> bool,
{
    let mut statement = connection.prepare(
        "SELECT message_sources.id AS source_row_id,
                message_sources.flags_json AS flags_json
         FROM message_sources
         INNER JOIN messages ON messages.id = message_sources.message_id
         WHERE messages.deleted_at IS NULL",
    )?;

    let source_rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>("source_row_id")?,
                row.get::<_, String>("flags_json")?,
            ))
        })?
        .collect::<Result<Vec<_>>>()?;

    let mut changed_count = 0;
    for (source_row_id, flags_json) in &source_rows {
        let mut flags = serde_json::from_str::<serde_json::Value>(flags_json)
            .ok()
            .and_then(|value| match value {
                serde_json::Value::Object(map) => Some(map),
                _ => None,
            })
            .unwrap_or_default();
        if !update(&mut flags) {
            continue;
        }
        let serialized = serde_json::Value::Object(flags).to_string();
        connection.execute(
            "UPDATE message_sources
             SET flags_json = ?1,
                 last_seen_at = ?2
             WHERE id = ?3",
            params![serialized, now, source_row_id],
        )?;
        changed_count += 1;
    }

    Ok(changed_count)
}

fn update_message_source_flags<F>(
    connection: &Connection,
    message_id: &str,
    now: &str,
    mut update: F,
) -> Result<bool>
where
    F: FnMut(&mut serde_json::Map<String, serde_json::Value>),
{
    let mut statement = connection.prepare(
        "SELECT message_sources.id AS source_row_id,
                message_sources.flags_json AS flags_json
         FROM message_sources
         INNER JOIN messages ON messages.id = message_sources.message_id
         WHERE message_sources.message_id = ?1
           AND messages.deleted_at IS NULL",
    )?;

    let source_rows = statement
        .query_map(params![message_id], |row| {
            Ok((
                row.get::<_, String>("source_row_id")?,
                row.get::<_, String>("flags_json")?,
            ))
        })?
        .collect::<Result<Vec<_>>>()?;

    for (source_row_id, flags_json) in &source_rows {
        let mut flags = serde_json::from_str::<serde_json::Value>(flags_json)
            .ok()
            .and_then(|value| match value {
                serde_json::Value::Object(map) => Some(map),
                _ => None,
            })
            .unwrap_or_default();
        update(&mut flags);
        let serialized = serde_json::Value::Object(flags).to_string();
        connection.execute(
            "UPDATE message_sources
             SET flags_json = ?1,
                 last_seen_at = ?2
             WHERE id = ?3",
            params![serialized, now, source_row_id],
        )?;
    }

    Ok(!source_rows.is_empty())
}

pub fn get_message_for_agent_association(
    connection: &Connection,
    message_id: &str,
) -> Result<Option<AgentAssociationMessageRow>> {
    connection
        .query_row(
            "SELECT
                id AS message_id,
                subject,
                from_address,
                snippet,
                body_text_cache AS body_text
             FROM messages
             WHERE id = ?1
               AND deleted_at IS NULL",
            params![message_id],
            |row| {
                Ok(AgentAssociationMessageRow {
                    message_id: row.get("message_id")?,
                    subject: row.get("subject")?,
                    from_address: row.get("from_address")?,
                    snippet: row.get("snippet")?,
                    body_text: row.get("body_text")?,
                })
            },
        )
        .optional()
}

pub fn insert_outgoing_message(
    connection: &Connection,
    message: NewOutgoingMessage,
) -> Result<OutgoingMessageRow> {
    let NewOutgoingMessage {
        account_id,
        source_id,
        from_address,
        target_address,
        subject,
        body_text,
        now,
    } = message;
    let message_id = format!("msg_{}", Uuid::new_v4());
    let snippet: String = body_text.chars().take(180).collect();
    connection.execute(
        "INSERT INTO messages (
            id,
            subject,
            from_address,
            snippet,
            body_text_cache,
            body_cache_state,
            classification,
            created_at,
            updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, 'cached', 'outgoing', ?6, ?6)",
        params![message_id, subject, from_address, snippet, body_text, now,],
    )?;
    connection.execute(
        "INSERT INTO message_sources (
            id,
            message_id,
            source_id,
            account_id,
            received_address,
            first_seen_at,
            last_seen_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
        params![
            format!("msrc_{}", Uuid::new_v4()),
            message_id,
            source_id,
            account_id,
            target_address,
            now,
        ],
    )?;

    Ok(OutgoingMessageRow {
        id: message_id,
        account_id,
        source_id,
        target_address,
        subject,
        body_text,
        created_at: now,
    })
}

pub fn upsert_local_draft_message(
    connection: &Connection,
    draft: NewLocalDraftMessage,
) -> Result<OutgoingMessageRow> {
    let NewLocalDraftMessage {
        draft_id,
        account_id,
        source_id,
        from_address,
        target_address,
        cc_addresses,
        bcc_addresses,
        subject,
        body_text,
        body_html,
        now,
    } = draft;
    let transaction = connection.unchecked_transaction()?;
    let message_id = match draft_id {
        Some(candidate_id) if existing_message_is_local_draft(&transaction, &candidate_id)? => {
            candidate_id
        }
        Some(candidate_id) if !message_exists(&transaction, &candidate_id)? => candidate_id,
        _ => format!("msg_{}", Uuid::new_v4()),
    };
    let snippet: String = body_text.chars().take(180).collect();
    let flags_json = json!({
        "local_folder": "drafts",
        "read": true,
        "draft_cc_addresses": cc_addresses,
        "draft_bcc_addresses": bcc_addresses,
    })
    .to_string();

    transaction.execute(
        "INSERT INTO messages (
            id,
            subject,
            from_address,
            snippet,
            body_text_cache,
            body_html_cache,
            body_cache_state,
            classification,
            created_at,
            updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'cached', 'outgoing', ?7, ?7)
        ON CONFLICT(id) DO UPDATE SET
            subject = excluded.subject,
            from_address = excluded.from_address,
            snippet = excluded.snippet,
            body_text_cache = excluded.body_text_cache,
            body_html_cache = excluded.body_html_cache,
            body_cache_state = 'cached',
            classification = 'outgoing',
            updated_at = excluded.updated_at,
            deleted_at = NULL",
        params![
            message_id,
            subject,
            from_address,
            snippet,
            body_text,
            body_html,
            now,
        ],
    )?;

    let existing_source_id: Option<String> = transaction
        .query_row(
            "SELECT id FROM message_sources WHERE message_id = ?1 LIMIT 1",
            params![message_id],
            |row| row.get(0),
        )
        .optional()?;

    if let Some(existing_source_id) = existing_source_id {
        transaction.execute(
            "UPDATE message_sources
             SET source_id = ?1,
                 account_id = ?2,
                 received_address = ?3,
                 flags_json = ?4,
                 last_seen_at = ?5
             WHERE id = ?6",
            params![
                source_id,
                account_id,
                target_address,
                flags_json,
                now,
                existing_source_id,
            ],
        )?;
    } else {
        transaction.execute(
            "INSERT INTO message_sources (
                id,
                message_id,
                source_id,
                account_id,
                received_address,
                flags_json,
                first_seen_at,
                last_seen_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
            params![
                format!("msrc_{}", Uuid::new_v4()),
                message_id,
                source_id,
                account_id,
                target_address,
                flags_json,
                now,
            ],
        )?;
    }
    transaction.commit()?;

    Ok(OutgoingMessageRow {
        id: message_id,
        account_id,
        source_id,
        target_address,
        subject,
        body_text,
        created_at: now,
    })
}

pub fn delete_local_draft_message(
    connection: &Connection,
    message_id: &str,
    now: &str,
) -> Result<bool> {
    let changed = connection.execute(
        "UPDATE messages
         SET deleted_at = ?1,
             updated_at = ?1
         WHERE id = ?2
           AND deleted_at IS NULL
           AND EXISTS (
             SELECT 1
             FROM message_sources
             WHERE message_sources.message_id = messages.id
               AND json_extract(message_sources.flags_json, '$.local_folder') = 'drafts'
           )",
        params![now, message_id],
    )?;
    Ok(changed > 0)
}

pub fn convert_scheduled_send_to_local_draft(
    connection: &Connection,
    message_id: &str,
    cc_addresses: &[String],
    bcc_addresses: &[String],
    now: &str,
) -> Result<bool> {
    let flags_json = json!({
        "local_folder": "drafts",
        "read": true,
        "draft_cc_addresses": cc_addresses,
        "draft_bcc_addresses": bcc_addresses,
    })
    .to_string();

    let changed = connection.execute(
        "UPDATE message_sources
         SET flags_json = ?1,
             last_seen_at = ?2
         WHERE message_id = ?3
           AND EXISTS (
             SELECT 1
             FROM messages
             INNER JOIN mailbox_sources ON mailbox_sources.id = message_sources.source_id
             WHERE messages.id = message_sources.message_id
               AND messages.classification = 'outgoing'
               AND messages.deleted_at IS NULL
               AND mailbox_sources.source_kind = 'smtp'
           )",
        params![flags_json, now, message_id],
    )?;

    Ok(changed > 0)
}

fn draft_address_list_from_flags(flags_json: &str, key: &str) -> Vec<String> {
    serde_json::from_str::<serde_json::Value>(flags_json)
        .ok()
        .and_then(|value| value.get(key).cloned())
        .and_then(|value| value.as_array().cloned())
        .map(|items| {
            items
                .iter()
                .filter_map(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn message_exists(connection: &Connection, message_id: &str) -> Result<bool> {
    connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM messages WHERE id = ?1)",
        params![message_id],
        |row| row.get(0),
    )
}

fn existing_message_is_local_draft(connection: &Connection, message_id: &str) -> Result<bool> {
    connection.query_row(
        "SELECT EXISTS(
            SELECT 1
            FROM messages
            INNER JOIN message_sources ON message_sources.message_id = messages.id
            WHERE messages.id = ?1
              AND json_extract(message_sources.flags_json, '$.local_folder') = 'drafts'
        )",
        params![message_id],
        |row| row.get(0),
    )
}

fn observed_snippet(observed: &EasyEmailObservedMessage) -> String {
    let source = observed
        .text_body
        .as_deref()
        .or(observed.html_body.as_deref())
        .or(observed.subject.as_deref())
        .unwrap_or("");
    source.chars().take(180).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::message::Message;
    use crate::domain::temp_mailbox::TempMailbox;
    use crate::storage::db::open_in_memory_database;
    use crate::storage::migrations::run_migrations;
    use crate::storage::temp_mailbox_repository::insert_temp_mailbox;

    #[test]
    fn message_source_keeps_temp_mailbox_id() {
        let connection = open_in_memory_database().expect("open database");
        run_migrations(&connection).expect("run migrations");

        let temp = TempMailbox::new_anonymous(
            "code@example.test".to_string(),
            "fake".to_string(),
            "Fake Provider".to_string(),
            "2026-06-11T00:00:00Z".to_string(),
        );
        insert_temp_mailbox(&connection, &temp).expect("insert temp mailbox");

        connection
            .execute(
                "INSERT INTO mailbox_sources (
                    id,
                    source_kind,
                    provider_id,
                    status,
                    created_at,
                    updated_at
                ) VALUES ('src_1', 'easyemail_temp', 'fake', 'ready', '2026-06-11T00:00:00Z', '2026-06-11T00:00:00Z')",
                [],
            )
            .expect("insert source");

        let message = Message::new(
            "Your code is 123456".to_string(),
            "noreply@example.test".to_string(),
            "Code 123456".to_string(),
            "2026-06-11T00:00:01Z".to_string(),
        );
        insert_message(&connection, &message).expect("insert message");

        let source = create_temp_message_source(
            message.id.clone(),
            "src_1".to_string(),
            temp.id.clone(),
            "provider_msg_1".to_string(),
            "code@example.test".to_string(),
            "2026-06-11T00:00:02Z".to_string(),
        );
        insert_message_source(&connection, &source).expect("insert message source");

        let stored_temp_id: String = connection
            .query_row(
                "SELECT temp_mailbox_id FROM message_sources WHERE message_id = ?1",
                params![message.id],
                |row| row.get(0),
            )
            .expect("select temp mailbox id");

        assert_eq!(stored_temp_id, temp.id);
    }

    #[test]
    fn ensure_easyemail_temp_source_is_idempotent_for_stale_mailbox_snapshot() {
        let connection = open_in_memory_database().expect("open database");
        run_migrations(&connection).expect("run migrations");
        let temp = TempMailbox::from_easyemail(
            "stale@example.test".to_string(),
            "mailtm".to_string(),
            "Mail.tm".to_string(),
            Some("session_stale".to_string()),
            None,
            "{}".to_string(),
            "2026-06-12T00:00:00Z".to_string(),
        );
        insert_temp_mailbox(&connection, &temp).expect("insert temp mailbox");
        let stale_row =
            crate::storage::temp_mailbox_repository::get_temp_mailbox(&connection, &temp.id)
                .expect("load temp")
                .expect("temp exists");

        let first = ensure_easyemail_temp_source(&connection, &stale_row, "2026-06-12T00:01:00Z")
            .expect("create source");
        let second = ensure_easyemail_temp_source(&connection, &stale_row, "2026-06-12T00:02:00Z")
            .expect("reuse source");
        let source_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM mailbox_sources WHERE source_kind = 'easyemail_temp'",
                [],
                |row| row.get(0),
            )
            .expect("count sources");

        assert_eq!(second, first);
        assert_eq!(source_count, 1);
    }

    #[test]
    fn fetch_temp_messages_inserts_messages_and_sources() {
        let connection = open_in_memory_database().expect("open database");
        run_migrations(&connection).expect("run migrations");
        let temp = TempMailbox::from_easyemail(
            "code@example.test".to_string(),
            "mailtm".to_string(),
            "Mail.tm".to_string(),
            Some("session_1".to_string()),
            None,
            "{}".to_string(),
            "2026-06-12T00:00:00Z".to_string(),
        );
        insert_temp_mailbox(&connection, &temp).expect("insert temp mailbox");
        let row = crate::storage::temp_mailbox_repository::get_temp_mailbox(&connection, &temp.id)
            .expect("load temp")
            .expect("temp exists");
        let source_id = ensure_easyemail_temp_source(&connection, &row, "2026-06-12T00:01:00Z")
            .expect("ensure source");
        let messages = vec![observed_message("observed_1", "session_1")];

        let result = persist_observed_messages(
            &connection,
            &row,
            &source_id,
            &messages,
            "2026-06-12T00:02:00Z",
        )
        .expect("persist observed messages");

        let message_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM messages", [], |row| row.get(0))
            .expect("count messages");
        let source_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM message_sources", [], |row| row.get(0))
            .expect("count message sources");
        assert_eq!(result.fetched_count, 1);
        assert_eq!(result.inserted_count, 1);
        assert_eq!(message_count, 1);
        assert_eq!(source_count, 1);
    }

    #[test]
    fn fetch_temp_messages_is_idempotent() {
        let connection = open_in_memory_database().expect("open database");
        run_migrations(&connection).expect("run migrations");
        let temp = TempMailbox::from_easyemail(
            "code@example.test".to_string(),
            "mailtm".to_string(),
            "Mail.tm".to_string(),
            Some("session_1".to_string()),
            None,
            "{}".to_string(),
            "2026-06-12T00:00:00Z".to_string(),
        );
        insert_temp_mailbox(&connection, &temp).expect("insert temp mailbox");
        let row = crate::storage::temp_mailbox_repository::get_temp_mailbox(&connection, &temp.id)
            .expect("load temp")
            .expect("temp exists");
        let source_id = ensure_easyemail_temp_source(&connection, &row, "2026-06-12T00:01:00Z")
            .expect("ensure source");
        let messages = vec![observed_message("observed_1", "session_1")];

        persist_observed_messages(
            &connection,
            &row,
            &source_id,
            &messages,
            "2026-06-12T00:02:00Z",
        )
        .expect("first persist");
        let second = persist_observed_messages(
            &connection,
            &row,
            &source_id,
            &messages,
            "2026-06-12T00:03:00Z",
        )
        .expect("second persist");

        let message_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM messages", [], |row| row.get(0))
            .expect("count messages");
        let source_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM message_sources", [], |row| row.get(0))
            .expect("count message sources");
        assert_eq!(second.fetched_count, 1);
        assert_eq!(second.inserted_count, 0);
        assert_eq!(message_count, 1);
        assert_eq!(source_count, 1);
    }

    /// The `messages` insert happens before the `message_sources` insert, so a
    /// failure on the second one would leave an orphaned message row behind if
    /// the batch were not wrapped in a transaction.
    #[test]
    fn failed_imap_header_batch_leaves_no_partial_rows() {
        let connection = open_in_memory_database().expect("open database");
        run_migrations(&connection).expect("run migrations");
        let (account_id, source_id, _folder_id) = seed_imap_identity(&connection);
        let header = imap_header("uid-1", "Subject", "sender@example.test");

        let result = persist_imap_headers(
            &connection,
            &account_id,
            &source_id,
            "folder_does_not_exist",
            &[header],
            "2026-06-12T00:02:00Z",
        );

        assert!(
            result.is_err(),
            "expected the foreign key violation to fail"
        );

        let message_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM messages", [], |row| row.get(0))
            .expect("count messages");
        let source_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM message_sources", [], |row| row.get(0))
            .expect("count message sources");

        assert_eq!(
            message_count, 0,
            "the messages insert should have rolled back"
        );
        assert_eq!(source_count, 0);
    }

    #[test]
    fn imap_header_resync_refreshes_decoded_header_fields() {
        let connection = open_in_memory_database().expect("open database");
        run_migrations(&connection).expect("run migrations");
        let (account_id, source_id, folder_id) = seed_imap_identity(&connection);
        let garbled = imap_header("uid-1", "ÄãºÃ", "ÕÅÈý <sender@example.test>");

        persist_imap_headers(
            &connection,
            &account_id,
            &source_id,
            &folder_id,
            &[garbled],
            "2026-06-12T00:02:00Z",
        )
        .expect("first persist");
        let corrected = imap_header("uid-1", "你好", "张三 <sender@example.test>");
        let second = persist_imap_headers(
            &connection,
            &account_id,
            &source_id,
            &folder_id,
            &[corrected],
            "2026-06-12T00:03:00Z",
        )
        .expect("second persist");

        let stored: (String, String, String) = connection
            .query_row(
                "SELECT subject, from_address, snippet FROM messages LIMIT 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("read stored message");

        assert_eq!(second.inserted_count, 0);
        assert_eq!(stored.0, "你好");
        assert_eq!(stored.1, "张三 <sender@example.test>");
        assert_eq!(stored.2, "张三 <sender@example.test> / 你好");
    }

    #[test]
    fn imap_headers_persist_rfc_thread_key_for_reply_conversations() {
        let connection = open_in_memory_database().expect("open database");
        run_migrations(&connection).expect("run migrations");
        let (account_id, source_id, folder_id) = seed_imap_identity(&connection);
        let mut root = imap_header("uid-root", "Project update", "Alice <alice@example.test>");
        root.message_id = Some("root@example.test".to_string());
        let mut reply = imap_header("uid-reply", "Re: Project update", "Bob <bob@example.test>");
        reply.message_id = Some("reply@example.test".to_string());
        reply.in_reply_to = Some("root@example.test".to_string());
        reply.references = vec!["root@example.test".to_string()];

        persist_imap_headers(
            &connection,
            &account_id,
            &source_id,
            &folder_id,
            &[root, reply],
            "2026-06-12T00:02:00Z",
        )
        .expect("persist threaded headers");

        let rows = list_normal_account_messages(&connection, &account_id).expect("list messages");
        assert_eq!(rows.len(), 2);
        assert_eq!(
            rows[0].thread_key,
            Some("rfc:root@example.test".to_string())
        );
        assert_eq!(
            rows[1].thread_key,
            Some("rfc:root@example.test".to_string())
        );
        let detail = get_message_detail(&connection, &rows[0].message_id)
            .expect("load detail")
            .expect("detail exists");
        assert_eq!(detail.thread_key, Some("rfc:root@example.test".to_string()));
    }

    #[test]
    fn imap_header_resync_without_message_id_preserves_existing_thread_identity() {
        let connection = open_in_memory_database().expect("open database");
        run_migrations(&connection).expect("run migrations");
        let (account_id, source_id, folder_id) = seed_imap_identity(&connection);
        let mut first = imap_header(
            "uid-stable-thread",
            "Project update",
            "Alice <alice@example.test>",
        );
        first.message_id = Some("stable-root@example.test".to_string());

        persist_imap_headers(
            &connection,
            &account_id,
            &source_id,
            &folder_id,
            &[first],
            "2026-06-12T00:02:00Z",
        )
        .expect("first persist");

        let mut resync = imap_header(
            "uid-stable-thread",
            "Project update",
            "Alice <alice@example.test>",
        );
        resync.message_id = None;
        persist_imap_headers(
            &connection,
            &account_id,
            &source_id,
            &folder_id,
            &[resync],
            "2026-06-12T00:03:00Z",
        )
        .expect("resync without message id");

        let stored: (Option<String>, Option<String>) = connection
            .query_row(
                "SELECT rfc_message_id, thread_key FROM messages LIMIT 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read stored thread identity");

        assert_eq!(stored.0, Some("stable-root@example.test".to_string()));
        assert_eq!(stored.1, Some("rfc:stable-root@example.test".to_string()));
    }

    #[test]
    fn soft_deleted_imap_message_is_hidden_from_lists() {
        let connection = open_in_memory_database().expect("open database");
        run_migrations(&connection).expect("run migrations");
        let (account_id, source_id, folder_id) = seed_imap_identity(&connection);
        persist_imap_headers(
            &connection,
            &account_id,
            &source_id,
            &folder_id,
            &[imap_header(
                "uid-delete",
                "Delete me",
                "sender@example.test",
            )],
            "2026-06-12T00:02:00Z",
        )
        .expect("persist imap header");
        let message_id = list_normal_account_messages(&connection, &account_id)
            .expect("list before delete")[0]
            .message_id
            .clone();

        let changed = soft_delete_message(&connection, &message_id, "2026-06-12T00:03:00Z")
            .expect("soft delete");
        let rows_after_delete =
            list_normal_account_messages(&connection, &account_id).expect("list after delete");

        assert!(changed);
        assert!(rows_after_delete.is_empty());
    }

    #[test]
    fn archived_imap_message_is_hidden_from_lists_until_unarchived() {
        let connection = open_in_memory_database().expect("open database");
        run_migrations(&connection).expect("run migrations");
        let (account_id, source_id, folder_id) = seed_imap_identity(&connection);
        persist_imap_headers(
            &connection,
            &account_id,
            &source_id,
            &folder_id,
            &[imap_header(
                "uid-archive",
                "Archive me",
                "sender@example.test",
            )],
            "2026-06-12T00:02:00Z",
        )
        .expect("persist imap header");
        let message_id = list_normal_account_messages(&connection, &account_id)
            .expect("list before archive")[0]
            .message_id
            .clone();

        let archived = set_message_source_flag(
            &connection,
            &message_id,
            "archived",
            true,
            "2026-06-12T00:03:00Z",
        )
        .expect("archive");
        let rows_after_archive =
            list_normal_account_messages(&connection, &account_id).expect("list after archive");
        let unarchived = set_message_source_flag(
            &connection,
            &message_id,
            "archived",
            false,
            "2026-06-12T00:04:00Z",
        )
        .expect("unarchive");
        let rows_after_unarchive =
            list_normal_account_messages(&connection, &account_id).expect("list after unarchive");

        assert!(archived);
        assert!(rows_after_archive.is_empty());
        assert!(unarchived);
        assert_eq!(rows_after_unarchive.len(), 1);
    }

    #[test]
    fn normal_account_messages_can_include_archived_for_all_mail_views() {
        let connection = open_in_memory_database().expect("open database");
        run_migrations(&connection).expect("run migrations");
        let (account_id, source_id, folder_id) = seed_imap_identity(&connection);
        persist_imap_headers(
            &connection,
            &account_id,
            &source_id,
            &folder_id,
            &[imap_header(
                "uid-archive-all",
                "Archive still belongs in all mail",
                "sender@example.test",
            )],
            "2026-06-12T00:02:00Z",
        )
        .expect("persist imap header");
        let message_id = list_normal_account_messages(&connection, &account_id)
            .expect("list before archive")[0]
            .message_id
            .clone();

        let archived = set_message_source_flag(
            &connection,
            &message_id,
            "archived",
            true,
            "2026-06-12T00:03:00Z",
        )
        .expect("archive");
        let inbox_rows =
            list_normal_account_messages(&connection, &account_id).expect("list after archive");
        let all_mail_rows =
            list_normal_account_messages_with_options(&connection, &account_id, true)
                .expect("list all mail");

        assert!(archived);
        assert!(inbox_rows.is_empty());
        assert_eq!(all_mail_rows.len(), 1);
        assert!(all_mail_rows[0].local_state.is_archived);
    }

    #[test]
    fn normal_account_messages_expose_read_state_from_local_flags() {
        let connection = open_in_memory_database().expect("open database");
        run_migrations(&connection).expect("run migrations");
        let (account_id, source_id, folder_id) = seed_imap_identity(&connection);
        persist_imap_headers(
            &connection,
            &account_id,
            &source_id,
            &folder_id,
            &[imap_header("uid-read", "Read state", "sender@example.test")],
            "2026-06-12T00:02:00Z",
        )
        .expect("persist imap header");
        let message_id = list_normal_account_messages(&connection, &account_id)
            .expect("list default")[0]
            .message_id
            .clone();

        let default_rows = list_normal_account_messages(&connection, &account_id)
            .expect("list default read state");
        set_message_source_flag(
            &connection,
            &message_id,
            "read",
            true,
            "2026-06-12T00:03:00Z",
        )
        .expect("mark read");
        let read_rows =
            list_normal_account_messages(&connection, &account_id).expect("list read state");
        set_message_source_flag(
            &connection,
            &message_id,
            "read",
            false,
            "2026-06-12T00:04:00Z",
        )
        .expect("mark unread");
        let unread_rows =
            list_normal_account_messages(&connection, &account_id).expect("list unread state");

        assert!(!default_rows[0].local_state.is_read);
        assert!(read_rows[0].local_state.is_read);
        assert!(!unread_rows[0].local_state.is_read);
    }

    #[test]
    fn local_folder_and_label_actions_update_message_local_state() {
        let connection = open_in_memory_database().expect("open database");
        run_migrations(&connection).expect("run migrations");
        let (account_id, source_id, folder_id) = seed_imap_identity(&connection);
        persist_imap_headers(
            &connection,
            &account_id,
            &source_id,
            &folder_id,
            &[imap_header(
                "uid-label",
                "Label state",
                "sender@example.test",
            )],
            "2026-06-12T00:02:00Z",
        )
        .expect("persist imap header");
        let message_id = list_normal_account_messages(&connection, &account_id)
            .expect("list before label")[0]
            .message_id
            .clone();

        set_message_source_folder(&connection, &message_id, "later", "2026-06-12T00:03:00Z")
            .expect("move to later");
        set_message_source_label(
            &connection,
            &message_id,
            "Follow up",
            true,
            "2026-06-12T00:04:00Z",
        )
        .expect("add label");
        let labeled_rows =
            list_normal_account_messages(&connection, &account_id).expect("list labeled message");
        set_message_source_label(
            &connection,
            &message_id,
            "Follow up",
            false,
            "2026-06-12T00:05:00Z",
        )
        .expect("remove label");
        let unlabeled_rows =
            list_normal_account_messages(&connection, &account_id).expect("list unlabeled message");

        assert_eq!(labeled_rows[0].local_state.local_folder, "later");
        assert_eq!(
            labeled_rows[0].local_state.labels,
            vec!["Follow up".to_string()]
        );
        assert!(unlabeled_rows[0].local_state.labels.is_empty());
    }

    #[test]
    fn taxonomy_folder_rename_and_delete_updates_message_local_folder_state() {
        let connection = open_in_memory_database().expect("open database");
        run_migrations(&connection).expect("run migrations");
        let (account_id, source_id, folder_id) = seed_imap_identity(&connection);
        persist_imap_headers(
            &connection,
            &account_id,
            &source_id,
            &folder_id,
            &[imap_header(
                "uid-custom-folder",
                "Custom folder state",
                "sender@example.test",
            )],
            "2026-06-12T00:02:00Z",
        )
        .expect("persist imap header");
        let message_id = list_normal_account_messages(&connection, &account_id)
            .expect("list before folder change")[0]
            .message_id
            .clone();

        set_message_source_folder(&connection, &message_id, "Receipts", "2026-06-12T00:03:00Z")
            .expect("move to custom folder");
        replace_message_source_folder_name(
            &connection,
            "Receipts",
            "Invoices",
            "2026-06-12T00:04:00Z",
        )
        .expect("rename folder on messages");
        let renamed_rows =
            list_normal_account_messages(&connection, &account_id).expect("list renamed folder");
        clear_message_source_folder_name(&connection, "Invoices", "2026-06-12T00:05:00Z")
            .expect("delete folder from messages");
        let cleared_rows =
            list_normal_account_messages(&connection, &account_id).expect("list cleared folder");

        assert_eq!(renamed_rows[0].local_state.local_folder, "invoices");
        assert_eq!(cleared_rows[0].local_state.local_folder, "inbox");
    }

    #[test]
    fn taxonomy_label_rename_and_delete_updates_message_label_state() {
        let connection = open_in_memory_database().expect("open database");
        run_migrations(&connection).expect("run migrations");
        let (account_id, source_id, folder_id) = seed_imap_identity(&connection);
        persist_imap_headers(
            &connection,
            &account_id,
            &source_id,
            &folder_id,
            &[imap_header(
                "uid-custom-label",
                "Custom label state",
                "sender@example.test",
            )],
            "2026-06-12T00:02:00Z",
        )
        .expect("persist imap header");
        let message_id = list_normal_account_messages(&connection, &account_id)
            .expect("list before label change")[0]
            .message_id
            .clone();

        set_message_source_label(
            &connection,
            &message_id,
            "Client",
            true,
            "2026-06-12T00:03:00Z",
        )
        .expect("add custom label");
        replace_message_source_label_name(
            &connection,
            "Client",
            "Customer",
            "2026-06-12T00:04:00Z",
        )
        .expect("rename label on messages");
        let renamed_rows =
            list_normal_account_messages(&connection, &account_id).expect("list renamed label");
        clear_message_source_label_name(&connection, "Customer", "2026-06-12T00:05:00Z")
            .expect("delete label from messages");
        let cleared_rows =
            list_normal_account_messages(&connection, &account_id).expect("list cleared label");

        assert_eq!(
            renamed_rows[0].local_state.labels,
            vec!["Customer".to_string()]
        );
        assert!(cleared_rows[0].local_state.labels.is_empty());
    }

    #[test]
    fn imap_newsletter_headers_add_newsletters_label() {
        let connection = open_in_memory_database().expect("open database");
        run_migrations(&connection).expect("run migrations");
        let (account_id, source_id, folder_id) = seed_imap_identity(&connection);
        let mut header = imap_header("uid-newsletter", "Product update", "updates@example.test");
        header.list_id = Some("Example Updates <updates.example.test>".to_string());
        header.list_unsubscribe = Some("<mailto:unsubscribe@example.test>".to_string());

        persist_imap_headers(
            &connection,
            &account_id,
            &source_id,
            &folder_id,
            &[header],
            "2026-06-12T00:02:00Z",
        )
        .expect("persist newsletter header");

        let rows = list_normal_account_messages(&connection, &account_id).expect("list messages");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].local_state.local_folder, "inbox");
        assert!(rows[0]
            .local_state
            .labels
            .contains(&"newsletters".to_string()));
    }

    #[test]
    fn imap_header_resync_adds_newsletter_label_to_existing_message() {
        let connection = open_in_memory_database().expect("open database");
        run_migrations(&connection).expect("run migrations");
        let (account_id, source_id, folder_id) = seed_imap_identity(&connection);

        persist_imap_headers(
            &connection,
            &account_id,
            &source_id,
            &folder_id,
            &[imap_header(
                "uid-newsletter",
                "Product update",
                "updates@example.test",
            )],
            "2026-06-12T00:02:00Z",
        )
        .expect("first persist");
        let mut header = imap_header("uid-newsletter", "Product update", "updates@example.test");
        header.list_unsubscribe = Some("<mailto:unsubscribe@example.test>".to_string());

        persist_imap_headers(
            &connection,
            &account_id,
            &source_id,
            &folder_id,
            &[header],
            "2026-06-12T00:03:00Z",
        )
        .expect("second persist");

        let rows = list_normal_account_messages(&connection, &account_id).expect("list messages");
        assert_eq!(rows.len(), 1);
        assert!(rows[0]
            .local_state
            .labels
            .contains(&"newsletters".to_string()));
    }

    #[test]
    fn imap_spam_folder_sets_local_folder_to_spam() {
        let connection = open_in_memory_database().expect("open database");
        run_migrations(&connection).expect("run migrations");
        let (account_id, source_id, _inbox_folder_id) = seed_imap_identity(&connection);
        let spam_folder_id = seed_imap_folder(&connection, &account_id, &source_id, "Spam", "spam");

        persist_imap_headers(
            &connection,
            &account_id,
            &source_id,
            &spam_folder_id,
            &[imap_header(
                "uid-spam",
                "Suspicious offer",
                "bad@example.test",
            )],
            "2026-06-12T00:02:00Z",
        )
        .expect("persist spam header");

        let rows = list_normal_account_messages(&connection, &account_id).expect("list messages");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].local_state.local_folder, "spam");
    }

    #[test]
    fn newsletter_subscriptions_are_grouped_by_list_id_with_counts() {
        let connection = open_in_memory_database().expect("open database");
        run_migrations(&connection).expect("run migrations");
        let (account_id, source_id, folder_id) = seed_imap_identity(&connection);
        let mut first = imap_header_with_date(
            "uid-newsletter-1",
            "Product update 1",
            "Example Updates <updates@example.test>",
            "2026-06-12T00:10:00Z",
        );
        first.list_id = Some("Example Updates <updates.example.test>".to_string());
        first.list_unsubscribe = Some("<mailto:unsubscribe@example.test>".to_string());
        let mut second = imap_header_with_date(
            "uid-newsletter-2",
            "Product update 2",
            "Example Updates <updates@example.test>",
            "2026-06-12T00:20:00Z",
        );
        second.list_id = Some("Example Updates <updates.example.test>".to_string());
        second.list_unsubscribe = Some("<mailto:unsubscribe@example.test>".to_string());

        persist_imap_headers(
            &connection,
            &account_id,
            &source_id,
            &folder_id,
            &[first, second],
            "2026-06-12T00:30:00Z",
        )
        .expect("persist newsletter headers");
        let messages =
            list_normal_account_messages(&connection, &account_id).expect("list messages");
        set_message_source_flag(
            &connection,
            &messages[0].message_id,
            "read",
            true,
            "2026-06-12T00:31:00Z",
        )
        .expect("mark newest read");

        let subscriptions =
            list_newsletter_subscriptions(&connection, &account_id).expect("list subscriptions");

        assert_eq!(subscriptions.len(), 1);
        assert_eq!(
            subscriptions[0].list_id,
            "Example Updates <updates.example.test>"
        );
        assert_eq!(
            subscriptions[0].sender_address,
            "Example Updates <updates@example.test>"
        );
        assert_eq!(subscriptions[0].name, "Example Updates");
        assert_eq!(subscriptions[0].received_message_count, 2);
        assert_eq!(subscriptions[0].unread_message_count, 1);
        assert_eq!(subscriptions[0].last_received_at, "2026-06-12T00:20:00Z");
        assert_eq!(
            subscriptions[0].unsubscribe_methods,
            vec!["<mailto:unsubscribe@example.test>".to_string()]
        );
    }

    #[test]
    fn newsletter_subscription_hidden_override_is_persistent_and_reversible() {
        let connection = open_in_memory_database().expect("open database");
        run_migrations(&connection).expect("run migrations");
        let (account_id, source_id, folder_id) = seed_imap_identity(&connection);
        let mut header = imap_header(
            "uid-newsletter-hidden",
            "Product update",
            "Example Updates <updates@example.test>",
        );
        header.list_id = Some("Example Updates <updates.example.test>".to_string());
        header.list_unsubscribe = Some("<mailto:unsubscribe@example.test>".to_string());

        persist_imap_headers(
            &connection,
            &account_id,
            &source_id,
            &folder_id,
            &[header],
            "2026-06-12T00:30:00Z",
        )
        .expect("persist newsletter header");
        let subscription_id = list_newsletter_subscriptions(&connection, &account_id)
            .expect("list subscriptions before hide")[0]
            .id
            .clone();

        let hidden = set_newsletter_subscription_hidden(
            &connection,
            &account_id,
            &subscription_id,
            true,
            "2026-06-12T00:31:00Z",
        )
        .expect("hide subscription");
        let hidden_rows =
            list_newsletter_subscriptions(&connection, &account_id).expect("list after hide");
        let restored = set_newsletter_subscription_hidden(
            &connection,
            &account_id,
            &subscription_id,
            false,
            "2026-06-12T00:32:00Z",
        )
        .expect("restore subscription");
        let restored_rows =
            list_newsletter_subscriptions(&connection, &account_id).expect("list after restore");

        assert!(hidden);
        assert!(hidden_rows[0].hidden);
        assert!(restored);
        assert!(!restored_rows[0].hidden);
    }

    #[test]
    fn newsletter_override_rejects_unknown_subscription_ids() {
        let connection = open_in_memory_database().expect("open database");
        run_migrations(&connection).expect("run migrations");
        let (account_id, _, _) = seed_imap_identity(&connection);

        let changed = set_newsletter_subscription_hidden(
            &connection,
            &account_id,
            "list:attacker-controlled",
            true,
            "2026-06-12T00:31:00Z",
        )
        .expect("reject unknown subscription");
        let override_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM newsletter_subscription_overrides",
                [],
                |row| row.get(0),
            )
            .expect("count overrides");

        assert!(!changed);
        assert_eq!(override_count, 0);
    }

    #[test]
    fn normal_account_messages_expose_newsletter_subscription_id_for_filtering() {
        let connection = open_in_memory_database().expect("open database");
        run_migrations(&connection).expect("run migrations");
        let (account_id, source_id, folder_id) = seed_imap_identity(&connection);
        let mut header = imap_header(
            "uid-newsletter-filter",
            "Product update",
            "Example Updates <updates@example.test>",
        );
        header.list_id = Some("Example Updates <updates.example.test>".to_string());
        header.list_unsubscribe = Some("<mailto:unsubscribe@example.test>".to_string());

        persist_imap_headers(
            &connection,
            &account_id,
            &source_id,
            &folder_id,
            &[header],
            "2026-06-12T00:30:00Z",
        )
        .expect("persist newsletter header");

        let rows = list_normal_account_messages(&connection, &account_id).expect("list messages");

        assert_eq!(
            rows[0].local_state.newsletter_subscription_id,
            Some("list:example updates <updates.example.test>".to_string())
        );
    }

    #[test]
    fn normal_account_messages_are_sorted_newest_first() {
        let connection = open_in_memory_database().expect("open database");
        run_migrations(&connection).expect("run migrations");
        let (account_id, source_id, folder_id) = seed_imap_identity(&connection);
        persist_imap_headers(
            &connection,
            &account_id,
            &source_id,
            &folder_id,
            &[
                imap_header_with_date("uid-old", "Old", "old@example.test", "2026-06-12T00:02:00Z"),
                imap_header_with_date("uid-new", "New", "new@example.test", "2026-06-12T00:05:00Z"),
            ],
            "2026-06-12T00:06:00Z",
        )
        .expect("persist imap headers");

        let rows =
            list_normal_account_messages(&connection, &account_id).expect("list sorted messages");

        assert_eq!(rows[0].subject, "New");
        assert_eq!(rows[1].subject, "Old");
    }

    #[test]
    fn normal_account_messages_sort_rfc2822_dates_by_real_time_not_weekday_text() {
        let connection = open_in_memory_database().expect("open database");
        run_migrations(&connection).expect("run migrations");
        let (account_id, source_id, folder_id) = seed_imap_identity(&connection);
        persist_imap_headers(
            &connection,
            &account_id,
            &source_id,
            &folder_id,
            &[
                imap_header_with_date(
                    "uid-real-new",
                    "Real newest",
                    "new@example.test",
                    "Fri, 03 Apr 2026 06:18:51 +0000 (UTC)",
                ),
                imap_header_with_date(
                    "uid-real-old",
                    "Real old",
                    "old@example.test",
                    "Wed, 29 Jan 2025 22:36:24 +0800 (CST)",
                ),
            ],
            "2026-06-12T00:06:00Z",
        )
        .expect("persist imap headers");

        let rows =
            list_normal_account_messages(&connection, &account_id).expect("list sorted messages");

        assert_eq!(rows[0].subject, "Real newest");
        assert_eq!(rows[1].subject, "Real old");
    }

    #[test]
    fn anonymous_message_query_excludes_upgraded_temp_mailbox() {
        let connection = open_in_memory_database().expect("open database");
        run_migrations(&connection).expect("run migrations");
        let anonymous = TempMailbox::from_easyemail(
            "anon@example.test".to_string(),
            "mailtm".to_string(),
            "Mail.tm".to_string(),
            Some("session_anon".to_string()),
            None,
            "{}".to_string(),
            "2026-06-12T00:00:00Z".to_string(),
        );
        let upgraded = TempMailbox::from_easyemail(
            "upgraded@example.test".to_string(),
            "mailtm".to_string(),
            "Mail.tm".to_string(),
            Some("session_upgraded".to_string()),
            None,
            "{}".to_string(),
            "2026-06-12T00:00:00Z".to_string(),
        );
        insert_temp_mailbox(&connection, &anonymous).expect("insert anonymous");
        insert_temp_mailbox(&connection, &upgraded).expect("insert upgraded");
        connection
            .execute(
                "UPDATE temp_mailboxes SET visibility_state = 'upgraded' WHERE id = ?1",
                params![upgraded.id],
            )
            .expect("mark upgraded");

        for (temp_id, session_id, observed_id) in [
            (&anonymous.id, "session_anon", "observed_anon"),
            (&upgraded.id, "session_upgraded", "observed_upgraded"),
        ] {
            let row =
                crate::storage::temp_mailbox_repository::get_temp_mailbox(&connection, temp_id)
                    .expect("load temp")
                    .expect("temp exists");
            let source_id = ensure_easyemail_temp_source(&connection, &row, "2026-06-12T00:01:00Z")
                .expect("ensure source");
            persist_observed_messages(
                &connection,
                &row,
                &source_id,
                &[observed_message(observed_id, session_id)],
                "2026-06-12T00:02:00Z",
            )
            .expect("persist observed");
        }

        let rows = list_anonymous_messages(&connection).expect("list anonymous messages");

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].temp_mailbox_id, anonymous.id);
        assert_eq!(rows[0].received_address, "anon@example.test");
    }

    #[test]
    fn normal_account_messages_include_only_successfully_sent_outgoing_mail_as_sent_folder() {
        let connection = open_in_memory_database().expect("open database");
        run_migrations(&connection).expect("run migrations");
        let (account_id, _, _) = seed_imap_identity(&connection);
        connection
            .execute(
                "INSERT INTO mailbox_sources (
                    id, account_id, source_kind, address, provider_id, config_json, status,
                    created_at, updated_at
                ) VALUES (
                    'src_smtp', ?1, 'smtp', 'user@qq.com', 'smtp.qq.com', '{}', 'ready', ?2, ?2
                )",
                params![account_id, "2026-06-12T00:00:00Z"],
            )
            .expect("insert smtp source");
        let queued = insert_outgoing_message(
            &connection,
            NewOutgoingMessage {
                account_id: account_id.clone(),
                source_id: "src_smtp".to_string(),
                from_address: "user@qq.com".to_string(),
                target_address: "queued@example.test".to_string(),
                subject: "Queued outgoing".to_string(),
                body_text: "Queued body".to_string(),
                now: "2026-06-12T00:10:00Z".to_string(),
            },
        )
        .expect("queued outgoing");
        let sent = insert_outgoing_message(
            &connection,
            NewOutgoingMessage {
                account_id: account_id.clone(),
                source_id: "src_smtp".to_string(),
                from_address: "user@qq.com".to_string(),
                target_address: "sent@example.test".to_string(),
                subject: "Sent outgoing".to_string(),
                body_text: "Sent body".to_string(),
                now: "2026-06-12T00:11:00Z".to_string(),
            },
        )
        .expect("sent outgoing");
        let scheduled = insert_outgoing_message(
            &connection,
            NewOutgoingMessage {
                account_id: account_id.clone(),
                source_id: "src_smtp".to_string(),
                from_address: "user@qq.com".to_string(),
                target_address: "scheduled@example.test".to_string(),
                subject: "Scheduled outgoing".to_string(),
                body_text: "Scheduled body".to_string(),
                now: "2026-06-12T00:12:00Z".to_string(),
            },
        )
        .expect("scheduled outgoing");
        connection
            .execute(
                "INSERT INTO send_queue (
                    id, account_id, source_id, message_id, target_address, status, attempt_count,
                    next_retry_at, created_at, updated_at, sent_at
                ) VALUES
                    ('send_queued', ?1, 'src_smtp', ?2, 'queued@example.test', 'queued', 0, NULL, ?5, ?5, NULL),
                    ('send_sent', ?1, 'src_smtp', ?3, 'sent@example.test', 'sent', 1, NULL, ?5, ?6, ?6),
                    ('send_scheduled', ?1, 'src_smtp', ?4, 'scheduled@example.test', 'queued', 0, ?7, ?5, ?5, NULL)",
                params![
                    account_id,
                    queued.id,
                    sent.id,
                    scheduled.id,
                    "2026-06-12T00:11:00Z",
                    "2026-06-12T00:12:00Z",
                    "2026-06-12T01:00:00Z"
                ],
            )
            .expect("insert send queue rows");

        let rows = list_normal_account_messages(&connection, &account_id).expect("list messages");

        assert!(rows.iter().any(|row| row.message_id == sent.id));
        assert!(rows.iter().any(|row| row.message_id == scheduled.id));
        assert!(!rows.iter().any(|row| row.message_id == queued.id));
        let sent_row = rows
            .iter()
            .find(|row| row.message_id == sent.id)
            .expect("sent row");
        assert_eq!(sent_row.local_state.local_folder, "sent");
        assert!(sent_row.local_state.is_read);
        let scheduled_row = rows
            .iter()
            .find(|row| row.message_id == scheduled.id)
            .expect("scheduled row");
        assert_eq!(scheduled_row.local_state.local_folder, "sent");
        assert!(scheduled_row
            .local_state
            .labels
            .contains(&"未发送".to_string()));
    }

    #[test]
    fn scheduled_queued_send_can_be_cancelled_and_reopened_as_local_draft() {
        let connection = open_in_memory_database().expect("open database");
        run_migrations(&connection).expect("run migrations");
        let (account_id, _, _) = seed_imap_identity(&connection);
        seed_smtp_source(&connection, &account_id);
        let scheduled = insert_outgoing_message(
            &connection,
            NewOutgoingMessage {
                account_id: account_id.clone(),
                source_id: "src_smtp".to_string(),
                from_address: "user@qq.com".to_string(),
                target_address: "scheduled@example.test".to_string(),
                subject: "Scheduled outgoing".to_string(),
                body_text: "Scheduled body".to_string(),
                now: "2026-06-12T00:12:00Z".to_string(),
            },
        )
        .expect("scheduled outgoing");
        connection
            .execute(
                "INSERT INTO send_queue (
                    id, account_id, source_id, message_id, target_address,
                    cc_addresses_json, bcc_addresses_json, status, attempt_count,
                    next_retry_at, created_at, updated_at, sent_at
                ) VALUES (
                    'send_scheduled', ?1, 'src_smtp', ?2, 'scheduled@example.test',
                    '[\"cc@example.test\"]', '[\"bcc@example.test\"]', 'queued', 0,
                    ?3, ?4, ?4, NULL
                )",
                params![
                    account_id,
                    scheduled.id,
                    "2026-06-12T01:00:00Z",
                    "2026-06-12T00:12:00Z",
                ],
            )
            .expect("insert scheduled send queue row");

        let before_rows =
            list_normal_account_messages(&connection, &account_id).expect("list before reopen");
        let before_row = before_rows
            .iter()
            .find(|row| row.message_id == scheduled.id)
            .expect("scheduled sent row");
        assert_eq!(before_row.local_state.local_folder, "sent");
        assert!(before_row
            .local_state
            .labels
            .contains(&"未发送".to_string()));

        let cancelled = crate::storage::send_queue_repository::cancel_scheduled_send_by_message_id(
            &connection,
            &scheduled.id,
            "2026-06-12T00:20:00Z",
        )
        .expect("cancel scheduled send")
        .expect("scheduled send exists");
        let converted = convert_scheduled_send_to_local_draft(
            &connection,
            &scheduled.id,
            &cancelled.cc_addresses,
            &cancelled.bcc_addresses,
            "2026-06-12T00:20:00Z",
        )
        .expect("convert scheduled send to draft");
        assert!(converted);

        let after_rows =
            list_normal_account_messages(&connection, &account_id).expect("list after reopen");
        let after_row = after_rows
            .iter()
            .find(|row| row.message_id == scheduled.id)
            .expect("draft row");
        assert_eq!(after_row.local_state.local_folder, "drafts");
        assert!(!after_row.local_state.labels.contains(&"未发送".to_string()));

        let detail = get_message_detail(&connection, &scheduled.id)
            .expect("get detail")
            .expect("detail exists");
        assert_eq!(detail.body_text, Some("Scheduled body".to_string()));
        assert_eq!(detail.draft_cc_addresses, vec!["cc@example.test"]);
        assert_eq!(detail.draft_bcc_addresses, vec!["bcc@example.test"]);

        let queue_status: (String, Option<String>, Option<String>) = connection
            .query_row(
                "SELECT status, next_retry_at, last_error_code
                 FROM send_queue
                 WHERE id = 'send_scheduled'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("queue row");
        assert_eq!(queue_status.0, "failed");
        assert_eq!(queue_status.1, None);
        assert_eq!(queue_status.2, Some("scheduled_send_cancelled".to_string()));
    }

    #[test]
    fn local_draft_message_is_listed_in_drafts_and_can_be_updated_and_deleted() {
        let connection = open_in_memory_database().expect("open database");
        run_migrations(&connection).expect("run migrations");
        let (account_id, _, _) = seed_imap_identity(&connection);
        seed_smtp_source(&connection, &account_id);

        let draft = upsert_local_draft_message(
            &connection,
            NewLocalDraftMessage {
                draft_id: None,
                account_id: account_id.clone(),
                source_id: "src_smtp".to_string(),
                from_address: "user@qq.com".to_string(),
                target_address: "target@example.test".to_string(),
                cc_addresses: vec!["cc@example.test".to_string()],
                bcc_addresses: vec!["bcc@example.test".to_string()],
                subject: "Draft subject".to_string(),
                body_text: "Draft body".to_string(),
                body_html: Some("<p>Draft body</p>".to_string()),
                now: "2026-06-12T00:15:00Z".to_string(),
            },
        )
        .expect("upsert draft");

        let rows = list_normal_account_messages(&connection, &account_id).expect("list drafts");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].message_id, draft.id);
        assert_eq!(rows[0].local_state.local_folder, "drafts");
        assert_eq!(rows[0].received_address, "target@example.test");

        let detail = get_message_detail(&connection, &draft.id)
            .expect("get detail")
            .expect("detail exists");
        assert_eq!(detail.body_text, Some("Draft body".to_string()));
        assert_eq!(detail.body_html, Some("<p>Draft body</p>".to_string()));
        assert_eq!(detail.draft_cc_addresses, vec!["cc@example.test"]);
        assert_eq!(detail.draft_bcc_addresses, vec!["bcc@example.test"]);

        let updated = upsert_local_draft_message(
            &connection,
            NewLocalDraftMessage {
                draft_id: Some(draft.id.clone()),
                account_id: account_id.clone(),
                source_id: "src_smtp".to_string(),
                from_address: "user@qq.com".to_string(),
                target_address: "new-target@example.test".to_string(),
                cc_addresses: Vec::new(),
                bcc_addresses: Vec::new(),
                subject: "Updated draft".to_string(),
                body_text: "Updated body".to_string(),
                body_html: Some("<p>Updated body</p>".to_string()),
                now: "2026-06-12T00:16:00Z".to_string(),
            },
        )
        .expect("update draft");

        let rows_after_update =
            list_normal_account_messages(&connection, &account_id).expect("list updated drafts");
        assert_eq!(rows_after_update.len(), 1);
        assert_eq!(updated.id, draft.id);
        assert_eq!(rows_after_update[0].subject, "Updated draft");
        assert_eq!(
            rows_after_update[0].received_address,
            "new-target@example.test"
        );

        let deleted = delete_local_draft_message(&connection, &draft.id, "2026-06-12T00:17:00Z")
            .expect("delete draft");
        let rows_after_delete =
            list_normal_account_messages(&connection, &account_id).expect("list after delete");
        assert!(deleted);
        assert!(rows_after_delete.is_empty());
    }

    #[test]
    fn local_draft_upsert_rolls_back_message_when_source_insert_fails() {
        let connection = open_in_memory_database().expect("open database");
        run_migrations(&connection).expect("run migrations");
        let (account_id, _, _) = seed_imap_identity(&connection);
        seed_smtp_source(&connection, &account_id);
        connection
            .execute_batch(
                "CREATE TRIGGER fail_draft_source_insert
                 BEFORE INSERT ON message_sources
                 BEGIN
                   SELECT RAISE(ABORT, 'forced draft source failure');
                 END;",
            )
            .expect("install failure trigger");

        upsert_local_draft_message(
            &connection,
            NewLocalDraftMessage {
                draft_id: None,
                account_id,
                source_id: "src_smtp".to_string(),
                from_address: "user@qq.com".to_string(),
                target_address: "target@example.test".to_string(),
                cc_addresses: Vec::new(),
                bcc_addresses: Vec::new(),
                subject: "Must roll back".to_string(),
                body_text: "Draft body".to_string(),
                body_html: None,
                now: "2026-06-12T00:15:00Z".to_string(),
            },
        )
        .expect_err("source insert should fail");
        let message_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM messages WHERE subject = 'Must roll back'",
                [],
                |row| row.get(0),
            )
            .expect("count rolled back draft");

        assert_eq!(message_count, 0);
    }

    #[test]
    fn local_draft_upsert_does_not_overwrite_non_draft_message_id() {
        let connection = open_in_memory_database().expect("open database");
        run_migrations(&connection).expect("run migrations");
        let (account_id, source_id, folder_id) = seed_imap_identity(&connection);
        seed_smtp_source(&connection, &account_id);
        persist_imap_headers(
            &connection,
            &account_id,
            &source_id,
            &folder_id,
            &[imap_header(
                "uid-existing",
                "Existing message",
                "sender@example.test",
            )],
            "2026-06-12T00:02:00Z",
        )
        .expect("persist existing message");
        let existing_id = list_normal_account_messages(&connection, &account_id).expect("list")[0]
            .message_id
            .clone();

        let draft = upsert_local_draft_message(
            &connection,
            NewLocalDraftMessage {
                draft_id: Some(existing_id.clone()),
                account_id: account_id.clone(),
                source_id: "src_smtp".to_string(),
                from_address: "user@qq.com".to_string(),
                target_address: "target@example.test".to_string(),
                cc_addresses: Vec::new(),
                bcc_addresses: Vec::new(),
                subject: "Draft subject".to_string(),
                body_text: "Draft body".to_string(),
                body_html: None,
                now: "2026-06-12T00:15:00Z".to_string(),
            },
        )
        .expect("upsert draft");

        let existing_detail = get_message_detail(&connection, &existing_id)
            .expect("get existing")
            .expect("existing detail");
        assert_ne!(draft.id, existing_id);
        assert_eq!(existing_detail.subject, "Existing message");
    }

    fn observed_message(id: &str, session_id: &str) -> EasyEmailObservedMessage {
        EasyEmailObservedMessage {
            id: id.to_string(),
            session_id: session_id.to_string(),
            provider_instance_id: "provider_instance_1".to_string(),
            observed_at: "2026-06-12T00:10:00Z".to_string(),
            sender: Some("noreply@example.test".to_string()),
            subject: Some("Your code is 123456".to_string()),
            text_body: Some("Use 123456 to continue.".to_string()),
            html_body: None,
            raw_json: serde_json::json!({"id": id, "sessionId": session_id}),
        }
    }

    fn seed_imap_identity(connection: &Connection) -> (String, String, String) {
        let account_id = "acct_imap".to_string();
        let source_id = "src_imap".to_string();
        let folder_id = "folder_inbox".to_string();

        connection
            .execute(
                "INSERT INTO accounts (
                    id, scope, kind, display_name, primary_address, provider_label, status,
                    auth_status, receive_status, send_status, listed_in_all_accounts,
                    created_at, updated_at
                ) VALUES (
                    ?1, 'normal', 'normal_long_lived', 'QQ Mail', 'user@qq.com',
                    'Manual IMAP', 'ready', 'valid', 'enabled', 'enabled', 1, ?2, ?2
                )",
                params![account_id, "2026-06-12T00:00:00Z"],
            )
            .expect("insert imap account");
        connection
            .execute(
                "INSERT INTO mailbox_sources (
                    id, account_id, source_kind, address, provider_id, config_json, status,
                    created_at, updated_at
                ) VALUES (
                    ?1, ?2, 'imap', 'user@qq.com', 'imap.qq.com', '{}', 'ready', ?3, ?3
                )",
                params![source_id, account_id, "2026-06-12T00:00:00Z"],
            )
            .expect("insert imap source");
        connection
            .execute(
                "INSERT INTO mail_folders (
                    id, account_id, source_id, provider_folder_id, display_name, path,
                    delimiter, folder_kind, created_at, updated_at
                ) VALUES (
                    ?1, ?2, ?3, 'INBOX', 'INBOX', 'INBOX', '/', 'inbox', ?4, ?4
                )",
                params![folder_id, account_id, source_id, "2026-06-12T00:00:00Z"],
            )
            .expect("insert imap folder");

        (account_id, source_id, folder_id)
    }

    fn seed_imap_folder(
        connection: &Connection,
        account_id: &str,
        source_id: &str,
        display_name: &str,
        folder_kind: &str,
    ) -> String {
        let folder_id = format!("folder_{}", folder_kind);
        connection
            .execute(
                "INSERT INTO mail_folders (
                    id, account_id, source_id, provider_folder_id, display_name, path,
                    delimiter, folder_kind, created_at, updated_at
                ) VALUES (
                    ?1, ?2, ?3, ?4, ?4, ?4, '/', ?5, ?6, ?6
                )",
                params![
                    folder_id,
                    account_id,
                    source_id,
                    display_name,
                    folder_kind,
                    "2026-06-12T00:00:00Z"
                ],
            )
            .expect("insert imap folder");
        folder_id
    }

    fn seed_smtp_source(connection: &Connection, account_id: &str) {
        connection
            .execute(
                "INSERT INTO mailbox_sources (
                    id, account_id, source_kind, address, provider_id, config_json, status,
                    created_at, updated_at
                ) VALUES (
                    'src_smtp', ?1, 'smtp', 'user@qq.com', 'smtp.qq.com', '{}', 'ready', ?2, ?2
                )",
                params![account_id, "2026-06-12T00:00:00Z"],
            )
            .expect("insert smtp source");
    }

    fn imap_header(uid: &str, subject: &str, from_address: &str) -> ImapMessageHeader {
        imap_header_with_date(uid, subject, from_address, "2026-06-12T00:10:00Z")
    }

    fn imap_header_with_date(
        uid: &str,
        subject: &str,
        from_address: &str,
        date_received: &str,
    ) -> ImapMessageHeader {
        ImapMessageHeader {
            provider_message_id: uid.to_string(),
            message_id: Some(format!("{uid}@example.test")),
            in_reply_to: None,
            references: Vec::new(),
            subject: subject.to_string(),
            from_address: from_address.to_string(),
            date_received: date_received.to_string(),
            snippet: format!("{from_address} / {subject}"),
            authentication_results: None,
            received_spf: None,
            dkim_signature: None,
            list_id: None,
            list_unsubscribe: None,
            list_unsubscribe_post: None,
            precedence: None,
            list_post: None,
            list_help: None,
            feedback_id: None,
        }
    }
}
