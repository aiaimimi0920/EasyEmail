use super::authentication::*;
use super::network::*;
use super::resolution::*;
use super::storage::*;
use super::*;
use crate::storage::db::open_in_memory_database;
use crate::storage::migrations::run_migrations;

#[test]
fn authentication_results_require_exact_method_result_tokens() {
    let headers = "mx.example; spf=passfoo smtp.mailfrom=attacker.test; dkim=failish; dmarc=pass";

    assert!(!authentication_result_is(headers, "spf", "pass"));
    assert!(!authentication_result_is(headers, "dkim", "fail"));
    assert!(authentication_result_is(headers, "dmarc", "pass"));
    assert!(!received_spf_result_is("notpass (sender SPF)", "pass"));
    assert!(received_spf_result_is("pass (sender SPF)", "pass"));
}

#[test]
fn avatar_redirects_are_revalidated_before_following() {
    assert_eq!(
        resolve_safe_redirect("https://assets.example.com/icon", "/mail/icon.png")
            .expect("safe relative redirect"),
        "https://assets.example.com/mail/icon.png"
    );
    for location in [
        "http://assets.example.com/icon.png",
        "https://127.0.0.1/icon.png",
        "//localhost/icon.png",
        "file:///etc/passwd",
    ] {
        assert!(
            resolve_safe_redirect("https://assets.example.com/icon", location).is_err(),
            "unsafe redirect should fail: {location}"
        );
    }
}

#[test]
fn avatar_targets_reject_non_public_resolved_addresses() {
    for address in [
        "0.0.0.0",
        "10.0.0.1",
        "100.64.0.1",
        "127.0.0.1",
        "169.254.1.1",
        "172.16.0.1",
        "192.168.0.1",
        "198.18.0.1",
        "224.0.0.1",
        "::1",
        "fc00::1",
        "fe80::1",
        "2001:db8::1",
        "::ffff:127.0.0.1",
    ] {
        assert!(
            !is_public_ip(address.parse().expect("parse non-public address")),
            "non-public address must be rejected: {address}"
        );
    }

    for address in ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"] {
        assert!(
            is_public_ip(address.parse().expect("parse public address")),
            "public address should be accepted: {address}"
        );
    }
}

#[test]
fn bimi_record_parser_extracts_logo_and_certificate() {
    let record = parse_bimi_record(
        "v=BIMI1; l=https://example.com/logo.svg; a=https://example.com/vmc.pem;",
    )
    .expect("parse BIMI");

    assert_eq!(
        record.logo_url.as_deref(),
        Some("https://example.com/logo.svg")
    );
    assert_eq!(
        record.certificate_url.as_deref(),
        Some("https://example.com/vmc.pem")
    );
}

#[test]
fn domain_candidates_preserve_chinese_registered_domain() {
    assert_eq!(
        domain_candidates("mail.rails.com.cn"),
        vec!["mail.rails.com.cn".to_string(), "rails.com.cn".to_string()]
    );
    assert_eq!(
        domain_candidates("tm.openai.com"),
        vec!["tm.openai.com".to_string(), "openai.com".to_string()]
    );
}

#[test]
fn contact_avatar_resolution_plan_requires_no_network_phase() {
    let connection = open_in_memory_database().expect("open database");
    run_migrations(&connection).expect("run migrations");
    let image = "data:image/png;base64,iVBORw0KGgo=";
    set_contact_avatar(&connection, "ChatGPT <noreply@tm.openai.com>", image)
        .expect("save contact avatar");

    let plan = plan_sender_avatar_resolution(
        &connection,
        vec!["ChatGPT <noreply@tm.openai.com>".to_string()],
    )
    .expect("plan resolution");

    // A contact override is a pure database hit, so the caller can finish
    // without ever releasing its lock for a fetch.
    assert!(!plan.has_pending());
    let resolved = persist_fetched_avatars(&connection, plan, Vec::new()).expect("persist");
    assert_eq!(resolved.len(), 1);
    assert_eq!(resolved[0].source_kind, "contact");
    assert_eq!(resolved[0].image_data_url.as_deref(), Some(image));
}

#[test]
fn oversized_avatar_data_url_is_rejected_before_base64_decoding() {
    let error = parse_image_data_url("data:image/png;base64,!!!!!", 3)
        .expect_err("oversized payload must be rejected");

    assert_eq!(error.code, "avatar_image_too_large");
}

#[test]
fn disabled_remote_lookups_never_schedule_a_fetch() {
    let connection = open_in_memory_database().expect("open database");
    run_migrations(&connection).expect("run migrations");
    save_avatar_settings(
        &connection,
        AvatarSettingsDto {
            remote_enabled: false,
            bimi_enabled: false,
            favicon_enabled: false,
            auth_enabled: false,
        },
    )
    .expect("disable remote avatar lookups");

    let plan = plan_sender_avatar_resolution(
        &connection,
        vec!["Someone <someone@example.test>".to_string()],
    )
    .expect("plan resolution");

    assert!(!plan.has_pending());
    let resolved = persist_fetched_avatars(&connection, plan, Vec::new()).expect("persist");
    assert_eq!(resolved.len(), 1);
    assert_eq!(resolved[0].source_kind, "builtin");
}

#[test]
fn unresolved_senders_are_deferred_to_the_lock_free_fetch_phase() {
    let connection = open_in_memory_database().expect("open database");
    run_migrations(&connection).expect("run migrations");

    let plan = plan_sender_avatar_resolution(
        &connection,
        vec!["Someone <someone@example.test>".to_string()],
    )
    .expect("plan resolution");

    // Nothing is cached and remote lookups are enabled by default, so this
    // sender must be handed to the phase that runs without the lock rather
    // than fetched inline.
    assert!(plan.has_pending());
    assert!(plan.resolved.is_empty());
    assert_eq!(plan.pending.len(), 1);
    assert_eq!(plan.pending[0].sender, "Someone <someone@example.test>");
}

#[test]
fn contact_avatar_round_trips_as_data_url() {
    let connection = open_in_memory_database().expect("open database");
    run_migrations(&connection).expect("run migrations");
    let image = "data:image/png;base64,iVBORw0KGgo=";

    let row = set_contact_avatar(&connection, "ChatGPT <noreply@tm.openai.com>", image)
        .expect("save contact avatar");

    assert_eq!(row.source_kind, "contact");
    assert_eq!(row.builtin_kind.as_deref(), Some("openai"));
    assert_eq!(row.image_data_url.as_deref(), Some(image));
}

#[test]
fn avatar_settings_default_to_remote_enabled() {
    let connection = open_in_memory_database().expect("open database");
    run_migrations(&connection).expect("run migrations");

    let settings = load_avatar_settings(&connection).expect("load settings");

    assert!(settings.remote_enabled);
    assert!(settings.bimi_enabled);
    assert!(settings.favicon_enabled);
    assert!(settings.auth_enabled);
}

#[test]
fn qq_mail_uses_official_qqmail_icon_candidates_before_domain_favicon() {
    let identity = normalize_sender_identity("QQ邮箱团队 <10000@qq.com>");

    let urls = provider_avatar_urls(&identity);

    assert_eq!(
        urls.first().map(String::as_str),
        Some("https://res.wx.qq.com/t/webmail/webmail/res/static/images/base/style/favicon/qqmail_favicon_96h.8d124a7.png")
    );
    assert!(urls.iter().any(|url| url.contains("qqmail_favicon_32h")));
    assert!(
        urls.iter()
            .position(|url| url.contains("qqmail_favicon_96h"))
            .unwrap()
            < urls
                .iter()
                .position(|url| url == "https://qq.com/favicon.ico")
                .unwrap()
    );
}

#[test]
fn openai_uses_official_brand_icon_before_domain_favicon() {
    let identity = normalize_sender_identity("OpenAI <noreply@tm.openai.com>");

    let urls = provider_avatar_urls(&identity);

    assert!(
        urls.first()
            .is_some_and(|url| url.contains("Blossom_Light.svg")),
        "OpenAI should prefer the official brand icon first, got {urls:?}"
    );
    assert!({
        let official = urls
            .iter()
            .position(|url| url.contains("Blossom_Light.svg"))
            .unwrap();
        let generic = urls
            .iter()
            .position(|url| url == "https://openai.com/favicon.ico")
            .unwrap();
        official < generic
    });
    assert!(provider_official_icon_url(&identity, &urls[0]));
}

#[test]
fn github_google_and_12306_use_official_icon_candidates_before_root_favicon() {
    let github = normalize_sender_identity("GitHub <noreply@github.com>");
    let github_urls = provider_avatar_urls(&github);
    assert_eq!(
        github_urls.first().map(String::as_str),
        Some("https://github.githubassets.com/favicons/favicon.svg")
    );
    assert!(provider_official_icon_url(&github, &github_urls[0]));

    let google = normalize_sender_identity("Google <no-reply@accounts.google.com>");
    let google_urls = provider_avatar_urls(&google);
    assert_eq!(
        google_urls.first().map(String::as_str),
        Some("https://ssl.gstatic.com/ui/v1/icons/mail/rfr/gmail.ico")
    );
    assert!(provider_official_icon_url(&google, &google_urls[0]));

    let railway = normalize_sender_identity("12306 <12306@rails.com.cn>");
    let railway_urls = provider_avatar_urls(&railway);
    assert_eq!(
        railway_urls.first().map(String::as_str),
        Some("https://www.12306.cn/index/images/favicon.ico")
    );
    assert!(provider_official_icon_url(&railway, &railway_urls[0]));
}

#[test]
fn google_mail_official_icon_candidates_do_not_include_lockup_wordmarks() {
    let identity = normalize_sender_identity("Gmail <mail-noreply@google.com>");
    let urls = provider_official_avatar_urls(&identity);

    assert!(
        urls.iter().all(|url| !url.contains("lockup")),
        "Gmail sender avatars should use square icon assets, not horizontal wordmark lockups: {urls:?}"
    );
}

#[test]
fn google_mail_rejects_cached_lockup_wordmark_official_icon() {
    let identity = normalize_sender_identity("Gmail <mail-noreply@google.com>");
    let cached = CachedAvatar {
        source_kind: "official-icon".to_string(),
        image_mime: Some("image/png".to_string()),
        image_bytes: Some(vec![1, 2, 3]),
        remote_url: Some(
            "https://ssl.gstatic.com/ui/v1/icons/mail/rfr/logo_gmail_lockup_default_1x_r5.png"
                .to_string(),
        ),
        fallback_text: identity.fallback_text.clone(),
        auth: SenderAuthDto::default(),
        fetched_at: now_rfc3339(),
        expires_at: (Utc::now() + chrono::Duration::days(1)).to_rfc3339(),
    };

    assert!(!cached_avatar_satisfies_provider_policy(
        &identity,
        &cached,
        &AvatarSettingsDto::default(),
    ));
}

#[test]
fn qq_mail_rejects_cached_generic_favicon_to_refresh_official_icon() {
    let identity = normalize_sender_identity("QQ邮箱团队 <10000@qq.com>");
    let cached = CachedAvatar {
        source_kind: "favicon".to_string(),
        image_mime: Some("image/png".to_string()),
        image_bytes: Some(vec![1, 2, 3]),
        remote_url: Some("https://qq.com/favicon.ico".to_string()),
        fallback_text: identity.fallback_text.clone(),
        auth: SenderAuthDto::default(),
        fetched_at: now_rfc3339(),
        expires_at: (Utc::now() + chrono::Duration::days(1)).to_rfc3339(),
    };

    assert!(!cached_avatar_satisfies_provider_policy(
        &identity,
        &cached,
        &AvatarSettingsDto::default(),
    ));
}

#[test]
fn openai_rejects_cached_subdomain_favicon_to_refresh_official_icon() {
    let identity = normalize_sender_identity("OpenAI <noreply@tm.openai.com>");
    let cached = CachedAvatar {
        source_kind: "favicon".to_string(),
        image_mime: Some("image/x-icon".to_string()),
        image_bytes: Some(vec![1, 2, 3]),
        remote_url: Some("https://tm.openai.com/favicon.ico".to_string()),
        fallback_text: identity.fallback_text.clone(),
        auth: SenderAuthDto::default(),
        fetched_at: now_rfc3339(),
        expires_at: (Utc::now() + chrono::Duration::days(1)).to_rfc3339(),
    };

    assert!(!cached_avatar_satisfies_provider_policy(
        &identity,
        &cached,
        &AvatarSettingsDto::default(),
    ));
}

#[test]
fn qq_mail_keeps_cached_official_icon_url() {
    let identity = normalize_sender_identity("QQ邮箱团队 <10000@qq.com>");
    let cached = CachedAvatar {
        source_kind: "favicon".to_string(),
        image_mime: Some("image/x-icon".to_string()),
        image_bytes: Some(vec![1, 2, 3]),
        remote_url: Some("https://mail.qq.com/favicon.ico".to_string()),
        fallback_text: identity.fallback_text.clone(),
        auth: SenderAuthDto::default(),
        fetched_at: now_rfc3339(),
        expires_at: (Utc::now() + chrono::Duration::days(1)).to_rfc3339(),
    };

    assert!(cached_avatar_satisfies_provider_policy(
        &identity,
        &cached,
        &AvatarSettingsDto::default(),
    ));
}
