use crate::error::{ActionRequired, AppError, ErrorCategory};

pub(super) fn validate_imap_uid(provider_message_id: &str) -> Result<String, AppError> {
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

pub(super) fn quote_imap_mailbox(mailbox: &str) -> Result<String, AppError> {
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

pub(super) fn parse_copyuid_target_uid(response: &[u8], source_uid: &str) -> Option<String> {
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

pub(super) fn parse_uid_set(value: &str) -> Option<Vec<u64>> {
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
