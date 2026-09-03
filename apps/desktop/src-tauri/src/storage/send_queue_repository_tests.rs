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
