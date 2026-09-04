from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "write-cloudflare-release-manifest.ps1"


class CloudflareReleaseManifestTests(unittest.TestCase):
    def test_dry_run_manifest_preserves_workflow_contract(self) -> None:
        powershell = shutil.which("pwsh") or shutil.which("powershell")
        if powershell is None:
            self.skipTest("PowerShell is required for the release manifest test.")

        with tempfile.TemporaryDirectory() as temp_dir:
            output_path = Path(temp_dir) / "manifest.json"
            github_output_path = Path(temp_dir) / "github-output.txt"
            environment = os.environ.copy()
            environment.update(
                {
                    "GITHUB_EVENT_NAME": "workflow_dispatch",
                    "GITHUB_REPOSITORY": "example/easyemail",
                    "GITHUB_WORKFLOW": "Deploy Cloudflare Email",
                    "GITHUB_RUN_ID": "42",
                    "GITHUB_RUN_NUMBER": "7",
                    "GITHUB_RUN_ATTEMPT": "1",
                    "GITHUB_ACTOR": "tester",
                    "GITHUB_REF": "refs/heads/main",
                    "GITHUB_SHA": "abc123",
                    "EASYEMAIL_RELEASE_TAG": "release-20260904-001",
                    "EASYEMAIL_COORDINATED_RELEASE": "false",
                    "EASYEMAIL_INPUT_DRY_RUN": "true",
                    "EASYEMAIL_INPUT_RUN_HEALTH_CHECK": "true",
                    "EASYEMAIL_INPUT_NO_ROUTING_SYNC": "false",
                    "EASYEMAIL_INPUT_BOOTSTRAP": "true",
                    "EASYEMAIL_INPUT_SYNC_MODE": "exact",
                    "EASYEMAIL_INPUT_RUN_SENDER_MATRIX": "true",
                    "EASYEMAIL_MATCHED_FILES": "scripts/example.ps1\nupstreams/cloudflare_temp_email/worker/src/index.ts",
                    "EASYEMAIL_CHANGE_REASON": "manual_or_forced",
                    "EASYEMAIL_RUNTIME_PATH": "",
                    "EASYEMAIL_CONFIG_SOURCE": "example",
                    "EASYEMAIL_SENDER_MATRIX_RESULT": "",
                }
            )
            completed = subprocess.run(
                [
                    powershell,
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    str(SCRIPT),
                    "-ConfigPath",
                    str(ROOT / "config.example.yaml"),
                    "-OutputPath",
                    str(output_path),
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
            manifest = json.loads(output_path.read_text(encoding="utf-8-sig"))
            self.assertEqual(manifest["schemaVersion"], 1)
            self.assertEqual(manifest["repository"], "example/easyemail")
            self.assertEqual(manifest["source"]["changeReason"], "manual_or_forced")
            self.assertEqual(
                manifest["source"]["matchedFiles"],
                [
                    "scripts/example.ps1",
                    "upstreams/cloudflare_temp_email/worker/src/index.ts",
                ],
            )
            deployment = manifest["deployment"]
            self.assertFalse(deployment["domains"])
            self.assertFalse(deployment["randomSubdomainDomains"])
            self.assertEqual(
                {key: value for key, value in deployment.items() if key not in {"domains", "randomSubdomainDomains"}},
                {
                    "kind": "cloudflare-email",
                    "channel": deployment["channel"],
                    "result": "validated",
                    "dryRun": True,
                    "baseUrl": "https://mail.example.com",
                    "version": "n/a",
                    "bootstrap": True,
                    "syncMode": "exact",
                    "routingSyncEnabled": False,
                    "needAuth": False,
                },
            )
            self.assertEqual(manifest["validation"]["healthCheck"], "skipped")
            self.assertEqual(manifest["validation"]["senderMatrix"], "skipped")
            self.assertIn(f"path={output_path}", github_output_path.read_text(encoding="utf-8-sig"))


if __name__ == "__main__":
    unittest.main()
