use super::*;

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
