from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
VALIDATE_WORKFLOW = ROOT / ".github" / "workflows" / "validate.yml"
REUSABLE_WORKFLOW = ROOT / ".github" / "workflows" / "reusable-validate.yml"


class ValidateWorkflowContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.validate_text = VALIDATE_WORKFLOW.read_text(encoding="utf-8")
        cls.reusable_text = REUSABLE_WORKFLOW.read_text(encoding="utf-8")

    def test_trigger_workflow_delegates_to_reusable_validation(self) -> None:
        self.assertIn("workflow_dispatch:", self.validate_text)
        self.assertIn("contents: read", self.validate_text)
        self.assertIn(
            "uses: ./.github/workflows/reusable-validate.yml",
            self.validate_text,
        )
        self.assertNotIn("runs-on:", self.validate_text)

    def test_reusable_validation_has_no_production_secret_channel(self) -> None:
        self.assertIn("workflow_call:", self.reusable_text)
        self.assertIn("contents: read", self.reusable_text)
        self.assertNotIn("${{ secrets.", self.reusable_text)
        self.assertNotIn("secrets: inherit", self.reusable_text)

    def test_reusable_validation_runs_repository_and_release_gates(self) -> None:
        self.assertIn("./scripts/test-all.ps1", self.reusable_text)
        self.assertIn(
            "python scripts/validate-release-contract.py",
            self.reusable_text,
        )
        self.assertIn("git diff --check", self.reusable_text)
        self.assertIn("git diff --exit-code", self.reusable_text)


if __name__ == "__main__":
    unittest.main()
