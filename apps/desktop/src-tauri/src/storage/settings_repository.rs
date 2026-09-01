use rusqlite::{params, Connection, OptionalExtension, Result};
use serde::{Deserialize, Serialize};

pub const EASYEMAIL_SETTINGS_KEY: &str = "easyemail.connection";

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct EasyEmailStoredSettings {
    pub service_url: Option<String>,
}

pub fn load_easyemail_settings(connection: &Connection) -> Result<EasyEmailStoredSettings> {
    let value_json: Option<String> = connection
        .query_row(
            "SELECT value_json FROM app_settings WHERE key = ?1",
            params![EASYEMAIL_SETTINGS_KEY],
            |row| row.get(0),
        )
        .optional()?;

    match value_json {
        Some(value) => Ok(serde_json::from_str(&value).unwrap_or_default()),
        None => Ok(EasyEmailStoredSettings::default()),
    }
}

pub fn save_easyemail_service_url(
    connection: &Connection,
    service_url: &str,
    now: &str,
) -> Result<()> {
    let settings = EasyEmailStoredSettings {
        service_url: Some(service_url.to_string()),
    };
    let value_json = serde_json::to_string(&settings).expect("serialize EasyEmail settings");

    connection.execute(
        "INSERT INTO app_settings (key, value_json, updated_at)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET
           value_json = excluded.value_json,
           updated_at = excluded.updated_at",
        params![EASYEMAIL_SETTINGS_KEY, value_json, now],
    )?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::storage::db::open_in_memory_database;
    use crate::storage::migrations::run_migrations;

    use super::*;

    #[test]
    fn settings_repository_saves_and_loads_easyemail_url() {
        let connection = open_in_memory_database().expect("open database");
        run_migrations(&connection).expect("run migrations");

        save_easyemail_service_url(&connection, "http://127.0.0.1:8080", "2026-06-12T00:00:00Z")
            .expect("save settings");

        let settings = load_easyemail_settings(&connection).expect("load settings");

        assert_eq!(
            settings,
            EasyEmailStoredSettings {
                service_url: Some("http://127.0.0.1:8080".to_string())
            }
        );
    }
}
