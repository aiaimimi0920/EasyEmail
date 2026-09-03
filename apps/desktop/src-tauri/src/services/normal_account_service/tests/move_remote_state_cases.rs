use super::*;

#[test]
fn normal_message_move_action_updates_follow_up_remote_action_folder() {
    let connection = test_connection();
    let vault = FakeSecretVaultAdapter::default();
    let adapter = FakeImapAdapter::with_recent_headers(vec![fake_header("uid-spam", "Move me")])
        .with_folders(test_remote_folders());
    let smtp_adapter = FakeSmtpAdapter::success();
    let result = seed_manual_account(&connection, &vault, &adapter, &smtp_adapter);
    sync_recent_headers(
        &connection,
        &vault,
        &adapter,
        SyncRecentHeadersRequest {
            account_id: result.account.id.clone(),
            limit: 25,
        },
        "2026-06-12T00:10:00Z".to_string(),
    )
    .expect("sync recent");
    let message = list_normal_account_messages(&connection, &result.account.id)
        .expect("messages")
        .pop()
        .expect("message");

    apply_normal_message_action(
        &connection,
        &vault,
        &adapter,
        NormalMessageActionRequest {
            message_id: message.message_id.clone(),
            action: NormalMessageAction::MoveTo("spam".to_string()),
        },
        "2026-06-12T00:20:00Z".to_string(),
    )
    .expect("apply move action");
    apply_normal_message_action(
        &connection,
        &vault,
        &adapter,
        NormalMessageActionRequest {
            message_id: message.message_id.clone(),
            action: NormalMessageAction::SetStarred(true),
        },
        "2026-06-12T00:21:00Z".to_string(),
    )
    .expect("apply star action after move");

    assert_eq!(
        adapter.recorded_actions(),
        vec![
            FakeImapAction::Move {
                from_folder_path: "INBOX".to_string(),
                target_folder_path: "Spam".to_string(),
                provider_message_id: "uid-spam".to_string(),
            },
            FakeImapAction::SetFlag {
                folder_path: "Spam".to_string(),
                provider_message_id: "uid-spam".to_string(),
                flag: "\\Flagged".to_string(),
                enabled: true,
            },
        ]
    );
}

#[test]
fn normal_message_move_action_updates_follow_up_remote_action_uid_when_server_reports_target_uid() {
    let connection = test_connection();
    let vault = FakeSecretVaultAdapter::default();
    let adapter = FakeImapAdapter::with_recent_headers(vec![fake_header("uid-spam", "Move me")])
        .with_folders(test_remote_folders())
        .with_move_target_provider_message_id("uid-spam-target");
    let smtp_adapter = FakeSmtpAdapter::success();
    let result = seed_manual_account(&connection, &vault, &adapter, &smtp_adapter);
    sync_recent_headers(
        &connection,
        &vault,
        &adapter,
        SyncRecentHeadersRequest {
            account_id: result.account.id.clone(),
            limit: 25,
        },
        "2026-06-12T00:10:00Z".to_string(),
    )
    .expect("sync recent");
    let message = list_normal_account_messages(&connection, &result.account.id)
        .expect("messages")
        .pop()
        .expect("message");

    apply_normal_message_action(
        &connection,
        &vault,
        &adapter,
        NormalMessageActionRequest {
            message_id: message.message_id.clone(),
            action: NormalMessageAction::MoveTo("spam".to_string()),
        },
        "2026-06-12T00:20:00Z".to_string(),
    )
    .expect("apply move action");
    apply_normal_message_action(
        &connection,
        &vault,
        &adapter,
        NormalMessageActionRequest {
            message_id: message.message_id.clone(),
            action: NormalMessageAction::SetStarred(true),
        },
        "2026-06-12T00:21:00Z".to_string(),
    )
    .expect("apply star action after move");

    assert_eq!(
        adapter.recorded_actions(),
        vec![
            FakeImapAction::Move {
                from_folder_path: "INBOX".to_string(),
                target_folder_path: "Spam".to_string(),
                provider_message_id: "uid-spam".to_string(),
            },
            FakeImapAction::SetFlag {
                folder_path: "Spam".to_string(),
                provider_message_id: "uid-spam-target".to_string(),
                flag: "\\Flagged".to_string(),
                enabled: true,
            },
        ]
    );
}

#[test]
fn normal_account_detail_fetch_after_move_uses_current_remote_folder() {
    let connection = test_connection();
    let vault = FakeSecretVaultAdapter::default();
    let adapter = FakeImapAdapter::with_recent_headers(vec![fake_header("uid-spam", "Move me")])
        .with_folders(test_remote_folders());
    let smtp_adapter = FakeSmtpAdapter::success();
    let result = seed_manual_account(&connection, &vault, &adapter, &smtp_adapter);
    sync_recent_headers(
        &connection,
        &vault,
        &adapter,
        SyncRecentHeadersRequest {
            account_id: result.account.id.clone(),
            limit: 25,
        },
        "2026-06-12T00:10:00Z".to_string(),
    )
    .expect("sync recent");
    let message = list_normal_account_messages(&connection, &result.account.id)
        .expect("messages")
        .pop()
        .expect("message");

    apply_normal_message_action(
        &connection,
        &vault,
        &adapter,
        NormalMessageActionRequest {
            message_id: message.message_id.clone(),
            action: NormalMessageAction::MoveTo("spam".to_string()),
        },
        "2026-06-12T00:20:00Z".to_string(),
    )
    .expect("apply move action");
    load_message_detail_with_imap_body(
        &connection,
        &vault,
        &adapter,
        &message.message_id,
        "2026-06-12T00:21:00Z".to_string(),
    )
    .expect("load detail after move")
    .expect("detail exists");

    assert_eq!(
        adapter.recorded_actions(),
        vec![
            FakeImapAction::Move {
                from_folder_path: "INBOX".to_string(),
                target_folder_path: "Spam".to_string(),
                provider_message_id: "uid-spam".to_string(),
            },
            FakeImapAction::FetchBody {
                folder_path: "Spam".to_string(),
                provider_message_id: "uid-spam".to_string(),
            },
        ]
    );
}

#[test]
fn normal_message_delete_action_moves_remote_to_trash_and_keeps_local_trash_message() {
    let connection = test_connection();
    let vault = FakeSecretVaultAdapter::default();
    let adapter = FakeImapAdapter::with_recent_headers(vec![fake_header("uid-trash", "Delete me")])
        .with_folders(test_remote_folders());
    let smtp_adapter = FakeSmtpAdapter::success();
    let result = seed_manual_account(&connection, &vault, &adapter, &smtp_adapter);
    sync_recent_headers(
        &connection,
        &vault,
        &adapter,
        SyncRecentHeadersRequest {
            account_id: result.account.id.clone(),
            limit: 25,
        },
        "2026-06-12T00:10:00Z".to_string(),
    )
    .expect("sync recent");
    let message = list_normal_account_messages(&connection, &result.account.id)
        .expect("messages")
        .pop()
        .expect("message");

    let action = apply_normal_message_action(
        &connection,
        &vault,
        &adapter,
        NormalMessageActionRequest {
            message_id: message.message_id.clone(),
            action: NormalMessageAction::Delete,
        },
        "2026-06-12T00:20:00Z".to_string(),
    )
    .expect("apply delete action");
    let messages_after =
        list_normal_account_messages(&connection, &result.account.id).expect("messages after");

    assert!(action.changed);
    assert!(action.remote_applied);
    assert_eq!(
        adapter.recorded_actions(),
        vec![FakeImapAction::Move {
            from_folder_path: "INBOX".to_string(),
            target_folder_path: "Trash".to_string(),
            provider_message_id: "uid-trash".to_string(),
        }]
    );
    assert_eq!(messages_after.len(), 1);
    assert_eq!(messages_after[0].local_state.local_folder, "trash");
}

#[test]
fn normal_message_restore_from_trash_moves_remote_to_inbox_and_clears_trash_folder() {
    let connection = test_connection();
    let vault = FakeSecretVaultAdapter::default();
    let adapter =
        FakeImapAdapter::with_recent_headers(vec![fake_header("uid-trash", "Restore me")])
            .with_folders(test_remote_folders());
    let smtp_adapter = FakeSmtpAdapter::success();
    let result = seed_manual_account(&connection, &vault, &adapter, &smtp_adapter);
    sync_recent_headers(
        &connection,
        &vault,
        &adapter,
        SyncRecentHeadersRequest {
            account_id: result.account.id.clone(),
            limit: 25,
        },
        "2026-06-12T00:10:00Z".to_string(),
    )
    .expect("sync recent");
    let message = list_normal_account_messages(&connection, &result.account.id)
        .expect("messages")
        .pop()
        .expect("message");

    apply_normal_message_action(
        &connection,
        &vault,
        &adapter,
        NormalMessageActionRequest {
            message_id: message.message_id.clone(),
            action: NormalMessageAction::Delete,
        },
        "2026-06-12T00:20:00Z".to_string(),
    )
    .expect("move to trash");
    let restore = apply_normal_message_action(
        &connection,
        &vault,
        &adapter,
        NormalMessageActionRequest {
            message_id: message.message_id.clone(),
            action: NormalMessageAction::MoveTo("inbox".to_string()),
        },
        "2026-06-12T00:21:00Z".to_string(),
    )
    .expect("restore to inbox");
    let messages_after =
        list_normal_account_messages(&connection, &result.account.id).expect("messages after");

    assert!(restore.changed);
    assert!(restore.remote_applied);
    assert_eq!(
        adapter.recorded_actions(),
        vec![
            FakeImapAction::Move {
                from_folder_path: "INBOX".to_string(),
                target_folder_path: "Trash".to_string(),
                provider_message_id: "uid-trash".to_string(),
            },
            FakeImapAction::Move {
                from_folder_path: "Trash".to_string(),
                target_folder_path: "INBOX".to_string(),
                provider_message_id: "uid-trash".to_string(),
            },
        ]
    );
    assert_eq!(messages_after.len(), 1);
    assert_eq!(messages_after[0].local_state.local_folder, "inbox");
    assert!(!messages_after[0].local_state.is_archived);
}

#[test]
fn normal_message_delete_forever_flags_remote_deleted_and_hides_local_trash_message() {
    let connection = test_connection();
    let vault = FakeSecretVaultAdapter::default();
    let adapter = FakeImapAdapter::with_recent_headers(vec![fake_header("uid-trash", "Empty me")])
        .with_folders(test_remote_folders());
    let smtp_adapter = FakeSmtpAdapter::success();
    let result = seed_manual_account(&connection, &vault, &adapter, &smtp_adapter);
    sync_recent_headers(
        &connection,
        &vault,
        &adapter,
        SyncRecentHeadersRequest {
            account_id: result.account.id.clone(),
            limit: 25,
        },
        "2026-06-12T00:10:00Z".to_string(),
    )
    .expect("sync recent");
    let message = list_normal_account_messages(&connection, &result.account.id)
        .expect("messages")
        .pop()
        .expect("message");

    apply_normal_message_action(
        &connection,
        &vault,
        &adapter,
        NormalMessageActionRequest {
            message_id: message.message_id.clone(),
            action: NormalMessageAction::Delete,
        },
        "2026-06-12T00:20:00Z".to_string(),
    )
    .expect("move to trash");
    let delete_forever = apply_normal_message_action(
        &connection,
        &vault,
        &adapter,
        NormalMessageActionRequest {
            message_id: message.message_id.clone(),
            action: NormalMessageAction::DeleteForever,
        },
        "2026-06-12T00:21:00Z".to_string(),
    )
    .expect("delete forever");
    let messages_after =
        list_normal_account_messages_with_options(&connection, &result.account.id, true)
            .expect("messages after");

    assert!(delete_forever.changed);
    assert!(delete_forever.remote_applied);
    assert_eq!(
        adapter.recorded_actions(),
        vec![
            FakeImapAction::Move {
                from_folder_path: "INBOX".to_string(),
                target_folder_path: "Trash".to_string(),
                provider_message_id: "uid-trash".to_string(),
            },
            FakeImapAction::SetFlag {
                folder_path: "Trash".to_string(),
                provider_message_id: "uid-trash".to_string(),
                flag: "\\Deleted".to_string(),
                enabled: true,
            },
        ]
    );
    assert!(messages_after.is_empty());
}
