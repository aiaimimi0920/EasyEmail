from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from sqlite_state_rows import (
    emit_json,
    host_binding_from_row,
    mailbox_session_from_row,
    observed_message_from_row,
    provider_instance_from_row,
)
from sqlite_state_schema import open_db, row_count

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
