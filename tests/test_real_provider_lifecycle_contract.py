from __future__ import annotations

import os
import shutil
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "test-real-provider-lifecycle.ps1"


class RealProviderLifecycleContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.script = SCRIPT.read_text(encoding="utf-8")

    def test_validation_is_explicitly_opt_in_before_config_or_docker(self) -> None:
        guard = "if (-not $ConfirmExternalSideEffects)"
        self.assertIn(guard, self.script)
        self.assertLess(self.script.index(guard), self.script.index("Read-EasyEmailConfig"))
        self.assertLess(self.script.index(guard), self.script.index("& docker"))
        self.assertIn("Port 18081 is reserved", self.script)
        self.assertIn("existingPort18081Touched = $false", self.script)

    def test_validation_reuses_the_isolated_service_smoke(self) -> None:
        for expected in (
            "smoke-easy-email-docker-api.ps1",
            "service-base-real/$runName",
            "-KeepRunning",
            "-SkipMailboxOpen",
            "127.0.0.1:$HostPort",
            "[Guid]::NewGuid()",
            "$ErrorActionPreference = 'Continue'",
            "$smokeExitCode = $LASTEXITCODE",
            "'/mail/query/provider-instances?providerTypeKey=cloudflare_temp_email&limit=20'",
            '"/mail/providers/$escapedInstanceId/probe"',
            "preferredInstanceId = $PreferredInstanceId",
            "reportedDomainsAvailable",
            "providerDefaultDomainsJson",
            "configuredSenderDomainSelected",
            "Real provider sender mailbox did not use the configured sender domain",
        ):
            self.assertIn(expected, self.script)

    def test_real_flow_covers_receive_body_code_release_and_restart(self) -> None:
        for expected in (
            "'/mail/mailboxes/open'",
            "'/mail/mailboxes/update-session'",
            "'/mail/mailboxes/send'",
            '"/mail/mailboxes/$escapedSessionId/code"',
            '"/mail/query/observed-messages?sessionId=$escapedSessionId',
            "'/mail/mailboxes/release'",
            "ENABLE_USER_DELETE_EMAIL=true",
            "Cloudflare Temp Email release did not delete the upstream mailbox",
            "m1-real-provider-lifecycle-sender",
            "Cloudflare Temp Email sender release returned unexpected semantics",
            "m1-real-provider-lifecycle-cleanup",
            "Wait-PersistedLifecycleState",
            "data/state/easy-email-state.json",
            "serviceBase.runtime.persistence.enabled=true",
            "docker restart --time 30 $containerName",
            "'/mail/snapshot'",
            "Restart readback lost the controlled observed message",
        ):
            self.assertIn(expected, self.script)

    def test_credentials_are_in_memory_scanned_and_not_passed_on_cli(self) -> None:
        for expected in (
            "Get-SensitiveConfigValues",
            "Test-ContainsSensitiveValue",
            "ConvertTo-SafeFailureMessage",
            "LOCAL_PROPERTY_MISSING_",
            "[REDACTED_SECRET]",
            "[REDACTED_EMAIL]",
            "code=$serviceErrorCode",
            "CLOUDFLARE_TEMP_EMAIL_NEW_ADDRESS_${providerFailureKind}_HTTP_",
            "INVALID_DOMAIN",
            "TURNSTILE",
            "CLOUDFLARE_TEMP_EMAIL_${sendOperation}_${sendFailureKind}_HTTP_",
            "TRANSPORT_DISABLED",
            "custom.?auth",
            "private.?key",
            "Real-provider validation output leaked a configured credential",
            "docker logs $containerName",
        ):
            self.assertIn(expected, self.script)
        self.assertNotIn("'-ApiKey'", self.script)
        self.assertNotIn('Write-Host $apiKey', self.script)
        self.assertNotIn("$text.Length -ge 8", self.script)
        redaction = self.script.index("$safeMessage = $Message")
        provider_guard = self.script.index("if ($safeMessage -match '^Cloudflare Temp Email')")
        self.assertLess(redaction, provider_guard)
        self.assertNotIn("|Cloudflare Temp Email|", self.script)

    def test_cleanup_targets_only_owned_resources(self) -> None:
        for expected in (
            'docker ps -a --filter "name=$containerName"',
            "docker rm -f $containerName",
            'docker network ls --filter "name=$networkName"',
            "docker network rm $networkName",
            "Refusing to remove runtime root outside the isolated validation directory",
            "Remove-IsolatedRuntimeRoot -Path $runtimeRoot",
            "Failed to remove the isolated validation image",
            "$cleanupErrors.Add('Failed to remove the isolated validation network.')",
            "$cleanupErrors.Add('Failed to remove the isolated validation runtime root.')",
            'Failed to release the isolated validation $($pendingRelease.Label) mailbox.',
            "$script:OwnedMailboxTargets.Add",
            "Find-OwnedOpenMailboxes",
            "m1-real-provider-lifecycle-uncertain-open-cleanup",
            "Failed to reconcile and release an uncertain mailbox open result",
            "foreach ($ownedTarget in $script:OwnedMailboxTargets)",
        ):
            self.assertIn(expected, self.script)
        self.assertNotIn("docker system prune", self.script)
        self.assertNotIn("foreach ($ownedTarget in @($script:OwnedMailboxTargets))", self.script)

    def test_script_parses_and_refuses_an_unconfirmed_run(self) -> None:
        powershell = shutil.which("pwsh") or shutil.which("powershell")
        if powershell is None:
            self.skipTest("PowerShell is required for lifecycle script validation.")

        parse_command = r"""
$tokens = $null
$errors = $null
[void][System.Management.Automation.Language.Parser]::ParseFile(
    $env:EASYEMAIL_REAL_LIFECYCLE_SCRIPT,
    [ref]$tokens,
    [ref]$errors
)
if ($errors.Count -gt 0) {
    $errors | ForEach-Object { Write-Error $_.Message }
    exit 1
}
"""
        environment = os.environ.copy()
        environment["EASYEMAIL_REAL_LIFECYCLE_SCRIPT"] = str(SCRIPT)
        completed = subprocess.run(
            [powershell, "-NoProfile", "-Command", parse_command],
            cwd=ROOT,
            env=environment,
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)

        refused = subprocess.run(
            [powershell, "-NoProfile", "-File", str(SCRIPT)],
            cwd=ROOT,
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertNotEqual(refused.returncode, 0)
        output = refused.stdout + refused.stderr
        self.assertIn("Real-provider validation is opt-in", output)
        self.assertNotIn("Creating docker network", output)


if __name__ == "__main__":
    unittest.main()
