use super::*;

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
        let row = crate::storage::temp_mailbox_repository::get_temp_mailbox(&connection, temp_id)
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
