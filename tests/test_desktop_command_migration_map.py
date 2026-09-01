from __future__ import annotations

import json
import re
import unittest
from collections import Counter
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MAPPING_PATH = ROOT / "docs" / "desktop-command-http-migration-map.json"
TAURI_LIB = ROOT / "apps" / "desktop" / "src-tauri" / "src" / "lib.rs"

ALLOWED_HTTP_METHODS = {"GET", "POST", "PUT", "PATCH", "DELETE"}
ALLOWED_DISPOSITIONS = {
    "retain_host",
    "migrate_http",
    "remove_development_stub",
}


def registered_tauri_commands(source: str) -> list[str]:
    matched = re.search(
        r"\.invoke_handler\(tauri::generate_handler!\[(.*?)\]\)\s*"
        r"\.build\(",
        source,
        re.DOTALL,
    )
    if not matched:
        raise AssertionError("missing Tauri generate_handler registration")
    return re.findall(r"(?:commands|core_runtime)::(\w+)", matched.group(1))


class DesktopCommandMigrationMapTests(unittest.TestCase):
    def setUp(self) -> None:
        self.mapping = json.loads(MAPPING_PATH.read_text(encoding="utf-8"))
        self.commands = self.mapping["commands"]
        self.registered = registered_tauri_commands(
            TAURI_LIB.read_text(encoding="utf-8")
        )

    def test_mapping_covers_every_registered_command_exactly_once(self) -> None:
        mapped_names = [entry["command"] for entry in self.commands]

        self.assertEqual(len(self.registered), 56)
        self.assertEqual(len(set(self.registered)), len(self.registered))
        self.assertEqual(len(set(mapped_names)), len(mapped_names))
        self.assertEqual(set(mapped_names), set(self.registered))
        self.assertEqual(self.mapping["counts"]["registered"], len(self.registered))

    def test_disposition_counts_and_owners_are_explicit(self) -> None:
        counts = Counter(entry["disposition"] for entry in self.commands)

        self.assertEqual(set(counts), ALLOWED_DISPOSITIONS)
        self.assertEqual(counts["retain_host"], self.mapping["counts"]["retainHost"])
        self.assertEqual(
            counts["migrate_http"], self.mapping["counts"]["migrateHttp"]
        )
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

    def test_http_migrations_use_explicit_version_one_resources(self) -> None:
        capabilities = self.mapping["capabilities"]

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
