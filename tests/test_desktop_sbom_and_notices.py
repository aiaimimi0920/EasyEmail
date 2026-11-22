from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SBOM_SCRIPT = ROOT / "scripts" / "generate-desktop-sbom-and-notices.py"


def load_sbom_module():
    spec = importlib.util.spec_from_file_location("desktop_sbom_test_mod", SBOM_SCRIPT)
    if spec is None or spec.loader is None:
        raise AssertionError(f"Unable to load {SBOM_SCRIPT}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class DesktopSbomAndNoticesTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.mod = load_sbom_module()

    def test_license_policy_blocks_missing_and_copyleft_expressions(self) -> None:
        for allowed in (
            "MIT",
            "Apache-2.0 OR MIT",
            "(MIT OR Apache-2.0) AND Unicode-3.0",
            "BSD-3-Clause",
            "ISC",
        ):
            self.assertEqual(
                self.mod.validate_license_expression("pkg:test@1.0.0", allowed),
                allowed,
            )

        for blocked in (
            None,
            "",
            "UNKNOWN",
            "UNLICENSED",
            "GPL-3.0-only",
            "AGPL-3.0-or-later",
            "SSPL-1.0",
            "BUSL-1.1",
            "MIT AND GPL-2.0-only",
        ):
            with self.assertRaises(ValueError, msg=f"Expected blocker for {blocked!r}"):
                self.mod.validate_license_expression("pkg:bad@1.0.0", blocked)

    def test_npm_and_cargo_collectors_fail_closed_on_missing_or_incompatible_license(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_root = Path(tmp)
            bad_lock = tmp_root / "package-lock.json"
            bad_lock.write_text(
                json.dumps(
                    {
                        "lockfileVersion": 3,
                        "packages": {
                            "": {"name": "demo", "version": "1.0.0"},
                            "node_modules/copyleft-pkg": {
                                "version": "2.0.0",
                                "license": "AGPL-3.0-only",
                            },
                        },
                    }
                ),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, "Incompatible or restricted license"):
                self.mod.collect_npm_runtime_components(bad_lock, "test-scope")

            missing_cargo = tmp_root / "cargo-meta.json"
            missing_cargo.write_text(
                json.dumps(
                    {
                        "workspace_members": [],
                        "packages": [
                            {
                                "id": "unlicensed-crate 0.1.0",
                                "name": "unlicensed-crate",
                                "version": "0.1.0",
                                "license": None,
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, "Missing or ambiguous license"):
                self.mod.collect_cargo_components(
                    ROOT / "apps" / "desktop" / "src-tauri" / "Cargo.toml",
                    missing_cargo,
                )

    def test_generates_and_verifies_cyclonedx_sbom_and_notices_from_real_workspace(self) -> None:
        core_dir = ROOT / "apps" / "desktop" / "src-tauri" / "resources" / "core"
        with tempfile.TemporaryDirectory() as tmp:
            tmp_root = Path(tmp)
            if not (core_dir / "runtime-manifest.json").is_file():
                core_dir = tmp_root / "mock-core"
                core_dir.mkdir(parents=True)
                (core_dir / "node.exe").write_bytes(b"MZ-mock-node-runtime")
                (core_dir / "dist" / "src" / "runtime").mkdir(parents=True)
                (core_dir / "dist" / "src" / "runtime" / "main.js").write_text(
                    "console.log('ready');\n",
                    encoding="utf-8",
                )
                (core_dir / "runtime-manifest.json").write_text(
                    json.dumps(
                        {
                            "schemaVersion": 1,
                            "component": "easyemail-service-base-desktop-core",
                            "sourceRevision": "abc1234",
                            "nodeVersion": "v22.22.2",
                            "platform": "win32",
                            "architecture": "x64",
                            "entry": "dist/src/runtime/main.js",
                            "runtime": "node.exe",
                        }
                    ),
                    encoding="utf-8",
                )

            out_dir = tmp_root / "sbom-out"
            sbom_path, notices_path = self.mod.build_sbom_and_notices(
                out_dir,
                repo_root=ROOT,
                core_dir=core_dir,
                git_commit="0123456789abcdef0123456789abcdef01234567",
            )
            self.assertTrue(sbom_path.is_file())
            self.assertTrue(notices_path.is_file())

            verified = self.mod.verify_sbom_and_notices(out_dir)
            self.assertEqual(verified["bomFormat"], "CycloneDX")
            self.assertGreater(len(verified["components"]), 50)


if __name__ == "__main__":
    unittest.main()
