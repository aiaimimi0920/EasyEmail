from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github" / "workflows" / "build-desktop-candidate.yml"
DESKTOP_PACKAGE = ROOT / "apps" / "desktop" / "package.json"
PORTABLE_SCRIPT = ROOT / "apps" / "desktop" / "scripts" / "build-portable.ps1"
STARTUP_SMOKE_SCRIPT = (
    ROOT / "apps" / "desktop" / "scripts" / "verify-desktop-startup-responsiveness.ps1"
)
DELAYED_CORE_FIXTURE = ROOT / "apps" / "desktop" / "scripts" / "fixtures" / "delayed-core.mjs"


class DesktopCandidateWorkflowContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.text = WORKFLOW.read_text(encoding="utf-8")
        cls.package_text = DESKTOP_PACKAGE.read_text(encoding="utf-8")
        cls.portable_text = PORTABLE_SCRIPT.read_text(encoding="utf-8")
        cls.startup_smoke_text = STARTUP_SMOKE_SCRIPT.read_text(encoding="utf-8")

    def test_candidate_is_manual_windows_only_and_read_only(self) -> None:
        self.assertIn("workflow_dispatch:", self.text)
        self.assertNotIn("pull_request:", self.text)
        self.assertNotIn("push:", self.text)
        self.assertIn("runs-on: windows-latest", self.text)
        self.assertIn("permissions:\n  contents: read", self.text)

    def test_candidate_builds_and_proves_the_bundled_runtime(self) -> None:
        self.assertGreaterEqual(self.text.count("run: npm ci"), 2)
        self.assertIn("run: npm run verify", self.text)
        self.assertIn(
            "npm run tauri -- build --ci --no-sign --bundles msi nsis",
            self.text,
        )
        self.assertIn(
            "run: npm run portable:bundle",
            self.text,
        )
        self.assertIn(
            "npm run host:smoke -- -ExecutablePath $portableExecutables[0].FullName",
            self.text,
        )
        self.assertIn(
            "npm run host:startup-smoke -- -ExecutablePath $portableExecutables[0].FullName",
            self.text,
        )
        self.assertIn("portableArchive = $portableArchives[0].Name", self.text)
        self.assertIn("Get-FileHash", self.text)
        self.assertIn("SHA256SUMS", self.text)

    def test_portable_bundle_contains_the_host_and_private_core(self) -> None:
        self.assertIn('"portable:bundle"', self.package_text)
        self.assertIn('"portable:build"', self.package_text)
        for expected in (
            "target/release/easyemailam.exe",
            "src-tauri/resources/core",
            "EasyEmail.exe",
            "core/runtime-manifest.json",
            "Run-EasyEmail-Portable.cmd",
            "EASYEMAILAM_DATA_DIR=%~dp0data",
            "portable-manifest.json",
            "desktop-portable-candidate",
            "releaseEligible = $false",
            "[System.Security.Cryptography.SHA256]::Create()",
            "CreateFromDirectory",
            "PORTABLE_SHA256",
        ):
            self.assertIn(expected, self.portable_text)

    def test_candidate_proves_the_window_stays_interactive_during_core_startup(self) -> None:
        self.assertIn('"host:startup-smoke"', self.package_text)
        self.assertTrue(DELAYED_CORE_FIXTURE.is_file())
        for expected in (
            "EASY_EMAIL_DESKTOP_CORE_ENTRY",
            "SendMessageTimeout",
            "WINDOW_RESPONSIVE_BEFORE_CORE_READY=True",
            "CORE_LISTENER_BEFORE_CLOSE=False",
            "CloseMainWindow",
            "CORE_EXITED_WITH_UI",
        ):
            self.assertIn(expected, self.startup_smoke_text)

    def test_candidate_cannot_be_mistaken_for_a_public_release(self) -> None:
        self.assertIn("artifactKind = 'desktop-migration-candidate'", self.text)
        self.assertIn("releaseEligible = $false", self.text)
        self.assertIn("actions/upload-artifact@v4", self.text)
        for forbidden in (
            "softprops/action-gh-release",
            "gh release create",
            "contents: write",
            "packages: write",
            "id-token: write",
            "secrets: inherit",
            "${{ secrets.",
        ):
            self.assertNotIn(forbidden, self.text)


if __name__ == "__main__":
    unittest.main()
