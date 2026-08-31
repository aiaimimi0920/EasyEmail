from __future__ import annotations

import os
import subprocess
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github" / "workflows" / "publish-client-userscript.yml"


class DistributionWorkflowContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.text = WORKFLOW.read_text(encoding="utf-8")

    def test_pipeline_has_preflight_build_publish_and_evidence_gates(self) -> None:
        self.assertIn("uses: ./.github/workflows/reusable-validate.yml", self.text)
        self.assertIn(
            "always() && needs.metadata.result == 'success' && needs.build.result == 'success'",
            self.text,
        )
        self.assertIn("--verify-only", self.text)
        self.assertIn("actions/attest-build-provenance", self.text)
        self.assertIn("easy-email-client-userscript-release-evidence", self.text)

    def test_distribution_workflow_has_no_production_secret_channel(self) -> None:
        self.assertNotIn("secrets.", self.text)
        self.assertIn("GH_TOKEN: ${{ github.token }}", self.text)

    def test_manual_input_is_passed_through_environment_not_shell_interpolation(self) -> None:
        self.assertIn("INPUT_RELEASE_TAG: ${{ inputs.release_tag }}", self.text)
        self.assertIn('release_tag="${INPUT_RELEASE_TAG}"', self.text)
        self.assertNotIn("release_tag='${{ inputs.release_tag }}'", self.text)

    def test_component_workflows_are_reusable_and_use_component_locks(self) -> None:
        self.assertIn("workflow_call:", self.text)
        self.assertIn("group: client-userscript-${{ inputs.release_tag || github.ref_name }}", self.text)
        self.assertIn("cancel-in-progress: false", self.text)
        self.assertIn("environment: easyemail-public-release", self.text)

        service_workflow = (WORKFLOW.parent / "publish-service-base-ghcr.yml").read_text(encoding="utf-8")
        cloudflare_workflow = (WORKFLOW.parent / "deploy-cloudflare-email.yml").read_text(encoding="utf-8")
        self.assertIn("workflow_call:", service_workflow)
        self.assertIn("workflow_call:", cloudflare_workflow)
        self.assertIn("group: service-base-${{ inputs.release_tag || inputs.version || github.ref_name }}", service_workflow)
        self.assertIn("group: cloudflare-email-${{ inputs.release_tag || github.ref_name }}", cloudflare_workflow)
        self.assertIn("environment: easyemail-service-production", service_workflow)
        self.assertIn("easyemail-cloudflare-production", cloudflare_workflow)

    def test_version_output_is_the_normalized_userscript_version(self) -> None:
        self.assertIn("PYTHONPATH: ${{ github.workspace }}/scripts", self.text)
        self.assertIn("from userscript_release import userscript_version", self.text)
        self.assertIn('echo "version=${version}"', self.text)

    def test_workflow_pythonpath_resolves_userscript_release_from_repository_root(self) -> None:
        environment = os.environ.copy()
        environment["PYTHONPATH"] = str(ROOT / "scripts")
        environment["RELEASE_TAG"] = "release-20260830-001"
        completed = subprocess.run(
            [
                sys.executable,
                "-c",
                (
                    "import os; "
                    "from userscript_release import userscript_version; "
                    'print(userscript_version(os.environ["RELEASE_TAG"]))'
                ),
            ],
            cwd=ROOT,
            env=environment,
            check=False,
            capture_output=True,
            text=True,
        )

        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(completed.stdout.strip(), "20260830.001")


if __name__ == "__main__":
    unittest.main()
