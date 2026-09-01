use std::path::Path;

use rusqlite::{Connection, Result};

/// Busy timeout for the single shared connection.
///
/// Sync and send-queue work can hold the connection for a while, so a blocked
/// statement should wait rather than fail immediately with `SQLITE_BUSY`.
const BUSY_TIMEOUT_MS: i32 = 5_000;

pub fn open_database(path: &Path) -> Result<Connection> {
    let connection = Connection::open(path)?;
    connection.pragma_update(None, "foreign_keys", "ON")?;
    apply_write_ahead_logging(&connection)?;
    apply_shared_pragmas(&connection)?;
    Ok(connection)
}

pub fn open_in_memory_database() -> Result<Connection> {
    let connection = Connection::open_in_memory()?;
    connection.pragma_update(None, "foreign_keys", "ON")?;
    // Write-ahead logging is a no-op for in-memory databases, so it is skipped
    // here to keep the journal mode reported by tests honest.
    apply_shared_pragmas(&connection)?;
    Ok(connection)
}

/// Switches a file-backed database to write-ahead logging.
///
/// `PRAGMA journal_mode` returns the resulting mode, so it has to be read as a
/// query rather than set through `pragma_update`.
fn apply_write_ahead_logging(connection: &Connection) -> Result<()> {
    connection.query_row("PRAGMA journal_mode = WAL", [], |row| {
        row.get::<_, String>(0)
    })?;
    Ok(())
}

fn apply_shared_pragmas(connection: &Connection) -> Result<()> {
    connection.busy_timeout(std::time::Duration::from_millis(BUSY_TIMEOUT_MS as u64))?;
    // With write-ahead logging enabled, NORMAL loses no durability on process
    // crash and only risks the most recent commits on host power loss, while
    // removing one fsync per commit from bulk sync writes.
    connection.pragma_update(None, "synchronous", "NORMAL")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_database_uses_write_ahead_logging() {
        let directory =
            std::env::temp_dir().join(format!("easyemailam_db_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).expect("create temp directory");
        let path = directory.join("test.db");

        let connection = open_database(&path).expect("open file database");
        let journal_mode: String = connection
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .expect("read journal mode");

        assert_eq!(journal_mode.to_ascii_lowercase(), "wal");

        drop(connection);
        let _ = std::fs::remove_dir_all(&directory);
    }

    #[test]
    fn databases_enable_foreign_keys_and_relax_synchronous() {
        let connection = open_in_memory_database().expect("open in-memory database");

        let foreign_keys: i64 = connection
            .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
            .expect("read foreign_keys");
        assert_eq!(foreign_keys, 1);

        // 1 == NORMAL
        let synchronous: i64 = connection
            .query_row("PRAGMA synchronous", [], |row| row.get(0))
            .expect("read synchronous");
        assert_eq!(synchronous, 1);
    }
}
