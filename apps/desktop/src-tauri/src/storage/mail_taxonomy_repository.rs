use rusqlite::{params, Connection, Result};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MailTaxonomyItemRow {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub color: String,
    pub sort_order: i64,
    pub system: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewMailTaxonomyItem {
    pub kind: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub color: String,
    pub now: String,
}

pub fn list_mail_taxonomy_items(
    connection: &Connection,
    kind: &str,
) -> Result<Vec<MailTaxonomyItemRow>> {
    let kind = normalize_kind(kind);
    let mut statement = connection.prepare(
        "SELECT id, kind, name, parent_id, color, sort_order, system, created_at, updated_at
         FROM mail_taxonomy_items
         WHERE kind = ?1
         ORDER BY sort_order ASC, name COLLATE NOCASE ASC",
    )?;

    let rows = statement
        .query_map(params![kind], |row| {
            Ok(MailTaxonomyItemRow {
                id: row.get("id")?,
                kind: row.get("kind")?,
                name: row.get("name")?,
                parent_id: row.get("parent_id")?,
                color: row.get("color")?,
                sort_order: row.get("sort_order")?,
                system: row.get::<_, i64>("system")? != 0,
                created_at: row.get("created_at")?,
                updated_at: row.get("updated_at")?,
            })
        })?
        .collect::<Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn upsert_mail_taxonomy_item(
    connection: &Connection,
    item: NewMailTaxonomyItem,
) -> Result<MailTaxonomyItemRow> {
    let kind = normalize_kind(&item.kind);
    let name = normalize_name(&item.name);
    let normalized_name = name.to_ascii_lowercase();
    let parent_id = normalize_parent_id(item.parent_id.as_deref());
    let color = normalize_color(&item.color);
    let id = format!("mailtax_{}_{}", kind, taxonomy_slug(&normalized_name));
    let sort_order = next_sort_order(connection, &kind)?;

    connection.execute(
        "INSERT INTO mail_taxonomy_items (
            id, kind, name, normalized_name, parent_id, color, sort_order, system, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, ?8)
         ON CONFLICT(kind, normalized_name) DO UPDATE SET
            name = excluded.name,
            parent_id = excluded.parent_id,
            color = excluded.color,
            updated_at = excluded.updated_at",
        params![id, kind, name, normalized_name, parent_id, color, sort_order, item.now],
    )?;

    connection.query_row(
        "SELECT id, kind, name, parent_id, color, sort_order, system, created_at, updated_at
         FROM mail_taxonomy_items
         WHERE kind = ?1
           AND normalized_name = ?2",
        params![kind, normalized_name],
        |row| {
            Ok(MailTaxonomyItemRow {
                id: row.get("id")?,
                kind: row.get("kind")?,
                name: row.get("name")?,
                parent_id: row.get("parent_id")?,
                color: row.get("color")?,
                sort_order: row.get("sort_order")?,
                system: row.get::<_, i64>("system")? != 0,
                created_at: row.get("created_at")?,
                updated_at: row.get("updated_at")?,
            })
        },
    )
}

pub fn get_mail_taxonomy_item(
    connection: &Connection,
    item_id: &str,
) -> Result<Option<MailTaxonomyItemRow>> {
    let mut statement = connection.prepare(
        "SELECT id, kind, name, parent_id, color, sort_order, system, created_at, updated_at
         FROM mail_taxonomy_items
         WHERE id = ?1",
    )?;
    let mut rows = statement.query_map(params![item_id.trim()], |row| {
        Ok(MailTaxonomyItemRow {
            id: row.get("id")?,
            kind: row.get("kind")?,
            name: row.get("name")?,
            parent_id: row.get("parent_id")?,
            color: row.get("color")?,
            sort_order: row.get("sort_order")?,
            system: row.get::<_, i64>("system")? != 0,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
        })
    })?;
    rows.next().transpose()
}

pub fn update_mail_taxonomy_item(
    connection: &Connection,
    item_id: &str,
    name: &str,
    parent_id: Option<&str>,
    color: &str,
    now: &str,
) -> Result<Option<MailTaxonomyItemRow>> {
    let name = normalize_name(name);
    let normalized_name = name.to_ascii_lowercase();
    let parent_id = normalize_parent_id(parent_id);
    let color = normalize_color(color);
    let changed = connection.execute(
        "UPDATE mail_taxonomy_items
         SET name = ?2,
             normalized_name = ?3,
             parent_id = ?4,
             color = ?5,
             updated_at = ?6
         WHERE id = ?1",
        params![item_id.trim(), name, normalized_name, parent_id, color, now],
    )?;
    if changed == 0 {
        return Ok(None);
    }
    get_mail_taxonomy_item(connection, item_id)
}

pub fn delete_mail_taxonomy_item(connection: &Connection, item_id: &str) -> Result<bool> {
    let changed = connection.execute(
        "DELETE FROM mail_taxonomy_items
         WHERE id = ?1
           AND system = 0",
        params![item_id.trim()],
    )?;
    Ok(changed > 0)
}

fn normalize_kind(kind: &str) -> String {
    match kind.trim().to_ascii_lowercase().as_str() {
        "folder" => "folder".to_string(),
        "label" => "label".to_string(),
        _ => "label".to_string(),
    }
}

fn normalize_name(name: &str) -> String {
    name.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(64)
        .collect()
}

fn normalize_color(color: &str) -> String {
    let trimmed = color.trim();
    if trimmed.len() == 7
        && trimmed.starts_with('#')
        && trimmed[1..].chars().all(|value| value.is_ascii_hexdigit())
    {
        trimmed.to_ascii_lowercase()
    } else {
        "#8b5cf6".to_string()
    }
}

fn normalize_parent_id(parent_id: Option<&str>) -> Option<String> {
    parent_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn taxonomy_slug(value: &str) -> String {
    let slug = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim_matches('_')
        .to_string();
    if slug.is_empty() {
        "item".to_string()
    } else {
        slug
    }
}

fn next_sort_order(connection: &Connection, kind: &str) -> Result<i64> {
    connection.query_row(
        "SELECT COALESCE(MAX(sort_order), 0) + 10
         FROM mail_taxonomy_items
         WHERE kind = ?1",
        params![kind],
        |row| row.get(0),
    )
}

#[cfg(test)]
mod tests {
    use crate::storage::db::open_in_memory_database;
    use crate::storage::migrations::run_migrations;

    use super::*;

    #[test]
    fn taxonomy_migration_creates_table_without_builtin_openai_label() {
        let connection = open_in_memory_database().expect("open database");

        run_migrations(&connection).expect("run migrations");

        let table_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type = 'table'
                   AND name = 'mail_taxonomy_items'",
                [],
                |row| row.get(0),
            )
            .expect("count taxonomy table");
        let labels = list_mail_taxonomy_items(&connection, "label").expect("list labels");

        assert_eq!(table_count, 1);
        assert!(!labels
            .iter()
            .any(|label| label.name.eq_ignore_ascii_case("openai")));
        assert!(!labels.iter().any(|label| label.system));
    }

    #[test]
    fn taxonomy_items_can_be_created_and_listed_by_kind() {
        let connection = open_in_memory_database().expect("open database");
        run_migrations(&connection).expect("run migrations");

        let folder = upsert_mail_taxonomy_item(
            &connection,
            NewMailTaxonomyItem {
                kind: "folder".to_string(),
                name: "Receipts".to_string(),
                parent_id: None,
                color: "#7c3aed".to_string(),
                now: "2026-06-17T20:00:00Z".to_string(),
            },
        )
        .expect("create folder");
        let label = upsert_mail_taxonomy_item(
            &connection,
            NewMailTaxonomyItem {
                kind: "label".to_string(),
                name: "Invoices".to_string(),
                parent_id: None,
                color: "#06b6d4".to_string(),
                now: "2026-06-17T20:01:00Z".to_string(),
            },
        )
        .expect("create label");

        let folders = list_mail_taxonomy_items(&connection, "folder").expect("list folders");
        let labels = list_mail_taxonomy_items(&connection, "label").expect("list labels");

        assert_eq!(folder.kind, "folder");
        assert_eq!(label.kind, "label");
        assert!(folders.iter().any(|item| item.name == "Receipts"));
        assert!(labels.iter().any(|item| item.name == "Invoices"));
        assert!(!labels.iter().any(|item| item.name == "Receipts"));
    }

    #[test]
    fn taxonomy_upsert_updates_existing_kind_name_color() {
        let connection = open_in_memory_database().expect("open database");
        run_migrations(&connection).expect("run migrations");

        let first = upsert_mail_taxonomy_item(
            &connection,
            NewMailTaxonomyItem {
                kind: "label".to_string(),
                name: "Client".to_string(),
                parent_id: None,
                color: "#06b6d4".to_string(),
                now: "2026-06-17T20:01:00Z".to_string(),
            },
        )
        .expect("create label");
        let second = upsert_mail_taxonomy_item(
            &connection,
            NewMailTaxonomyItem {
                kind: "label".to_string(),
                name: "Client".to_string(),
                parent_id: None,
                color: "#f59e0b".to_string(),
                now: "2026-06-17T20:02:00Z".to_string(),
            },
        )
        .expect("update label");

        let labels = list_mail_taxonomy_items(&connection, "label").expect("list labels");
        let matching = labels
            .iter()
            .filter(|item| item.name == "Client")
            .collect::<Vec<_>>();

        assert_eq!(first.id, second.id);
        assert_eq!(second.color, "#f59e0b");
        assert_eq!(matching.len(), 1);
    }

    #[test]
    fn taxonomy_item_can_be_updated_by_id_without_changing_identity() {
        let connection = open_in_memory_database().expect("open database");
        run_migrations(&connection).expect("run migrations");

        let created = upsert_mail_taxonomy_item(
            &connection,
            NewMailTaxonomyItem {
                kind: "folder".to_string(),
                name: "Receipts".to_string(),
                parent_id: None,
                color: "#7c3aed".to_string(),
                now: "2026-06-17T20:01:00Z".to_string(),
            },
        )
        .expect("create folder");

        let updated = update_mail_taxonomy_item(
            &connection,
            &created.id,
            "Invoices",
            None,
            "#06b6d4",
            "2026-06-17T20:02:00Z",
        )
        .expect("update folder")
        .expect("updated folder exists");

        assert_eq!(updated.id, created.id);
        assert_eq!(updated.name, "Invoices");
        assert_eq!(updated.color, "#06b6d4");
        assert_eq!(updated.kind, "folder");
    }

    #[test]
    fn custom_taxonomy_item_can_be_deleted_but_system_item_is_kept() {
        let connection = open_in_memory_database().expect("open database");
        run_migrations(&connection).expect("run migrations");

        let created = upsert_mail_taxonomy_item(
            &connection,
            NewMailTaxonomyItem {
                kind: "label".to_string(),
                name: "Client".to_string(),
                parent_id: None,
                color: "#06b6d4".to_string(),
                now: "2026-06-17T20:01:00Z".to_string(),
            },
        )
        .expect("create label");
        connection
            .execute(
                "INSERT INTO mail_taxonomy_items (
                    id, kind, name, normalized_name, color, sort_order, system, created_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    "mailtax_label_system",
                    "label",
                    "System",
                    "system",
                    "#06b6d4",
                    10_i64,
                    1_i64,
                    "2026-06-17T20:00:00Z",
                    "2026-06-17T20:00:00Z"
                ],
            )
            .expect("insert system item");

        let deleted = delete_mail_taxonomy_item(&connection, &created.id).expect("delete label");
        let deleted_system = delete_mail_taxonomy_item(&connection, "mailtax_label_system")
            .expect("delete system label");
        let labels = list_mail_taxonomy_items(&connection, "label").expect("list labels");

        assert!(deleted);
        assert!(!deleted_system);
        assert!(!labels.iter().any(|item| item.name == "Client"));
        assert!(labels.iter().any(|item| item.name == "System"));
    }

    #[test]
    fn folder_items_store_parent_id_and_delete_reparents_children() {
        let connection = open_in_memory_database().expect("open database");
        run_migrations(&connection).expect("run migrations");

        let parent = upsert_mail_taxonomy_item(
            &connection,
            NewMailTaxonomyItem {
                kind: "folder".to_string(),
                name: "Projects".to_string(),
                parent_id: None,
                color: "#7c3aed".to_string(),
                now: "2026-06-17T20:01:00Z".to_string(),
            },
        )
        .expect("create parent folder");
        let child = upsert_mail_taxonomy_item(
            &connection,
            NewMailTaxonomyItem {
                kind: "folder".to_string(),
                name: "Project A".to_string(),
                parent_id: Some(parent.id.clone()),
                color: "#06b6d4".to_string(),
                now: "2026-06-17T20:02:00Z".to_string(),
            },
        )
        .expect("create child folder");

        assert_eq!(child.parent_id.as_deref(), Some(parent.id.as_str()));

        let deleted =
            delete_mail_taxonomy_item(&connection, &parent.id).expect("delete parent folder");
        let orphaned_child = get_mail_taxonomy_item(&connection, &child.id)
            .expect("query child")
            .expect("child still exists");

        assert!(deleted);
        assert_eq!(orphaned_child.parent_id, None);
    }
}
