use mailparse::{parse_mail, ParsedMail};

use crate::imap::models::ImapMessageBody;

use super::html::{
    html_to_readable_text, looks_like_html, normalize_body_cache_text, sanitize_email_html,
};

pub(super) fn decoded_message_body(raw_message: &[u8]) -> Option<ImapMessageBody> {
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
