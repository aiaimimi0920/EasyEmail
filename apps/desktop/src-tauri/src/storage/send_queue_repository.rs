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
mod tests {
    use std::sync::{Arc, Barrier};
    use std::thread;

    use rusqlite::{params, Connection};

    use crate::storage::db::{open_database, open_in_memory_database};
    use crate::storage::migrations::run_migrations;

    use super::*;

    #[test]
    fn send_queue_repository_enqueues_queued_job() {
        let connection = test_connection();
        seed_sendable_account_source_and_message(&connection);

        let row = enqueue_send(
            &connection,
            NewSendQueueItem {
                account_id: "acct_send".to_string(),
                source_id: "src_smtp".to_string(),
                message_id: "msg_outgoing".to_string(),
                target_address: "target@example.test".to_string(),
                cc_addresses: vec!["cc@example.test".to_string()],
                bcc_addresses: vec!["bcc@example.test".to_string()],
                scheduled_at: None,
                now: "2026-06-12T01:00:00Z".to_string(),
            },
        )
        .expect("enqueue send");

        assert_eq!(row.status, "queued");
        assert_eq!(row.attempt_count, 0);
        assert_eq!(row.target_address, "target@example.test");
        assert_eq!(row.cc_addresses, vec!["cc@example.test"]);
        assert_eq!(row.bcc_addresses, vec!["bcc@example.test"]);
    }

    #[test]
    fn send_queue_list_caps_extreme_limits_before_sql_conversion() {
        let connection = test_connection();
        seed_sendable_account_source_and_message(&connection);

        for index in 0..=MAX_SEND_QUEUE_LIST_LIMIT {
            enqueue_send(
                &connection,
                NewSendQueueItem {
                    account_id: "acct_send".to_string(),
                    source_id: "src_smtp".to_string(),
                    message_id: "msg_outgoing".to_string(),
                    target_address: format!("target-{index}@example.test"),
                    cc_addresses: Vec::new(),
                    bcc_addresses: Vec::new(),
                    scheduled_at: None,
                    now: "2026-06-12T01:00:00Z".to_string(),
                },
            )
            .expect("enqueue send");
        }

        let rows = list_recent_send_queue(&connection, usize::MAX).expect("list capped queue");

        assert_eq!(rows.len(), MAX_SEND_QUEUE_LIST_LIMIT);
        assert!(list_recent_send_queue(&connection, 0)
            .expect("list empty page")
            .is_empty());
    }

    #[test]
    fn send_queue_repository_uses_scheduled_at_as_first_due_time() {
        let connection = test_connection();
        seed_sendable_account_source_and_message(&connection);

        let row = enqueue_send(
            &connection,
            NewSendQueueItem {
                account_id: "acct_send".to_string(),
                source_id: "src_smtp".to_string(),
                message_id: "msg_outgoing".to_string(),
                target_address: "target@example.test".to_string(),
                cc_addresses: Vec::new(),
                bcc_addresses: Vec::new(),
                scheduled_at: Some("2026-06-12T08:00:00Z".to_string()),
                now: "2026-06-12T01:00:00Z".to_string(),
            },
        )
        .expect("enqueue scheduled send");

        assert_eq!(row.status, "queued");
        assert_eq!(row.next_retry_at, Some("2026-06-12T08:00:00Z".to_string()));
        assert!(claim_next_due_send(&connection, "2026-06-12T07:59:59Z")
            .expect("claim before schedule")
            .is_none());
        assert!(claim_next_due_send(&connection, "2026-06-12T08:00:00Z")
            .expect("claim at schedule")
            .is_some());
    }

    #[test]
    fn claim_next_due_send_marks_job_sending_once() {
        let connection = test_connection();
        seed_sendable_account_source_and_message(&connection);
        enqueue_send(
            &connection,
            NewSendQueueItem {
                account_id: "acct_send".to_string(),
                source_id: "src_smtp".to_string(),
                message_id: "msg_outgoing".to_string(),
                target_address: "target@example.test".to_string(),
                cc_addresses: Vec::new(),
                bcc_addresses: Vec::new(),
                scheduled_at: None,
                now: "2026-06-12T01:00:00Z".to_string(),
            },
        )
        .expect("enqueue send");

        let first = claim_next_due_send(&connection, "2026-06-12T01:00:01Z")
            .expect("claim")
            .expect("job");
        let second = claim_next_due_send(&connection, "2026-06-12T01:00:02Z").expect("claim again");

        assert_eq!(first.status, "sending");
        assert!(second.is_none());
    }

    #[test]
    fn stale_sending_job_becomes_non_retryable_delivery_unknown() {
        let connection = test_connection();
        seed_sendable_account_source_and_message(&connection);
        let queued = enqueue_send(
            &connection,
            NewSendQueueItem {
                account_id: "acct_send".to_string(),
                source_id: "src_smtp".to_string(),
                message_id: "msg_outgoing".to_string(),
                target_address: "target@example.test".to_string(),
                cc_addresses: Vec::new(),
                bcc_addresses: Vec::new(),
                scheduled_at: None,
                now: "2026-06-12T01:00:00Z".to_string(),
            },
        )
        .expect("enqueue send");
        claim_due_send_by_id(&connection, &queued.id, "2026-06-12T01:10:00Z")
            .expect("claim send")
            .expect("claimed send");

        assert_eq!(
            mark_stale_sends_delivery_unknown(
                &connection,
                "2026-06-12T01:05:00Z",
                "2026-06-12T01:20:00Z",
            )
            .expect("keep recent send"),
            0
        );
        assert_eq!(
            get_send_queue_item(&connection, &queued.id)
                .expect("load recent send")
                .expect("recent send")
                .status,
            "sending"
        );

        assert_eq!(
            mark_stale_sends_delivery_unknown(
                &connection,
                "2026-06-12T01:10:00Z",
                "2026-06-12T01:25:00Z",
            )
            .expect("recover stale send"),
            1
        );
        let recovered = get_send_queue_item(&connection, &queued.id)
            .expect("load recovered send")
            .expect("recovered send");
        assert_eq!(recovered.status, "failed");
        assert_eq!(recovered.attempt_count, 1);
        assert_eq!(recovered.next_retry_at, None);
        assert_eq!(
            recovered.last_error_code.as_deref(),
            Some("smtp_delivery_unknown")
        );
        assert!(recovered
            .last_error_message
            .as_deref()
            .is_some_and(|message| message.contains("Verify the Sent folder")));
    }

    #[test]
    fn terminal_transition_only_updates_a_claimed_send() {
        let connection = test_connection();
        seed_sendable_account_source_and_message(&connection);
        let queued = enqueue_send(
            &connection,
            NewSendQueueItem {
                account_id: "acct_send".to_string(),
                source_id: "src_smtp".to_string(),
                message_id: "msg_outgoing".to_string(),
                target_address: "target@example.test".to_string(),
                cc_addresses: Vec::new(),
                bcc_addresses: Vec::new(),
                scheduled_at: None,
                now: "2026-06-12T01:00:00Z".to_string(),
            },
        )
        .expect("enqueue send");

        assert!(
            !mark_send_sent(&connection, &queued.id, "2026-06-12T01:00:01Z")
                .expect("reject unclaimed transition")
        );
        assert_eq!(
            get_send_queue_item(&connection, &queued.id)
                .expect("load queued send")
                .expect("queued send")
                .status,
            "queued"
        );

        claim_due_send_by_id(&connection, &queued.id, "2026-06-12T01:00:02Z")
            .expect("claim send")
            .expect("claimed send");
        assert!(
            mark_send_sent(&connection, &queued.id, "2026-06-12T01:00:03Z")
                .expect("complete claimed send")
        );
        assert!(!mark_send_failed(
            &connection,
            &queued.id,
            "late_worker",
            None,
            "2026-06-12T01:00:04Z"
        )
        .expect("reject stale worker transition"));
        assert_eq!(
            get_send_queue_item(&connection, &queued.id)
                .expect("load completed send")
                .expect("completed send")
                .status,
            "sent"
        );
    }

    #[test]
    fn concurrent_workers_claim_a_due_send_exactly_once() {
        let directory = std::env::temp_dir().join(format!(
            "easyemailam_send_queue_claim_{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&directory).expect("create temp directory");
        let path = directory.join("mail.db");
        {
            let connection = open_database(&path).expect("open file database");
            run_migrations(&connection).expect("run migrations");
            seed_sendable_account_source_and_message(&connection);
            enqueue_send(
                &connection,
                NewSendQueueItem {
                    account_id: "acct_send".to_string(),
                    source_id: "src_smtp".to_string(),
                    message_id: "msg_outgoing".to_string(),
                    target_address: "target@example.test".to_string(),
                    cc_addresses: Vec::new(),
                    bcc_addresses: Vec::new(),
                    scheduled_at: None,
                    now: "2026-06-12T01:00:00Z".to_string(),
                },
            )
            .expect("enqueue send");
        }

        let barrier = Arc::new(Barrier::new(3));
        let handles = (0..2)
            .map(|_| {
                let barrier = Arc::clone(&barrier);
                let path = path.clone();
                thread::spawn(move || {
                    let connection = open_database(&path).expect("open worker database");
                    barrier.wait();
                    claim_next_due_send(&connection, "2026-06-12T01:00:01Z").expect("claim send")
                })
            })
            .collect::<Vec<_>>();
        barrier.wait();

        let claimed_count = handles
            .into_iter()
            .map(|handle| handle.join().expect("join worker"))
            .filter(Option::is_some)
            .count();

        assert_eq!(claimed_count, 1);

        let _ = std::fs::remove_dir_all(&directory);
    }

    #[test]
    fn claim_due_send_by_id_marks_requested_job_not_oldest_job() {
        let connection = test_connection();
        seed_sendable_account_source_and_message(&connection);
        enqueue_send(
            &connection,
            NewSendQueueItem {
                account_id: "acct_send".to_string(),
                source_id: "src_smtp".to_string(),
                message_id: "msg_outgoing".to_string(),
                target_address: "old@example.test".to_string(),
                cc_addresses: Vec::new(),
                bcc_addresses: Vec::new(),
                scheduled_at: None,
                now: "2026-06-12T01:00:00Z".to_string(),
            },
        )
        .expect("enqueue older send");
        connection
            .execute(
                "INSERT INTO messages (
                    id, subject, from_address, snippet, body_text_cache, body_cache_state,
                    classification, created_at, updated_at
                ) VALUES (
                    'msg_outgoing_new', 'New', 'sender@example.test', 'New body', 'New body',
                    'cached', 'outgoing', '2026-06-12T01:01:00Z', '2026-06-12T01:01:00Z'
                )",
                [],
            )
            .expect("insert newer message");
        let newer = enqueue_send(
            &connection,
            NewSendQueueItem {
                account_id: "acct_send".to_string(),
                source_id: "src_smtp".to_string(),
                message_id: "msg_outgoing_new".to_string(),
                target_address: "new@example.test".to_string(),
                cc_addresses: Vec::new(),
                bcc_addresses: Vec::new(),
                scheduled_at: None,
                now: "2026-06-12T01:01:00Z".to_string(),
            },
        )
        .expect("enqueue newer send");

        let claimed = claim_due_send_by_id(&connection, &newer.id, "2026-06-12T01:01:01Z")
            .expect("claim requested")
            .expect("requested job");
        let next = claim_next_due_send(&connection, "2026-06-12T01:01:02Z")
            .expect("claim oldest")
            .expect("oldest job");

        assert_eq!(claimed.id, newer.id);
        assert_eq!(claimed.status, "sending");
        assert_eq!(next.target_address, "old@example.test");
    }

    fn test_connection() -> Connection {
        let connection = open_in_memory_database().expect("open database");
        run_migrations(&connection).expect("run migrations");
        connection
    }

    fn seed_sendable_account_source_and_message(connection: &Connection) {
        connection
            .execute(
                "INSERT INTO accounts (
                    id,
                    scope,
                    kind,
                    display_name,
                    primary_address,
                    provider_label,
                    status,
                    auth_status,
                    receive_status,
                    send_status,
                    listed_in_all_accounts,
                    created_at,
                    updated_at
                ) VALUES ('acct_send', 'normal', 'normal_long_lived', 'Sender', 'sender@example.test', 'Manual SMTP', 'ready', 'valid', 'enabled', 'enabled', 1, '2026-06-12T01:00:00Z', '2026-06-12T01:00:00Z')",
                [],
            )
            .expect("insert account");
        connection
            .execute(
                "INSERT INTO mailbox_sources (
                    id,
                    account_id,
                    source_kind,
                    address,
                    provider_id,
                    config_json,
                    status,
                    created_at,
                    updated_at
                ) VALUES ('src_smtp', 'acct_send', 'smtp', 'sender@example.test', 'smtp.example.test', '{\"host\":\"smtp.example.test\",\"port\":587,\"security\":\"starttls\",\"username\":\"sender@example.test\"}', 'ready', '2026-06-12T01:00:00Z', '2026-06-12T01:00:00Z')",
                [],
            )
            .expect("insert smtp source");
        connection
            .execute(
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
                ) VALUES ('msg_outgoing', 'Hello', 'sender@example.test', 'Queued body', 'Queued body', 'cached', 'outgoing', '2026-06-12T01:00:00Z', '2026-06-12T01:00:00Z')",
                params![],
            )
            .expect("insert outgoing message");
    }
}
