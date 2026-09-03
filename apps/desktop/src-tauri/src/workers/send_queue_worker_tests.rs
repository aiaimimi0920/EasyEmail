use std::sync::mpsc::sync_channel;
use std::sync::{Arc, Mutex};
use std::thread;

use crate::secret::fake::FakeSecretVaultAdapter;
use crate::secret::SecretVaultAdapter;
use crate::smtp::fake::FakeSmtpAdapter;
use crate::storage::send_queue_repository::list_recent_send_queue;

use super::test_support::*;
use super::*;

#[test]
fn smtp_retryable_error_requeues_with_backoff() {
    let connection = test_connection();
    let vault = FakeSecretVaultAdapter::default();
    seed_send_enabled_normal_account_with_secret(&connection, &vault);
    seed_queued_send(&connection);
    let adapter = FakeSmtpAdapter::retryable_failure();

    let result = run_send_queue_once(
        &connection,
        &vault,
        &adapter,
        "2026-06-12T01:20:00Z".to_string(),
    )
    .expect("worker");

    assert_eq!(result.processed_count, 1);
    let rows = list_recent_send_queue(&connection, 10).expect("list queue");
    assert_eq!(rows[0].status, "queued");
    assert_eq!(rows[0].attempt_count, 1);
    assert_eq!(
        rows[0].next_retry_at,
        Some("2026-06-12T01:21:00Z".to_string())
    );
}

#[test]
fn smtp_auth_failure_sets_action_required() {
    let connection = test_connection();
    let vault = FakeSecretVaultAdapter::default();
    seed_send_enabled_normal_account_with_secret(&connection, &vault);
    seed_queued_send(&connection);
    let adapter = FakeSmtpAdapter::auth_failure();

    run_send_queue_once(
        &connection,
        &vault,
        &adapter,
        "2026-06-12T01:20:00Z".to_string(),
    )
    .expect("worker");

    let rows = list_recent_send_queue(&connection, 10).expect("list queue");
    assert_eq!(rows[0].status, "auth_failed");
    assert_eq!(
        rows[0].last_error_code,
        Some("smtp_auth_failed".to_string())
    );
}

#[test]
fn missing_smtp_secret_marks_claimed_send_failed() {
    let connection = test_connection();
    let vault = FakeSecretVaultAdapter::default();
    seed_send_enabled_normal_account_with_secret(&connection, &vault);
    vault
        .delete_secret("secret://smtp/acct_send")
        .expect("delete smtp secret");
    seed_queued_send(&connection);
    let adapter = FakeSmtpAdapter::success();

    let result = run_send_queue_once(
        &connection,
        &vault,
        &adapter,
        "2026-06-12T01:20:00Z".to_string(),
    )
    .expect("worker handles missing secret");

    let rows = list_recent_send_queue(&connection, 10).expect("list queue");
    assert_eq!(result.failed_count, 1);
    assert_eq!(rows[0].status, "failed");
    assert_eq!(
        rows[0].last_error_code.as_deref(),
        Some("smtp_secret_missing")
    );
    assert!(adapter.sent_messages().is_empty());
}

#[test]
fn missing_smtp_source_marks_claimed_send_failed() {
    let connection = test_connection();
    let vault = FakeSecretVaultAdapter::default();
    seed_send_enabled_normal_account_with_secret(&connection, &vault);
    seed_queued_send(&connection);
    connection
        .execute(
            "UPDATE mailbox_sources SET source_kind = 'imap' WHERE id = 'src_smtp'",
            [],
        )
        .expect("remove smtp source role");
    let adapter = FakeSmtpAdapter::success();

    let result = run_send_queue_once(
        &connection,
        &vault,
        &adapter,
        "2026-06-12T01:20:00Z".to_string(),
    )
    .expect("worker handles missing source");

    let rows = list_recent_send_queue(&connection, 10).expect("list queue");
    assert_eq!(result.failed_count, 1);
    assert_eq!(rows[0].status, "failed");
    assert_eq!(
        rows[0].last_error_code.as_deref(),
        Some("smtp_source_missing")
    );
    assert!(adapter.sent_messages().is_empty());
}

#[test]
fn send_queue_worker_is_idempotent() {
    let connection = test_connection();
    let vault = FakeSecretVaultAdapter::default();
    seed_send_enabled_normal_account_with_secret(&connection, &vault);
    seed_queued_send(&connection);
    let adapter = FakeSmtpAdapter::success();

    let first = run_send_queue_once(
        &connection,
        &vault,
        &adapter,
        "2026-06-12T01:20:00Z".to_string(),
    )
    .expect("first worker");
    let second = run_send_queue_once(
        &connection,
        &vault,
        &adapter,
        "2026-06-12T01:20:01Z".to_string(),
    )
    .expect("second worker");

    assert_eq!(first.processed_count, 1);
    assert_eq!(second.processed_count, 0);
    assert_eq!(adapter.sent_messages().len(), 1);
}

#[test]
fn stale_sending_job_is_not_automatically_retried_after_restart() {
    let connection = test_connection();
    let vault = FakeSecretVaultAdapter::default();
    seed_send_enabled_normal_account_with_secret(&connection, &vault);
    seed_queued_send(&connection);
    claim_due_send_by_id(&connection, "send_outgoing", "2026-06-12T01:10:00Z")
        .expect("claim send")
        .expect("claimed send");
    let adapter = FakeSmtpAdapter::success();

    let result = run_send_queue_once(
        &connection,
        &vault,
        &adapter,
        "2026-06-12T01:26:00Z".to_string(),
    )
    .expect("recover stale send");

    let row = list_recent_send_queue(&connection, 10)
        .expect("list queue")
        .remove(0);
    assert_eq!(result.processed_count, 1);
    assert_eq!(result.failed_count, 1);
    assert_eq!(row.status, "failed");
    assert_eq!(row.next_retry_at, None);
    assert_eq!(
        row.last_error_code.as_deref(),
        Some("smtp_delivery_unknown")
    );
    assert!(adapter.sent_messages().is_empty());
}

#[test]
fn shared_worker_releases_database_lock_during_smtp_round_trip() {
    let connection = Arc::new(Mutex::new(test_connection()));
    let vault = FakeSecretVaultAdapter::default();
    {
        let connection = connection.lock().expect("seed lock");
        seed_send_enabled_normal_account_with_secret(&connection, &vault);
        seed_queued_send(&connection);
    }
    let (entered_tx, entered_rx) = sync_channel(1);
    let (release_tx, release_rx) = sync_channel(1);
    let adapter = BlockingSmtpAdapter {
        entered: entered_tx,
        release: Mutex::new(release_rx),
    };
    let worker_connection = Arc::clone(&connection);
    let worker_vault = vault.clone();

    let handle = thread::spawn(move || {
        run_send_queue_once_shared(
            &worker_connection,
            &worker_vault,
            &adapter,
            "2026-06-12T01:20:00Z".to_string(),
        )
    });

    entered_rx
        .recv_timeout(std::time::Duration::from_secs(5))
        .expect("SMTP operation started");
    {
        let connection = connection
            .try_lock()
            .expect("database lock must be available during SMTP");
        let status: String = connection
            .query_row(
                "SELECT status FROM send_queue WHERE id = 'send_outgoing'",
                [],
                |row| row.get(0),
            )
            .expect("read queue while SMTP is blocked");
        assert_eq!(status, "sending");
    }
    release_tx.send(()).expect("release SMTP operation");

    let result = handle.join().expect("join worker").expect("worker result");
    assert_eq!(result.sent_count, 1);
    assert_eq!(
        list_recent_send_queue(&connection.lock().expect("final lock"), 10,)
            .expect("list final queue")[0]
            .status,
        "sent"
    );
}

#[test]
fn send_queue_worker_can_run_requested_item_without_processing_older_queue() {
    let connection = test_connection();
    let vault = FakeSecretVaultAdapter::default();
    seed_send_enabled_normal_account_with_secret(&connection, &vault);
    seed_queued_send_with(
        &connection,
        "msg_old",
        "send-old",
        "old@example.test",
        "2026-06-12T01:10:00Z",
    );
    seed_queued_send_with(
        &connection,
        "msg_new",
        "send-new",
        "new@example.test",
        "2026-06-12T01:11:00Z",
    );
    let adapter = FakeSmtpAdapter::success();

    let result = run_send_queue_item(
        &connection,
        &vault,
        &adapter,
        "send-new",
        "2026-06-12T01:20:00Z".to_string(),
    )
    .expect("targeted worker");

    let rows = list_recent_send_queue(&connection, 10).expect("list queue");
    let old_row = rows
        .iter()
        .find(|row| row.id == "send-old")
        .expect("old row");
    let new_row = rows
        .iter()
        .find(|row| row.id == "send-new")
        .expect("new row");

    assert_eq!(result.sent_count, 1);
    assert_eq!(new_row.status, "sent");
    assert_eq!(old_row.status, "queued");
    assert_eq!(
        adapter.sent_messages()[0].to_addresses,
        vec!["new@example.test"]
    );
}

#[test]
fn send_queue_due_batch_processes_all_due_items_and_skips_future_scheduled_items() {
    let connection = test_connection();
    let vault = FakeSecretVaultAdapter::default();
    seed_send_enabled_normal_account_with_secret(&connection, &vault);
    seed_queued_send_with(
        &connection,
        "msg_unscheduled",
        "send-unscheduled",
        "unscheduled@example.test",
        "2026-06-12T01:09:00Z",
    );
    seed_queued_send_with_due(
        &connection,
        "msg_due_one",
        "send-due-one",
        "one@example.test",
        Some("2026-06-12T01:19:00Z"),
        "2026-06-12T01:10:00Z",
    );
    seed_queued_send_with_due(
        &connection,
        "msg_due_two",
        "send-due-two",
        "two@example.test",
        Some("2026-06-12T01:20:00Z"),
        "2026-06-12T01:11:00Z",
    );
    seed_queued_send_with_due(
        &connection,
        "msg_future",
        "send-future",
        "future@example.test",
        Some("2026-06-12T01:21:00Z"),
        "2026-06-12T01:12:00Z",
    );
    let adapter = FakeSmtpAdapter::success();

    let result = run_send_queue_due_batch(
        &connection,
        &vault,
        &adapter,
        "2026-06-12T01:20:00Z".to_string(),
        10,
    )
    .expect("due batch");

    let rows = list_recent_send_queue(&connection, 10).expect("list queue");
    let future = rows
        .iter()
        .find(|row| row.id == "send-future")
        .expect("future row");
    let unscheduled = rows
        .iter()
        .find(|row| row.id == "send-unscheduled")
        .expect("unscheduled row");

    assert_eq!(result.processed_count, 2);
    assert_eq!(result.sent_count, 2);
    assert_eq!(adapter.sent_messages().len(), 2);
    assert_eq!(future.status, "queued");
    assert_eq!(unscheduled.status, "queued");
}

#[test]
fn send_queue_due_batch_caps_extreme_limits() {
    let connection = test_connection();
    let vault = FakeSecretVaultAdapter::default();
    seed_send_enabled_normal_account_with_secret(&connection, &vault);
    let now = "2026-06-12T01:20:00Z";

    for index in 0..=MAX_SEND_QUEUE_BATCH_LIMIT {
        seed_queued_send_with_due(
            &connection,
            &format!("msg_due_{index}"),
            &format!("send-due-{index}"),
            &format!("target-{index}@example.test"),
            Some("2026-06-12T01:19:00Z"),
            now,
        );
    }
    let adapter = FakeSmtpAdapter::success();

    let result =
        run_send_queue_due_batch(&connection, &vault, &adapter, now.to_string(), usize::MAX)
            .expect("bounded due batch");
    let queued_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM send_queue WHERE status = 'queued'",
            [],
            |row| row.get(0),
        )
        .expect("count remaining queue");

    assert_eq!(result.processed_count, MAX_SEND_QUEUE_BATCH_LIMIT);
    assert_eq!(adapter.sent_messages().len(), MAX_SEND_QUEUE_BATCH_LIMIT);
    assert_eq!(queued_count, 1);
}
