from __future__ import annotations

import sys
from pathlib import Path

from sqlite_state_queries import (
    emit_stats,
    parse_filters,
    query_host_bindings,
    query_mailbox_sessions,
    query_observed_messages,
    query_provider_instances,
)
from sqlite_state_snapshot import load_snapshot, save_snapshot

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
