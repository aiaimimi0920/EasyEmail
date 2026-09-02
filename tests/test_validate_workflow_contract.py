from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
VALIDATE_WORKFLOW = ROOT / ".github" / "workflows" / "validate.yml"
REUSABLE_WORKFLOW = ROOT / ".github" / "workflows" / "reusable-validate.yml"
CLOUDFLARE_WORKFLOW = ROOT / ".github" / "workflows" / "deploy-cloudflare-email.yml"
TEST_ALL = ROOT / "scripts" / "test-all.ps1"
NODE_VERSION = ROOT / ".nvmrc"


class ValidateWorkflowContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.validate_text = VALIDATE_WORKFLOW.read_text(encoding="utf-8")
        cls.reusable_text = REUSABLE_WORKFLOW.read_text(encoding="utf-8")
        cls.cloudflare_text = CLOUDFLARE_WORKFLOW.read_text(encoding="utf-8")
        cls.test_all_text = TEST_ALL.read_text(encoding="utf-8")
        cls.node_version = NODE_VERSION.read_text(encoding="utf-8").strip()

    def test_trigger_workflow_delegates_to_reusable_validation(self) -> None:
        self.assertIn("workflow_dispatch:", self.validate_text)
        self.assertIn("contents: read", self.validate_text)
        self.assertIn(
            "uses: ./.github/workflows/reusable-validate.yml",
            self.validate_text,
        )
        self.assertNotIn("runs-on:", self.validate_text)

    def test_node_and_corepack_versions_cover_the_pnpm_toolchain(self) -> None:
        self.assertEqual(self.node_version, "22.22.2")
        self.assertIn("[Version]'22.22.2'", self.test_all_text)
        for workflow in (self.reusable_text, self.cloudflare_text):
            self.assertIn("npm install --global corepack@0.34.6", workflow)
            self.assertIn("corepack enable", workflow)

    def test_reusable_validation_has_no_production_secret_channel(self) -> None:
        self.assertIn("workflow_call:", self.reusable_text)
        self.assertIn("contents: read", self.reusable_text)
        self.assertNotIn("${{ secrets.", self.reusable_text)
        self.assertNotIn("secrets: inherit", self.reusable_text)

    def test_reusable_validation_runs_repository_and_release_gates(self) -> None:
        self.assertIn(
            "python -m pip install --disable-pip-version-check pyyaml",
            self.reusable_text,
        )
        self.assertIn("./scripts/test-all.ps1", self.reusable_text)
        self.assertIn(
            "python scripts/validate-release-contract.py",
            self.reusable_text,
        )
        self.assertIn("git diff --check", self.reusable_text)
        self.assertIn("git diff --exit-code", self.reusable_text)

    def test_reusable_validation_installs_and_runs_desktop_gate(self) -> None:
        self.assertIn("working-directory: apps/desktop", self.reusable_text)
        self.assertIn("rustc --version", self.reusable_text)
        self.assertIn("$desktopDir = Join-Path $repoRoot 'apps/desktop'", self.test_all_text)
        self.assertIn(
            "Validating imported desktop migration baseline",
            self.test_all_text,
        )
        self.assertIn("Invoke-InDirectory $desktopDir { & npm run verify }", self.test_all_text)


if __name__ == "__main__":
    unittest.main()
