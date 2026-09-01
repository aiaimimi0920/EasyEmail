use rusqlite::{params, Connection, OptionalExtension, Result};

use crate::domain::account::Account;
use crate::domain::temp_mailbox::TempMailbox;
use crate::storage::account_repository::{enum_to_snake, insert_account};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TempMailboxRow {
    pub id: String,
    pub email_address: String,
    pub provider_id: String,
    pub provider_label: String,
    pub domain: Option<String>,
    pub local_part: Option<String>,
    pub easyemail_mailbox_id: Option<String>,
    pub source_id: Option<String>,
    pub visibility_state: String,
    pub lifecycle_state: String,
    pub lease_expires_at: Option<String>,
    pub upgraded_account_id: Option<String>,
    pub raw_provider_snapshot_json: String,
    pub created_at: String,
    pub updated_at: String,
}

pub fn insert_temp_mailbox(connection: &Connection, mailbox: &TempMailbox) -> Result<()> {
    connection.execute(
        "INSERT INTO temp_mailboxes (
            id,
            email_address,
            provider_id,
            provider_label,
            domain,
            local_part,
            easyemail_mailbox_id,
            visibility_state,
            lifecycle_state,
            lease_expires_at,
            upgraded_account_id,
            raw_provider_snapshot_json,
            created_at,
            updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
        params![
            mailbox.id,
            mailbox.email_address,
            mailbox.provider_id,
            mailbox.provider_label,
            mailbox.domain.as_deref(),
            mailbox.local_part.as_deref(),
            mailbox.easyemail_mailbox_id.as_deref(),
            enum_to_snake(&mailbox.visibility_state),
            enum_to_snake(&mailbox.lifecycle_state),
            mailbox.lease_expires_at.as_deref(),
            mailbox.upgraded_account_id.as_deref(),
            mailbox.raw_provider_snapshot_json.as_str(),
            mailbox.created_at,
            mailbox.updated_at,
        ],
    )?;

    Ok(())
}

pub fn get_temp_mailbox(connection: &Connection, id: &str) -> Result<Option<TempMailboxRow>> {
    connection
        .query_row(
            "SELECT
                id,
                email_address,
                provider_id,
                provider_label,
                domain,
                local_part,
                easyemail_mailbox_id,
                source_id,
                visibility_state,
                lifecycle_state,
                lease_expires_at,
                upgraded_account_id,
                raw_provider_snapshot_json,
                created_at,
                updated_at
             FROM temp_mailboxes
             WHERE id = ?1",
            params![id],
            map_temp_mailbox_row,
        )
        .optional()
}

pub fn list_temp_mailboxes(connection: &Connection) -> Result<Vec<TempMailboxRow>> {
    let mut statement = connection.prepare(
        "SELECT
            id,
            email_address,
            provider_id,
            provider_label,
            domain,
            local_part,
            easyemail_mailbox_id,
            source_id,
            visibility_state,
            lifecycle_state,
            lease_expires_at,
            upgraded_account_id,
            raw_provider_snapshot_json,
            created_at,
            updated_at
         FROM temp_mailboxes
         WHERE visibility_state != 'archived'
         ORDER BY created_at DESC, id DESC",
    )?;

    let rows = statement
        .query_map([], map_temp_mailbox_row)?
        .collect::<Result<Vec<_>>>()?;

    Ok(rows)
}

pub fn update_temp_mailbox_lifecycle(
    connection: &Connection,
    temp_mailbox_id: &str,
    lifecycle_state: &str,
    now: &str,
) -> Result<()> {
    connection.execute(
        "UPDATE temp_mailboxes
         SET lifecycle_state = ?1,
             updated_at = ?2
         WHERE id = ?3",
        params![lifecycle_state, now, temp_mailbox_id],
    )?;
    Ok(())
}

pub fn mark_temp_mailbox_refresh_success(
    connection: &Connection,
    temp_mailbox_id: &str,
    now: &str,
) -> Result<()> {
    connection.execute(
        "UPDATE temp_mailboxes
         SET last_fetch_at = ?1,
             last_success_at = ?1,
             updated_at = ?1
         WHERE id = ?2",
        params![now, temp_mailbox_id],
    )?;
    Ok(())
}

fn map_temp_mailbox_row(row: &rusqlite::Row<'_>) -> Result<TempMailboxRow> {
    Ok(TempMailboxRow {
        id: row.get("id")?,
        email_address: row.get("email_address")?,
        provider_id: row.get("provider_id")?,
        provider_label: row.get("provider_label")?,
        domain: row.get("domain")?,
        local_part: row.get("local_part")?,
        easyemail_mailbox_id: row.get("easyemail_mailbox_id")?,
        source_id: row.get("source_id")?,
        visibility_state: row.get("visibility_state")?,
        lifecycle_state: row.get("lifecycle_state")?,
        lease_expires_at: row.get("lease_expires_at")?,
        upgraded_account_id: row.get("upgraded_account_id")?,
        raw_provider_snapshot_json: row.get("raw_provider_snapshot_json")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

pub fn upgrade_temp_mailbox(
    connection: &mut Connection,
    temp_mailbox_id: &str,
    now: String,
) -> Result<String> {
    let transaction = connection.transaction()?;

    let (email_address, provider_label, lifecycle_state, source_id): (
        String,
        String,
        String,
        Option<String>,
    ) = transaction.query_row(
        "SELECT email_address, provider_label, lifecycle_state, source_id
             FROM temp_mailboxes
             WHERE id = ?1 AND visibility_state = 'anonymous'",
        params![temp_mailbox_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    )?;

    let mut account =
        Account::normal_upgraded_temp(email_address, Some(provider_label), now.clone());
    if lifecycle_state == "expired" || lifecycle_state == "history_only" {
        account.status = crate::domain::account::AccountStatus::HistoryOnly;
        account.receive_status = crate::domain::account::ReceiveStatus::Expired;
    }

    let account_id = account.id.clone();
    insert_account(&transaction, &account)?;

    transaction.execute(
        "UPDATE temp_mailboxes
         SET visibility_state = 'upgraded',
             upgraded_account_id = ?1,
             updated_at = ?2
         WHERE id = ?3",
        params![account_id, now, temp_mailbox_id],
    )?;
    if let Some(source_id) = source_id {
        transaction.execute(
            "UPDATE mailbox_sources
             SET account_id = ?1,
                 updated_at = ?2
             WHERE id = ?3",
            params![account_id, now, source_id],
        )?;
    }
    transaction.execute(
        "UPDATE message_sources
         SET account_id = ?1
         WHERE temp_mailbox_id = ?2",
        params![account_id, temp_mailbox_id],
    )?;

    transaction.commit()?;
    Ok(account_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::temp_mailbox::TempMailbox;
    use crate::storage::account_repository::list_normal_accounts;
    use crate::storage::db::open_in_memory_database;
    use crate::storage::message_repository::list_promoted_account_messages;
    use crate::storage::migrations::run_migrations;

    fn test_connection() -> Connection {
        let connection = open_in_memory_database().expect("open database");
        run_migrations(&connection).expect("run migrations");
        connection
    }

    #[test]
    fn temp_mailbox_default_visibility_is_persisted_as_anonymous() {
        let connection = test_connection();
        let mailbox = TempMailbox::new_anonymous(
            "code@example.test".to_string(),
            "fake".to_string(),
            "Fake Provider".to_string(),
            "2026-06-11T00:00:00Z".to_string(),
        );

        insert_temp_mailbox(&connection, &mailbox).expect("insert temp mailbox");
        let row = get_temp_mailbox(&connection, &mailbox.id)
            .expect("get mailbox")
            .expect("mailbox exists");

        assert_eq!(row.visibility_state, "anonymous");
        assert_eq!(row.lifecycle_state, "active");
        assert_eq!(row.upgraded_account_id, None);
    }

    #[test]
    fn upgrade_temp_mailbox_transaction_creates_account_and_updates_visibility() {
        let mut connection = test_connection();
        let mailbox = TempMailbox::new_anonymous(
            "code@example.test".to_string(),
            "fake".to_string(),
            "Fake Provider".to_string(),
            "2026-06-11T00:00:00Z".to_string(),
        );
        insert_temp_mailbox(&connection, &mailbox).expect("insert temp mailbox");

        let account_id = upgrade_temp_mailbox(
            &mut connection,
            &mailbox.id,
            "2026-06-11T00:01:00Z".to_string(),
        )
        .expect("upgrade temp mailbox");

        let upgraded = get_temp_mailbox(&connection, &mailbox.id)
            .expect("get upgraded")
            .expect("upgraded exists");
        let account_kind: String = connection
            .query_row(
                "SELECT kind FROM accounts WHERE id = ?1",
                params![account_id],
                |row| row.get(0),
            )
            .expect("get account kind");

        assert_eq!(upgraded.visibility_state, "upgraded");
        assert!(upgraded.upgraded_account_id.is_some());
        assert_eq!(account_kind, "normal_upgraded_temp");
    }

    #[test]
    fn upgrade_temp_mailbox_creates_normal_upgraded_temp_account() {
        let mut connection = test_connection();
        let mailbox =
            seed_temp_with_message(&connection, "temp_1", "code@example.test", "observed_1");

        let account_id = upgrade_temp_mailbox(
            &mut connection,
            &mailbox.id,
            "2026-06-12T00:20:00Z".to_string(),
        )
        .expect("upgrade temp");

        let account = list_normal_accounts(&connection)
            .expect("list accounts")
            .into_iter()
            .find(|row| row.id == account_id)
            .expect("promoted account visible");
        assert_eq!(account.kind, "normal_upgraded_temp");
        assert_eq!(
            account.primary_address,
            Some("code@example.test".to_string())
        );
        assert_eq!(account.status, "ready");
    }

    #[test]
    fn upgrade_does_not_move_or_rewrite_messages() {
        let mut connection = test_connection();
        let mailbox =
            seed_temp_with_message(&connection, "temp_1", "code@example.test", "observed_1");
        let before_message_ids = all_message_ids(&connection);
        let before_source_ids = all_message_source_ids(&connection);

        upgrade_temp_mailbox(
            &mut connection,
            &mailbox.id,
            "2026-06-12T00:20:00Z".to_string(),
        )
        .expect("upgrade temp");

        assert_eq!(all_message_ids(&connection), before_message_ids);
        assert_eq!(all_message_source_ids(&connection), before_source_ids);
    }

    #[test]
    fn upgraded_account_query_includes_historical_messages() {
        let mut connection = test_connection();
        let mailbox =
            seed_temp_with_message(&connection, "temp_1", "code@example.test", "observed_1");
        let account_id = upgrade_temp_mailbox(
            &mut connection,
            &mailbox.id,
            "2026-06-12T00:20:00Z".to_string(),
        )
        .expect("upgrade temp");

        let rows = list_promoted_account_messages(&connection, &account_id)
            .expect("list promoted history");

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].message_id, "msg_temp_1");
        assert_eq!(rows[0].received_address, "code@example.test");
        assert_eq!(rows[0].account_id, account_id);
    }

    #[test]
    fn expired_temp_upgrade_results_in_history_only_account() {
        let mut connection = test_connection();
        let mailbox =
            seed_temp_with_message(&connection, "temp_1", "expired@example.test", "observed_1");
        connection
            .execute(
                "UPDATE temp_mailboxes SET lifecycle_state = 'expired' WHERE id = ?1",
                params![mailbox.id],
            )
            .expect("expire mailbox");

        let account_id = upgrade_temp_mailbox(
            &mut connection,
            &mailbox.id,
            "2026-06-12T00:20:00Z".to_string(),
        )
        .expect("upgrade expired temp");

        let status: String = connection
            .query_row(
                "SELECT status FROM accounts WHERE id = ?1",
                params![account_id],
                |row| row.get(0),
            )
            .expect("account status");
        assert_eq!(status, "history_only");
    }

    fn seed_temp_with_message(
        connection: &Connection,
        temp_mailbox_id: &str,
        received_address: &str,
        observed_id: &str,
    ) -> TempMailbox {
        let source_id = format!("src_{temp_mailbox_id}");
        let message_id = format!("msg_{temp_mailbox_id}");
        let mut mailbox = TempMailbox::new_anonymous(
            received_address.to_string(),
            "fake".to_string(),
            "Fake Provider".to_string(),
            "2026-06-12T00:00:00Z".to_string(),
        );
        mailbox.id = temp_mailbox_id.to_string();
        insert_temp_mailbox(connection, &mailbox).expect("insert temp mailbox");
        connection
            .execute(
                "INSERT INTO mailbox_sources (
                    id,
                    source_kind,
                    address,
                    provider_id,
                    status,
                    created_at,
                    updated_at
                ) VALUES (?1, 'easyemail_temp', ?2, 'fake', 'ready', '2026-06-12T00:00:00Z', '2026-06-12T00:00:00Z')",
                params![source_id, received_address],
            )
            .expect("insert source");
        connection
            .execute(
                "UPDATE temp_mailboxes SET source_id = ?1 WHERE id = ?2",
                params![source_id, temp_mailbox_id],
            )
            .expect("bind source");
        connection
            .execute(
                "INSERT INTO messages (
                    id,
                    rfc_message_id,
                    subject,
                    from_address,
                    date_received,
                    snippet,
                    body_text_cache,
                    body_cache_state,
                    created_at,
                    updated_at
                ) VALUES (?1, ?2, 'Welcome', 'noreply@example.test', '2026-06-12T00:10:00Z', 'Welcome', 'Welcome body', 'cached', '2026-06-12T00:10:00Z', '2026-06-12T00:10:00Z')",
                params![message_id, observed_id],
            )
            .expect("insert message");
        connection
            .execute(
                "INSERT INTO message_sources (
                    id,
                    message_id,
                    source_id,
                    temp_mailbox_id,
                    provider_message_id,
                    easyemail_message_id,
                    received_address,
                    first_seen_at,
                    last_seen_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6, '2026-06-12T00:10:00Z', '2026-06-12T00:10:00Z')",
                params![
                    format!("msrc_{temp_mailbox_id}"),
                    message_id,
                    source_id,
                    temp_mailbox_id,
                    observed_id,
                    received_address
                ],
            )
            .expect("insert message source");

        mailbox
    }

    fn all_message_ids(connection: &Connection) -> Vec<String> {
        collect_string_column(connection, "SELECT id FROM messages ORDER BY id")
    }

    fn all_message_source_ids(connection: &Connection) -> Vec<String> {
        collect_string_column(connection, "SELECT id FROM message_sources ORDER BY id")
    }

    fn collect_string_column(connection: &Connection, sql: &str) -> Vec<String> {
        let mut statement = connection.prepare(sql).expect("prepare query");
        statement
            .query_map([], |row| row.get(0))
            .expect("query rows")
            .collect::<Result<Vec<String>>>()
            .expect("collect rows")
    }
}
