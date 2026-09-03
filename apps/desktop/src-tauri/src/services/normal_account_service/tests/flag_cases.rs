use super::*;

#[test]
fn normal_message_read_action_updates_imap_seen_and_local_cache() {
    let connection = test_connection();
    let vault = FakeSecretVaultAdapter::default();
    let adapter = FakeImapAdapter::with_recent_headers(vec![fake_header("uid-1", "Welcome")])
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
            action: NormalMessageAction::SetRead(true),
        },
        "2026-06-12T00:20:00Z".to_string(),
    )
    .expect("apply read action");
    let messages_after =
        list_normal_account_messages(&connection, &result.account.id).expect("messages after");

    assert!(action.changed);
    assert!(action.remote_applied);
    assert_eq!(
        adapter.recorded_actions(),
        vec![FakeImapAction::SetFlag {
            folder_path: "INBOX".to_string(),
            provider_message_id: "uid-1".to_string(),
            flag: "\\Seen".to_string(),
            enabled: true,
        }]
    );
    assert!(messages_after[0].local_state.is_read);
}

#[test]
fn normal_message_star_action_updates_imap_flagged_and_local_cache() {
    let connection = test_connection();
    let vault = FakeSecretVaultAdapter::default();
    let adapter = FakeImapAdapter::with_recent_headers(vec![fake_header("uid-star", "Star me")])
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
            action: NormalMessageAction::SetStarred(true),
        },
        "2026-06-12T00:20:00Z".to_string(),
    )
    .expect("apply star action");
    let messages_after =
        list_normal_account_messages(&connection, &result.account.id).expect("messages after");

    assert!(action.changed);
    assert!(action.remote_applied);
    assert_eq!(
        adapter.recorded_actions(),
        vec![FakeImapAction::SetFlag {
            folder_path: "INBOX".to_string(),
            provider_message_id: "uid-star".to_string(),
            flag: "\\Flagged".to_string(),
            enabled: true,
        }]
    );
    assert!(messages_after[0].local_state.is_starred);
}

/// Note on what this does and does not prove: that planning performs no IMAP
/// call is guaranteed by `plan_remote_flag_action` taking no adapter, not by
/// any assertion here. What is actually worth testing is that the plan carries
/// the correct folder and provider id across the lock release, since planning
/// is the last phase with database access.
#[test]
fn planned_flag_action_targets_the_same_folder_and_uid_after_the_lock_release() {
    let connection = test_connection();
    let vault = FakeSecretVaultAdapter::default();
    let adapter = FakeImapAdapter::with_recent_headers(vec![fake_header("uid-1", "Welcome")])
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

    let plan = plan_remote_flag_action(
        &connection,
        &vault,
        &message.message_id,
        RemoteFlagKind::Read,
        true,
    )
    .expect("plan phase");

    let after_plan = adapter.recorded_actions().len();
    assert!(plan.needs_remote());

    push_planned_remote_flag(&adapter, &plan).expect("push phase");

    // The plan must have captured the real folder and provider id while it had
    // database access; getting either wrong would target the wrong message.
    assert_eq!(
        adapter.recorded_actions()[after_plan..],
        [FakeImapAction::SetFlag {
            folder_path: "INBOX".to_string(),
            provider_message_id: "uid-1".to_string(),
            flag: "\\Seen".to_string(),
            enabled: true,
        }]
    );

    let action = persist_planned_remote_flag(&connection, plan, "2026-06-12T00:20:00Z")
        .expect("persist phase");
    let messages_after =
        list_normal_account_messages(&connection, &result.account.id).expect("messages after");

    assert!(action.changed);
    assert!(action.remote_applied);
    assert_eq!(action.status, "remote_read");
    assert!(messages_after[0].local_state.is_read);
}

#[test]
fn planned_permanent_delete_sets_remote_deleted_flag_then_soft_deletes_locally() {
    let connection = test_connection();
    let vault = FakeSecretVaultAdapter::default();
    let adapter = FakeImapAdapter::with_recent_headers(vec![fake_header("uid-gone", "Bye")])
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

    let plan =
        plan_permanent_delete_action(&connection, &vault, &message.message_id).expect("plan phase");
    let after_plan = adapter.recorded_actions().len();
    assert!(plan.needs_remote());

    push_planned_remote_flag(&adapter, &plan).expect("push phase");

    assert_eq!(
        adapter.recorded_actions()[after_plan..],
        [FakeImapAction::SetFlag {
            folder_path: "INBOX".to_string(),
            provider_message_id: "uid-gone".to_string(),
            flag: "\\Deleted".to_string(),
            enabled: true,
        }]
    );

    let action = persist_planned_remote_flag(&connection, plan, "2026-06-12T00:20:00Z")
        .expect("persist phase");

    assert!(action.changed);
    assert!(action.remote_applied);
    assert_eq!(action.status, "remote_deleted_forever");
    assert!(
        list_normal_account_messages(&connection, &result.account.id)
            .expect("messages after")
            .is_empty(),
        "a permanently deleted message must not stay in the account listing"
    );
}

#[test]
fn phased_flag_action_on_a_message_without_imap_source_stays_local() {
    let connection = test_connection();
    let vault = FakeSecretVaultAdapter::default();
    let adapter = FakeImapAdapter::with_recent_headers(Vec::new());

    let plan = plan_remote_flag_action(
        &connection,
        &vault,
        "missing-message",
        RemoteFlagKind::Starred,
        true,
    )
    .expect("plan phase");

    // Without an IMAP source the caller can keep its lock: there is no round
    // trip to make room for.
    assert!(!plan.needs_remote());

    let action = persist_planned_remote_flag(&connection, plan, "2026-06-12T00:20:00Z")
        .expect("persist phase");

    assert!(!action.remote_applied);
    assert_eq!(action.status, "starred");
    assert!(adapter.recorded_actions().is_empty());
}
