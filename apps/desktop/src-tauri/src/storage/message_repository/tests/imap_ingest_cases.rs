use super::*;

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
