use rusqlite::{params, Connection, OptionalExtension, Result};
use uuid::Uuid;

const MAX_SEND_QUEUE_LIST_LIMIT: usize = 100;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SendQueueRow {
    pub id: String,
    pub account_id: String,
    pub source_id: String,
    pub message_id: String,
    pub target_address: String,
    pub cc_addresses: Vec<String>,
    pub bcc_addresses: Vec<String>,
    pub subject: String,
    pub status: String,
    pub attempt_count: i64,
    pub next_retry_at: Option<String>,
    pub last_error_code: Option<String>,
    pub last_error_message: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub sent_at: Option<String>,
    pub credential_ref_id: Option<String>,
    pub secret_key: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewSendQueueItem {
    pub account_id: String,
    pub source_id: String,
    pub message_id: String,
    pub target_address: String,
    pub cc_addresses: Vec<String>,
    pub bcc_addresses: Vec<String>,
    pub scheduled_at: Option<String>,
    pub now: String,
}

pub fn enqueue_send(connection: &Connection, item: NewSendQueueItem) -> Result<SendQueueRow> {
    let id = format!("send_{}", Uuid::new_v4());
    let cc_addresses_json =
        serde_json::to_string(&item.cc_addresses).unwrap_or_else(|_| "[]".to_string());
    let bcc_addresses_json =
        serde_json::to_string(&item.bcc_addresses).unwrap_or_else(|_| "[]".to_string());
    connection.execute(
        "INSERT INTO send_queue (
            id,
            account_id,
            source_id,
            message_id,
            target_address,
            cc_addresses_json,
            bcc_addresses_json,
            status,
            attempt_count,
            next_retry_at,
            created_at,
            updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'queued', 0, ?8, ?9, ?9)",
        params![
            id,
            item.account_id,
            item.source_id,
            item.message_id,
            item.target_address,
            cc_addresses_json,
            bcc_addresses_json,
            item.scheduled_at,
            item.now,
        ],
    )?;

    get_send_queue_item(connection, &id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)
}

pub fn get_send_queue_item(connection: &Connection, id: &str) -> Result<Option<SendQueueRow>> {
    connection
        .query_row(
            send_queue_select_sql("send_queue.id = ?1").as_str(),
            params![id],
            map_send_queue_row,
        )
        .optional()
}

pub fn cancel_scheduled_send_by_message_id(
    connection: &Connection,
    message_id: &str,
    now: &str,
) -> Result<Option<SendQueueRow>> {
    let id: Option<String> = connection
        .query_row(
            "SELECT id
             FROM send_queue
             WHERE message_id = ?1
               AND status = 'queued'
               AND next_retry_at IS NOT NULL
             ORDER BY next_retry_at ASC, created_at ASC, id ASC
             LIMIT 1",
            params![message_id],
            |row| row.get(0),
        )
        .optional()?;

    let Some(id) = id else {
        return Ok(None);
    };

    let changed = connection.execute(
        "UPDATE send_queue
         SET status = 'failed',
             next_retry_at = NULL,
             last_error_code = 'scheduled_send_cancelled',
             last_error_message = 'Scheduled send was reopened for editing.',
             updated_at = ?1
         WHERE id = ?2
           AND status = 'queued'
           AND next_retry_at IS NOT NULL",
        params![now, id],
    )?;

    if changed == 0 {
        return Ok(None);
    }

    get_send_queue_item(connection, &id)
}

pub fn list_recent_send_queue(connection: &Connection, limit: usize) -> Result<Vec<SendQueueRow>> {
    let limit = limit.min(MAX_SEND_QUEUE_LIST_LIMIT) as i64;
    let mut statement = connection.prepare(
        format!(
            "{} ORDER BY send_queue.created_at DESC, send_queue.id DESC LIMIT ?1",
            send_queue_select_sql("1 = 1")
        )
        .as_str(),
    )?;

    let rows = statement.query_map(params![limit], map_send_queue_row)?;
    rows.collect()
}

pub fn claim_next_due_send(connection: &Connection, now: &str) -> Result<Option<SendQueueRow>> {
    let claimed_id: Option<String> = connection
        .query_row(
            "UPDATE send_queue
             SET status = 'sending',
                 updated_at = ?1
             WHERE id = (
                 SELECT id
                 FROM send_queue
                 WHERE status = 'queued'
                   AND (next_retry_at IS NULL OR next_retry_at <= ?1)
                 ORDER BY created_at ASC, id ASC
                 LIMIT 1
             )
               AND status = 'queued'
             RETURNING id",
            params![now],
            |row| row.get(0),
        )
        .optional()?;

    let Some(id) = claimed_id else {
        return Ok(None);
    };

    get_send_queue_item(connection, &id)
}

pub fn claim_next_due_scheduled_send(
    connection: &Connection,
    now: &str,
) -> Result<Option<SendQueueRow>> {
    let claimed_id: Option<String> = connection
        .query_row(
            "UPDATE send_queue
             SET status = 'sending',
                 updated_at = ?1
             WHERE id = (
                 SELECT id
                 FROM send_queue
                 WHERE status = 'queued'
                   AND next_retry_at IS NOT NULL
                   AND next_retry_at <= ?1
                 ORDER BY next_retry_at ASC, created_at ASC, id ASC
                 LIMIT 1
             )
               AND status = 'queued'
             RETURNING id",
            params![now],
            |row| row.get(0),
        )
        .optional()?;

    let Some(id) = claimed_id else {
        return Ok(None);
    };

    get_send_queue_item(connection, &id)
}

pub fn claim_due_send_by_id(
    connection: &Connection,
    id: &str,
    now: &str,
) -> Result<Option<SendQueueRow>> {
    let changed = connection.execute(
        "UPDATE send_queue
         SET status = 'sending',
             updated_at = ?1
         WHERE id = ?2
           AND status = 'queued'
           AND (next_retry_at IS NULL OR next_retry_at <= ?1)",
        params![now, id],
    )?;

    if changed == 0 {
        return Ok(None);
    }

    get_send_queue_item(connection, id)
}

pub fn mark_stale_sends_delivery_unknown(
    connection: &Connection,
    stale_before: &str,
    now: &str,
) -> Result<usize> {
    connection.execute(
        "UPDATE send_queue
         SET status = 'failed',
             attempt_count = attempt_count + 1,
             next_retry_at = NULL,
             last_error_code = 'smtp_delivery_unknown',
             last_error_message = 'The app stopped while this message was being sent. Delivery may have succeeded. Verify the Sent folder before retrying.',
             updated_at = ?1
         WHERE status = 'sending'
           AND updated_at <= ?2",
        params![now, stale_before],
    )
}

pub fn mark_send_sent(connection: &Connection, id: &str, now: &str) -> Result<bool> {
    let changed = connection.execute(
        "UPDATE send_queue
         SET status = 'sent',
             next_retry_at = NULL,
             last_error_code = NULL,
             last_error_message = NULL,
             updated_at = ?1,
             sent_at = ?1
         WHERE id = ?2
           AND status = 'sending'",
        params![now, id],
    )?;
    Ok(changed > 0)
}

pub fn mark_send_retry(
    connection: &Connection,
    id: &str,
    next_retry_at: &str,
    error_code: &str,
    error_message: Option<&str>,
    now: &str,
) -> Result<bool> {
    let changed = connection.execute(
        "UPDATE send_queue
         SET status = 'queued',
             attempt_count = attempt_count + 1,
             next_retry_at = ?1,
             last_error_code = ?2,
             last_error_message = ?3,
             updated_at = ?4
         WHERE id = ?5
           AND status = 'sending'",
        params![next_retry_at, error_code, error_message, now, id],
    )?;
    Ok(changed > 0)
}

pub fn mark_send_auth_failed(
    connection: &Connection,
    id: &str,
    error_code: &str,
    error_message: Option<&str>,
    now: &str,
) -> Result<bool> {
    let changed = connection.execute(
        "UPDATE send_queue
         SET status = 'auth_failed',
             attempt_count = attempt_count + 1,
             next_retry_at = NULL,
             last_error_code = ?1,
             last_error_message = ?2,
             updated_at = ?3
         WHERE id = ?4
           AND status = 'sending'",
        params![error_code, error_message, now, id],
    )?;
    Ok(changed > 0)
}

pub fn mark_send_failed(
    connection: &Connection,
    id: &str,
    error_code: &str,
    error_message: Option<&str>,
    now: &str,
) -> Result<bool> {
    let changed = connection.execute(
        "UPDATE send_queue
         SET status = 'failed',
             attempt_count = attempt_count + 1,
             next_retry_at = NULL,
             last_error_code = ?1,
             last_error_message = ?2,
             updated_at = ?3
         WHERE id = ?4
           AND status = 'sending'",
        params![error_code, error_message, now, id],
    )?;
    Ok(changed > 0)
}

fn send_queue_select_sql(where_clause: &str) -> String {
    format!(
        "SELECT
            send_queue.id AS id,
            send_queue.account_id AS account_id,
            send_queue.source_id AS source_id,
            send_queue.message_id AS message_id,
            send_queue.target_address AS target_address,
            send_queue.cc_addresses_json AS cc_addresses_json,
            send_queue.bcc_addresses_json AS bcc_addresses_json,
            COALESCE(messages.subject, '') AS subject,
            send_queue.status AS status,
            send_queue.attempt_count AS attempt_count,
            send_queue.next_retry_at AS next_retry_at,
            send_queue.last_error_code AS last_error_code,
            send_queue.last_error_message AS last_error_message,
            send_queue.created_at AS created_at,
            send_queue.updated_at AS updated_at,
            send_queue.sent_at AS sent_at,
            credential_refs.id AS credential_ref_id,
            credential_refs.secret_key AS secret_key
         FROM send_queue
         INNER JOIN messages ON messages.id = send_queue.message_id
         LEFT JOIN mailbox_sources ON mailbox_sources.id = send_queue.source_id
         LEFT JOIN credential_refs ON credential_refs.id = mailbox_sources.credential_ref_id
         WHERE {where_clause}"
    )
}

fn map_send_queue_row(row: &rusqlite::Row<'_>) -> Result<SendQueueRow> {
    Ok(SendQueueRow {
        id: row.get("id")?,
        account_id: row.get("account_id")?,
        source_id: row.get("source_id")?,
        message_id: row.get("message_id")?,
        target_address: row.get("target_address")?,
        cc_addresses: parse_address_list_json(row.get::<_, String>("cc_addresses_json")?.as_str()),
        bcc_addresses: parse_address_list_json(
            row.get::<_, String>("bcc_addresses_json")?.as_str(),
        ),
        subject: row.get("subject")?,
        status: row.get("status")?,
        attempt_count: row.get("attempt_count")?,
        next_retry_at: row.get("next_retry_at")?,
        last_error_code: row.get("last_error_code")?,
        last_error_message: row.get("last_error_message")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        sent_at: row.get("sent_at")?,
        credential_ref_id: row.get("credential_ref_id")?,
        secret_key: row.get("secret_key")?,
    })
}

fn parse_address_list_json(value: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(value).unwrap_or_default()
}

#[cfg(test)]
#[path = "send_queue_repository_tests.rs"]
mod tests;
