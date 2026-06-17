from __future__ import annotations

import re
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


def read_text(relative_path: str) -> str:
    return (REPO_ROOT / relative_path).read_text(encoding="utf-8")


def default_string_parameter(script_text: str, parameter_name: str) -> str:
    pattern = rf"\[string\]\${re.escape(parameter_name)}\s*=\s*['\"]([^'\"]*)['\"]"
    match = re.search(pattern, script_text)
    if match is None:
        raise AssertionError(f"Missing string parameter default: {parameter_name}")
    return match.group(1)


class DeployNamingContractTests(unittest.TestCase):
    def test_root_and_internal_deploy_default_to_stable_service_alias(self) -> None:
        for script in ("deploy-host.ps1", "scripts/deploy-service-base.ps1"):
            with self.subTest(script=script):
                script_text = read_text(script)
                self.assertEqual(
                    default_string_parameter(script_text, "NetworkAlias"),
                    "easy-email-service",
                )

    def test_primary_deploy_defaults_to_unsuffixed_container_and_compose_names(self) -> None:
        script_text = read_text("scripts/deploy-service-base.ps1")

        self.assertIn("'easy-email'", script_text)
        self.assertRegex(
            script_text,
            r"(?s)\$derivedContainerName\s*=\s*if.*?else\s*\{\s*'easy-email'\s*\}",
        )
        self.assertRegex(
            script_text,
            r"(?s)\$resolvedComposeProjectName\s*=\s*if.*?else\s*\{\s*'easy-email'\s*\}",
        )


if __name__ == "__main__":
    unittest.main()
