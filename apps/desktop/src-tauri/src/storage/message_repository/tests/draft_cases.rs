use super::*;

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
