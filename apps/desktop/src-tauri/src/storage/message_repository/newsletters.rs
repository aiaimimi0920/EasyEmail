use super::*;

pub(super) fn imap_header_is_newsletter(header: &ImapMessageHeader) -> bool {
    header
        .list_unsubscribe
        .as_deref()
        .map(str::trim)
        .is_some_and(|value| !value.is_empty())
        || header
            .list_id
            .as_deref()
            .map(str::trim)
            .is_some_and(|value| !value.is_empty())
        || header
            .list_unsubscribe_post
            .as_deref()
            .map(str::trim)
            .is_some_and(|value| !value.is_empty())
        || header
            .precedence
            .as_deref()
            .map(|value| {
                let normalized = value.trim().to_ascii_lowercase();
                normalized == "bulk" || normalized == "list"
            })
            .unwrap_or(false)
        || header
            .list_post
            .as_deref()
            .map(str::trim)
            .is_some_and(|value| !value.is_empty())
        || header
            .list_help
            .as_deref()
            .map(str::trim)
            .is_some_and(|value| !value.is_empty())
        || header
            .feedback_id
            .as_deref()
            .map(str::trim)
            .is_some_and(|value| !value.is_empty())
}

pub(super) fn imap_newsletter_metadata(header: &ImapMessageHeader) -> Option<serde_json::Value> {
    if !imap_header_is_newsletter(header) {
        return None;
    }
    let list_id = header
        .list_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("");
    let sender_address = header.from_address.trim();
    let mut unsubscribe_methods = Vec::new();
    for value in [
        header.list_unsubscribe.as_deref(),
        header.list_unsubscribe_post.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        let method = value.trim();
        if !method.is_empty() && !unsubscribe_methods.contains(&method.to_string()) {
            unsubscribe_methods.push(method.to_string());
        }
    }
    Some(json!({
        "list_id": list_id,
        "sender_address": sender_address,
        "name": newsletter_display_name(list_id, sender_address),
        "unsubscribe_methods": unsubscribe_methods,
    }))
}

fn newsletter_display_name(list_id: &str, sender_address: &str) -> String {
    let list_name = list_id
        .split('<')
        .next()
        .unwrap_or(list_id)
        .trim()
        .trim_matches('"');
    if !list_name.is_empty() {
        return list_name.to_string();
    }
    let sender_name = sender_address
        .split('<')
        .next()
        .unwrap_or(sender_address)
        .trim()
        .trim_matches('"');
    if !sender_name.is_empty() {
        return sender_name.to_string();
    }
    sender_address.to_string()
}

pub(super) fn newsletter_subscription_id_from_flags(
    flags: &serde_json::Map<String, serde_json::Value>,
    fallback_sender_address: Option<&str>,
) -> Option<String> {
    let labels = flags
        .get("labels")
        .and_then(serde_json::Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(serde_json::Value::as_str)
                .any(|label| label.trim().eq_ignore_ascii_case("newsletters"))
        })
        .unwrap_or(false);
    if !labels {
        return None;
    }

    let newsletter = flags
        .get("newsletter")
        .and_then(serde_json::Value::as_object);
    let list_id = newsletter
        .and_then(|value| value.get("list_id"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("");
    let sender_address = newsletter
        .and_then(|value| value.get("sender_address"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| fallback_sender_address.map(str::trim))
        .filter(|value| !value.is_empty())
        .unwrap_or("");

    if !list_id.is_empty() {
        Some(format!("list:{}", list_id.to_ascii_lowercase()))
    } else if !sender_address.is_empty() {
        Some(format!("sender:{}", sender_address.to_ascii_lowercase()))
    } else {
        None
    }
}

pub(super) fn merge_imap_observed_flags(
    connection: &Connection,
    source_id: &str,
    folder_id: &str,
    imap_uid: &str,
    header: &ImapMessageHeader,
    now: &str,
) -> Result<()> {
    let mut flags = connection.query_row(
        "SELECT flags_json
         FROM message_sources
         WHERE source_id = ?1
           AND folder_id = ?2
           AND imap_uid = ?3",
        params![source_id, folder_id, imap_uid],
        |row| row.get::<_, String>(0),
    )?;
    let mut parsed = serde_json::from_str::<serde_json::Value>(&flags)
        .ok()
        .and_then(|value| match value {
            serde_json::Value::Object(map) => Some(map),
            _ => None,
        })
        .unwrap_or_default();
    let mut changed = false;

    if imap_header_is_newsletter(header) {
        let labels = parsed
            .entry("labels".to_string())
            .or_insert_with(|| serde_json::Value::Array(Vec::new()));
        if let serde_json::Value::Array(items) = labels {
            let has_newsletters = items
                .iter()
                .filter_map(serde_json::Value::as_str)
                .any(|label| label.trim().eq_ignore_ascii_case("newsletters"));
            if !has_newsletters {
                items.push(serde_json::Value::String("newsletters".to_string()));
                changed = true;
            }
        }
        if let Some(metadata) = imap_newsletter_metadata(header) {
            parsed.insert("newsletter".to_string(), metadata);
            changed = true;
        }
    }

    if changed {
        flags = serde_json::Value::Object(parsed).to_string();
        connection.execute(
            "UPDATE message_sources
             SET flags_json = ?1,
                 last_seen_at = ?2
             WHERE source_id = ?3
               AND folder_id = ?4
               AND imap_uid = ?5",
            params![flags, now, source_id, folder_id, imap_uid],
        )?;
    }

    Ok(())
}

pub fn list_newsletter_subscriptions(
    connection: &Connection,
    account_id: &str,
) -> Result<Vec<NewsletterSubscriptionRow>> {
    let mut statement = connection.prepare(
        "SELECT
            messages.from_address AS from_address,
            COALESCE(messages.date_received, message_sources.last_seen_at, message_sources.first_seen_at, messages.created_at) AS observed_at,
            message_sources.flags_json AS flags_json
         FROM messages
         INNER JOIN message_sources ON message_sources.message_id = messages.id
         INNER JOIN mailbox_sources ON mailbox_sources.id = message_sources.source_id
         WHERE message_sources.account_id = ?1
           AND mailbox_sources.source_kind = 'imap'
           AND messages.deleted_at IS NULL
           AND EXISTS (
             SELECT 1
             FROM json_each(
               CASE
                 WHEN json_valid(message_sources.flags_json) THEN message_sources.flags_json
                 ELSE '{}'
               END,
               '$.labels'
             ) AS newsletter_labels
             WHERE lower(trim(CAST(newsletter_labels.value AS TEXT))) = 'newsletters'
           )",
    )?;
    let rows = statement
        .query_map(params![account_id], |row| {
            Ok((
                row.get::<_, String>("from_address")?,
                row.get::<_, String>("observed_at")?,
                row.get::<_, String>("flags_json")?,
            ))
        })?
        .collect::<Result<Vec<_>>>()?;
    let mut grouped: BTreeMap<String, NewsletterSubscriptionRow> = BTreeMap::new();

    for (from_address, observed_at, flags_json) in rows {
        let flags = serde_json::from_str::<serde_json::Value>(&flags_json)
            .ok()
            .and_then(|value| match value {
                serde_json::Value::Object(map) => Some(map),
                _ => None,
            })
            .unwrap_or_default();
        let local_state = message_local_state_from_flags(&flags_json);
        if !local_state
            .labels
            .iter()
            .any(|label| label.trim().eq_ignore_ascii_case("newsletters"))
        {
            continue;
        }
        let newsletter = flags
            .get("newsletter")
            .and_then(serde_json::Value::as_object);
        let list_id = newsletter
            .and_then(|value| value.get("list_id"))
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("");
        let sender_address = newsletter
            .and_then(|value| value.get("sender_address"))
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(from_address.trim());
        let group_key = newsletter_subscription_id_from_flags(&flags, Some(sender_address))
            .unwrap_or_else(|| format!("sender:{}", sender_address.to_ascii_lowercase()));
        let name = newsletter
            .and_then(|value| value.get("name"))
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string)
            .unwrap_or_else(|| newsletter_display_name(list_id, sender_address));
        let unsubscribe_methods = newsletter
            .and_then(|value| value.get("unsubscribe_methods"))
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
        let spam = local_state.local_folder == "spam";

        let entry = grouped
            .entry(group_key.clone())
            .or_insert_with(|| NewsletterSubscriptionRow {
                id: group_key,
                list_id: list_id.to_string(),
                sender_address: sender_address.to_string(),
                name,
                received_message_count: 0,
                unread_message_count: 0,
                last_received_at: observed_at.clone(),
                unsubscribe_methods: Vec::new(),
                spam: false,
                hidden: false,
            });
        entry.received_message_count += 1;
        if !local_state.is_read {
            entry.unread_message_count += 1;
        }
        if compare_message_time_desc(&observed_at, "", &entry.last_received_at, "").is_lt() {
            entry.last_received_at = observed_at;
        }
        entry.spam = entry.spam || spam;
        for method in unsubscribe_methods {
            if !entry.unsubscribe_methods.contains(&method) {
                entry.unsubscribe_methods.push(method);
            }
        }
    }

    let mut subscriptions = grouped.into_values().collect::<Vec<_>>();

    // Fetch every override for the account once rather than issuing one query
    // per subscription.
    let hidden_keys: HashSet<String> = {
        let mut statement = connection.prepare(
            "SELECT subscription_key
             FROM newsletter_subscription_overrides
             WHERE account_id = ?1
               AND hidden <> 0",
        )?;
        let rows = statement.query_map(params![account_id], |row| row.get::<_, String>(0))?;
        rows.collect::<Result<HashSet<String>>>()?
    };
    for subscription in &mut subscriptions {
        subscription.hidden = hidden_keys.contains(&subscription.id);
    }
    subscriptions.sort_by(|left, right| {
        compare_message_time_desc(
            &left.last_received_at,
            &left.id,
            &right.last_received_at,
            &right.id,
        )
    });
    Ok(subscriptions)
}

pub fn set_newsletter_subscription_hidden(
    connection: &Connection,
    account_id: &str,
    subscription_id: &str,
    hidden: bool,
    now: &str,
) -> Result<bool> {
    let trimmed_account_id = account_id.trim();
    let trimmed_subscription_id = subscription_id.trim();
    if trimmed_account_id.is_empty()
        || trimmed_subscription_id.is_empty()
        || trimmed_subscription_id.len() > 1_024
    {
        return Ok(false);
    }
    let subscription_exists = list_newsletter_subscriptions(connection, trimmed_account_id)?
        .iter()
        .any(|subscription| subscription.id == trimmed_subscription_id);
    if !subscription_exists {
        return Ok(false);
    }

    let changed = connection.execute(
        "INSERT INTO newsletter_subscription_overrides (
            account_id,
            subscription_key,
            hidden,
            updated_at
         ) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(account_id, subscription_key) DO UPDATE SET
            hidden = excluded.hidden,
            updated_at = excluded.updated_at",
        params![
            trimmed_account_id,
            trimmed_subscription_id,
            if hidden { 1_i64 } else { 0_i64 },
            now
        ],
    )?;

    Ok(changed > 0)
}
