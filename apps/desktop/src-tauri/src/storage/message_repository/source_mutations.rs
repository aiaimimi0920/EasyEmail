use super::*;

pub fn soft_delete_message(connection: &Connection, message_id: &str, now: &str) -> Result<bool> {
    let changed = connection.execute(
        "UPDATE messages
         SET deleted_at = ?1,
             updated_at = ?1
         WHERE id = ?2
           AND deleted_at IS NULL",
        params![now, message_id],
    )?;
    Ok(changed > 0)
}

pub fn set_message_source_flag(
    connection: &Connection,
    message_id: &str,
    flag_name: &str,
    enabled: bool,
    now: &str,
) -> Result<bool> {
    update_message_source_flags(connection, message_id, now, |flags| {
        if enabled {
            flags.insert(flag_name.to_string(), serde_json::Value::Bool(true));
        } else {
            flags.remove(flag_name);
        }
    })
}

pub fn set_message_source_folder(
    connection: &Connection,
    message_id: &str,
    folder_name: &str,
    now: &str,
) -> Result<bool> {
    let folder_name = folder_name.trim().to_ascii_lowercase();
    update_message_source_flags(connection, message_id, now, |flags| {
        if folder_name.eq_ignore_ascii_case("inbox") {
            flags.remove("local_folder");
            flags.remove("archived");
        } else {
            flags.insert(
                "local_folder".to_string(),
                serde_json::Value::String(folder_name.to_string()),
            );
            if folder_name == "archive" {
                flags.insert("archived".to_string(), serde_json::Value::Bool(true));
            } else {
                flags.remove("archived");
            }
        }
    })
}

pub fn set_message_source_remote_folder(
    connection: &Connection,
    message_id: &str,
    source_id: &str,
    folder_id: &str,
    provider_message_id: Option<&str>,
    now: &str,
) -> Result<bool> {
    let changed = connection.execute(
        "UPDATE message_sources
         SET folder_id = ?3,
             provider_message_id = COALESCE(?4, provider_message_id),
             imap_uid = COALESCE(?4, imap_uid),
             last_seen_at = ?5
         WHERE message_id = ?1
           AND source_id = ?2
           AND EXISTS (
               SELECT 1
               FROM messages
               WHERE messages.id = message_sources.message_id
                 AND messages.deleted_at IS NULL
           )",
        params![message_id, source_id, folder_id, provider_message_id, now],
    )?;
    Ok(changed > 0)
}

pub fn set_message_source_label(
    connection: &Connection,
    message_id: &str,
    label_name: &str,
    enabled: bool,
    now: &str,
) -> Result<bool> {
    let label_name = label_name.trim();
    update_message_source_flags(connection, message_id, now, |flags| {
        let mut labels = flags
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

        if enabled {
            if !labels.iter().any(|item| item == label_name) && !label_name.is_empty() {
                labels.push(label_name.to_string());
            }
        } else {
            labels.retain(|item| item != label_name);
        }
        labels.sort();

        if labels.is_empty() {
            flags.remove("labels");
        } else {
            flags.insert(
                "labels".to_string(),
                serde_json::Value::Array(
                    labels
                        .into_iter()
                        .map(serde_json::Value::String)
                        .collect::<Vec<_>>(),
                ),
            );
        }
    })
}

pub fn replace_message_source_folder_name(
    connection: &Connection,
    old_folder_name: &str,
    new_folder_name: &str,
    now: &str,
) -> Result<usize> {
    let old_folder_name = old_folder_name.trim().to_ascii_lowercase();
    let new_folder_name = new_folder_name.trim().to_ascii_lowercase();
    update_all_message_source_flags(connection, now, |flags| {
        let matches = flags
            .get("local_folder")
            .and_then(serde_json::Value::as_str)
            .map(|value| value.trim().eq_ignore_ascii_case(&old_folder_name))
            .unwrap_or(false);
        if !matches {
            return false;
        }
        if new_folder_name == "inbox" || new_folder_name.is_empty() {
            flags.remove("local_folder");
            flags.remove("archived");
        } else {
            flags.insert(
                "local_folder".to_string(),
                serde_json::Value::String(new_folder_name.clone()),
            );
            if new_folder_name == "archive" {
                flags.insert("archived".to_string(), serde_json::Value::Bool(true));
            } else {
                flags.remove("archived");
            }
        }
        true
    })
}

pub fn clear_message_source_folder_name(
    connection: &Connection,
    folder_name: &str,
    now: &str,
) -> Result<usize> {
    let folder_name = folder_name.trim().to_ascii_lowercase();
    update_all_message_source_flags(connection, now, |flags| {
        let matches = flags
            .get("local_folder")
            .and_then(serde_json::Value::as_str)
            .map(|value| value.trim().eq_ignore_ascii_case(&folder_name))
            .unwrap_or(false);
        if !matches {
            return false;
        }
        flags.remove("local_folder");
        flags.remove("archived");
        true
    })
}

pub fn replace_message_source_label_name(
    connection: &Connection,
    old_label_name: &str,
    new_label_name: &str,
    now: &str,
) -> Result<usize> {
    let old_label_name = old_label_name.trim().to_ascii_lowercase();
    let new_label_name = new_label_name.trim();
    update_all_message_source_flags(connection, now, |flags| {
        let mut changed = false;
        let mut normalized_seen = std::collections::HashSet::new();
        let labels = flags
            .get("labels")
            .and_then(serde_json::Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(serde_json::Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .filter_map(|value| {
                        let next_value = if value.eq_ignore_ascii_case(&old_label_name) {
                            changed = true;
                            new_label_name
                        } else {
                            value
                        };
                        if next_value.is_empty() {
                            return None;
                        }
                        let normalized = next_value.to_ascii_lowercase();
                        if normalized_seen.insert(normalized) {
                            Some(next_value.to_string())
                        } else {
                            changed = true;
                            None
                        }
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        if !changed {
            return false;
        }
        if labels.is_empty() {
            flags.remove("labels");
        } else {
            flags.insert(
                "labels".to_string(),
                serde_json::Value::Array(
                    labels
                        .into_iter()
                        .map(serde_json::Value::String)
                        .collect::<Vec<_>>(),
                ),
            );
        }
        true
    })
}

pub fn clear_message_source_label_name(
    connection: &Connection,
    label_name: &str,
    now: &str,
) -> Result<usize> {
    let label_name = label_name.trim().to_ascii_lowercase();
    update_all_message_source_flags(connection, now, |flags| {
        let mut changed = false;
        let labels = flags
            .get("labels")
            .and_then(serde_json::Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(serde_json::Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .filter_map(|value| {
                        if value.eq_ignore_ascii_case(&label_name) {
                            changed = true;
                            None
                        } else {
                            Some(value.to_string())
                        }
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        if !changed {
            return false;
        }
        if labels.is_empty() {
            flags.remove("labels");
        } else {
            flags.insert(
                "labels".to_string(),
                serde_json::Value::Array(
                    labels
                        .into_iter()
                        .map(serde_json::Value::String)
                        .collect::<Vec<_>>(),
                ),
            );
        }
        true
    })
}

fn update_all_message_source_flags<F>(
    connection: &Connection,
    now: &str,
    mut update: F,
) -> Result<usize>
where
    F: FnMut(&mut serde_json::Map<String, serde_json::Value>) -> bool,
{
    let mut statement = connection.prepare(
        "SELECT message_sources.id AS source_row_id,
                message_sources.flags_json AS flags_json
         FROM message_sources
         INNER JOIN messages ON messages.id = message_sources.message_id
         WHERE messages.deleted_at IS NULL",
    )?;

    let source_rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>("source_row_id")?,
                row.get::<_, String>("flags_json")?,
            ))
        })?
        .collect::<Result<Vec<_>>>()?;

    let mut changed_count = 0;
    for (source_row_id, flags_json) in &source_rows {
        let mut flags = serde_json::from_str::<serde_json::Value>(flags_json)
            .ok()
            .and_then(|value| match value {
                serde_json::Value::Object(map) => Some(map),
                _ => None,
            })
            .unwrap_or_default();
        if !update(&mut flags) {
            continue;
        }
        let serialized = serde_json::Value::Object(flags).to_string();
        connection.execute(
            "UPDATE message_sources
             SET flags_json = ?1,
                 last_seen_at = ?2
             WHERE id = ?3",
            params![serialized, now, source_row_id],
        )?;
        changed_count += 1;
    }

    Ok(changed_count)
}

fn update_message_source_flags<F>(
    connection: &Connection,
    message_id: &str,
    now: &str,
    mut update: F,
) -> Result<bool>
where
    F: FnMut(&mut serde_json::Map<String, serde_json::Value>),
{
    let mut statement = connection.prepare(
        "SELECT message_sources.id AS source_row_id,
                message_sources.flags_json AS flags_json
         FROM message_sources
         INNER JOIN messages ON messages.id = message_sources.message_id
         WHERE message_sources.message_id = ?1
           AND messages.deleted_at IS NULL",
    )?;

    let source_rows = statement
        .query_map(params![message_id], |row| {
            Ok((
                row.get::<_, String>("source_row_id")?,
                row.get::<_, String>("flags_json")?,
            ))
        })?
        .collect::<Result<Vec<_>>>()?;

    for (source_row_id, flags_json) in &source_rows {
        let mut flags = serde_json::from_str::<serde_json::Value>(flags_json)
            .ok()
            .and_then(|value| match value {
                serde_json::Value::Object(map) => Some(map),
                _ => None,
            })
            .unwrap_or_default();
        update(&mut flags);
        let serialized = serde_json::Value::Object(flags).to_string();
        connection.execute(
            "UPDATE message_sources
             SET flags_json = ?1,
                 last_seen_at = ?2
             WHERE id = ?3",
            params![serialized, now, source_row_id],
        )?;
    }

    Ok(!source_rows.is_empty())
}
