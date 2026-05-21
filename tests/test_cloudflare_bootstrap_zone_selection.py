from __future__ import annotations

import importlib.util
import sys
import unittest
from unittest import mock
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


def load_module(name: str, relative_path: str):
    path = REPO_ROOT / relative_path
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


BOOTSTRAP = load_module(
    "bootstrap_cloudflare_mail",
    "deploy/upstreams/cloudflare_temp_email/scripts/bootstrap_cloudflare_mail.py",
)
TEARDOWN = load_module(
    "teardown_cloudflare_mail",
    "deploy/upstreams/cloudflare_temp_email/scripts/teardown_cloudflare_mail.py",
)


class CloudflareZoneSelectionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.config = {
            "cloudflareMail": {
                "publicDomain": "mail.aiaimimi.com",
                "publicZone": "aiaimimi.com",
                "bootstrap": {
                    "zones": ["example.com"],
                },
                "routing": {
                    "plan": {
                        "domains": [
                            "mail.aiaimimi.com",
                            "aiaiai.cc.cd",
                            "*.aiaiai.cc.cd",
                        ]
                    }
                },
            }
        }

    def assert_zone_selection(self, module) -> None:
        desired = module.collect_desired_zones(self.config)
        self.assertIn("aiaimimi.com", desired)
        self.assertIn("aiaiai.cc.cd", desired)
        self.assertNotIn("mail.aiaimimi.com", desired)
        self.assertNotIn("example.com", desired)

    def test_bootstrap_collect_desired_zones_prefers_real_root_zones(self) -> None:
        self.assert_zone_selection(BOOTSTRAP)

    def test_teardown_collect_desired_zones_prefers_real_root_zones(self) -> None:
        self.assert_zone_selection(TEARDOWN)

    def test_bootstrap_ensure_d1_database_skips_wrangler_when_real_id_already_exists(self) -> None:
        config = {
            "cloudflareMail": {
                "bootstrap": {
                    "enabled": False,
                },
                "worker": {
                    "d1_databases": [
                        {
                            "binding": "DB",
                            "database_name": "cloudflare-temp-email",
                            "database_id": "6208adc3-5b07-4a60-9efa-613d3ca1580d",
                        }
                    ]
                },
            }
        }

        with mock.patch.object(
            BOOTSTRAP,
            "run_wrangler_json",
            side_effect=AssertionError("run_wrangler_json should not be called"),
        ):
            result = BOOTSTRAP.ensure_d1_database(
                config,
                wrangler_command="wrangler",
                worker_dir=REPO_ROOT,
                env={},
                dry_run=False,
            )

        self.assertEqual(result["databaseId"], "6208adc3-5b07-4a60-9efa-613d3ca1580d")
        self.assertFalse(result["changed"])
        self.assertFalse(result["created"])


if __name__ == "__main__":
    unittest.main()
