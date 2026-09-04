from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github" / "workflows" / "publish-service-base-ghcr.yml"
METADATA_SCRIPT = ROOT / "scripts" / "resolve-service-base-release.py"
MANIFEST_SCRIPT = ROOT / "scripts" / "write-service-base-release-manifest.ps1"


def parse_github_outputs(text: str) -> dict[str, str]:
    lines = text.splitlines()
    outputs: dict[str, str] = {}
    index = 0
    while index < len(lines):
        line = lines[index]
        if "<<" in line:
            name, delimiter = line.split("<<", 1)
            index += 1
            values: list[str] = []
            while index < len(lines) and lines[index] != delimiter:
                values.append(lines[index])
                index += 1
            outputs[name] = "\n".join(values)
        else:
            name, value = line.split("=", 1)
            outputs[name] = value
        index += 1
    return outputs


class ServiceBaseReleaseWorkflowScriptTests(unittest.TestCase):
    def test_workflow_invokes_extracted_release_scripts(self) -> None:
        workflow = WORKFLOW.read_text(encoding="utf-8")

        self.assertIn("run: python scripts/resolve-service-base-release.py", workflow)
        self.assertIn("run: .\\scripts\\write-service-base-release-manifest.ps1", workflow)

    def test_metadata_script_preserves_manual_release_outputs(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            output_path = Path(temp_dir) / "github-output.txt"
            environment = os.environ.copy()
            environment.update(
                {
                    "GITHUB_OUTPUT": str(output_path),
                    "GITHUB_REPOSITORY_OWNER": "ExampleOwner",
                    "GITHUB_EVENT_NAME": "workflow_dispatch",
                    "GITHUB_REF_NAME": "main",
                    "GITHUB_RUN_ID": "123",
                    "GITHUB_RUN_NUMBER": "8",
                    "REGISTRY": "ghcr.io",
                    "IMAGE_NAME": "easy-email-service",
                    "RELEASE_TAG_INPUT": "service-base-20260904-001",
                    "VERSION_INPUT": "ignored-version",
                    "COORDINATED_RELEASE": "false",
                    "PUSH_LATEST_INPUT": "false",
                    "RUN_SMOKE_INPUT": "true",
                    "PLATFORM_INPUT": "linux/amd64,linux/arm64",
                    "FORCE_PUBLISH_INPUT": "true",
                }
            )
            completed = subprocess.run(
                ["python", str(METADATA_SCRIPT)],
                cwd=ROOT,
                env=environment,
                check=False,
                capture_output=True,
                text=True,
            )

            self.assertEqual(completed.returncode, 0, completed.stderr)
            outputs = parse_github_outputs(output_path.read_text(encoding="utf-8"))
            self.assertEqual(outputs["owner"], "exampleowner")
            self.assertEqual(outputs["version"], "service-base-20260904-001")
            self.assertEqual(outputs["release_tag"], outputs["version"])
            self.assertEqual(outputs["platform"], "linux/amd64,linux/arm64")
            self.assertEqual(outputs["push_latest"], "false")
            self.assertEqual(outputs["run_smoke"], "true")
            self.assertEqual(outputs["force_publish"], "true")
            self.assertEqual(outputs["smoke_image"], "ghcr.io/exampleowner/easy-email-service:smoke-123")
            self.assertEqual(
                outputs["tags"].splitlines(),
                [
                    "ghcr.io/exampleowner/easy-email-service:service-base-20260904-001",
                    f"ghcr.io/exampleowner/easy-email-service:sha-{outputs['short_sha']}",
                ],
            )

    def test_manifest_script_preserves_release_schema_and_outputs(self) -> None:
        powershell = shutil.which("pwsh") or shutil.which("powershell")
        if powershell is None:
            self.skipTest("PowerShell is required for the release manifest test.")

        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            distribution_path = temp_path / "distribution.json"
            distribution_path.write_text('{"schemaVersion": 1, "objects": ["config.yaml"]}', encoding="utf-8")
            manifest_path = temp_path / "manifest.json"
            github_output_path = temp_path / "github-output.txt"
            environment = os.environ.copy()
            environment.update(
                {
                    "GITHUB_REPOSITORY": "example/easyemail",
                    "GITHUB_WORKFLOW": "Publish Service Base GHCR",
                    "GITHUB_RUN_ID": "42",
                    "GITHUB_RUN_NUMBER": "7",
                    "GITHUB_RUN_ATTEMPT": "1",
                    "GITHUB_EVENT_NAME": "workflow_dispatch",
                    "GITHUB_ACTOR": "tester",
                    "GITHUB_REF": "refs/heads/main",
                    "GITHUB_SHA": "abc123",
                    "EASYEMAIL_RELEASE_VERSION": "service-base-20260904-001",
                    "EASYEMAIL_IMAGE_REF": "ghcr.io/example/easy-email-service",
                    "EASYEMAIL_SHORT_SHA": "abc123",
                    "EASYEMAIL_PUSH_LATEST": "true",
                    "EASYEMAIL_PLATFORM": "linux/amd64",
                    "EASYEMAIL_IMAGE_DIGEST": "sha256:1234",
                    "EASYEMAIL_DISTRIBUTION_PATH": str(distribution_path),
                    "EASYEMAIL_MATCHED_FILES": "service/base/src/index.ts\ndeploy/service/base/Dockerfile",
                    "EASYEMAIL_CHANGE_REASON": "relevant_changes_detected",
                    "EASYEMAIL_SMOKE_LABEL": "passed",
                }
            )
            completed = subprocess.run(
                [
                    powershell,
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    str(MANIFEST_SCRIPT),
                    "-OutputPath",
                    str(manifest_path),
                    "-GitHubOutputPath",
                    str(github_output_path),
                ],
                cwd=ROOT,
                env=environment,
                check=False,
                capture_output=True,
                text=True,
            )

            self.assertEqual(completed.returncode, 0, completed.stderr)
            manifest = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
            self.assertEqual(manifest["schemaVersion"], 1)
            self.assertEqual(manifest["release"]["kind"], "service-base-ghcr")
            self.assertEqual(manifest["release"]["digest"], "sha256:1234")
            self.assertTrue(manifest["release"]["publishLatest"])
            self.assertEqual(
                manifest["release"]["tags"],
                [
                    "ghcr.io/example/easy-email-service:service-base-20260904-001",
                    "ghcr.io/example/easy-email-service:sha-abc123",
                    "ghcr.io/example/easy-email-service:latest",
                ],
            )
            self.assertEqual(manifest["distribution"]["objects"], ["config.yaml"])
            self.assertEqual(manifest["validation"]["smoke"], "passed")
            self.assertIn(f"path={manifest_path}", github_output_path.read_text(encoding="utf-8-sig"))


if __name__ == "__main__":
    unittest.main()
