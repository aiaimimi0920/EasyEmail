use super::*;

#[test]
fn normal_account_detail_fetches_and_caches_body_when_headers_only() {
    let connection = test_connection();
    let vault = FakeSecretVaultAdapter::default();
    let adapter = FakeImapAdapter::with_recent_headers(vec![fake_header("uid-1", "Welcome")]);
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

    let detail = load_message_detail_with_imap_body(
        &connection,
        &vault,
        &adapter,
        &message.message_id,
        "2026-06-12T00:15:00Z".to_string(),
    )
    .expect("detail")
    .expect("detail exists");

    assert_eq!(detail.body_text, Some("Body for uid-1".to_string()));
    assert_eq!(detail.body_cache_state, "cached");
}

#[test]
fn normal_account_detail_caches_rich_html_body() {
    let connection = test_connection();
    let vault = FakeSecretVaultAdapter::default();
    let adapter =
        FakeImapAdapter::with_recent_headers(vec![fake_header("uid-1", "OpenAI code")])
            .with_message_body(ImapMessageBody {
                text: "Your OpenAI code is 996703".to_string(),
                html: Some(
                    r#"<!doctype html><html><body><h1>OpenAI</h1><div style="background:#f3f3f3">996703</div></body></html>"#
                        .to_string(),
                ),
            });
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

    let detail = load_message_detail_with_imap_body(
        &connection,
        &vault,
        &adapter,
        &message.message_id,
        "2026-06-12T00:15:00Z".to_string(),
    )
    .expect("detail")
    .expect("detail exists");

    assert_eq!(
        detail.body_text,
        Some("Your OpenAI code is 996703".to_string())
    );
    assert!(detail
        .body_html
        .as_deref()
        .is_some_and(|html| html.contains("<h1>OpenAI</h1>")));
    assert_eq!(detail.body_cache_state, "cached");
}

#[test]
fn cached_message_detail_plan_requires_no_imap_fetch() {
    let connection = test_connection();
    let vault = FakeSecretVaultAdapter::default();
    let adapter = FakeImapAdapter::with_recent_headers(vec![fake_header("uid-1", "Welcome")])
        .with_message_body(ImapMessageBody {
            text: "Body for uid-1".to_string(),
            html: None,
        });
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
    let message = load_message_detail_with_imap_body(
        &connection,
        &vault,
        &adapter,
        &list_normal_account_messages(&connection, &result.account.id)
            .expect("messages")
            .pop()
            .expect("message")
            .message_id,
        "2026-06-12T00:15:00Z".to_string(),
    )
    .expect("prime the body cache")
    .expect("detail exists");
    assert_eq!(message.body_cache_state, "cached");

    // The body is cached now, so planning must resolve the detail outright and
    // leave nothing for the lock-free fetch phase to do.
    let plan =
        plan_message_detail(&connection, &vault, &message.message_id).expect("plan cached detail");
    assert!(!plan.needs_fetch());

    let before = adapter.recorded_actions().len();
    let body = fetch_planned_message_body(&adapter, &plan).expect("fetch phase");

    assert!(body.is_none());
    assert_eq!(
        adapter.recorded_actions().len(),
        before,
        "a cached body must not reach IMAP"
    );

    let detail = persist_planned_message_body(&connection, plan, body, "2026-06-12T00:20:00Z")
        .expect("persist phase")
        .expect("detail exists");
    assert_eq!(detail.body_text, Some("Body for uid-1".to_string()));
}

#[test]
fn normal_account_detail_refetches_undecoded_cached_body() {
    let connection = test_connection();
    let vault = FakeSecretVaultAdapter::default();
    let adapter = FakeImapAdapter::with_recent_headers(vec![fake_header("uid-1", "Welcome")]);
    let smtp_adapter = FakeSmtpAdapter::success();
    let result = seed_manual_account(&connection, &vault, &adapter, &smtp_adapter);
    sync_recent_headers(
        &connection,
        &vault,
        &adapter,
        SyncRecentHeadersRequest {
            account_id: result.account.id.clone(),
            limit: 10,
        },
        "2026-06-12T00:05:00Z".to_string(),
    )
    .expect("sync headers");
    let message_id: String = connection
        .query_row("SELECT id FROM messages LIMIT 1", [], |row| row.get(0))
        .expect("read message id");
    update_message_body_text_cache(
        &connection,
        &message_id,
        "Content-Transfer-Encoding: base64\r\n\r\nxOO6ww==",
        "2026-06-12T00:06:00Z",
    )
    .expect("seed undecoded cache");

    let detail = load_message_detail_with_imap_body(
        &connection,
        &vault,
        &adapter,
        &message_id,
        "2026-06-12T00:07:00Z".to_string(),
    )
    .expect("load detail")
    .expect("detail exists");

    assert_eq!(detail.body_text, Some("Body for uid-1".to_string()));
    assert_eq!(detail.body_cache_state, "cached");
}

#[test]
fn normal_account_detail_refetches_cached_html_body() {
    let connection = test_connection();
    let vault = FakeSecretVaultAdapter::default();
    let adapter = FakeImapAdapter::with_recent_headers(vec![fake_header("uid-1", "Welcome")]);
    let smtp_adapter = FakeSmtpAdapter::success();
    let result = seed_manual_account(&connection, &vault, &adapter, &smtp_adapter);
    sync_recent_headers(
        &connection,
        &vault,
        &adapter,
        SyncRecentHeadersRequest {
            account_id: result.account.id.clone(),
            limit: 10,
        },
        "2026-06-12T00:05:00Z".to_string(),
    )
    .expect("sync headers");
    let message_id: String = connection
        .query_row("SELECT id FROM messages LIMIT 1", [], |row| row.get(0))
        .expect("read message id");
    update_message_body_text_cache(
        &connection,
        &message_id,
        "<html><body><p>Raw cached HTML</p></body></html>",
        "2026-06-12T00:06:00Z",
    )
    .expect("seed html cache");

    let detail = load_message_detail_with_imap_body(
        &connection,
        &vault,
        &adapter,
        &message_id,
        "2026-06-12T00:07:00Z".to_string(),
    )
    .expect("load detail")
    .expect("detail exists");

    assert_eq!(detail.body_text, Some("Body for uid-1".to_string()));
}
