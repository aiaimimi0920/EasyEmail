from __future__ import annotations

import importlib.util
import io
import sys
import unittest
from contextlib import redirect_stdout
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

    def test_sending_only_bootstrap_skips_unrelated_zone_and_d1_bootstrap(self) -> None:
        config = {
            "cloudflareMail": {
                "publicDomain": "mail.example.com",
                "publicZone": "example.com",
                "bootstrap": {"enabled": False, "accountId": "account-id"},
                "routing": {"plan": {"domains": ["missing-routing.example.net"]}},
                "sending": {"domains": ["send.example.com"]},
            }
        }
        sending_result = {
            "desired": ["send.example.com"],
            "existing": ["send.example.com"],
            "created": [],
            "wouldCreate": [],
            "unresolved": [],
        }
        argv = [
            "bootstrap_cloudflare_mail.py",
            "--config",
            str(REPO_ROOT / "config.yaml"),
            "--worker-dir",
            str(REPO_ROOT),
            "--wrangler-command",
            str(REPO_ROOT / "wrangler"),
            "--sending-domains-only",
            "--dry-run",
        ]

        with (
            mock.patch.object(sys, "argv", argv),
            mock.patch.object(BOOTSTRAP, "load_yaml_file", return_value=config),
            mock.patch.object(BOOTSTRAP, "get_auth_config", return_value=({}, {})),
            mock.patch.object(
                BOOTSTRAP,
                "fetch_all_zones",
                return_value=[{"id": "zone-id", "name": "example.com", "status": "active"}],
            ),
            mock.patch.object(BOOTSTRAP, "ensure_sending_subdomains", return_value=sending_result) as ensure_sending,
            mock.patch.object(BOOTSTRAP, "ensure_zones") as ensure_zones,
            mock.patch.object(BOOTSTRAP, "ensure_d1_database") as ensure_d1,
            redirect_stdout(io.StringIO()),
        ):
            self.assertEqual(BOOTSTRAP.main(), 0)

        ensure_sending.assert_called_once()
        self.assertTrue(ensure_sending.call_args.kwargs["dry_run"])
        ensure_zones.assert_not_called()
        ensure_d1.assert_not_called()

    def test_full_bootstrap_still_requires_routing_zones(self) -> None:
        with mock.patch.object(
            BOOTSTRAP,
            "fetch_all_zones",
            return_value=[{"id": "zone-id", "name": "aiaimimi.com", "status": "active"}],
        ):
            result = BOOTSTRAP.ensure_zones(
                self.config,
                headers={},
                account_id="account-id",
                create_missing=False,
                dry_run=True,
            )

        self.assertIn("aiaiai.cc.cd", result["missing"])


if __name__ == "__main__":
    unittest.main()
