from __future__ import annotations

import json
import re
import unittest
from collections import Counter
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MAPPING_PATH = ROOT / "docs" / "desktop-command-http-migration-map.json"
OPENAPI_PATH = ROOT / "docs" / "easyemail-openapi.json"
TAURI_ROOT = ROOT / "apps" / "desktop" / "src-tauri"
TAURI_LIB = TAURI_ROOT / "src" / "lib.rs"
TAURI_APP_STATE = TAURI_ROOT / "src" / "app_state.rs"
TAURI_CARGO = TAURI_ROOT / "Cargo.toml"

ALLOWED_HTTP_METHODS = {"GET", "POST", "PUT", "PATCH", "DELETE"}
ALLOWED_DISPOSITIONS = {
    "retain_host",
    "migrate_http",
    "remove_development_stub",
}
EXPECTED_HOST_ALLOWLIST = [
    "health_check",
    "desktop_core_runtime",
    "desktop_export_diagnostics",
    "desktop_credential_store",
    "desktop_credential_delete",
]
REMOVED_TAURI_BUSINESS_PATHS = (
    "migrations",
    "src/avatar.rs",
    "src/avatar",
    "src/commands",
    "src/diagnostics.rs",
    "src/domain",
    "src/easyemail",
    "src/events.rs",
    "src/imap",
    "src/services",
    "src/smtp",
    "src/storage",
    "src/time.rs",
    "src/workers",
)
FORBIDDEN_TAURI_CRATES = (
    "rusqlite",
    "imap",
    "lettre",
    "mailparse",
    "encoding_rs",
    "chrono",
    "base64",
    "url =",
)


def registered_tauri_commands(source: str) -> list[str]:
    matched = re.search(
        r"\.invoke_handler\(tauri::generate_handler!\[(.*?)\]\)\s*"
        r"\.build\(",
        source,
        re.DOTALL,
    )
    if not matched:
        raise AssertionError("missing Tauri generate_handler registration")
    return re.findall(r"(?:\w+::)+(\w+)", matched.group(1))


class DesktopCommandMigrationMapTests(unittest.TestCase):
    def setUp(self) -> None:
        self.mapping = json.loads(MAPPING_PATH.read_text(encoding="utf-8"))
        self.openapi = json.loads(OPENAPI_PATH.read_text(encoding="utf-8"))
        self.commands = self.mapping["commands"]
        self.registered = registered_tauri_commands(
            TAURI_LIB.read_text(encoding="utf-8")
        )

    def test_tauri_registers_only_the_host_and_vault_allowlist(self) -> None:
        self.assertTrue(self.mapping.get("tauriSlimmed"))
        self.assertEqual(self.mapping.get("tauriHostAllowlist"), EXPECTED_HOST_ALLOWLIST)
        self.assertEqual(self.registered, EXPECTED_HOST_ALLOWLIST)

        migrated_or_removed = {
            entry["command"]
            for entry in self.commands
            if entry["disposition"] != "retain_host"
        }
        self.assertTrue(migrated_or_removed.isdisjoint(self.registered))

    def test_tauri_has_no_mail_business_modules_or_sqlite_dependencies(self) -> None:
        for relative in REMOVED_TAURI_BUSINESS_PATHS:
            self.assertFalse(
                (TAURI_ROOT / relative).exists(),
                f"superseded Tauri business path must be removed: {relative}",
            )

        cargo_text = TAURI_CARGO.read_text(encoding="utf-8")
        for forbidden_crate in FORBIDDEN_TAURI_CRATES:
            self.assertNotIn(forbidden_crate, cargo_text)

        app_state_text = TAURI_APP_STATE.read_text(encoding="utf-8")
        self.assertNotIn("rusqlite", app_state_text)
        self.assertNotIn("easyemailam.sqlite", app_state_text)

    def test_historical_56_command_ledger_and_disposition_counts_are_preserved(self) -> None:
        mapped_names = [entry["command"] for entry in self.commands]
        self.assertEqual(len(mapped_names), 56)
        self.assertEqual(len(set(mapped_names)), 56)
        self.assertEqual(self.mapping["counts"]["registered"], 56)

        counts = Counter(entry["disposition"] for entry in self.commands)
        self.assertEqual(set(counts), ALLOWED_DISPOSITIONS)
        self.assertEqual(counts["retain_host"], self.mapping["counts"]["retainHost"])
        self.assertEqual(counts["migrate_http"], self.mapping["counts"]["migrateHttp"])
        self.assertEqual(
            counts["remove_development_stub"],
            self.mapping["counts"]["removeDevelopmentStub"],
        )
        self.assertEqual(
            {
                entry["command"]
                for entry in self.commands
                if entry["disposition"] == "retain_host"
            },
            {"health_check", "desktop_core_runtime"},
        )
        self.assertEqual(
            {
                entry["command"]
                for entry in self.commands
                if entry["disposition"] == "remove_development_stub"
            },
            {"platform_account_get_session", "platform_account_query_data"},
        )

    def test_http_migrations_use_explicit_documented_resources(self) -> None:
        capabilities = self.mapping["capabilities"]
        openapi_paths = self.openapi["paths"]

        for entry in self.commands:
            self.assertIn(entry["capability"], capabilities, entry["command"])
            self.assertRegex(entry["milestone"], r"^M\d+(?:[A-C])?$")
            target = entry["targetHttp"]
            if entry["disposition"] != "migrate_http":
                self.assertIsNone(target, entry["command"])
                continue

            self.assertIsInstance(target, dict, entry["command"])
            self.assertIn(target["method"], ALLOWED_HTTP_METHODS, entry["command"])
            self.assertTrue(target["path"].startswith("/mail/"), entry["command"])
            self.assertNotIn("/commands", target["path"], entry["command"])
            self.assertNotIn("?", target["path"], entry["command"])
            self.assertIn(target["path"], openapi_paths, entry["command"])
            self.assertIn(
                target["method"].lower(),
                openapi_paths[target["path"]],
                entry["command"],
            )

    def test_mapping_references_existing_current_implementation_paths(self) -> None:
        for capability, details in self.mapping["capabilities"].items():
            for relative_path in [*details["currentBackend"], *details["frontend"]]:
                self.assertTrue(
                    (ROOT / relative_path).exists(),
                    f"{capability}: missing {relative_path}",
                )

    def test_mapping_metadata_is_stable_and_machine_readable(self) -> None:
        self.assertEqual(self.mapping["schemaVersion"], 1)
        self.assertRegex(self.mapping["baselineCommit"], r"^[0-9a-f]{40}$")
        self.assertEqual(
            self.mapping["sourceRegistration"],
            "apps/desktop/src-tauri/src/lib.rs",
        )
        self.assertTrue(self.mapping["rules"]["genericCommandEndpointForbidden"])
        self.assertEqual(self.mapping["rules"]["httpPathPrefix"], "/mail/")


if __name__ == "__main__":
    unittest.main()
