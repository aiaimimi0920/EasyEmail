use rusqlite::{params, Connection, OptionalExtension, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CredentialRefRow {
    pub id: String,
    pub owner_account_id: String,
    pub source_id: String,
    pub secret_backend: String,
    pub secret_key: String,
    pub credential_kind: String,
    pub auth_method: String,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
    pub last_verified_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewCredentialRef {
    pub owner_account_id: String,
    pub source_id: String,
    pub secret_backend: String,
    pub secret_key: String,
    pub credential_kind: String,
    pub auth_method: String,
    pub now: String,
}

pub fn insert_credential_ref(
    connection: &Connection,
    credential: NewCredentialRef,
) -> Result<CredentialRefRow> {
    let row = CredentialRefRow {
        id: format!("cred_{}", uuid::Uuid::new_v4()),
        owner_account_id: credential.owner_account_id,
        source_id: credential.source_id,
        secret_backend: credential.secret_backend,
        secret_key: credential.secret_key,
        credential_kind: credential.credential_kind,
        auth_method: credential.auth_method,
        status: "active".to_string(),
        created_at: credential.now.clone(),
        updated_at: credential.now,
        last_verified_at: None,
    };
    connection.execute(
        "INSERT INTO credential_refs (
            id,
            owner_account_id,
            source_id,
            secret_backend,
            secret_key,
            credential_kind,
            auth_method,
            status,
            created_at,
            updated_at,
            last_verified_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            &row.id,
            &row.owner_account_id,
            &row.source_id,
            &row.secret_backend,
            &row.secret_key,
            &row.credential_kind,
            &row.auth_method,
            &row.status,
            &row.created_at,
            &row.updated_at,
            &row.last_verified_at,
        ],
    )?;

    Ok(row)
}

pub fn get_credential_ref(connection: &Connection, id: &str) -> Result<Option<CredentialRefRow>> {
    connection
        .query_row(
            "SELECT
                id,
                owner_account_id,
                source_id,
                secret_backend,
                secret_key,
                credential_kind,
                auth_method,
                status,
                created_at,
                updated_at,
                last_verified_at
             FROM credential_refs
             WHERE id = ?1",
            params![id],
            map_credential_ref_row,
        )
        .optional()
}

fn map_credential_ref_row(row: &rusqlite::Row<'_>) -> Result<CredentialRefRow> {
    Ok(CredentialRefRow {
        id: row.get("id")?,
        owner_account_id: row.get("owner_account_id")?,
        source_id: row.get("source_id")?,
        secret_backend: row.get("secret_backend")?,
        secret_key: row.get("secret_key")?,
        credential_kind: row.get("credential_kind")?,
        auth_method: row.get("auth_method")?,
        status: row.get("status")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        last_verified_at: row.get("last_verified_at")?,
    })
}

#[cfg(test)]
mod tests {
    use rusqlite::{params, Connection};

    use crate::storage::db::open_in_memory_database;
    use crate::storage::migrations::run_migrations;

    use super::*;

    #[test]
    fn credential_ref_repository_never_stores_secret_value() {
        let connection = test_connection();
        seed_owner_and_source(&connection);

        let row = insert_credential_ref(
            &connection,
            NewCredentialRef {
                owner_account_id: "acct_1".to_string(),
                source_id: "src_1".to_string(),
                secret_backend: "fake_vault".to_string(),
                secret_key: "secret://imap/account-1".to_string(),
                credential_kind: "imap_password".to_string(),
                auth_method: "password".to_string(),
                now: "2026-06-12T00:00:00Z".to_string(),
            },
        )
        .expect("insert credential ref");

        let serialized = serde_json::to_string(&row).expect("serialize row");
        assert!(serialized.contains("secret://imap/account-1"));
        assert!(!serialized.contains("app-password"));
    }

    fn test_connection() -> Connection {
        let connection = open_in_memory_database().expect("open database");
        run_migrations(&connection).expect("run migrations");
        connection
    }

    fn seed_owner_and_source(connection: &Connection) {
        connection
            .execute(
                "INSERT INTO accounts (
                    id,
                    scope,
                    kind,
                    display_name,
                    primary_address,
                    provider_label,
                    status,
                    auth_status,
                    receive_status,
                    send_status,
                    listed_in_all_accounts,
                    created_at,
                    updated_at
                ) VALUES ('acct_1', 'normal', 'normal_long_lived', 'Work', 'work@example.test', 'Example', 'ready', 'not_required', 'enabled', 'unsupported', 1, '2026-06-12T00:00:00Z', '2026-06-12T00:00:00Z')",
                [],
            )
            .expect("insert account");
        connection
            .execute(
                "INSERT INTO mailbox_sources (
                    id,
                    account_id,
                    source_kind,
                    address,
                    provider_id,
                    status,
                    created_at,
                    updated_at
                ) VALUES ('src_1', 'acct_1', 'imap', 'work@example.test', 'manual_imap', 'ready', '2026-06-12T00:00:00Z', '2026-06-12T00:00:00Z')",
                params![],
            )
            .expect("insert source");
    }
}
