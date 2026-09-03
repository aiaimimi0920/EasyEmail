use super::*;

fn message_sort_timestamp(value: &str) -> i64 {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return 0;
    }

    if let Ok(parsed) = DateTime::parse_from_rfc3339(trimmed) {
        return parsed.timestamp_millis();
    }

    let without_timezone_comment = trimmed
        .rfind(" (")
        .and_then(|index| trimmed.ends_with(')').then_some(&trimmed[..index]))
        .unwrap_or(trimmed)
        .trim();

    DateTime::parse_from_rfc2822(without_timezone_comment)
        .map(|parsed| parsed.timestamp_millis())
        .unwrap_or(0)
}

pub(super) fn compare_message_time_desc(
    left_observed_at: &str,
    left_message_id: &str,
    right_observed_at: &str,
    right_message_id: &str,
) -> std::cmp::Ordering {
    message_sort_timestamp(right_observed_at)
        .cmp(&message_sort_timestamp(left_observed_at))
        .then_with(|| right_observed_at.cmp(left_observed_at))
        .then_with(|| right_message_id.cmp(left_message_id))
}

pub(super) fn message_local_state_from_flags(flags_json: &str) -> MessageLocalState {
    let parsed = serde_json::from_str::<serde_json::Value>(flags_json)
        .ok()
        .and_then(|value| match value {
            serde_json::Value::Object(map) => Some(map),
            _ => None,
        })
        .unwrap_or_default();

    let labels = parsed
        .get("labels")
        .and_then(serde_json::Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    MessageLocalState {
        is_read: parsed
            .get("read")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
        is_starred: parsed
            .get("starred")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
        is_archived: parsed
            .get("archived")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
        is_important: parsed
            .get("important")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
        local_folder: parsed
            .get("local_folder")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("inbox")
            .to_string(),
        labels,
        newsletter_subscription_id: newsletter_subscription_id_from_flags(&parsed, None),
    }
}
