from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SMOKE = ROOT / "deploy" / "service" / "base" / "smoke-easy-email-docker-api.ps1"
DEPLOY = ROOT / "scripts" / "deploy-service-base.ps1"
REMOVE = ROOT / "scripts" / "remove-service-base.ps1"


class ServiceBaseSmokeContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.smoke = SMOKE.read_text(encoding="utf-8")
        cls.deploy = DEPLOY.read_text(encoding="utf-8")
        cls.remove = REMOVE.read_text(encoding="utf-8")

    def test_smoke_uses_isolated_runtime_and_compose_scope(self) -> None:
        for contract in (
            "EASY_EMAIL_SERVICE_CONTAINER_NAME",
            "EASY_EMAIL_SERVICE_HOST_PORT",
            "EASY_EMAIL_SERVICE_CONFIG_DIR",
            "EASY_EMAIL_SERVICE_DATA_DIR",
            "EASY_EMAIL_SERVICE_NETWORK",
        ):
            self.assertIn(contract, self.smoke)
        self.assertIn('"compose", "-p", $ComposeProjectName', self.smoke)
        self.assertIn("service-base-smoke/$runName", self.smoke)

    def test_smoke_cleanup_targets_only_its_compose_project(self) -> None:
        self.assertIn(
            "docker compose -p $ComposeProjectName -f $composeFile down --remove-orphans",
            self.smoke,
        )
        self.assertNotIn("docker compose -f $composeFile down", self.smoke)

    def test_deploy_and_remove_agree_on_instance_project_name(self) -> None:
        self.assertIn('return "easy-email-$Name"', self.remove)
        self.assertNotIn('return "easyemail-$Name"', self.remove)

    def test_instance_names_cannot_escape_the_runtime_root(self) -> None:
        instance_name_contract = "^[A-Za-z0-9][A-Za-z0-9_.-]*$"
        self.assertIn(instance_name_contract, self.deploy)
        self.assertIn(instance_name_contract, self.remove)
        self.assertIn("GetFullPath((Join-Path $instancesRoot $Name))", self.remove)
        self.assertIn("Refusing to remove instance data outside", self.remove)

    def test_smoke_refuses_resource_reuse_and_reports_cleanup_failures(self) -> None:
        for contract in (
            "Refusing to reuse an existing smoke runtime root",
            "Refusing to reuse existing docker network",
            "Refusing to reuse existing docker container",
            "Refusing to reuse existing compose project",
            "if ($cleanupFailure)",
        ):
            self.assertIn(contract, self.smoke)

    def test_smoke_cleanup_can_remove_container_owned_runtime_files(self) -> None:
        self.assertIn("function Clear-DockerOwnedSmokeRuntime", self.smoke)
        self.assertIn('$mountSpec = "${Path}:/runtime"', self.smoke)
        self.assertIn("'--pull', 'never', '--network', 'none', '--user', '0'", self.smoke)
        self.assertIn("Path(\"/runtime\").iterdir()", self.smoke)
        self.assertIn(
            "Clear-DockerOwnedSmokeRuntime -Path $resolvedRuntimeRoot -ImageName $Image",
            self.smoke,
        )


if __name__ == "__main__":
    unittest.main()
