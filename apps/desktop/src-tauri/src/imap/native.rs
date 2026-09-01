use imap::{ConnectionMode, Session};
use mailparse::{parse_headers, parse_mail, MailHeader, ParsedMail};

use crate::error::{ActionRequired, AppError, ErrorCategory};
use crate::imap::adapter::ImapAdapter;
use crate::imap::models::{
    ImapConnectionProfile, ImapConnectionTestResult, ImapFolder, ImapMessageBody, ImapMessageFlag,
    ImapMessageHeader, ImapMessageMoveResult,
};

#[derive(Debug, Clone, Default)]
pub struct NativeImapAdapter;

const HEADER_FETCH_QUERY: &str = "(UID BODY.PEEK[HEADER] INTERNALDATE)";

struct OpenHtmlAnchor {
    href: String,
    text_start: usize,
}

impl ImapAdapter for NativeImapAdapter {
    fn test_connection(
        &self,
        profile: &ImapConnectionProfile,
        secret: &str,
    ) -> Result<ImapConnectionTestResult, AppError> {
        let mut session = connect_session(profile, secret)?;
        let capabilities = session
            .capabilities()
            .map_err(|error| imap_error("imap_capabilities_failed", error))?;
        let summary = format!(
            "{} capabilities; IMAP4rev1={}",
            capabilities.len(),
            capabilities.has_str("IMAP4rev1")
        );
        logout_quietly(session);

        Ok(ImapConnectionTestResult {
            authenticated: true,
            capability_summary: summary,
        })
    }

    fn discover_folders(
        &self,
        profile: &ImapConnectionProfile,
        secret: &str,
    ) -> Result<Vec<ImapFolder>, AppError> {
        let mut session = connect_session(profile, secret)?;
        let names = session
            .list(None, Some("*"))
            .map_err(|error| imap_error("imap_list_folders_failed", error))?;
        let mut folders = names
            .iter()
            .map(|name| {
                let path = name.name().to_string();
                ImapFolder {
                    provider_folder_id: path.clone(),
                    display_name: path.clone(),
                    path: path.clone(),
                    delimiter: name.delimiter().unwrap_or("/").to_string(),
                    folder_kind: classify_folder_kind(&path).to_string(),
                }
            })
            .collect::<Vec<_>>();
        logout_quietly(session);

        if folders.is_empty() {
            folders.push(default_inbox_folder());
        }
        Ok(folders)
    }

    fn fetch_recent_headers(
        &self,
        profile: &ImapConnectionProfile,
        secret: &str,
        folder: &ImapFolder,
        limit: usize,
    ) -> Result<Vec<ImapMessageHeader>, AppError> {
        let mut session = connect_session(profile, secret)?;
        let mailbox = session
            .select(&folder.path)
            .map_err(|error| imap_error("imap_select_folder_failed", error))?;
        if mailbox.exists == 0 || limit == 0 {
            logout_quietly(session);
            return Ok(Vec::new());
        }

        let limit = limit.min(mailbox.exists as usize) as u32;
        let start = mailbox.exists.saturating_sub(limit).saturating_add(1);
        let sequence = format!("{start}:{}", mailbox.exists);
        let fetches = session
            .fetch(sequence, HEADER_FETCH_QUERY)
            .map_err(|error| imap_error("imap_fetch_headers_failed", error))?;
        let mut headers = fetches
            .iter()
            .filter_map(fetch_to_header)
            .collect::<Vec<_>>();
        headers.reverse();
        logout_quietly(session);
        Ok(headers)
    }

    fn fetch_incremental(
        &self,
        profile: &ImapConnectionProfile,
        secret: &str,
        folder: &ImapFolder,
        _cursor: Option<String>,
    ) -> Result<Vec<ImapMessageHeader>, AppError> {
        self.fetch_recent_headers(profile, secret, folder, 100)
    }

    fn fetch_message_body(
        &self,
        profile: &ImapConnectionProfile,
        secret: &str,
        folder: &ImapFolder,
        provider_message_id: &str,
    ) -> Result<Option<ImapMessageBody>, AppError> {
        let mut session = connect_session(profile, secret)?;
        session
            .select(&folder.path)
            .map_err(|error| imap_error("imap_select_folder_failed", error))?;
        let fetches = session
            .uid_fetch(provider_message_id, "BODY.PEEK[]")
            .map_err(|error| imap_error("imap_fetch_body_failed", error))?;
        let body = fetches
            .iter()
            .find_map(|fetch| fetch.body().or_else(|| fetch.text()))
            .and_then(decoded_message_body);
        logout_quietly(session);
        Ok(body)
    }

    fn set_message_flag(
        &self,
        profile: &ImapConnectionProfile,
        secret: &str,
        folder: &ImapFolder,
        provider_message_id: &str,
        flag: ImapMessageFlag,
        enabled: bool,
    ) -> Result<(), AppError> {
        let uid = validate_imap_uid(provider_message_id)?;
        let mut session = connect_session(profile, secret)?;
        session
            .select(&folder.path)
            .map_err(|error| imap_error("imap_select_folder_failed", error))?;
        let operation = if enabled {
            "+FLAGS.SILENT"
        } else {
            "-FLAGS.SILENT"
        };
        session
            .uid_store(&uid, format!("{operation} ({})", flag.as_imap_atom()))
            .map_err(|error| imap_error("imap_store_flags_failed", error))?;
        logout_quietly(session);
        Ok(())
    }

    fn move_message(
        &self,
        profile: &ImapConnectionProfile,
        secret: &str,
        source_folder: &ImapFolder,
        provider_message_id: &str,
        target_folder: &ImapFolder,
    ) -> Result<ImapMessageMoveResult, AppError> {
        if source_folder.path == target_folder.path {
            return Ok(ImapMessageMoveResult {
                provider_message_id: None,
            });
        }

        let uid = validate_imap_uid(provider_message_id)?;
        let mut session = connect_session(profile, secret)?;
        let capabilities = session
            .capabilities()
            .map_err(|error| imap_error("imap_capabilities_failed", error))?;
        let supports_move = capabilities.has_str("MOVE");
        let supports_uidplus = capabilities.has_str("UIDPLUS");
        session
            .select(&source_folder.path)
            .map_err(|error| imap_error("imap_select_folder_failed", error))?;

        let target_provider_message_id = if supports_move {
            let (response, _) = session
                .run(format!(
                    "UID MOVE {} {}",
                    uid,
                    quote_imap_mailbox(&target_folder.path)?
                ))
                .map_err(|error| imap_error("imap_move_message_failed", error))?;
            parse_copyuid_target_uid(&response, &uid)
        } else {
            let (response, _) = session
                .run(format!(
                    "UID COPY {} {}",
                    uid,
                    quote_imap_mailbox(&target_folder.path)?
                ))
                .map_err(|error| imap_error("imap_copy_message_failed", error))?;
            let target_uid = parse_copyuid_target_uid(&response, &uid);
            session
                .uid_store(&uid, "+FLAGS.SILENT (\\Deleted)")
                .map_err(|error| imap_error("imap_mark_moved_source_deleted_failed", error))?;
            if supports_uidplus {
                session
                    .uid_expunge(&uid)
                    .map_err(|error| imap_error("imap_uid_expunge_failed", error))?;
            }
            target_uid
        };

        logout_quietly(session);
        Ok(ImapMessageMoveResult {
            provider_message_id: target_provider_message_id,
        })
    }
}

fn connect_session(
    profile: &ImapConnectionProfile,
    secret: &str,
) -> Result<Session<imap::Connection>, AppError> {
    let mode = match profile.security.trim().to_ascii_lowercase().as_str() {
        "tls" | "ssl" => ConnectionMode::Tls,
        "starttls" => ConnectionMode::StartTls,
        "" if profile.port == 993 => ConnectionMode::Tls,
        "" if profile.port == 143 => ConnectionMode::StartTls,
        _ => return Err(imap_security_unsupported(profile)),
    };
    let client = imap::ClientBuilder::new(profile.host.trim(), profile.port)
        .mode(mode)
        .connect()
        .map_err(|error| imap_error("imap_connect_failed", error))?;

    client
        .login(profile.username.trim(), secret)
        .map_err(|(error, _)| imap_error("imap_login_failed", error))
}

fn imap_security_unsupported(profile: &ImapConnectionProfile) -> AppError {
    AppError {
        code: "imap_security_unsupported".to_string(),
        category: ErrorCategory::Validation,
        user_message: "IMAP security must use TLS or STARTTLS before credentials can be sent."
            .to_string(),
        technical_message: Some(format!(
            "unsupported security mode '{}' on port {}",
            profile.security, profile.port
        )),
        retryable: false,
        action_required: ActionRequired::EditSettings,
        correlation_id: uuid::Uuid::new_v4().to_string(),
        metadata: Box::new(serde_json::json!({ "adapter": "native_imap" })),
    }
}

fn fetch_to_header(fetch: &imap::types::Fetch<'_>) -> Option<ImapMessageHeader> {
    let raw_header = fetch.header()?;
    let (headers, _) = parse_headers(raw_header).ok()?;
    let subject = header_value(&headers, "Subject").unwrap_or_else(|| "(no subject)".to_string());
    let from_address =
        header_value(&headers, "From").unwrap_or_else(|| "(unknown sender)".to_string());
    let date_received = header_value(&headers, "Date")
        .or_else(|| fetch.internal_date().map(|date| date.to_rfc3339()))
        .unwrap_or_else(|| chrono::Utc::now().to_rfc3339());
    let authentication_results = header_value(&headers, "Authentication-Results");
    let received_spf = header_value(&headers, "Received-SPF");
    let dkim_signature = header_value(&headers, "DKIM-Signature");
    let list_id = header_value(&headers, "List-ID");
    let list_unsubscribe = header_value(&headers, "List-Unsubscribe");
    let list_unsubscribe_post = header_value(&headers, "List-Unsubscribe-Post");
    let precedence = header_value(&headers, "Precedence");
    let list_post = header_value(&headers, "List-Post");
    let list_help = header_value(&headers, "List-Help");
    let feedback_id = header_value(&headers, "Feedback-ID");
    let message_id =
        header_value(&headers, "Message-ID").and_then(|value| normalize_rfc_message_id(&value));
    let in_reply_to =
        header_value(&headers, "In-Reply-To").and_then(|value| normalize_rfc_message_id(&value));
    let references = header_value(&headers, "References")
        .map(|value| parse_rfc_message_id_list(&value))
        .unwrap_or_default();
    let provider_message_id = fetch
        .uid
        .map(|uid| uid.to_string())
        .unwrap_or_else(|| fetch.message.to_string());

    Some(ImapMessageHeader {
        provider_message_id,
        message_id,
        in_reply_to,
        references,
        subject: subject.clone(),
        from_address: from_address.clone(),
        date_received,
        snippet: format!("{from_address} / {subject}"),
        authentication_results,
        received_spf,
        dkim_signature,
        list_id,
        list_unsubscribe,
        list_unsubscribe_post,
        precedence,
        list_post,
        list_help,
        feedback_id,
    })
}

fn header_value(headers: &[MailHeader<'_>], name: &str) -> Option<String> {
    headers
        .iter()
        .find(|header| header.get_key_ref().eq_ignore_ascii_case(name))
        .and_then(decoded_header_value)
        .filter(|value| !value.trim().is_empty())
}

fn normalize_rfc_message_id(value: &str) -> Option<String> {
    let trimmed = value.trim().trim_matches('"').trim();
    if trimmed.is_empty() {
        return None;
    }
    let without_brackets = trimmed
        .strip_prefix('<')
        .and_then(|value| value.strip_suffix('>'))
        .unwrap_or(trimmed)
        .trim();
    if without_brackets.is_empty() {
        None
    } else {
        Some(without_brackets.to_ascii_lowercase())
    }
}

fn parse_rfc_message_id_list(value: &str) -> Vec<String> {
    let mut ids = Vec::new();
    let mut remainder = value;
    while let Some(start) = remainder.find('<') {
        let after_start = &remainder[start + 1..];
        let Some(end) = after_start.find('>') else {
            break;
        };
        if let Some(id) = normalize_rfc_message_id(&after_start[..end]) {
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
        remainder = &after_start[end + 1..];
    }

    if ids.is_empty() {
        for token in value.split_whitespace() {
            if let Some(id) = normalize_rfc_message_id(token) {
                if !ids.contains(&id) {
                    ids.push(id);
                }
            }
        }
    }

    ids
}

fn classify_folder_kind(path: &str) -> &'static str {
    let token = normalized_folder_token(path);
    if token == "inbox" || token.ends_with("inbox") || token.ends_with("收件箱") {
        "inbox"
    } else if matches_folder_alias(&token, &["archive", "archives", "归档", "已归档"]) {
        "archive"
    } else if matches_folder_alias(
        &token,
        &["spam", "junk", "junkemail", "垃圾邮件", "广告邮件"],
    ) {
        "spam"
    } else if matches_folder_alias(
        &token,
        &[
            "trash",
            "deleted",
            "deletedmessages",
            "deleteditems",
            "bin",
            "已删除",
            "已删除邮件",
            "废件箱",
            "垃圾箱",
        ],
    ) {
        "trash"
    } else {
        "mail"
    }
}

fn normalized_folder_token(value: &str) -> String {
    value
        .to_ascii_lowercase()
        .chars()
        .filter(|character| !character.is_whitespace() && !matches!(character, '_' | '-'))
        .collect()
}

fn matches_folder_alias(token: &str, aliases: &[&str]) -> bool {
    aliases.iter().any(|alias| {
        let alias = normalized_folder_token(alias);
        token == alias || token.ends_with(&alias)
    })
}

fn validate_imap_uid(provider_message_id: &str) -> Result<String, AppError> {
    let uid = provider_message_id.trim();
    if uid.is_empty() || !uid.chars().all(|character| character.is_ascii_digit()) {
        return Err(AppError {
            code: "imap_uid_invalid".to_string(),
            category: ErrorCategory::Protocol,
            user_message: "The selected IMAP message has an invalid remote UID.".to_string(),
            technical_message: None,
            retryable: false,
            action_required: ActionRequired::Retry,
            correlation_id: uuid::Uuid::new_v4().to_string(),
            metadata: Box::new(serde_json::json!({})),
        });
    }
    Ok(uid.to_string())
}

fn quote_imap_mailbox(mailbox: &str) -> Result<String, AppError> {
    if mailbox.contains('\n') || mailbox.contains('\r') {
        return Err(AppError {
            code: "imap_mailbox_name_invalid".to_string(),
            category: ErrorCategory::Protocol,
            user_message: "The IMAP folder name is not valid for a remote command.".to_string(),
            technical_message: None,
            retryable: false,
            action_required: ActionRequired::Retry,
            correlation_id: uuid::Uuid::new_v4().to_string(),
            metadata: Box::new(serde_json::json!({})),
        });
    }

    let escaped = mailbox.replace('\\', "\\\\").replace('"', "\\\"");
    Ok(format!("\"{escaped}\""))
}

fn parse_copyuid_target_uid(response: &[u8], source_uid: &str) -> Option<String> {
    let response = String::from_utf8_lossy(response);
    response
        .split('[')
        .filter_map(|segment| segment.split(']').next())
        .find_map(|response_code| {
            let mut parts = response_code.split_whitespace();
            let code = parts.next()?;
            if !code.eq_ignore_ascii_case("COPYUID") {
                return None;
            }

            let _uid_validity = parts.next()?;
            let source_set = parts.next()?;
            let target_set = parts.next()?;
            map_copyuid_target(source_set, target_set, source_uid)
        })
}

fn map_copyuid_target(source_set: &str, target_set: &str, source_uid: &str) -> Option<String> {
    let source_uid = source_uid.parse::<u64>().ok()?;
    let source_values = parse_uid_set(source_set)?;
    let target_values = parse_uid_set(target_set)?;
    let index = source_values.iter().position(|uid| *uid == source_uid)?;
    target_values.get(index).map(u64::to_string)
}

fn parse_uid_set(value: &str) -> Option<Vec<u64>> {
    const MAX_EXPANDED_UIDS: usize = 4096;
    let mut values = Vec::new();
    for part in value.split(',') {
        let part = part.trim();
        if part.is_empty() || part == "*" {
            return None;
        }

        if let Some((start, end)) = part.split_once(':') {
            let start = start.parse::<u64>().ok()?;
            let end = end.parse::<u64>().ok()?;
            let range_len = end.checked_sub(start)?.checked_add(1)?;
            let range_len = usize::try_from(range_len).ok()?;
            if range_len > MAX_EXPANDED_UIDS.saturating_sub(values.len()) {
                return None;
            }
            values.extend(start..=end);
        } else {
            if values.len() >= MAX_EXPANDED_UIDS {
                return None;
            }
            values.push(part.parse::<u64>().ok()?);
        }
    }
    Some(values)
}

fn decoded_message_body(raw_message: &[u8]) -> Option<ImapMessageBody> {
    let parsed = parse_mail(raw_message).ok()?;
    let html = decoded_text_part(&parsed, "text/html");
    let text = decoded_text_part(&parsed, "text/plain")
        .or_else(|| html.as_deref().map(html_to_readable_text))
        .or_else(|| {
            parsed.get_body().ok().map(|body| {
                if looks_like_html(&body) {
                    html_to_readable_text(&body)
                } else {
                    body
                }
            })
        })?;
    let text = normalize_body_cache_text(&text);
    if text.is_empty() {
        return None;
    }

    Some(ImapMessageBody {
        text,
        html: html.as_deref().and_then(sanitize_email_html),
    })
}

fn decoded_text_part(part: &ParsedMail<'_>, mime_type: &str) -> Option<String> {
    if part.ctype.mimetype.eq_ignore_ascii_case(mime_type) {
        return part.get_body().ok();
    }

    part.subparts
        .iter()
        .find_map(|child| decoded_text_part(child, mime_type))
}

fn html_to_readable_text(html: &str) -> String {
    let without_scripts = strip_html_block(html, "script");
    let without_styles = strip_html_block(&without_scripts, "style");
    let mut text = String::with_capacity(without_styles.len());
    let mut rest = without_styles.as_str();
    let mut open_anchor: Option<OpenHtmlAnchor> = None;

    while let Some(open) = rest.find('<') {
        text.push_str(&rest[..open]);
        let after_open = &rest[open + 1..];
        let Some(close) = after_open.find('>') else {
            text.push_str(&rest[open..]);
            rest = "";
            break;
        };

        let tag = &after_open[..close];
        let tag_name = html_tag_name(tag);
        let is_close_tag = tag.trim_start().starts_with('/');
        if tag_name == "a" {
            if is_close_tag {
                append_anchor_href(&mut text, open_anchor.take());
            } else if let Some(href) = html_tag_href(tag) {
                open_anchor = Some(OpenHtmlAnchor {
                    href,
                    text_start: text.len(),
                });
            }
        }
        if let Some(separator) = html_tag_separator(tag) {
            text.push(separator);
        }
        rest = &after_open[close + 1..];
    }

    text.push_str(rest);
    append_anchor_href(&mut text, open_anchor);
    normalize_readable_text(&decode_html_entities(&text))
}

fn strip_html_block(input: &str, tag: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut cursor = 0;
    let open_prefix = format!("<{tag}");
    let close_tag = format!("</{tag}>");
    let lower = input.to_ascii_lowercase();

    while let Some(relative_open) = lower[cursor..].find(&open_prefix) {
        let open = cursor + relative_open;
        output.push_str(&input[cursor..open]);
        let Some(relative_close) = lower[open..].find(&close_tag) else {
            cursor = input.len();
            break;
        };
        cursor = open + relative_close + close_tag.len();
    }

    output.push_str(&input[cursor..]);
    output
}

fn html_tag_separator(tag: &str) -> Option<char> {
    let normalized = tag.trim().trim_start_matches('/').trim_start();
    if normalized.starts_with('!') || normalized.starts_with('?') {
        return None;
    }
    let name = html_tag_name(tag);

    match name.as_str() {
        "br" | "p" | "div" | "section" | "article" | "header" | "footer" | "main" | "li" | "ul"
        | "ol" | "table" | "thead" | "tbody" | "tfoot" | "tr" | "h1" | "h2" | "h3" | "h4"
        | "h5" | "h6" | "blockquote" | "pre" | "hr" => Some('\n'),
        "td" | "th" => Some(' '),
        _ => None,
    }
}

fn html_tag_name(tag: &str) -> String {
    tag.trim()
        .trim_start_matches('/')
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .trim_end_matches('/')
        .to_ascii_lowercase()
}

fn html_tag_href(tag: &str) -> Option<String> {
    let mut rest = tag.trim();
    if rest.starts_with('/') {
        return None;
    }

    rest = rest
        .split_once(char::is_whitespace)
        .map(|(_, attributes)| attributes)
        .unwrap_or_default();

    loop {
        let lower = rest.to_ascii_lowercase();
        let relative_href = lower.find("href")?;
        let href_start = relative_href + "href".len();
        let before = rest[..relative_href].chars().next_back();
        if before.is_some_and(|character| character.is_alphanumeric() || character == '-') {
            rest = &rest[href_start..];
            continue;
        }

        let after_href = rest[href_start..].trim_start();
        let Some(after_equals) = after_href.strip_prefix('=') else {
            rest = after_href;
            continue;
        };
        let value = after_equals.trim_start();
        let (raw_href, _) = read_html_attr_value(value)?;
        let href = decode_html_entities(raw_href.trim()).trim().to_string();
        return (!href.is_empty()).then_some(href);
    }
}

fn read_html_attr_value(value: &str) -> Option<(&str, &str)> {
    let mut chars = value.chars();
    let first = chars.next()?;
    if first == '"' || first == '\'' {
        let close = value[1..].find(first)?;
        let end = close + 1;
        return Some((&value[1..end], &value[end + 1..]));
    }

    let end = value
        .find(|character: char| character.is_whitespace() || character == '>')
        .unwrap_or(value.len());
    Some((&value[..end], &value[end..]))
}

fn append_anchor_href(text: &mut String, anchor: Option<OpenHtmlAnchor>) {
    let Some(anchor) = anchor else {
        return;
    };
    let visible_text = decode_html_entities(&text[anchor.text_start..]);
    let normalized_visible = visible_text.trim();
    if normalized_visible.is_empty() {
        text.push_str(&anchor.href);
    }
}

fn normalize_body_cache_text(text: &str) -> String {
    text.trim_matches('\u{feff}').trim().to_string()
}

fn sanitize_email_html(html: &str) -> Option<String> {
    let cleaned = strip_dangerous_html_blocks(html);
    let cleaned = strip_html_event_attributes(&cleaned);
    let cleaned = strip_unsafe_url_attributes(&cleaned);
    let body = cleaned.trim();
    if body.is_empty() {
        return None;
    }

    let document = if body.to_ascii_lowercase().contains("<html") {
        inject_email_render_head(body)
    } else {
        format!(
            "<!doctype html><html><head><meta charset=\"utf-8\">{}</head><body>{}</body></html>",
            email_render_style(),
            body
        )
    };
    Some(document)
}

fn strip_dangerous_html_blocks(html: &str) -> String {
    ["script", "iframe", "object", "embed", "form", "input"]
        .iter()
        .fold(html.to_string(), |current, tag| {
            strip_html_block(&current, tag)
        })
}

fn strip_html_event_attributes(html: &str) -> String {
    let mut output = String::with_capacity(html.len());
    let mut rest = html;

    while let Some(open) = rest.find('<') {
        output.push_str(&rest[..open]);
        let after_open = &rest[open + 1..];
        let Some(close) = after_open.find('>') else {
            output.push_str(&rest[open..]);
            rest = "";
            break;
        };
        output.push('<');
        output.push_str(&sanitize_tag_attributes(&after_open[..close]));
        output.push('>');
        rest = &after_open[close + 1..];
    }

    output.push_str(rest);
    output
}

fn sanitize_tag_attributes(tag: &str) -> String {
    let mut output = String::with_capacity(tag.len());
    let mut rest = tag;

    loop {
        let Some(relative_on) = rest.to_ascii_lowercase().find(" on") else {
            output.push_str(rest);
            break;
        };
        output.push_str(&rest[..relative_on]);
        let mut after_name = relative_on + 1;
        while after_name < rest.len() {
            let character = rest[after_name..].chars().next().unwrap_or_default();
            if character.is_whitespace() || character == '=' {
                break;
            }
            after_name += character.len_utf8();
        }
        let skipped = skip_attribute_value(&rest[after_name..]);
        rest = &rest[after_name + skipped..];
    }

    output
}

fn skip_attribute_value(value: &str) -> usize {
    let trimmed_len = value.len() - value.trim_start().len();
    let value = value.trim_start();
    let Some(value) = value.strip_prefix('=') else {
        return trimmed_len;
    };
    let after_equals_trim = value.len() - value.trim_start().len();
    let value = value.trim_start();
    let Some(first) = value.chars().next() else {
        return trimmed_len + 1 + after_equals_trim;
    };

    if first == '"' || first == '\'' {
        if let Some(close) = value[1..].find(first) {
            return trimmed_len + 1 + after_equals_trim + close + 2;
        }
        return trimmed_len + 1 + after_equals_trim + value.len();
    }

    let end = value.find(char::is_whitespace).unwrap_or(value.len());
    trimmed_len + 1 + after_equals_trim + end
}

fn strip_unsafe_url_attributes(html: &str) -> String {
    let mut output = String::with_capacity(html.len());
    let mut rest = html;

    while let Some(open) = rest.find('<') {
        output.push_str(&rest[..open]);
        let after_open = &rest[open + 1..];
        let Some(close) = after_open.find('>') else {
            output.push_str(&rest[open..]);
            rest = "";
            break;
        };
        let tag = after_open[..close].to_string();
        output.push('<');
        output.push_str(&sanitize_url_attributes_in_tag(&tag));
        output.push('>');
        rest = &after_open[close + 1..];
    }

    output.push_str(rest);
    output
}

fn sanitize_url_attributes_in_tag(tag: &str) -> String {
    ["href", "src"]
        .iter()
        .fold(tag.to_string(), |current, attribute| {
            sanitize_single_url_attribute(&current, attribute)
        })
}

fn sanitize_single_url_attribute(tag: &str, attribute: &str) -> String {
    let mut output = String::with_capacity(tag.len());
    let mut rest = tag;

    loop {
        let lower = rest.to_ascii_lowercase();
        let Some(relative) = lower.find(attribute) else {
            output.push_str(rest);
            break;
        };
        let before = rest[..relative].chars().next_back();
        let after_index = relative + attribute.len();
        let after = rest[after_index..].chars().next();
        if before.is_some_and(|character| character.is_alphanumeric() || character == '-')
            || after.is_some_and(|character| character.is_alphanumeric() || character == '-')
        {
            output.push_str(&rest[..after_index]);
            rest = &rest[after_index..];
            continue;
        }

        output.push_str(&rest[..relative]);
        let attr_and_after = &rest[relative..];
        let Some((raw_attr, remainder, raw_value)) =
            split_attribute_assignment(attr_and_after, attribute)
        else {
            output.push_str(attribute);
            rest = &attr_and_after[attribute.len()..];
            continue;
        };
        if is_safe_email_url(raw_value) {
            output.push_str(raw_attr);
        }
        rest = remainder;
    }

    output
}

fn split_attribute_assignment<'a>(
    input: &'a str,
    attribute: &str,
) -> Option<(&'a str, &'a str, &'a str)> {
    let after_name = &input[attribute.len()..];
    let whitespace_after_name = after_name.len() - after_name.trim_start().len();
    let after_name = after_name.trim_start();
    let after_equals = after_name.strip_prefix('=')?;
    let whitespace_after_equals = after_equals.len() - after_equals.trim_start().len();
    let value_start_offset = attribute.len() + whitespace_after_name + 1 + whitespace_after_equals;
    let value = after_equals.trim_start();
    let (raw_value, _remainder) = read_html_attr_value(value)?;
    let consumed = value_start_offset
        + if value.starts_with('"') || value.starts_with('\'') {
            raw_value.len() + 2
        } else {
            raw_value.len()
        };
    Some((&input[..consumed], &input[consumed..], raw_value))
}

fn is_safe_email_url(url: &str) -> bool {
    let lower = decode_html_entities(url.trim()).to_ascii_lowercase();
    lower.starts_with("https://")
        || lower.starts_with("http://")
        || lower.starts_with("mailto:")
        || lower.starts_with("cid:")
        || lower.starts_with('#')
        || lower.starts_with('/')
        || lower.starts_with("./")
        || lower.starts_with("../")
}

fn inject_email_render_head(html: &str) -> String {
    let lower = html.to_ascii_lowercase();
    if let Some(head_end) = lower.find("</head>") {
        let mut document = String::with_capacity(html.len() + 256);
        document.push_str(&html[..head_end]);
        document.push_str(email_render_style());
        document.push_str(&html[head_end..]);
        document
    } else {
        format!("{style}{html}", style = email_render_style())
    }
}

fn email_render_style() -> &'static str {
    r#"<base target="_blank"><style>
html,body{margin:0!important;padding:0!important;background:transparent!important;}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",Arial,sans-serif!important;color:#111827;}
img{max-width:100%;height:auto;}
a{color:#0969da;}
table{max-width:100%;}
</style>"#
}

fn decode_html_entities(text: &str) -> String {
    let mut decoded = String::with_capacity(text.len());
    let mut rest = text;

    while let Some(amp) = rest.find('&') {
        decoded.push_str(&rest[..amp]);
        let after_amp = &rest[amp + 1..];
        let Some(semicolon) = after_amp.find(';') else {
            decoded.push('&');
            rest = after_amp;
            continue;
        };

        let entity = &after_amp[..semicolon];
        if entity.len() <= 32 {
            if let Some(character) = decode_html_entity(entity) {
                decoded.push(character);
                rest = &after_amp[semicolon + 1..];
                continue;
            }
        }

        decoded.push('&');
        decoded.push_str(entity);
        decoded.push(';');
        rest = &after_amp[semicolon + 1..];
    }

    decoded.push_str(rest);
    decoded
}

fn decode_html_entity(entity: &str) -> Option<char> {
    match entity {
        "nbsp" => Some(' '),
        "amp" => Some('&'),
        "lt" => Some('<'),
        "gt" => Some('>'),
        "quot" => Some('"'),
        "apos" | "#39" => Some('\''),
        _ => {
            let numeric = entity.strip_prefix('#')?;
            let value = numeric
                .strip_prefix('x')
                .or_else(|| numeric.strip_prefix('X'))
                .and_then(|hex| u32::from_str_radix(hex, 16).ok())
                .or_else(|| numeric.parse::<u32>().ok())?;
            char::from_u32(value)
        }
    }
}

fn normalize_readable_text(text: &str) -> String {
    text.replace("\r\n", "\n")
        .replace('\r', "\n")
        .lines()
        .map(collapse_inline_whitespace)
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn collapse_inline_whitespace(line: &str) -> String {
    let mut output = String::with_capacity(line.len());
    let mut previous_was_space = false;

    for character in line.chars() {
        if character.is_whitespace() {
            if !previous_was_space {
                output.push(' ');
                previous_was_space = true;
            }
        } else {
            output.push(character);
            previous_was_space = false;
        }
    }

    output
}

fn looks_like_html(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.contains("<html")
        || lower.contains("<body")
        || lower.contains("<p")
        || lower.contains("</p>")
        || lower.contains("<div")
        || lower.contains("</div>")
        || lower.contains("<br")
        || lower.contains("<table")
}

fn decoded_header_value(header: &MailHeader<'_>) -> Option<String> {
    let raw = header.get_value_raw();
    if let Some(decoded) = decode_rfc2047_header(raw) {
        return Some(decoded);
    }

    if std::str::from_utf8(raw).is_ok() {
        return header
            .get_value_utf8()
            .ok()
            .or_else(|| Some(header.get_value()));
    }

    decode_legacy_chinese_header(raw).or_else(|| Some(header.get_value()))
}

fn decode_rfc2047_header(raw: &[u8]) -> Option<String> {
    let input = std::str::from_utf8(raw).ok()?;
    let mut output = String::with_capacity(input.len());
    let mut cursor = 0;
    let mut changed = false;
    let mut previous_was_encoded_word = false;

    while cursor < input.len() {
        let Some(relative_start) = input[cursor..].find("=?") else {
            output.push_str(&input[cursor..]);
            break;
        };
        let start = cursor + relative_start;
        let literal = &input[cursor..start];
        if !(previous_was_encoded_word && literal.chars().all(char::is_whitespace)) {
            output.push_str(literal);
        }

        let Some((decoded, end)) = decode_rfc2047_word_at(input, start) else {
            output.push_str("=?");
            cursor = start + 2;
            previous_was_encoded_word = false;
            continue;
        };

        output.push_str(&decoded);
        cursor = end;
        changed = true;
        previous_was_encoded_word = true;
    }

    changed.then(|| normalize_unstructured_header(&output))
}

fn decode_rfc2047_word_at(input: &str, start: usize) -> Option<(String, usize)> {
    let after_prefix = start.checked_add(2)?;
    let charset_end = after_prefix + input[after_prefix..].find('?')?;
    let charset = &input[after_prefix..charset_end];
    let encoding_start = charset_end + 1;
    let encoding = input[encoding_start..].chars().next()?;
    let encoded_text_start = encoding_start + encoding.len_utf8() + 1;
    if input.as_bytes().get(encoding_start + encoding.len_utf8()) != Some(&b'?') {
        return None;
    }
    let encoded_text_end = encoded_text_start + input[encoded_text_start..].find("?=")?;
    let encoded_text = &input[encoded_text_start..encoded_text_end];
    let bytes = match encoding.to_ascii_uppercase() {
        'B' => decode_base64_ascii(encoded_text)?,
        'Q' => decode_rfc2047_q_ascii(encoded_text)?,
        _ => return None,
    };
    let decoded = decode_header_bytes(charset, &bytes)?;
    Some((decoded, encoded_text_end + 2))
}

fn decode_header_bytes(charset: &str, bytes: &[u8]) -> Option<String> {
    let decoded = if let Some(encoding) = encoding_rs::Encoding::for_label(charset.as_bytes()) {
        let (decoded, _, _) = encoding.decode(bytes);
        decoded.into_owned()
    } else {
        String::from_utf8(bytes.to_vec()).ok()?
    };
    (!decoded.trim().is_empty()).then_some(decoded)
}

fn decode_base64_ascii(value: &str) -> Option<Vec<u8>> {
    let mut output = Vec::with_capacity(value.len() * 3 / 4);
    let mut buffer = 0_u32;
    let mut bits = 0_u8;

    for byte in value.bytes().filter(|byte| !byte.is_ascii_whitespace()) {
        if byte == b'=' {
            break;
        }
        let six_bits = base64_value(byte)? as u32;
        buffer = (buffer << 6) | six_bits;
        bits += 6;
        while bits >= 8 {
            bits -= 8;
            output.push(((buffer >> bits) & 0xff) as u8);
            buffer &= (1_u32 << bits) - 1;
        }
    }

    Some(output)
}

fn base64_value(byte: u8) -> Option<u8> {
    match byte {
        b'A'..=b'Z' => Some(byte - b'A'),
        b'a'..=b'z' => Some(byte - b'a' + 26),
        b'0'..=b'9' => Some(byte - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

fn decode_rfc2047_q_ascii(value: &str) -> Option<Vec<u8>> {
    let mut output = Vec::with_capacity(value.len());
    let mut bytes = value.bytes().peekable();

    while let Some(byte) = bytes.next() {
        match byte {
            b'_' => output.push(b' '),
            b'=' => {
                let high = bytes.next()?;
                let low = bytes.next()?;
                output.push(hex_pair(high, low)?);
            }
            _ => output.push(byte),
        }
    }

    Some(output)
}

fn hex_pair(high: u8, low: u8) -> Option<u8> {
    Some((hex_value(high)? << 4) | hex_value(low)?)
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn decode_legacy_chinese_header(raw: &[u8]) -> Option<String> {
    for label in ["gb18030", "gbk", "gb2312", "big5"] {
        let Some(encoding) = encoding_rs::Encoding::for_label(label.as_bytes()) else {
            continue;
        };
        let (decoded, _, _) = encoding.decode(raw);
        let normalized = normalize_unstructured_header(&decoded);
        if !normalized.trim().is_empty() {
            return Some(normalized);
        }
    }
    None
}

fn normalize_unstructured_header(value: &str) -> String {
    value
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn default_inbox_folder() -> ImapFolder {
    ImapFolder {
        provider_folder_id: "INBOX".to_string(),
        display_name: "INBOX".to_string(),
        path: "INBOX".to_string(),
        delimiter: "/".to_string(),
        folder_kind: "inbox".to_string(),
    }
}

fn logout_quietly(mut session: Session<imap::Connection>) {
    let _ = session.logout();
}

fn imap_error(code: &str, error: imap::Error) -> AppError {
    let technical_message = error.to_string();
    let lower = technical_message.to_ascii_lowercase();
    let auth_error = lower.contains("auth")
        || lower.contains("login")
        || lower.contains("credential")
        || lower.contains("password")
        || lower.contains("authenticationfailed");

    AppError {
        code: if auth_error {
            "imap_auth_failed".to_string()
        } else {
            code.to_string()
        },
        category: if auth_error {
            ErrorCategory::Auth
        } else {
            ErrorCategory::Provider
        },
        user_message: if auth_error {
            "The IMAP server rejected the supplied credentials.".to_string()
        } else {
            "The IMAP server could not complete the requested operation.".to_string()
        },
        technical_message: Some(technical_message),
        retryable: !auth_error,
        action_required: if auth_error {
            ActionRequired::EditSettings
        } else {
            ActionRequired::Retry
        },
        correlation_id: uuid::Uuid::new_v4().to_string(),
        metadata: Box::new(serde_json::json!({ "adapter": "native_imap" })),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let raw =
            b"Subject: \xc4\xe3\xba\xc3\r\nFrom: \xd5\xc5\xc8\xfd <sender@example.test>\r\n\r\n";
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
            header_value(&headers, "In-Reply-To")
                .and_then(|value| normalize_rfc_message_id(&value)),
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
        let response =
            b"* OK [COPYUID 1511554416 142 2048] Moved UID.\r\nA0001 OK MOVE completed\r\n";

        assert_eq!(
            parse_copyuid_target_uid(response, "142"),
            Some("2048".to_string())
        );
    }

    #[test]
    fn native_imap_parses_copyuid_target_uid_from_ranges() {
        let response =
            b"* OK [COPYUID 1511554416 140:142 2046:2048] Moved UIDs.\r\nA0001 OK done\r\n";

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
}
