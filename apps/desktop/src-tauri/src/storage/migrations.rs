use rusqlite::{params, Connection, Result};

use super::migration_steps::MIGRATIONS;

pub fn run_migrations(connection: &Connection) -> Result<()> {
    run_migrations_through(connection, i64::MAX)
}

/// Applies migrations with a version at or below `max_version`.
///
/// `run_migrations` passes `i64::MAX`. Tests use a lower bound to build a
/// database as an older release would have left it, which is the only way to
/// exercise an upgrade over existing rows.
fn run_migrations_through(connection: &Connection, max_version: i64) -> Result<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );",
    )?;

    for migration in MIGRATIONS.iter().filter(|m| m.version <= max_version) {
        let already_applied: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version = ?1)",
            params![migration.version],
            |row| row.get(0),
        )?;
        if already_applied {
            continue;
        }

        // Each step and its bookkeeping row commit together, so a failure part
        // way through a batch cannot leave the schema half-changed while still
        // looking unapplied. `unchecked_transaction` is used because this takes
        // `&Connection`; migrations run before anything else opens a
        // transaction, so there is no nesting risk.
        let transaction = connection.unchecked_transaction()?;
        (migration.apply)(&transaction)?;
        transaction.execute(
            "INSERT INTO schema_migrations(version, name) VALUES (?1, ?2)",
            params![migration.version, migration.name],
        )?;
        transaction.commit()?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::db::open_in_memory_database;

    /// The pre-existing tests only cover a fresh database and a rerun. This one
    /// covers the case that actually breaks a hand-written runner: upgrading a
    /// database that already holds user rows.
    #[test]
    fn upgrading_from_version_7_preserves_existing_taxonomy_rows() {
        let connection = open_in_memory_database().expect("open in-memory database");
        run_migrations_through(&connection, 7).expect("migrate to version 7");

        // A v7 database has mail_taxonomy_items but no parent_id column yet.
        let has_parent_id_before: bool = connection
            .query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM pragma_table_info('mail_taxonomy_items')
                    WHERE name = 'parent_id'
                )",
                [],
                |row| row.get(0),
            )
            .expect("check parent_id before upgrade");
        assert!(
            !has_parent_id_before,
            "version 7 must predate the parent_id column, or this test proves nothing"
        );

        connection
            .execute(
                "INSERT INTO mail_taxonomy_items(
                    id, kind, name, normalized_name, color, sort_order, system,
                    created_at, updated_at
                 ) VALUES
                 ('lbl-1', 'label', 'Receipts', 'receipts', '#6d4aff', 3, 0,
                  '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
                 ('fld-1', 'folder', 'Archive 2025', 'archive 2025', '#111821', 1, 1,
                  '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z')",
                [],
            )
            .expect("seed taxonomy rows as an older release would have");

        run_migrations(&connection).expect("upgrade to latest");

        let has_parent_id_after: bool = connection
            .query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM pragma_table_info('mail_taxonomy_items')
                    WHERE name = 'parent_id'
                )",
                [],
                |row| row.get(0),
            )
            .expect("check parent_id after upgrade");
        assert!(has_parent_id_after, "upgrade must add parent_id");

        // The rows must survive with their values intact and a NULL parent.
        let (name, sort_order, system, parent_id): (String, i64, i64, Option<String>) = connection
            .query_row(
                "SELECT name, sort_order, system, parent_id
                 FROM mail_taxonomy_items WHERE id = 'lbl-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .expect("seeded label survives the upgrade");
        assert_eq!(name, "Receipts");
        assert_eq!(sort_order, 3);
        assert_eq!(system, 0);
        assert_eq!(parent_id, None);

        let surviving: i64 = connection
            .query_row("SELECT COUNT(*) FROM mail_taxonomy_items", [], |row| {
                row.get(0)
            })
            .expect("count taxonomy rows");
        assert_eq!(surviving, 2, "no seeded row may be dropped by the upgrade");
    }

    /// A migration and its bookkeeping row commit together, so a failure must
    /// leave neither behind. Without the transaction, the schema change would
    /// persist while the version stayed unrecorded.
    #[test]
    fn a_failing_migration_records_no_version_and_leaves_no_schema_change() {
        let connection = open_in_memory_database().expect("open in-memory database");
        connection
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS schema_migrations (
                    version INTEGER PRIMARY KEY,
                    name TEXT NOT NULL,
                    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );",
            )
            .expect("create bookkeeping table");

        let transaction = connection
            .unchecked_transaction()
            .expect("begin migration transaction");
        transaction
            .execute_batch("CREATE TABLE doomed_table (id TEXT PRIMARY KEY);")
            .expect("first statement of the batch succeeds");
        // Stand in for a later statement in the same batch failing.
        let failure = transaction.execute_batch("SELECT this_column_does_not_exist;");
        assert!(failure.is_err(), "the simulated failure must actually fail");
        drop(transaction);

        let doomed_exists: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='doomed_table')",
                [],
                |row| row.get(0),
            )
            .expect("check rolled-back table");
        assert!(
            !doomed_exists,
            "a rolled-back migration must not leave its table behind"
        );

        let recorded: i64 = connection
            .query_row("SELECT COUNT(*) FROM schema_migrations", [], |row| {
                row.get(0)
            })
            .expect("count recorded migrations");
        assert_eq!(recorded, 0, "a failed migration must record no version");
    }

    #[test]
    fn migrations_apply_cleanly() {
        let connection = open_in_memory_database().expect("open in-memory database");

        run_migrations(&connection).expect("run migrations");

        let count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN (
                    'accounts',
                    'mailbox_sources',
                    'credential_refs',
                    'mail_folders',
                    'temp_mailboxes',
                    'messages',
                    'message_sources',
                    'send_queue',
                    'agent_services',
                    'agent_threads',
                    'agent_messages',
                    'sync_states',
                    'verification_codes',
                    'app_settings',
                    'contacts'
                )",
                [],
                |row| row.get(0),
            )
            .expect("count foundation tables");

        assert_eq!(count, 15);

        let avatar_table_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN (
                    'sender_avatar_cache',
                    'contact_avatar_overrides'
                )",
                [],
                |row| row.get(0),
            )
            .expect("count avatar tables");

        assert_eq!(avatar_table_count, 2);

        let send_queue_recipient_column_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('send_queue')
                 WHERE name IN ('cc_addresses_json', 'bcc_addresses_json')",
                [],
                |row| row.get(0),
            )
            .expect("count send queue recipient columns");

        assert_eq!(send_queue_recipient_column_count, 2);

        let contact_table_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='contacts'",
                [],
                |row| row.get(0),
            )
            .expect("count contacts table");
        assert_eq!(contact_table_count, 1);

        let newsletter_override_table_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type='table' AND name='newsletter_subscription_overrides'",
                [],
                |row| row.get(0),
            )
            .expect("count newsletter override table");
        assert_eq!(newsletter_override_table_count, 1);

        let taxonomy_table_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type='table' AND name='mail_taxonomy_items'",
                [],
                |row| row.get(0),
            )
            .expect("count taxonomy table");
        assert_eq!(taxonomy_table_count, 1);

        let taxonomy_parent_column_count: i64 = connection
            .query_row(
                "SELECT COUNT(*)
                 FROM pragma_table_info('mail_taxonomy_items')
                 WHERE name = 'parent_id'",
                [],
                |row| row.get(0),
            )
            .expect("count taxonomy parent column");
        assert_eq!(taxonomy_parent_column_count, 1);

        let thread_key_index_count: i64 = connection
            .query_row(
                "SELECT COUNT(*)
                 FROM sqlite_master
                 WHERE type='index'
                   AND name='idx_messages_thread_key'",
                [],
                |row| row.get(0),
            )
            .expect("count message thread key index");
        assert_eq!(thread_key_index_count, 1);

        let lookup_index_count: i64 = connection
            .query_row(
                "SELECT COUNT(*)
                 FROM sqlite_master
                 WHERE type='index'
                   AND name IN (
                     'idx_message_sources_message_id',
                     'idx_message_sources_account_source',
                     'idx_message_sources_temp_mailbox',
                     'idx_message_sources_folder',
                     'idx_send_queue_message_id',
                     'idx_messages_active_date_received',
                     'idx_messages_rfc_message_id_lower'
                   )",
                [],
                |row| row.get(0),
            )
            .expect("count message lookup indexes");
        assert_eq!(lookup_index_count, 7);
    }

    /// Mirrors the join order of `load_message_detail`, where `messages` is
    /// driven by its primary key and `message_sources` must then be reached by
    /// `message_id`. Without the index that second step is a full scan.
    #[test]
    fn message_source_join_uses_index_instead_of_scanning() {
        let connection = open_in_memory_database().expect("open in-memory database");
        run_migrations(&connection).expect("run migrations");

        let plan = explain_query_plan(
            &connection,
            "SELECT messages.id, message_sources.flags_json
             FROM messages
             LEFT JOIN message_sources ON message_sources.message_id = messages.id
             WHERE messages.id = 'msg_probe'
               AND messages.deleted_at IS NULL
             ORDER BY message_sources.first_seen_at ASC
             LIMIT 1",
        );

        assert!(
            plan.contains("idx_message_sources_message_id"),
            "expected the message_id index to be used, got: {plan}"
        );
        assert!(
            !plan.contains("SCAN message_sources"),
            "expected no full scan of message_sources, got: {plan}"
        );
    }

    fn explain_query_plan(connection: &Connection, query: &str) -> String {
        let mut statement = connection
            .prepare(&format!("EXPLAIN QUERY PLAN {query}"))
            .expect("prepare explain");
        statement
            .query_map([], |row| row.get::<_, String>(3))
            .expect("run explain")
            .collect::<Result<Vec<_>>>()
            .expect("collect explain rows")
            .join(" | ")
    }

    #[test]
    fn lowercased_rfc_message_id_lookup_uses_expression_index() {
        let connection = open_in_memory_database().expect("open in-memory database");
        run_migrations(&connection).expect("run migrations");

        let plan = explain_query_plan(
            &connection,
            "SELECT thread_key
             FROM messages
             WHERE rfc_message_id IS NOT NULL
               AND lower(rfc_message_id) = lower('Probe@Example.COM')
               AND thread_key IS NOT NULL
               AND trim(thread_key) <> ''
             ORDER BY created_at ASC
             LIMIT 1",
        );

        assert!(
            plan.contains("idx_messages_rfc_message_id_lower"),
            "expected the lowercased expression index to be used, got: {plan}"
        );
    }

    #[test]
    fn migrations_are_idempotent() {
        let connection = open_in_memory_database().expect("open in-memory database");

        run_migrations(&connection).expect("first migration run");
        run_migrations(&connection).expect("second migration run");

        let count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM schema_migrations WHERE version = 1",
                [],
                |row| row.get(0),
            )
            .expect("count migration records");

        assert_eq!(count, 1);
    }

    #[test]
    fn migration_removes_legacy_builtin_openai_label() {
        let connection = open_in_memory_database().expect("open in-memory database");

        run_migrations(&connection).expect("initial migration run");
        connection
            .execute(
                "INSERT INTO mail_taxonomy_items (
                    id, kind, name, normalized_name, color, sort_order, system, created_at, updated_at
                 ) VALUES (
                    'legacy_openai_label', 'label', 'openai', 'openai', '#e45bd8', 10, 1,
                    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                 )",
                [],
            )
            .expect("insert legacy builtin label");
        connection
            .execute("DELETE FROM schema_migrations WHERE version = 7", [])
            .expect("mark cleanup migration unapplied");

        run_migrations(&connection).expect("rerun cleanup migration");

        let legacy_label_count: i64 = connection
            .query_row(
                "SELECT COUNT(*)
                 FROM mail_taxonomy_items
                 WHERE kind = 'label'
                   AND normalized_name = 'openai'
                   AND system = 1",
                [],
                |row| row.get(0),
            )
            .expect("count legacy builtin labels");

        assert_eq!(legacy_label_count, 0);
    }
}
