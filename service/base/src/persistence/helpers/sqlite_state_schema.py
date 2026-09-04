from __future__ import annotations

import sqlite3
from pathlib import Path

SCHEMA_STATEMENTS = [
    """
    CREATE TABLE IF NOT EXISTS provider_types (
        key TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        description TEXT NOT NULL,
        supports_dynamic_provisioning INTEGER NOT NULL,
        default_strategy_key TEXT NOT NULL,
        tags_json TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS runtime_templates (
        id TEXT PRIMARY KEY,
        provider_type_key TEXT NOT NULL,
        display_name TEXT NOT NULL,
        description TEXT NOT NULL,
        role_key TEXT NOT NULL,
        shared_by_default INTEGER NOT NULL,
        metadata_json TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS provider_instances (
        id TEXT PRIMARY KEY,
        provider_type_key TEXT NOT NULL,
        display_name TEXT NOT NULL,
        status TEXT NOT NULL,
        runtime_kind TEXT NOT NULL,
        connector_kind TEXT NOT NULL,
        shared INTEGER NOT NULL,
        cost_tier TEXT NOT NULL,
        health_score REAL NOT NULL,
        average_latency_ms INTEGER NOT NULL,
        connection_ref TEXT NOT NULL,
        host_bindings_json TEXT NOT NULL,
        group_keys_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS host_bindings (
        host_id TEXT NOT NULL,
        provider_type_key TEXT NOT NULL,
        binding_mode TEXT NOT NULL,
        instance_id TEXT NOT NULL,
        group_key TEXT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(host_id, provider_type_key)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS strategy_profiles (
        id TEXT PRIMARY KEY,
        key_name TEXT NOT NULL,
        display_name TEXT NOT NULL,
        description TEXT NOT NULL,
        preferred_instance_ids_json TEXT NULL,
        metadata_json TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS credential_sets (
        id TEXT PRIMARY KEY,
        provider_type_key TEXT NOT NULL,
        display_name TEXT NOT NULL,
        use_cases_json TEXT NOT NULL,
        strategy TEXT NULL,
        priority INTEGER NULL,
        group_keys_json TEXT NOT NULL,
        items_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS credential_bindings (
        provider_instance_id TEXT NOT NULL,
        credential_set_id TEXT NOT NULL,
        use_cases_json TEXT NULL,
        priority INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(provider_instance_id, credential_set_id)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS mailbox_sessions (
        id TEXT PRIMARY KEY,
        host_id TEXT NOT NULL,
        provider_type_key TEXT NOT NULL,
        provider_instance_id TEXT NOT NULL,
        email_address TEXT NOT NULL,
        mailbox_ref TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NULL,
        metadata_json TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS observed_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        provider_instance_id TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        sender TEXT NULL,
        subject TEXT NULL,
        html_body TEXT NULL,
        text_body TEXT NULL,
        extracted_code TEXT NULL,
        code_source TEXT NULL
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_provider_instances_type ON provider_instances(provider_type_key)",
    "CREATE INDEX IF NOT EXISTS idx_host_bindings_instance ON host_bindings(instance_id)",
    "CREATE INDEX IF NOT EXISTS idx_credential_bindings_instance ON credential_bindings(provider_instance_id)",
    "CREATE INDEX IF NOT EXISTS idx_mailbox_sessions_instance ON mailbox_sessions(provider_instance_id)",
    "CREATE INDEX IF NOT EXISTS idx_mailbox_sessions_host ON mailbox_sessions(host_id)",
    "CREATE INDEX IF NOT EXISTS idx_observed_messages_session ON observed_messages(session_id)",
    "CREATE INDEX IF NOT EXISTS idx_observed_messages_instance ON observed_messages(provider_instance_id)",
]

TABLES_IN_DELETE_ORDER = [
    "observed_messages",
    "mailbox_sessions",
    "credential_bindings",
    "credential_sets",
    "host_bindings",
    "provider_instances",
    "strategy_profiles",
    "runtime_templates",
    "provider_types",
]

def ensure_parent(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)

def open_db(db_path: Path) -> sqlite3.Connection:
    ensure_parent(db_path)
    conn = sqlite3.connect(str(db_path))
    for statement in SCHEMA_STATEMENTS:
        conn.execute(statement)
    conn.commit()
    return conn


def row_count(conn: sqlite3.Connection, table: str) -> int:
    row = conn.execute(f"SELECT COUNT(1) FROM {table}").fetchone()
    return int(row[0]) if row else 0


def has_any_state(conn: sqlite3.Connection) -> bool:
    for table in TABLES_IN_DELETE_ORDER:
        if row_count(conn, table) > 0:
            return True
    return False
