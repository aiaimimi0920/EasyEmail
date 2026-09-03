use mailparse::{parse_headers, MailHeader};

use crate::imap::models::ImapMessageHeader;

pub(super) const HEADER_FETCH_QUERY: &str = "(UID BODY.PEEK[HEADER] INTERNALDATE)";

pub(super) fn fetch_to_header(fetch: &imap::types::Fetch<'_>) -> Option<ImapMessageHeader> {
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

pub(super) fn header_value(headers: &[MailHeader<'_>], name: &str) -> Option<String> {
    headers
        .iter()
        .find(|header| header.get_key_ref().eq_ignore_ascii_case(name))
        .and_then(decoded_header_value)
        .filter(|value| !value.trim().is_empty())
}

pub(super) fn normalize_rfc_message_id(value: &str) -> Option<String> {
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

pub(super) fn parse_rfc_message_id_list(value: &str) -> Vec<String> {
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
