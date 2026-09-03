use super::*;

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
    let messages = list_normal_account_messages(&connection, &account_id).expect("list messages");
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
