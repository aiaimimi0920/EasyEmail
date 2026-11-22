from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import sys
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "materialize-action-config.py"


def load_module():
    spec = importlib.util.spec_from_file_location("materialize_action_config", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


MATERIALIZE = load_module()
SECRET_NAME = "EASYEMAIL_TEST_LIST_SECRET"


class MaterializeActionConfigTests(unittest.TestCase):
    def test_workflows_forward_temporam_secrets_to_the_config_step(self) -> None:
        for name in ("publish-service-base-ghcr.yml", "deploy-cloudflare-email.yml"):
            with self.subTest(workflow=name):
                workflow = MATERIALIZE.yaml.safe_load((ROOT / ".github" / "workflows" / name).read_text(encoding="utf-8"))
                environments = [
                    step["env"] for job in workflow["jobs"].values() for step in job.get("steps", [])
                    if "EASYEMAIL_SERVICE_RUNTIME_API_KEY" in step.get("env", {})
                ]
                self.assertEqual(len(environments), 1)
                for suffix in ("API_KEY", "BASE_URL", "PREFERRED_DOMAIN"):
                    key = f"EASYEMAIL_PROVIDER_TEMPORAM_{suffix}"
                    self.assertEqual(environments[0].get(key), "${{ secrets." + key + " }}")

    def test_temporam_secrets_independently_create_the_service_overlay(self) -> None:
        cases = {
            "API_KEY": ("apiKey", "test-temporam-key"),
            "BASE_URL": ("baseUrl", "https://api.temporam.com/v3"),
            "PREFERRED_DOMAIN": ("preferredDomain", "mail.example"),
        }
        for suffix, (field, value) in cases.items():
            with self.subTest(field=field), mock.patch.dict(
                os.environ, {f"EASYEMAIL_PROVIDER_TEMPORAM_{suffix}": value}, clear=True
            ):
                overlay = MATERIALIZE.build_granular_service_overlay({})
                self.assertIsNotNone(overlay)
                self.assertEqual(overlay["serviceBase"]["runtime"]["providers"]["temporam"][field], value)

    def test_blank_temporam_key_does_not_create_an_overlay(self) -> None:
        with mock.patch.dict(os.environ, {"EASYEMAIL_PROVIDER_TEMPORAM_API_KEY": "  "}, clear=True):
            self.assertIsNone(MATERIALIZE.build_granular_service_overlay({}))

    def parse(self, value: str):
        with mock.patch.dict(os.environ, {SECRET_NAME: value}, clear=False):
            return MATERIALIZE.parse_list_secret(SECRET_NAME)

    def test_newline_delimited_secrets_preserve_each_item(self) -> None:
        for value in ("alpha\nbeta", "alpha\r\nbeta", "alpha\n\nbeta"):
            with self.subTest(value=repr(value)):
                self.assertEqual(self.parse(value), ["alpha", "beta"])

    def test_structured_comma_and_scalar_formats_remain_supported(self) -> None:
        cases = {
            '["alpha", "beta"]': ["alpha", "beta"],
            "- alpha\n- beta": ["alpha", "beta"],
            "alpha,beta": ["alpha", "beta"],
            "alpha": ["alpha"],
        }
        for value, expected in cases.items():
            with self.subTest(value=value):
                self.assertEqual(self.parse(value), expected)


if __name__ == "__main__":
    unittest.main()
