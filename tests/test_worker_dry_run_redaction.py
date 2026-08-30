from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
RENDERER = ROOT / "scripts" / "render-derived-configs.py"
RENDER_WRAPPER = ROOT / "scripts" / "render-derived-configs.ps1"
QUICK_DEPLOY = ROOT / "scripts" / "quick-deploy-cloudflare-mail.ps1"
WORKER_RUNNER = (
    ROOT
    / "upstreams"
    / "cloudflare_temp_email"
    / "worker"
    / "scripts"
    / "run-with-root-config.mjs"
)


class WorkerDryRunRedactionTests(unittest.TestCase):
    def test_renderer_redacts_every_worker_var_while_preserving_toml_types(self) -> None:
        config = """
cloudflareMail:
  worker:
    vars:
      JWT_SECRET: live-jwt-value
      PASSWORDS:
        - first-live-password
        - second-live-password
      ENABLE_AUTO_REPLY: true
      RANDOM_SUBDOMAIN_LENGTH: 17
      NESTED_VALUE:
        token: nested-live-token
"""
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_root = Path(temp_dir)
            config_path = temp_root / "config.yaml"
            output_path = temp_root / "wrangler.toml"
            config_path.write_text(config, encoding="utf-8")

            completed = subprocess.run(
                [
                    sys.executable,
                    str(RENDERER),
                    "--root-config",
                    str(config_path),
                    "--worker-output",
                    str(output_path),
                    "--redact-worker-vars",
                ],
                cwd=ROOT,
                check=False,
                capture_output=True,
                text=True,
            )

            self.assertEqual(completed.returncode, 0, completed.stderr)
            rendered = output_path.read_text(encoding="utf-8")

        for secret in (
            "live-jwt-value",
            "first-live-password",
            "second-live-password",
            "nested-live-token",
        ):
            self.assertNotIn(secret, rendered)
        self.assertIn("[REDACTED_SECRET]", rendered)
        self.assertIn("ENABLE_AUTO_REPLY = false", rendered)
        self.assertIn("RANDOM_SUBDOMAIN_LENGTH = 0", rendered)

    def test_all_dry_run_entry_points_request_redacted_worker_vars(self) -> None:
        wrapper = RENDER_WRAPPER.read_text(encoding="utf-8")
        quick_deploy = QUICK_DEPLOY.read_text(encoding="utf-8")
        worker_runner = WORKER_RUNNER.read_text(encoding="utf-8")

        self.assertIn("--redact-worker-vars", wrapper)
        self.assertIn("$renderParameters['RedactWorkerVars'] = $true", quick_deploy)
        self.assertIn("rendererArgs.push('--redact-worker-vars')", worker_runner)


if __name__ == "__main__":
    unittest.main()
