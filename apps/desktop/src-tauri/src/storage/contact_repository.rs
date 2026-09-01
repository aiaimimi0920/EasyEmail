use rusqlite::{params, Connection, OptionalExtension, Result};
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContactRow {
    pub id: String,
    pub display_name: String,
    pub email_address: String,
    pub note: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewContact {
    pub display_name: String,
    pub email_address: String,
    pub note: Option<String>,
    pub now: String,
}

pub fn list_contacts(connection: &Connection) -> Result<Vec<ContactRow>> {
    let mut statement = connection.prepare(
        "SELECT id, display_name, email_address, note, created_at, updated_at
         FROM contacts
         ORDER BY display_name COLLATE NOCASE ASC, email_address COLLATE NOCASE ASC",
    )?;
    let rows = statement.query_map([], map_contact_row)?;
    rows.collect()
}

pub fn create_contact(connection: &Connection, contact: NewContact) -> Result<ContactRow> {
    let normalized_email = normalize_contact_email(&contact.email_address)?;
    let display_name =
        normalize_contact_display_name(&contact.display_name, &contact.email_address);
    let note = normalize_optional_note(contact.note);
    let id = format!("contact_{}", Uuid::new_v4());

    connection.execute(
        "INSERT INTO contacts (
            id,
            display_name,
            email_address,
            note,
            created_at,
            updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?5)
        ON CONFLICT(email_address) DO UPDATE SET
            display_name = excluded.display_name,
            note = excluded.note,
            updated_at = excluded.updated_at",
        params![id, display_name, normalized_email, note, contact.now],
    )?;

    get_contact_by_email(connection, &normalized_email)?.ok_or(rusqlite::Error::QueryReturnedNoRows)
}

fn get_contact_by_email(
    connection: &Connection,
    email_address: &str,
) -> Result<Option<ContactRow>> {
    connection
        .query_row(
            "SELECT id, display_name, email_address, note, created_at, updated_at
             FROM contacts
             WHERE email_address = ?1",
            params![email_address],
            map_contact_row,
        )
        .optional()
}

fn map_contact_row(row: &rusqlite::Row<'_>) -> Result<ContactRow> {
    Ok(ContactRow {
        id: row.get("id")?,
        display_name: row.get("display_name")?,
        email_address: row.get("email_address")?,
        note: row.get("note")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn normalize_contact_email(value: &str) -> Result<String> {
    let trimmed = value.trim();
    let candidate = if let (Some(start), Some(end)) = (trimmed.find('<'), trimmed.rfind('>')) {
        trimmed[start + 1..end].trim()
    } else {
        trimmed
    };
    let normalized = candidate.to_ascii_lowercase();
    if !normalized.contains('@') || normalized.starts_with('@') || normalized.ends_with('@') {
        return Err(rusqlite::Error::InvalidParameterName(
            "email_address must be a valid mailbox address".to_string(),
        ));
    }
    Ok(normalized)
}

fn normalize_contact_display_name(display_name: &str, email_address: &str) -> String {
    let trimmed = display_name.trim();
    if !trimmed.is_empty() {
        return trimmed.to_string();
    }

    let raw_email = email_address.trim();
    let candidate = if let (Some(start), Some(end)) = (raw_email.find('<'), raw_email.rfind('>')) {
        raw_email[start + 1..end].trim()
    } else {
        raw_email
    };
    let local_part = candidate.split('@').next().unwrap_or("Contact").trim();
    if local_part.is_empty() {
        "Contact".to_string()
    } else {
        let mut chars = local_part.chars();
        match chars.next() {
            Some(first) => format!("{}{}", first.to_uppercase(), chars.as_str()),
            None => "Contact".to_string(),
        }
    }
}

fn normalize_optional_note(note: Option<String>) -> Option<String> {
    note.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::db::open_in_memory_database;
    use crate::storage::migrations::run_migrations;

    #[test]
    fn create_contact_normalizes_email_and_defaults_blank_display_name() {
        let connection = open_in_memory_database().expect("open in-memory database");
        run_migrations(&connection).expect("run migrations");

        let contact = create_contact(
            &connection,
            NewContact {
                display_name: "  ".to_string(),
                email_address: "  Friend@Example.COM  ".to_string(),
                note: Some("  lunch  ".to_string()),
                now: "2026-06-16T01:02:03Z".to_string(),
            },
        )
        .expect("create contact");

        assert_eq!(contact.display_name, "Friend");
        assert_eq!(contact.email_address, "friend@example.com");
        assert_eq!(contact.note.as_deref(), Some("lunch"));

        let contacts = list_contacts(&connection).expect("list contacts");
        assert_eq!(contacts, vec![contact]);
    }

    #[test]
    fn create_contact_updates_existing_email_without_duplicate_rows() {
        let connection = open_in_memory_database().expect("open in-memory database");
        run_migrations(&connection).expect("run migrations");

        let first = create_contact(
            &connection,
            NewContact {
                display_name: "Alice".to_string(),
                email_address: "alice@example.com".to_string(),
                note: None,
                now: "2026-06-16T01:02:03Z".to_string(),
            },
        )
        .expect("create first contact");

        let updated = create_contact(
            &connection,
            NewContact {
                display_name: "Alice Zhang".to_string(),
                email_address: "ALICE@example.com".to_string(),
                note: Some("Project lead".to_string()),
                now: "2026-06-16T02:02:03Z".to_string(),
            },
        )
        .expect("update existing contact");

        assert_eq!(updated.id, first.id);
        assert_eq!(updated.display_name, "Alice Zhang");
        assert_eq!(updated.note.as_deref(), Some("Project lead"));
        assert_eq!(updated.created_at, first.created_at);
        assert_eq!(updated.updated_at, "2026-06-16T02:02:03Z");
        assert_eq!(list_contacts(&connection).expect("list contacts").len(), 1);
    }
}
