from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
QUICK_DEPLOY = ROOT / "scripts" / "quick-deploy-cloudflare-mail.ps1"


class CloudflareDryRunContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.text = QUICK_DEPLOY.read_text(encoding="utf-8")

    def test_dry_run_disables_all_routing_synchronization(self) -> None:
        self.assertIn(
            "$syncRouting = -not $NoRoutingSync -and -not $DryRun -and",
            self.text,
        )
        self.assertIn("if ($syncRouting) {", self.text)

    def test_dry_run_explains_the_safety_override(self) -> None:
        self.assertIn("if ($DryRun -and -not $NoRoutingSync)", self.text)
        self.assertIn("no routing state is mutated", self.text)

    def test_sending_only_mode_is_forwarded_when_resource_bootstrap_is_disabled(self) -> None:
        self.assertIn("if ($SendingDomainsOnly)", self.text)
        self.assertIn("$args += '--sending-domains-only'", self.text)
        self.assertIn("-SendingDomainsOnly:(-not $bootstrapEnabled)", self.text)


if __name__ == "__main__":
    unittest.main()
