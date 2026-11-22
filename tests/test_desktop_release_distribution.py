from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DESKTOP_DIST_SCRIPT = ROOT / "scripts" / "build-desktop-distribution.py"
SBOM_SCRIPT = ROOT / "scripts" / "generate-desktop-sbom-and-notices.py"
DESKTOP_WORKFLOW = ROOT / ".github" / "workflows" / "publish-desktop-release.yml"
LIVE_WORKFLOW = ROOT / ".github" / "workflows" / "validate-desktop-controlled-live.yml"
CANDIDATE_WORKFLOW = ROOT / ".github" / "workflows" / "build-desktop-candidate.yml"
DESKTOP_TEMPLATE = ROOT / ".github" / "release-notes" / "desktop-ui.md.tmpl"


def load_python_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise AssertionError(f"Unable to load {path}")
    sys.path.insert(0, str(ROOT / "scripts"))
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class DesktopReleaseDistributionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.dist_mod = load_python_module("desktop_dist_mod", DESKTOP_DIST_SCRIPT)
        cls.sbom_mod = load_python_module("desktop_sbom_mod_for_dist", SBOM_SCRIPT)
        cls.desktop_workflow = DESKTOP_WORKFLOW.read_text(encoding="utf-8")
        cls.live_workflow = LIVE_WORKFLOW.read_text(encoding="utf-8")
        cls.candidate_workflow = CANDIDATE_WORKFLOW.read_text(encoding="utf-8")

    def _prepare_mock_inputs(self, tmp_root: Path) -> tuple[Path, Path, Path, Path, Path]:
        msi_path = tmp_root / "NMail_0.1.0_x64.msi"
        msi_path.write_bytes(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"\x00" * 128)

        nsis_path = tmp_root / "NMail_0.1.0_x64-setup.exe"
        nsis_path.write_bytes(b"MZ" + b"\x90" * 128)

        portable_zip = tmp_root / "EasyEmail-Desktop_0.1.0_x64-portable.zip"
        with zipfile.ZipFile(portable_zip, "w") as zf:
            zf.writestr("EasyEmail-Desktop_0.1.0_x64-portable/EasyEmail.exe", b"MZ-exe")
            zf.writestr(
                "EasyEmail-Desktop_0.1.0_x64-portable/core/runtime-manifest.json",
                '{"schemaVersion":1}',
            )

        mock_repo = tmp_root / "repo"
        desktop_dir = mock_repo / "apps" / "desktop"
        core_dir = desktop_dir / "src-tauri" / "resources" / "core"
        (core_dir / "dist" / "src" / "runtime").mkdir(parents=True)
        (core_dir / "node.exe").write_bytes(b"MZ-node")
        (core_dir / "dist" / "src" / "runtime" / "main.js").write_text("export {};\n", encoding="utf-8")
        (core_dir / "runtime-manifest.json").write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "component": "easyemail-service-base-desktop-core",
                    "sourceRevision": "deadbeef",
                    "nodeVersion": "v22.22.2",
                    "platform": "win32",
                    "architecture": "x64",
                    "entry": "dist/src/runtime/main.js",
                    "runtime": "node.exe",
                }
            ),
            encoding="utf-8",
        )
        (desktop_dir / "package.json").write_text(
            json.dumps({"name": "easyemailam", "version": "0.1.0"}),
            encoding="utf-8",
        )
        (desktop_dir / "SOURCE_SNAPSHOT.json").write_text(
            json.dumps({"sourceProject": "EasyEmailAM", "sourceCommit": "34838bc", "copiedFileCount": 182}),
            encoding="utf-8",
        )
        (desktop_dir / "SOURCE_SNAPSHOT_FILES.sha256").write_text(
            "0" * 64 + "  src/App.tsx\n",
            encoding="utf-8",
        )

        sbom_dir = tmp_root / "sbom"
        sbom_dir.mkdir(parents=True)
        (sbom_dir / "easy-email-desktop-sbom.cdx.json").write_text(
            json.dumps(
                {
                    "bomFormat": "CycloneDX",
                    "specVersion": "1.5",
                    "version": 1,
                    "components": [
                        {
                            "type": "application",
                            "name": "EasyEmailAM",
                            "version": "34838bc",
                            "licenses": [{"license": {"name": "First-Party-EasyEmail-Project"}}],
                            "properties": [{"name": "easyemail:ecosystem", "value": "first-party-import"}],
                        },
                        {
                            "type": "application",
                            "name": "nodejs",
                            "version": "22.22.2",
                            "licenses": [{"license": {"name": "MIT"}}],
                            "properties": [{"name": "easyemail:ecosystem", "value": "nodejs-runtime"}],
                        },
                        {
                            "type": "library",
                            "name": "yaml",
                            "version": "2.8.1",
                            "licenses": [{"license": {"name": "ISC"}}],
                            "properties": [{"name": "easyemail:ecosystem", "value": "npm"}],
                        },
                        {
                            "type": "library",
                            "name": "dompurify",
                            "version": "3.4.13",
                            "licenses": [{"license": {"name": "Apache-2.0"}}],
                            "properties": [{"name": "easyemail:ecosystem", "value": "npm"}],
                        },
                        {
                            "type": "library",
                            "name": "serde",
                            "version": "1.0.219",
                            "licenses": [{"license": {"name": "MIT OR Apache-2.0"}}],
                            "properties": [{"name": "easyemail:ecosystem", "value": "cargo"}],
                        },
                    ],
                }
            ),
            encoding="utf-8",
        )
        (sbom_dir / "THIRD_PARTY_NOTICES.txt").write_text(
            "\n".join(
                [
                    "1. Bundled Private Node.js Runtime",
                    "2. Service Core Production npm Packages",
                    "3. Desktop Renderer Production npm Packages",
                    "4. Tauri Host Rust Crates",
                ]
            )
            + "\n",
            encoding="utf-8",
        )
        return msi_path, nsis_path, portable_zip, sbom_dir, mock_repo

    def test_unsigned_distribution_is_rejected_when_release_eligibility_is_required(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_root = Path(tmp)
            msi, nsis, portable_zip, sbom_dir, mock_repo = self._prepare_mock_inputs(tmp_root)
            unsigned_out = tmp_root / "dist-unsigned"
            manifest = self.dist_mod.build_desktop_distribution(
                unsigned_out,
                release_tag="desktop-20261122-001",
                msi_source=msi,
                nsis_source=nsis,
                portable_zip_source=portable_zip,
                sbom_dir=sbom_dir,
                repo_root=mock_repo,
                require_release_eligible=False,
            )
            self.assertFalse(manifest["releaseEligible"])
            self.assertEqual(manifest["signing"]["status"], "unsigned")

            with self.assertRaisesRegex(ValueError, "releaseEligible=false"):
                self.dist_mod.verify_desktop_distribution(
                    unsigned_out,
                    require_release_eligible=True,
                )

    def test_signed_distribution_verifies_and_renders_release_notes_cleanly(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_root = Path(tmp)
            msi, nsis, portable_zip, sbom_dir, mock_repo = self._prepare_mock_inputs(tmp_root)
            signing_report = tmp_root / "signing-report.json"
            signing_report.write_text(
                json.dumps(
                    {
                        "schemaVersion": 1,
                        "verified": True,
                        "artifacts": [
                            {
                                "file": "easyemailam.exe",
                                "status": "Valid",
                                "signerSubject": "CN=EasyEmail Release",
                                "certificateThumbprint": "AABBCCDDEEFF00112233445566778899AABBCCDD",
                                "hasTimestamp": True,
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )
            signed_out = tmp_root / "dist-signed"
            manifest = self.dist_mod.build_desktop_distribution(
                signed_out,
                release_tag="v1.0.0",
                msi_source=msi,
                nsis_source=nsis,
                portable_zip_source=portable_zip,
                sbom_dir=sbom_dir,
                signing_report_path=signing_report,
                repo_root=mock_repo,
                require_release_eligible=True,
            )
            self.assertTrue(manifest["releaseEligible"])
            self.assertEqual(manifest["signing"]["status"], "verified")

            # Ensure Client/Userscript contamination fails closed
            contaminant = signed_out / "easy-email-userscript-v1.0.0.user.js"
            contaminant.write_text("// ==UserScript==", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "Client/Userscript artifact"):
                self.dist_mod.verify_desktop_distribution(signed_out, require_release_eligible=True)
            contaminant.unlink()

            rendered_notes = tmp_root / "desktop-notes.md"
            completed = subprocess.run(
                [
                    sys.executable,
                    str(ROOT / "scripts" / "render-release-template.py"),
                    "--template",
                    str(DESKTOP_TEMPLATE),
                    "--context",
                    str(signed_out / "easy-email-desktop-release-manifest.json"),
                    "--output",
                    str(rendered_notes),
                ],
                cwd=ROOT,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            notes_text = rendered_notes.read_text(encoding="utf-8")
            self.assertIn("## EasyEmail Desktop (NMail)", notes_text)
            self.assertIn("EasyEmail-Desktop-v1.0.0-x64.msi", notes_text)
            self.assertIn("SHA256SUMS-desktop.txt", notes_text)

    def test_desktop_workflows_isolate_signing_live_secrets_and_candidate_readonly(self) -> None:
        self.assertIn("environment: easyemail-desktop-signing", self.desktop_workflow)
        self.assertIn("environment: easyemail-desktop-production", self.desktop_workflow)
        self.assertIn("--require-release-eligible", self.desktop_workflow)
        self.assertIn("actions/attest-build-provenance@v3", self.desktop_workflow)
        self.assertNotIn("pull_request:", self.desktop_workflow)

        # Publish job must never receive code-signing PFX secrets
        _, publish_section = self.desktop_workflow.split("  publish:", maxsplit=1)
        self.assertNotIn("WINDOWS_CODESIGN_", publish_section)

        self.assertIn("environment: easyemail-desktop-live-validation", self.live_workflow)
        self.assertNotIn("pull_request:", self.live_workflow)
        self.assertNotIn("push:", self.live_workflow)
        self.assertIn("permissions:\n  contents: read", self.live_workflow)

        self.assertIn("permissions:\n  contents: read", self.candidate_workflow)
        self.assertNotIn("secrets.", self.candidate_workflow)


if __name__ == "__main__":
    unittest.main()
