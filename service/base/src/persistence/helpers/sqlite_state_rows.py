from __future__ import annotations

import json
import sqlite3
import sys
from typing import Any

def encode_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False)


def emit_json(value: Any) -> None:
    sys.stdout.write(encode_json(value))


def decode_json(value: str | None, fallback: Any) -> Any:
    if value is None or value == "":
        return fallback
    return json.loads(value)

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
