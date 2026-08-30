from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
WORKFLOWS = ROOT / ".github" / "workflows"
COORDINATOR = WORKFLOWS / "release-easyemail.yml"


class ReleaseCoordinatorContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.coordinator = COORDINATOR.read_text(encoding="utf-8")
        cls.client = (WORKFLOWS / "publish-client-userscript.yml").read_text(encoding="utf-8")
        cls.service = (WORKFLOWS / "publish-service-base-ghcr.yml").read_text(encoding="utf-8")
        cls.cloudflare = (WORKFLOWS / "deploy-cloudflare-email.yml").read_text(encoding="utf-8")

    def test_public_tags_are_owned_only_by_the_coordinator(self) -> None:
        self.assertIn('- "v*"', self.coordinator)
        self.assertIn('- "release-*"', self.coordinator)
        self.assertNotIn('- "v*"', self.client)
        self.assertNotIn('- "release-*"', self.client)
        self.assertNotIn('- "v*"', self.service)
        self.assertNotIn('- "release-*"', self.service)
        self.assertNotIn('- "v*"', self.cloudflare)
        self.assertNotIn('- "release-*"', self.cloudflare)
        self.assertIn('- "service-base-*"', self.service)

    def test_coordinator_runs_one_preflight_and_serial_component_calls(self) -> None:
        self.assertIn("uses: ./.github/workflows/reusable-validate.yml", self.coordinator)
        self.assertIn("uses: ./.github/workflows/publish-client-userscript.yml", self.coordinator)
        self.assertIn("uses: ./.github/workflows/publish-service-base-ghcr.yml", self.coordinator)
        self.assertIn("uses: ./.github/workflows/deploy-cloudflare-email.yml", self.coordinator)
        self.assertIn("- client-userscript", self.coordinator)
        self.assertIn("- service-base", self.coordinator)
        self.assertIn("skip_preflight: true", self.coordinator)
        self.assertIn("force_publish: true", self.coordinator)
        self.assertIn("force_deploy: true", self.coordinator)

    def test_coordinator_has_release_lock_and_selectable_targets(self) -> None:
        self.assertIn("group: release-${{ inputs.release_tag || github.ref_name }}", self.coordinator)
        self.assertIn("cancel-in-progress: false", self.coordinator)
        for target in ("all", "service-base", "cloudflare-email", "client-userscript"):
            self.assertIn(f"- {target}", self.coordinator)

    def test_secret_free_client_call_does_not_inherit_production_secrets(self) -> None:
        client_section, service_section = self.coordinator.split("  service-base:", maxsplit=1)
        self.assertNotIn("secrets: inherit", client_section)
        self.assertIn("secrets: inherit", service_section)

    def test_each_component_keeps_a_direct_preflight(self) -> None:
        for workflow in (self.client, self.service, self.cloudflare):
            self.assertIn("uses: ./.github/workflows/reusable-validate.yml", workflow)
            self.assertIn("if: ${{ !inputs.skip_preflight }}", workflow)


if __name__ == "__main__":
    unittest.main()
