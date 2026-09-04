from __future__ import annotations

import json
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

from sqlite_state_rows import (
    credential_binding_from_row,
    credential_set_from_row,
    emit_json,
    encode_json,
    host_binding_from_row,
    mailbox_session_from_row,
    observed_message_from_row,
    provider_instance_from_row,
    provider_type_from_row,
    runtime_template_from_row,
    strategy_profile_from_row,
)
from sqlite_state_schema import TABLES_IN_DELETE_ORDER, has_any_state, open_db

def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()

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
