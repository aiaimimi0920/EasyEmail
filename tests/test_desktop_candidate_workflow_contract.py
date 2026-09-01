from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github" / "workflows" / "build-desktop-candidate.yml"


class DesktopCandidateWorkflowContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.text = WORKFLOW.read_text(encoding="utf-8")

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
            "npm run host:smoke -- -ExecutablePath "
            "src-tauri/target/release/easyemailam.exe",
            self.text,
        )
        self.assertIn("Get-FileHash", self.text)
        self.assertIn("SHA256SUMS", self.text)

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
