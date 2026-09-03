use mailparse::parse_headers;

use crate::error::ErrorCategory;
use crate::imap::models::ImapConnectionProfile;

use super::connection::connect_session;
use super::folders::default_inbox_folder;
use super::headers::{
    header_value, normalize_rfc_message_id, parse_rfc_message_id_list, HEADER_FETCH_QUERY,
};
use super::message_body::decoded_message_body;
use super::move_protocol::{parse_copyuid_target_uid, parse_uid_set};

#[test]
fn native_imap_parses_decoded_headers() {
    let raw = b"Subject: =?UTF-8?B?5rWL6K+V?=\r\nFrom: Alice <alice@example.test>\r\nDate: Fri, 12 Jun 2026 10:00:00 +0800\r\n\r\n";
    let (headers, _) = parse_headers(raw).expect("parse headers");

    assert_eq!(header_value(&headers, "Subject"), Some("测试".to_string()));
    assert_eq!(
        header_value(&headers, "From"),
        Some("Alice <alice@example.test>".to_string())
    );
}

#[test]
fn native_imap_decodes_lowercase_rfc2047_headers_from_qq() {
    let raw = b"From: =?utf-8?B?UVHpgq7nrrHlm6LpmJ8==?= <10000@qq.com>\r\nSubject: =?utf-8?B?5pu05a6J5YWo44CB5pu06auY5pWI44CB5pu05by65aSn77yM5bC95ZyoUVHpgq7nrrFBUFA==?=\r\n\r\n";
    let (headers, _) = parse_headers(raw).expect("parse headers");

    assert_eq!(
        header_value(&headers, "Subject"),
        Some("更安全、更高效、更强大，尽在QQ邮箱APP".to_string())
    );
    assert_eq!(
        header_value(&headers, "From"),
        Some("QQ邮箱团队 <10000@qq.com>".to_string())
    );
}

#[test]
fn native_imap_decodes_legacy_gbk_headers() {
    let raw = b"Subject: \xc4\xe3\xba\xc3\r\nFrom: \xd5\xc5\xc8\xfd <sender@example.test>\r\n\r\n";
    let (headers, _) = parse_headers(raw).expect("parse headers");

    assert_eq!(header_value(&headers, "Subject"), Some("你好".to_string()));
    assert_eq!(
        header_value(&headers, "From"),
        Some("张三 <sender@example.test>".to_string())
    );
}

#[test]
fn native_imap_normalizes_rfc_threading_headers() {
    let raw = b"Message-ID: <Root@Example.Test>\r\nIn-Reply-To: <Parent@Example.Test>\r\nReferences: <Root@Example.Test> <Parent@Example.Test>\r\n\r\n";
    let (headers, _) = parse_headers(raw).expect("parse headers");

    assert_eq!(
        header_value(&headers, "Message-ID").and_then(|value| normalize_rfc_message_id(&value)),
        Some("root@example.test".to_string())
    );
    assert_eq!(
        header_value(&headers, "In-Reply-To").and_then(|value| normalize_rfc_message_id(&value)),
        Some("parent@example.test".to_string())
    );
    assert_eq!(
        header_value(&headers, "References").map(|value| parse_rfc_message_id_list(&value)),
        Some(vec![
            "root@example.test".to_string(),
            "parent@example.test".to_string()
        ])
    );
}

#[test]
fn native_imap_extracts_decoded_gbk_plain_text_body() {
    let raw = b"Content-Type: text/plain; charset=gbk\r\nContent-Transfer-Encoding: base64\r\n\r\nxOO6ww==";

    assert_eq!(
        decoded_message_body(raw).map(|body| body.text),
        Some("你好".to_string())
    );
}

#[test]
fn native_imap_converts_html_body_to_readable_text() {
    let raw = r#"Content-Type: text/html; charset=utf-8
Content-Transfer-Encoding: 8bit

<html>
  <head>
    <style>.hidden { display: none; }</style>
    <script>alert("ignore")</script>
  </head>
  <body>
    <p>你好&nbsp;<strong>用户</strong></p>
    <div>验证码：<span>123456</span></div>
    <p>确认 &amp; 继续</p>
  </body>
</html>"#
        .as_bytes();

    let body = decoded_message_body(raw).expect("decoded body");

    assert_eq!(body.text, "你好 用户\n验证码：123456\n确认 & 继续");
    let html = body.html.expect("html render body");
    assert!(html.contains("<base target=\"_blank\">"));
    assert!(html.contains("<strong>用户</strong>"));
    assert!(!html.contains("<script>"));
}

#[test]
fn native_imap_preserves_html_anchor_href_in_render_html() {
    let raw = r#"Content-Type: text/html; charset=utf-8
Content-Transfer-Encoding: 8bit

<html>
  <body>
    <p>点击 <a href="https://example.test/reset?token=abc&amp;lang=zh">这里</a> 重置密码。</p>
    <p><a href="https://example.test/direct">https://example.test/direct</a></p>
  </body>
</html>"#
        .as_bytes();

    let body = decoded_message_body(raw).expect("decoded body");

    assert_eq!(
        body.text,
        "点击 这里 重置密码。\nhttps://example.test/direct"
    );
    let html = body.html.expect("html render body");
    assert!(html.contains("href=\"https://example.test/reset?token=abc&amp;lang=zh\""));
    assert!(html.contains(">这里</a>"));
    assert!(html.contains("https://example.test/direct"));
}

#[test]
fn native_imap_default_folder_is_inbox() {
    let folder = default_inbox_folder();
    assert_eq!(folder.path, "INBOX");
    assert_eq!(folder.folder_kind, "inbox");
}

#[test]
fn native_imap_rejects_plaintext_security_before_connecting() {
    let profile = ImapConnectionProfile {
        host: "imap.example.test".to_string(),
        port: 143,
        security: "plain".to_string(),
        username: "user@example.test".to_string(),
    };

    let Err(error) = connect_session(&profile, "password") else {
        panic!("plaintext security must be rejected before connecting");
    };

    assert_eq!(error.code, "imap_security_unsupported");
    assert_eq!(error.category, ErrorCategory::Validation);
    assert!(!error.retryable);
}

#[test]
fn native_imap_parses_copyuid_target_uid() {
    let response = b"* OK [COPYUID 1511554416 142 2048] Moved UID.\r\nA0001 OK MOVE completed\r\n";

    assert_eq!(
        parse_copyuid_target_uid(response, "142"),
        Some("2048".to_string())
    );
}

#[test]
fn native_imap_parses_copyuid_target_uid_from_ranges() {
    let response = b"* OK [COPYUID 1511554416 140:142 2046:2048] Moved UIDs.\r\nA0001 OK done\r\n";

    assert_eq!(
        parse_copyuid_target_uid(response, "142"),
        Some("2048".to_string())
    );
}

#[test]
fn native_imap_rejects_oversized_copyuid_sets() {
    let oversized = (1..=4097)
        .map(|uid| uid.to_string())
        .collect::<Vec<_>>()
        .join(",");
    assert_eq!(parse_uid_set(&oversized), None);
    assert_eq!(parse_uid_set("1:4097"), None);
}

#[test]
fn native_imap_header_fetch_query_uses_body_peek() {
    let body_peek_query = ["BODY", "PEEK[HEADER]"].join(".");
    let rejected_rfc822_header = ["RFC822", "HEADER"].join(".");

    assert!(
        HEADER_FETCH_QUERY.contains(&body_peek_query),
        "QQ IMAP accepts BODY.PEEK[HEADER] but drops RFC822.HEADER"
    );
    assert!(
        !HEADER_FETCH_QUERY.contains(&rejected_rfc822_header),
        "QQ IMAP closes the session for RFC822.HEADER header fetches"
    );
}
