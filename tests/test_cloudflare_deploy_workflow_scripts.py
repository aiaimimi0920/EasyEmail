from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github" / "workflows" / "deploy-cloudflare-email.yml"
CHANGE_GATE_SCRIPT = ROOT / "scripts" / "resolve-cloudflare-deploy-change-gate.py"
OPERATOR_CONFIG_SCRIPT = ROOT / "scripts" / "prepare-cloudflare-operator-config.ps1"
GRANULAR_SECRET_NAMES = (
    "EASYEMAIL_CF_PUBLIC_BASE_URL",
    "EASYEMAIL_CF_PUBLIC_DOMAIN",
    "EASYEMAIL_CF_PASSWORDS",
    "EASYEMAIL_CF_ADMIN_PASSWORDS",
    "EASYEMAIL_CF_JWT_SECRET",
    "EASYEMAIL_CF_DOMAINS",
    "EASYEMAIL_CF_SUBDOMAIN_LABEL_POOL",
    "EASYEMAIL_CF_SENDING_DOMAINS",
    "EASYEMAIL_CF_D1_DATABASE_ID",
    "EASYEMAIL_CF_D1_DATABASE_NAME",
    "EASYEMAIL_CF_AUTH_EMAIL",
    "EASYEMAIL_CF_GLOBAL_API_KEY",
    "EASYEMAIL_CF_API_TOKEN",
    "EASYEMAIL_CF_RESEND_TOKEN",
)


def load_change_gate_module():
    spec = importlib.util.spec_from_file_location("cloudflare_change_gate", CHANGE_GATE_SCRIPT)
    if spec is None or spec.loader is None:
        raise AssertionError(f"unable to load {CHANGE_GATE_SCRIPT}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class CloudflareDeployWorkflowScriptTests(unittest.TestCase):
    def test_workflow_invokes_extracted_control_scripts(self) -> None:
        workflow = WORKFLOW.read_text(encoding="utf-8")

        self.assertIn("run: python scripts/resolve-cloudflare-deploy-change-gate.py", workflow)
        self.assertIn("run: .\\scripts\\prepare-cloudflare-operator-config.ps1", workflow)
        self.assertIn("EASYEMAIL_CF_API_TOKEN: ${{ secrets.EASYEMAIL_CF_API_TOKEN }}", workflow)
        self.assertIn("environment:", workflow)

    def test_workflow_limits_write_permission_to_the_deploy_job(self) -> None:
        workflow = WORKFLOW.read_text(encoding="utf-8")

        self.assertIn("permissions:\n  contents: read", workflow)
        self.assertIn(
            "  deploy:\n    needs: preflight\n    permissions:\n      contents: write",
            workflow,
        )

    def test_change_gate_preserves_manual_and_detected_output_protocol(self) -> None:
        module = load_change_gate_module()

        manual = module.resolve_change_gate("workflow_dispatch", "false", "false", [])
        coordinated = module.resolve_change_gate("workflow_call", "true", "false", [])
        forced = module.resolve_change_gate("push", "false", "true", [])
        detected = module.resolve_change_gate("push", "false", "false", ["scripts/example.py"])
        skipped = module.resolve_change_gate("push", "false", "false", [])

        self.assertEqual(module.render_github_output(manual), "should_deploy=true\nreason=manual_or_forced\n")
        self.assertEqual(coordinated.reason, "manual_or_forced")
        self.assertTrue(forced.should_deploy)
        self.assertEqual(
            module.render_github_output(detected),
            "should_deploy=true\nreason=relevant_changes_detected\nmatched_files<<EOF\n"
            "scripts/example.py\nEOF\n",
        )
        self.assertEqual(
            module.render_github_output(skipped),
            "should_deploy=false\nreason=no_relevant_changes\nmatched_files<<EOF\nEOF\n",
        )

    def test_change_gate_tracks_its_extracted_workflow_support(self) -> None:
        module = load_change_gate_module()

        self.assertIn(".github/workflows/deploy-cloudflare-email.yml", module.RELEVANT_PATHS)
        self.assertIn("scripts/resolve-cloudflare-deploy-change-gate.py", module.RELEVANT_PATHS)
        self.assertIn("scripts/prepare-cloudflare-operator-config.ps1", module.RELEVANT_PATHS)

    def test_change_gate_filters_a_real_git_commit(self) -> None:
        module = load_change_gate_module()

        with tempfile.TemporaryDirectory() as temp_dir:
            repo = Path(temp_dir)
            subprocess.run(["git", "init", "--quiet"], cwd=repo, check=True)
            subprocess.run(["git", "config", "user.email", "test@example.test"], cwd=repo, check=True)
            subprocess.run(["git", "config", "user.name", "EasyEmail Test"], cwd=repo, check=True)
            (repo / "README.md").write_text("baseline\n", encoding="utf-8")
            subprocess.run(["git", "add", "README.md"], cwd=repo, check=True)
            subprocess.run(["git", "commit", "--quiet", "-m", "baseline"], cwd=repo, check=True)

            script_path = repo / "scripts" / "prepare-cloudflare-operator-config.ps1"
            script_path.parent.mkdir()
            script_path.write_text("Write-Host 'changed'\n", encoding="utf-8")
            (repo / "README.md").write_text("unrelated\n", encoding="utf-8")
            subprocess.run(["git", "add", "."], cwd=repo, check=True)
            subprocess.run(["git", "commit", "--quiet", "-m", "change"], cwd=repo, check=True)

            self.assertEqual(
                module.find_matched_files(repo, "HEAD"),
                ("scripts/prepare-cloudflare-operator-config.ps1",),
            )

    def test_operator_config_supports_secretless_dry_run(self) -> None:
        powershell = shutil.which("pwsh") or shutil.which("powershell")
        if powershell is None:
            self.skipTest("PowerShell is required for the operator config test.")

        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            config_path = temp_path / "config.yaml"
            output_path = temp_path / "github-output.txt"
            github_env_path = temp_path / "github-env.txt"
            environment = os.environ.copy()
            for name in GRANULAR_SECRET_NAMES:
                environment.pop(name, None)
            environment["ALLOW_EXAMPLE_CONFIG"] = "true"

            completed = subprocess.run(
                [
                    powershell,
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    str(OPERATOR_CONFIG_SCRIPT),
                    "-ConfigPath",
                    str(config_path),
                    "-GitHubEnvironmentPath",
                    str(github_env_path),
                    "-GitHubOutputPath",
                    str(output_path),
                ],
                cwd=ROOT,
                env=environment,
                check=False,
                capture_output=True,
                text=True,
            )

            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertEqual(config_path.read_bytes(), (ROOT / "config.example.yaml").read_bytes())
            self.assertEqual(output_path.read_text(encoding="utf-8-sig"), "source=example\n")

    def test_operator_config_rejects_missing_github_file_paths(self) -> None:
        powershell = shutil.which("pwsh") or shutil.which("powershell")
        if powershell is None:
            self.skipTest("PowerShell is required for the operator config test.")
        environment = os.environ.copy()
        environment.pop("GITHUB_ENV", None)
        environment.pop("GITHUB_OUTPUT", None)

        completed = subprocess.run(
            [powershell, "-NoProfile", "-File", str(OPERATOR_CONFIG_SCRIPT)],
            cwd=ROOT,
            env=environment,
            check=False,
            capture_output=True,
            text=True,
        )

        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("GitHubEnvironmentPath is required", completed.stderr)

    def test_operator_config_exports_api_token_auth(self) -> None:
        powershell = shutil.which("pwsh") or shutil.which("powershell")
        if powershell is None:
            self.skipTest("PowerShell is required for the operator config test.")

        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            config_path = temp_path / "config.yaml"
            output_path = temp_path / "github-output.txt"
            github_env_path = temp_path / "github-env.txt"
            environment = os.environ.copy()
            for name in GRANULAR_SECRET_NAMES:
                environment.pop(name, None)
            environment.update(
                {
                    "ALLOW_EXAMPLE_CONFIG": "false",
                    "EASYEMAIL_CF_API_TOKEN": "example-test-token",
                    "EASYEMAIL_CF_PUBLIC_BASE_URL": "https://mail.example.test",
                }
            )

            completed = subprocess.run(
                [
                    powershell,
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    str(OPERATOR_CONFIG_SCRIPT),
                    "-ConfigPath",
                    str(config_path),
                    "-GitHubEnvironmentPath",
                    str(github_env_path),
                    "-GitHubOutputPath",
                    str(output_path),
                ],
                cwd=ROOT,
                env=environment,
                check=False,
                capture_output=True,
                text=True,
            )

            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertTrue(config_path.is_file())
            self.assertEqual(output_path.read_text(encoding="utf-8-sig"), "source=granular-secrets\n")
            self.assertEqual(
                github_env_path.read_text(encoding="utf-8-sig"),
                "CLOUDFLARE_API_TOKEN=example-test-token\n",
            )

    def test_operator_config_exports_global_auth_fallback(self) -> None:
        powershell = shutil.which("pwsh") or shutil.which("powershell")
        if powershell is None:
            self.skipTest("PowerShell is required for the operator config test.")

        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            environment = os.environ.copy()
            for name in GRANULAR_SECRET_NAMES:
                environment.pop(name, None)
            environment.update(
                {
                    "ALLOW_EXAMPLE_CONFIG": "false",
                    "EASYEMAIL_CF_AUTH_EMAIL": "operator@example.test",
                    "EASYEMAIL_CF_GLOBAL_API_KEY": "example-global-key",
                }
            )

            github_env_path = temp_path / "github-env.txt"
            completed = subprocess.run(
                [
                    powershell,
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    str(OPERATOR_CONFIG_SCRIPT),
                    "-ConfigPath",
                    str(temp_path / "config.yaml"),
                    "-GitHubEnvironmentPath",
                    str(github_env_path),
                    "-GitHubOutputPath",
                    str(temp_path / "github-output.txt"),
                ],
                cwd=ROOT,
                env=environment,
                check=False,
                capture_output=True,
                text=True,
            )

            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertEqual(
                github_env_path.read_text(encoding="utf-8-sig").splitlines(),
                [
                    "CLOUDFLARE_EMAIL=operator@example.test",
                    "CLOUDFLARE_API_KEY=example-global-key",
                ],
            )


if __name__ == "__main__":
    unittest.main()
