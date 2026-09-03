struct OpenHtmlAnchor {
    href: String,
    text_start: usize,
}

pub(super) fn html_to_readable_text(html: &str) -> String {
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

pub(super) fn normalize_body_cache_text(text: &str) -> String {
    text.trim_matches('\u{feff}').trim().to_string()
}

pub(super) fn sanitize_email_html(html: &str) -> Option<String> {
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

pub(super) fn looks_like_html(text: &str) -> bool {
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
