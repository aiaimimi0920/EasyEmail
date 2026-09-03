use super::*;

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

    let changed =
        soft_delete_message(&connection, &message_id, "2026-06-12T00:03:00Z").expect("soft delete");
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
    let all_mail_rows = list_normal_account_messages_with_options(&connection, &account_id, true)
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
    let message_id = list_normal_account_messages(&connection, &account_id).expect("list default")
        [0]
    .message_id
    .clone();

    let default_rows =
        list_normal_account_messages(&connection, &account_id).expect("list default read state");
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
    replace_message_source_folder_name(&connection, "Receipts", "Invoices", "2026-06-12T00:04:00Z")
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
    replace_message_source_label_name(&connection, "Client", "Customer", "2026-06-12T00:04:00Z")
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
