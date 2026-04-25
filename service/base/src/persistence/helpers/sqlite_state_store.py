from __future__ import annotations

import json
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

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


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def ensure_parent(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)


def encode_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False)


def emit_json(value: Any) -> None:
    sys.stdout.write(encode_json(value))


def decode_json(value: str | None, fallback: Any) -> Any:
    if value is None or value == "":
        return fallback
    return json.loads(value)


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


def optional_key(item: dict[str, Any], key: str, value: Any) -> None:
    if value is not None:
        item[key] = value


def provider_type_from_row(row: sqlite3.Row | tuple[Any, ...]) -> dict[str, Any]:
    return {
        "key": row[0],
        "displayName": row[1],
        "description": row[2],
        "supportsDynamicProvisioning": bool(row[3]),
        "defaultStrategyKey": row[4],
        "tags": decode_json(row[5], []),
    }


def runtime_template_from_row(row: sqlite3.Row | tuple[Any, ...]) -> dict[str, Any]:
    return {
        "id": row[0],
        "providerTypeKey": row[1],
        "displayName": row[2],
        "description": row[3],
        "roleKey": row[4],
        "sharedByDefault": bool(row[5]),
        "metadata": decode_json(row[6], {}),
    }


def provider_instance_from_row(row: sqlite3.Row | tuple[Any, ...]) -> dict[str, Any]:
    return {
        "id": row[0],
        "providerTypeKey": row[1],
        "displayName": row[2],
        "status": row[3],
        "runtimeKind": row[4],
        "connectorKind": row[5],
        "shared": bool(row[6]),
        "costTier": row[7],
        "healthScore": float(row[8]),
        "averageLatencyMs": int(row[9]),
        "connectionRef": row[10],
        "hostBindings": decode_json(row[11], []),
        "groupKeys": decode_json(row[12], []),
        "metadata": decode_json(row[13], {}),
        "createdAt": row[14],
        "updatedAt": row[15],
    }


def host_binding_from_row(row: sqlite3.Row | tuple[Any, ...]) -> dict[str, Any]:
    item = {
        "hostId": row[0],
        "providerTypeKey": row[1],
        "bindingMode": row[2],
        "instanceId": row[3],
        "updatedAt": row[5],
    }
    optional_key(item, "groupKey", row[4])
    return item


def strategy_profile_from_row(row: sqlite3.Row | tuple[Any, ...]) -> dict[str, Any]:
    item = {
        "id": row[0],
        "key": row[1],
        "displayName": row[2],
        "description": row[3],
        "metadata": decode_json(row[5], {}),
    }
    preferred_ids = decode_json(row[4], None)
    if preferred_ids is not None:
        item["preferredInstanceIds"] = preferred_ids
    return item


def credential_set_from_row(row: sqlite3.Row | tuple[Any, ...]) -> dict[str, Any]:
    item = {
        "id": row[0],
        "providerTypeKey": row[1],
        "displayName": row[2],
        "useCases": decode_json(row[3], []),
        "groupKeys": decode_json(row[6], []),
        "items": decode_json(row[7], []),
        "metadata": decode_json(row[8], {}),
        "createdAt": row[9],
        "updatedAt": row[10],
    }
    optional_key(item, "strategy", row[4])
    optional_key(item, "priority", row[5])
    return item


def credential_binding_from_row(row: sqlite3.Row | tuple[Any, ...]) -> dict[str, Any]:
    item = {
        "providerInstanceId": row[0],
        "credentialSetId": row[1],
        "priority": int(row[3]),
        "updatedAt": row[4],
    }
    use_cases = decode_json(row[2], None)
    if use_cases is not None:
        item["useCases"] = use_cases
    return item


def mailbox_session_from_row(row: sqlite3.Row | tuple[Any, ...]) -> dict[str, Any]:
    item = {
        "id": row[0],
        "hostId": row[1],
        "providerTypeKey": row[2],
        "providerInstanceId": row[3],
        "emailAddress": row[4],
        "mailboxRef": row[5],
        "status": row[6],
        "createdAt": row[7],
        "metadata": decode_json(row[9], {}),
    }
    optional_key(item, "expiresAt", row[8])
    return item


def observed_message_from_row(row: sqlite3.Row | tuple[Any, ...]) -> dict[str, Any]:
    item = {
        "id": row[0],
        "sessionId": row[1],
        "providerInstanceId": row[2],
        "observedAt": row[3],
    }
    optional_key(item, "sender", row[4])
    optional_key(item, "subject", row[5])
    optional_key(item, "htmlBody", row[6])
    optional_key(item, "textBody", row[7])
    optional_key(item, "extractedCode", row[8])
    optional_key(item, "codeSource", row[9])
    return item


def load_snapshot(db_path: Path) -> None:
    conn = open_db(db_path)
    try:
        if not has_any_state(conn):
            sys.stdout.write("null")
            return

        snapshot = {
            "providerTypes": [
                provider_type_from_row(row)
                for row in conn.execute(
                    "SELECT key, display_name, description, supports_dynamic_provisioning, default_strategy_key, tags_json FROM provider_types ORDER BY key"
                )
            ],
            "runtimeTemplates": [
                runtime_template_from_row(row)
                for row in conn.execute(
                    "SELECT id, provider_type_key, display_name, description, role_key, shared_by_default, metadata_json FROM runtime_templates ORDER BY id"
                )
            ],
            "instances": [
                provider_instance_from_row(row)
                for row in conn.execute(
                    """
                    SELECT id, provider_type_key, display_name, status, runtime_kind, connector_kind,
                           shared, cost_tier, health_score, average_latency_ms, connection_ref,
                           host_bindings_json, group_keys_json, metadata_json, created_at, updated_at
                    FROM provider_instances
                    ORDER BY id
                    """
                )
            ],
            "bindings": [
                host_binding_from_row(row)
                for row in conn.execute(
                    "SELECT host_id, provider_type_key, binding_mode, instance_id, group_key, updated_at FROM host_bindings ORDER BY host_id, provider_type_key"
                )
            ],
            "strategies": [
                strategy_profile_from_row(row)
                for row in conn.execute(
                    "SELECT id, key_name, display_name, description, preferred_instance_ids_json, metadata_json FROM strategy_profiles ORDER BY id"
                )
            ],
            "credentialSets": [
                credential_set_from_row(row)
                for row in conn.execute(
                    """
                    SELECT id, provider_type_key, display_name, use_cases_json, strategy, priority,
                           group_keys_json, items_json, metadata_json, created_at, updated_at
                    FROM credential_sets
                    ORDER BY id
                    """
                )
            ],
            "credentialBindings": [
                credential_binding_from_row(row)
                for row in conn.execute(
                    "SELECT provider_instance_id, credential_set_id, use_cases_json, priority, updated_at FROM credential_bindings ORDER BY provider_instance_id, credential_set_id"
                )
            ],
            "sessions": [
                mailbox_session_from_row(row)
                for row in conn.execute(
                    """
                    SELECT id, host_id, provider_type_key, provider_instance_id, email_address,
                           mailbox_ref, status, created_at, expires_at, metadata_json
                    FROM mailbox_sessions
                    ORDER BY created_at, id
                    """
                )
            ],
            "messages": [
                observed_message_from_row(row)
                for row in conn.execute(
                    """
                    SELECT id, session_id, provider_instance_id, observed_at, sender, subject,
                           html_body, text_body, extracted_code, code_source
                    FROM observed_messages
                    ORDER BY observed_at, id
                    """
                )
            ],
        }
        emit_json(snapshot)
    finally:
        conn.close()


def delete_all(conn: sqlite3.Connection) -> None:
    for table in TABLES_IN_DELETE_ORDER:
        conn.execute(f"DELETE FROM {table}")


def save_snapshot(db_path: Path) -> None:
    payload = sys.stdin.read()
    payload = payload.lstrip("\ufeff").strip()
    snapshot = json.loads(payload) if payload else {}
    conn = open_db(db_path)
    try:
        conn.execute("BEGIN IMMEDIATE")
        delete_all(conn)

        for item in snapshot.get("providerTypes", []):
            conn.execute(
                """
                INSERT INTO provider_types(key, display_name, description, supports_dynamic_provisioning, default_strategy_key, tags_json)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    item["key"],
                    item["displayName"],
                    item["description"],
                    1 if item.get("supportsDynamicProvisioning") else 0,
                    item["defaultStrategyKey"],
                    encode_json(item.get("tags", [])),
                ),
            )

        for item in snapshot.get("runtimeTemplates", []):
            conn.execute(
                """
                INSERT INTO runtime_templates(id, provider_type_key, display_name, description, role_key, shared_by_default, metadata_json)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    item["id"],
                    item["providerTypeKey"],
                    item["displayName"],
                    item["description"],
                    item["roleKey"],
                    1 if item.get("sharedByDefault") else 0,
                    encode_json(item.get("metadata", {})),
                ),
            )

        for item in snapshot.get("instances", []):
            conn.execute(
                """
                INSERT INTO provider_instances(
                    id, provider_type_key, display_name, status, runtime_kind, connector_kind,
                    shared, cost_tier, health_score, average_latency_ms, connection_ref,
                    host_bindings_json, group_keys_json, metadata_json, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    item["id"],
                    item["providerTypeKey"],
                    item["displayName"],
                    item["status"],
                    item["runtimeKind"],
                    item["connectorKind"],
                    1 if item.get("shared") else 0,
                    item["costTier"],
                    float(item["healthScore"]),
                    int(item["averageLatencyMs"]),
                    item["connectionRef"],
                    encode_json(item.get("hostBindings", [])),
                    encode_json(item.get("groupKeys", [])),
                    encode_json(item.get("metadata", {})),
                    item["createdAt"],
                    item["updatedAt"],
                ),
            )

        for item in snapshot.get("bindings", []):
            conn.execute(
                """
                INSERT INTO host_bindings(host_id, provider_type_key, binding_mode, instance_id, group_key, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    item["hostId"],
                    item["providerTypeKey"],
                    item["bindingMode"],
                    item["instanceId"],
                    item.get("groupKey"),
                    item["updatedAt"],
                ),
            )

        for item in snapshot.get("strategies", []):
            conn.execute(
                """
                INSERT INTO strategy_profiles(id, key_name, display_name, description, preferred_instance_ids_json, metadata_json)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    item["id"],
                    item["key"],
                    item["displayName"],
                    item["description"],
                    encode_json(item["preferredInstanceIds"]) if "preferredInstanceIds" in item else None,
                    encode_json(item.get("metadata", {})),
                ),
            )

        for item in snapshot.get("credentialSets", []):
            conn.execute(
                """
                INSERT INTO credential_sets(
                    id, provider_type_key, display_name, use_cases_json, strategy, priority,
                    group_keys_json, items_json, metadata_json, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    item["id"],
                    item["providerTypeKey"],
                    item["displayName"],
                    encode_json(item.get("useCases", [])),
                    item.get("strategy"),
                    item.get("priority"),
                    encode_json(item.get("groupKeys", [])),
                    encode_json(item.get("items", [])),
                    encode_json(item.get("metadata", {})),
                    item["createdAt"],
                    item["updatedAt"],
                ),
            )

        for item in snapshot.get("credentialBindings", []):
            conn.execute(
                """
                INSERT INTO credential_bindings(provider_instance_id, credential_set_id, use_cases_json, priority, updated_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    item["providerInstanceId"],
                    item["credentialSetId"],
                    encode_json(item["useCases"]) if "useCases" in item else None,
                    int(item.get("priority", 0)),
                    item["updatedAt"],
                ),
            )

        for item in snapshot.get("sessions", []):
            conn.execute(
                """
                INSERT INTO mailbox_sessions(
                    id, host_id, provider_type_key, provider_instance_id, email_address,
                    mailbox_ref, status, created_at, expires_at, metadata_json
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    item["id"],
                    item["hostId"],
                    item["providerTypeKey"],
                    item["providerInstanceId"],
                    item["emailAddress"],
                    item["mailboxRef"],
                    item["status"],
                    item["createdAt"],
                    item.get("expiresAt"),
                    encode_json(item.get("metadata", {})),
                ),
            )

        for item in snapshot.get("messages", []):
            conn.execute(
                """
                INSERT INTO observed_messages(
                    id, session_id, provider_instance_id, observed_at, sender, subject,
                    html_body, text_body, extracted_code, code_source
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    item["id"],
                    item["sessionId"],
                    item["providerInstanceId"],
                    item["observedAt"],
                    item.get("sender"),
                    item.get("subject"),
                    item.get("htmlBody"),
                    item.get("textBody"),
                    item.get("extractedCode"),
                    item.get("codeSource"),
                ),
            )

        conn.commit()
        emit_json({"ok": True, "updatedAt": utc_now_iso()})
    finally:
        conn.close()


def parse_filters(raw: str | None) -> dict[str, Any]:
    if not raw:
        return {}
    text = raw.lstrip("\ufeff").strip()
    if not text:
        return {}
    parsed = json.loads(text)
    return parsed if isinstance(parsed, dict) else {}


def parse_limit(filters: dict[str, Any]) -> int | None:
    value = filters.get("limit")
    if value is None or value == "":
        return None
    parsed = int(value)
    return max(0, min(parsed, 1000))


def query_provider_instances(db_path: Path, filters: dict[str, Any]) -> None:
    conn = open_db(db_path)
    try:
        where: list[str] = []
        params: list[Any] = []
        if filters.get("providerTypeKey"):
            where.append("provider_type_key = ?")
            params.append(filters["providerTypeKey"])
        if filters.get("status"):
            where.append("status = ?")
            params.append(filters["status"])
        if filters.get("shared") is not None:
            where.append("shared = ?")
            params.append(1 if filters.get("shared") else 0)

        sql = """
            SELECT id, provider_type_key, display_name, status, runtime_kind, connector_kind,
                   shared, cost_tier, health_score, average_latency_ms, connection_ref,
                   host_bindings_json, group_keys_json, metadata_json, created_at, updated_at
            FROM provider_instances
        """
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += " ORDER BY updated_at DESC, id ASC"

        items = [provider_instance_from_row(row) for row in conn.execute(sql, params)]
        group_key = filters.get("groupKey")
        if group_key:
            items = [item for item in items if group_key in item.get("groupKeys", [])]

        limit = parse_limit(filters)
        if limit is not None:
            items = items[:limit]

        emit_json(items)
    finally:
        conn.close()


def query_host_bindings(db_path: Path, filters: dict[str, Any]) -> None:
    conn = open_db(db_path)
    try:
        where: list[str] = []
        params: list[Any] = []
        if filters.get("hostId"):
            where.append("host_id = ?")
            params.append(filters["hostId"])
        if filters.get("providerTypeKey"):
            where.append("provider_type_key = ?")
            params.append(filters["providerTypeKey"])
        if filters.get("instanceId"):
            where.append("instance_id = ?")
            params.append(filters["instanceId"])

        sql = "SELECT host_id, provider_type_key, binding_mode, instance_id, group_key, updated_at FROM host_bindings"
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += " ORDER BY updated_at DESC, host_id ASC, provider_type_key ASC"

        items = [host_binding_from_row(row) for row in conn.execute(sql, params)]
        limit = parse_limit(filters)
        if limit is not None:
            items = items[:limit]

        emit_json(items)
    finally:
        conn.close()


def query_mailbox_sessions(db_path: Path, filters: dict[str, Any]) -> None:
    conn = open_db(db_path)
    try:
        where: list[str] = []
        params: list[Any] = []
        if filters.get("hostId"):
            where.append("host_id = ?")
            params.append(filters["hostId"])
        if filters.get("providerTypeKey"):
            where.append("provider_type_key = ?")
            params.append(filters["providerTypeKey"])
        if filters.get("providerInstanceId"):
            where.append("provider_instance_id = ?")
            params.append(filters["providerInstanceId"])
        if filters.get("status"):
            where.append("status = ?")
            params.append(filters["status"])

        newest_first = bool(filters.get("newestFirst"))
        order_direction = "DESC" if newest_first else "ASC"
        sql = """
            SELECT id, host_id, provider_type_key, provider_instance_id, email_address,
                   mailbox_ref, status, created_at, expires_at, metadata_json
            FROM mailbox_sessions
        """
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += f" ORDER BY created_at {order_direction}, id ASC"

        items = [mailbox_session_from_row(row) for row in conn.execute(sql, params)]
        limit = parse_limit(filters)
        if limit is not None:
            items = items[:limit]

        emit_json(items)
    finally:
        conn.close()


def query_observed_messages(db_path: Path, filters: dict[str, Any]) -> None:
    conn = open_db(db_path)
    try:
        where: list[str] = []
        params: list[Any] = []
        if filters.get("sessionId"):
            where.append("session_id = ?")
            params.append(filters["sessionId"])
        if filters.get("providerInstanceId"):
            where.append("provider_instance_id = ?")
            params.append(filters["providerInstanceId"])
        if filters.get("extractedCodeOnly"):
            where.append("extracted_code IS NOT NULL AND extracted_code <> ''")

        newest_first = bool(filters.get("newestFirst"))
        order_direction = "DESC" if newest_first else "ASC"
        sql = """
            SELECT id, session_id, provider_instance_id, observed_at, sender, subject,
                   html_body, text_body, extracted_code, code_source
            FROM observed_messages
        """
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += f" ORDER BY observed_at {order_direction}, id ASC"

        items = [observed_message_from_row(row) for row in conn.execute(sql, params)]
        limit = parse_limit(filters)
        if limit is not None:
            items = items[:limit]

        emit_json(items)
    finally:
        conn.close()


def emit_stats(db_path: Path) -> None:
    conn = open_db(db_path)
    try:
        stats = {
            "providerInstanceCount": row_count(conn, "provider_instances"),
            "hostBindingCount": row_count(conn, "host_bindings"),
            "credentialSetCount": row_count(conn, "credential_sets"),
            "credentialBindingCount": row_count(conn, "credential_bindings"),
            "mailboxSessionCount": row_count(conn, "mailbox_sessions"),
            "observedMessageCount": row_count(conn, "observed_messages"),
            "resolvedSessionCount": int(conn.execute("SELECT COUNT(1) FROM mailbox_sessions WHERE status = 'resolved'").fetchone()[0]),
            "extractedCodeMessageCount": int(
                conn.execute(
                    "SELECT COUNT(1) FROM observed_messages WHERE extracted_code IS NOT NULL AND extracted_code <> ''"
                ).fetchone()[0]
            ),
        }
        emit_json(stats)
    finally:
        conn.close()


def main(argv: list[str]) -> int:
    if len(argv) < 3:
        sys.stderr.write(
            "usage: sqlite_state_store.py <load|save|query|stats> <db_path> [entity] [filters_json]\n"
        )
        return 1

    command = argv[1].strip().lower()
    db_path = Path(argv[2]).expanduser()

    try:
        if command == "load":
            load_snapshot(db_path)
            return 0
        if command == "save":
            save_snapshot(db_path)
            return 0
        if command == "stats":
            emit_stats(db_path)
            return 0
        if command == "query":
            if len(argv) < 4:
                sys.stderr.write("query command requires an entity name\n")
                return 1
            entity = argv[3].strip().lower()
            filters = parse_filters(argv[4] if len(argv) > 4 else None)
            if entity == "provider_instances":
                query_provider_instances(db_path, filters)
                return 0
            if entity == "host_bindings":
                query_host_bindings(db_path, filters)
                return 0
            if entity == "mailbox_sessions":
                query_mailbox_sessions(db_path, filters)
                return 0
            if entity == "observed_messages":
                query_observed_messages(db_path, filters)
                return 0
            sys.stderr.write(f"unknown query entity: {entity}\n")
            return 1
        sys.stderr.write(f"unknown command: {command}\n")
        return 1
    except Exception as exc:
        sys.stderr.write(str(exc) + "\n")
        return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
