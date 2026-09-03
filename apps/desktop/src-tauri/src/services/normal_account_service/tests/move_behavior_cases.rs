use super::*;

#[test]
fn normal_message_move_action_moves_remote_to_spam_and_updates_local_folder() {
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

    let action = apply_normal_message_action(
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
    let messages_after =
        list_normal_account_messages(&connection, &result.account.id).expect("messages after");

    assert!(action.changed);
    assert!(action.remote_applied);
    assert_eq!(
        adapter.recorded_actions(),
        vec![FakeImapAction::Move {
            from_folder_path: "INBOX".to_string(),
            target_folder_path: "Spam".to_string(),
            provider_message_id: "uid-spam".to_string(),
        }]
    );
    assert_eq!(messages_after[0].local_state.local_folder, "spam");
}

/// Pins which branch of `resolve_target_folder` a synced account actually
/// takes, because a proposed refactor turns that function into a pure read.
///
/// `with_folders` supplies what discovery *returns*; it does not populate the
/// local folder cache. The cache is populated by `sync_recent_headers`, which
/// upserts discovered folders. So for a synced account the action resolves
/// from the cache and never reaches the network — which is what makes the
/// pure-read refactor safe on this path. The untested risk is the account that
/// has never synced folders at all.
#[test]
fn move_action_on_a_synced_account_resolves_the_target_folder_without_discovery() {
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

    // Sync itself discovers folders, so the baseline is taken after setup to
    // attribute any further discovery to the action under test.
    let discoveries_before = adapter.discover_folders_call_count();

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

    assert_eq!(
        adapter.discover_folders_call_count(),
        discoveries_before,
        "a synced account must resolve the target folder from the local cache; \
         sync already upserted the folders, so the action itself needs no \
         network discovery"
    );
}

/// Pins what happens when the target folder cannot be resolved at all: the
/// local state still changes and `remote_applied` reports false, with no
/// error. Both `resolve_target_folder` call sites share this shape.
///
/// This is the safety net for turning `resolve_target_folder` into a pure
/// read. That change would make an uncached target resolve to `None`, and
/// this test records that `None` degrades to local-only rather than failing —
/// which also means the failure mode is *silent* divergence from the server,
/// so a pure read is only safe if sync reliably caches every target folder.
#[test]
fn move_action_degrades_to_local_only_when_the_target_folder_does_not_exist_remotely() {
    let connection = test_connection();
    let vault = FakeSecretVaultAdapter::default();
    // A server that only has INBOX: nothing can resolve to a spam folder,
    // neither from the cache nor from discovery.
    let adapter =
        FakeImapAdapter::with_recent_headers(vec![fake_header("uid-only-inbox", "Move me")])
            .with_folders(vec![test_folder("INBOX", "INBOX", "inbox")]);
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
            action: NormalMessageAction::MoveTo("spam".to_string()),
        },
        "2026-06-12T00:20:00Z".to_string(),
    )
    .expect("an unresolvable target folder must not be an error");

    assert!(
        !action.remote_applied,
        "no remote move is possible when the target folder does not exist"
    );
    assert!(
        !adapter
            .recorded_actions()
            .iter()
            .any(|entry| matches!(entry, FakeImapAction::Move { .. })),
        "no Move may be sent for a folder that could not be resolved"
    );

    let messages_after =
        list_normal_account_messages(&connection, &result.account.id).expect("messages after");
    assert_eq!(
        messages_after[0].local_state.local_folder, "spam",
        "the local folder still changes, so local and server state diverge"
    );
}

#[test]
fn normal_message_move_action_moves_to_custom_folder_locally() {
    let connection = test_connection();
    let vault = FakeSecretVaultAdapter::default();
    let adapter =
        FakeImapAdapter::with_recent_headers(vec![fake_header("uid-custom-folder", "Move me")])
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
            action: NormalMessageAction::MoveTo("Receipts".to_string()),
        },
        "2026-06-12T00:20:00Z".to_string(),
    )
    .expect("apply custom folder move");
    let messages_after =
        list_normal_account_messages(&connection, &result.account.id).expect("messages after");

    assert!(action.changed);
    assert!(!action.remote_applied);
    assert!(adapter.recorded_actions().is_empty());
    assert_eq!(messages_after[0].local_state.local_folder, "receipts");
}
