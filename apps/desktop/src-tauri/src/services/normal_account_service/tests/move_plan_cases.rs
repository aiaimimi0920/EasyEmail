use super::*;

/// The phased move must reach the same end state as the locked path, and must
/// send its IMAP move only from the phase that holds no database lock.
#[test]
fn planned_move_matches_the_locked_path_and_sends_its_move_after_planning() {
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

    let plan =
        plan_move_action(&connection, &vault, &message.message_id, "spam").expect("plan phase");

    // A synced account must resolve the target from cache, so the lock-free
    // path applies rather than the locked fallback.
    assert!(
        !plan.requires_locked_fallback(),
        "a synced account must not need the locked fallback"
    );
    assert!(plan.needs_remote());

    let before_fetch = adapter.recorded_actions().len();
    let move_result = fetch_planned_move(&adapter, &plan).expect("fetch phase");

    // The plan must have captured the right source folder and uid while it
    // still had database access.
    assert_eq!(
        adapter.recorded_actions()[before_fetch..],
        [FakeImapAction::Move {
            from_folder_path: "INBOX".to_string(),
            target_folder_path: "Spam".to_string(),
            provider_message_id: "uid-spam".to_string(),
        }]
    );

    let action = persist_planned_move(&connection, plan, move_result, "2026-06-12T00:20:00Z")
        .expect("persist phase");
    let messages_after =
        list_normal_account_messages(&connection, &result.account.id).expect("messages after");

    assert!(action.changed);
    assert!(action.remote_applied);
    assert_eq!(action.status, "remote_folder:spam");
    assert_eq!(messages_after[0].local_state.local_folder, "spam");
}

/// A target folder missing from the cache must report the locked fallback
/// rather than silently skipping the remote move. This is what keeps the
/// phased path from degrading behaviour: resolving an uncached folder needs a
/// network discovery interleaved with the writes that assign folder ids.
#[test]
fn planned_move_requires_the_locked_fallback_when_the_target_is_not_cached() {
    let connection = test_connection();
    let vault = FakeSecretVaultAdapter::default();
    // Sync caches only INBOX, so "spam" cannot resolve from the cache.
    let adapter = FakeImapAdapter::with_recent_headers(vec![fake_header("uid-nocache", "Move me")])
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

    let plan =
        plan_move_action(&connection, &vault, &message.message_id, "spam").expect("plan phase");

    assert!(
        plan.requires_locked_fallback(),
        "an uncached target must defer to the locked path, not skip the move"
    );
    assert!(!plan.needs_remote());
}

/// A folder with no remote counterpart stays local, and the phased path must
/// not attempt any IMAP call for it.
#[test]
fn planned_move_to_a_local_only_folder_sends_nothing() {
    let connection = test_connection();
    let vault = FakeSecretVaultAdapter::default();
    let adapter = FakeImapAdapter::with_recent_headers(Vec::new());

    let plan =
        plan_move_action(&connection, &vault, "missing-message", "later").expect("plan phase");

    assert!(!plan.needs_remote());
    assert!(!plan.requires_locked_fallback());

    let move_result = fetch_planned_move(&adapter, &plan).expect("fetch phase");
    assert!(move_result.is_none());
    assert!(adapter.recorded_actions().is_empty());
}

/// The phased archive must reach the same end state as the locked path, and
/// send its IMAP move only from the phase holding no database lock.
#[test]
fn planned_archive_moves_to_the_archive_folder_and_sets_the_local_flag() {
    let connection = test_connection();
    let vault = FakeSecretVaultAdapter::default();
    let adapter = FakeImapAdapter::with_recent_headers(vec![fake_header("uid-arch", "Archive me")])
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
        plan_archive_action(&connection, &vault, &message.message_id, true).expect("plan phase");

    assert!(
        !plan.requires_locked_fallback(),
        "a synced account must resolve the archive folder from cache"
    );
    assert!(plan.needs_remote());

    let before_fetch = adapter.recorded_actions().len();
    let move_result = fetch_planned_move(&adapter, &plan).expect("fetch phase");

    assert_eq!(
        adapter.recorded_actions()[before_fetch..],
        [FakeImapAction::Move {
            from_folder_path: "INBOX".to_string(),
            target_folder_path: "Archive".to_string(),
            provider_message_id: "uid-arch".to_string(),
        }]
    );

    let action = persist_planned_move(&connection, plan, move_result, "2026-06-12T00:20:00Z")
        .expect("persist phase");

    assert!(action.changed);
    assert!(action.remote_applied);
    assert_eq!(action.status, "remote_archived");

    // Archived messages drop out of the default listing.
    assert!(
        list_normal_account_messages(&connection, &result.account.id)
            .expect("messages after")
            .is_empty(),
        "an archived message must not remain in the default listing"
    );
}

/// Un-archiving only clears a local flag, so it must never plan remote work.
#[test]
fn planned_archive_clearing_stays_local_and_sends_nothing() {
    let connection = test_connection();
    let vault = FakeSecretVaultAdapter::default();
    let adapter = FakeImapAdapter::with_recent_headers(Vec::new());

    let plan = plan_archive_action(&connection, &vault, "some-message", false).expect("plan phase");

    assert!(!plan.needs_remote());
    assert!(!plan.requires_locked_fallback());

    let move_result = fetch_planned_move(&adapter, &plan).expect("fetch phase");
    assert!(move_result.is_none());
    assert!(adapter.recorded_actions().is_empty());

    let action = persist_planned_move(&connection, plan, None, "2026-06-12T00:20:00Z")
        .expect("persist phase");
    assert!(!action.remote_applied);
    assert_eq!(action.status, "archived_cleared");
}

/// An archive folder missing from the cache must defer to the locked path
/// rather than silently skipping the remote move.
#[test]
fn planned_archive_requires_the_locked_fallback_when_the_archive_folder_is_not_cached() {
    let connection = test_connection();
    let vault = FakeSecretVaultAdapter::default();
    let adapter =
        FakeImapAdapter::with_recent_headers(vec![fake_header("uid-noarch", "Archive me")])
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

    let plan =
        plan_archive_action(&connection, &vault, &message.message_id, true).expect("plan phase");

    assert!(
        plan.requires_locked_fallback(),
        "an uncached archive folder must defer to the locked path"
    );
    assert!(!plan.needs_remote());
}
