from __future__ import annotations

import shutil
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "test-real-imap-account-gate.ps1"
SMOKE_SCRIPT = (
    ROOT / "apps" / "desktop" / "scripts" / "verify-desktop-credential-restart-smoke.ps1"
)
SMOKE_SUPPORT = (
    ROOT / "apps" / "desktop" / "scripts" / "lib" / "desktop-credential-smoke-support.ps1"
)


class RealImapAccountGateContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.script = SCRIPT.read_text(encoding="utf-8")
        cls.smoke_script = SMOKE_SCRIPT.read_text(encoding="utf-8")
        cls.smoke_support = SMOKE_SUPPORT.read_text(encoding="utf-8")

    def test_gate_is_explicitly_opt_in_and_never_accepts_cli_password(self) -> None:
        guard = "if (-not $ConfirmExternalSideEffects)"
        self.assertIn(guard, self.script)
        self.assertLess(
            self.script.index(guard),
            self.script.index("EASYEMAIL_REAL_IMAP_PASSWORD"),
        )
        self.assertNotIn("[string]$ImapPassword", self.script)
        self.assertIn("[REDACTED_SECRET]", self.script)
        self.assertIn("[REDACTED_EMAIL]", self.script)
        self.assertIn("Assert-ZeroCanarySecretMatches", self.script)

    def test_unconfirmed_run_refuses_before_touching_network_or_vault(self) -> None:
        shell = shutil.which("pwsh") or shutil.which("powershell")
        if shell is None:
            self.skipTest("PowerShell is unavailable")
        completed = subprocess.run(
            [shell, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(SCRIPT)],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("ConfirmExternalSideEffects", completed.stderr + completed.stdout)

    def test_gate_covers_m6_folder_discovery_header_body_sync_and_reversible_flag_action(
        self,
    ) -> None:
        for expected in (
            "/mail/accounts/imap/test",
            'name: "Sync"',
            "/folders",
            "/mail/messages?accountId=",
            'flagName: "starred", enabled: !initialStarred',
            'flagName: "starred", enabled: initialStarred',
            "REAL_IMAP_FOLDERS_AND_SYNC_VERIFIED=True",
            "REAL_IMAP_REVERSIBLE_ACTION_VERIFIED=True",
        ):
            self.assertIn(expected, self.script)

    def test_packaged_restart_smoke_covers_ref_v1_legacy_import_missing_vault_and_canary_scan(
        self,
    ) -> None:
        for expected in (
            "run1-create-and-test",
            "run2-restart-and-legacy",
            "seed-and-import-legacy-accounts.mjs",
            "Assert-ZeroCanarySecretMatches",
            "Remove-EasyEmailSmokeVaultSecret",
            "CREDENTIAL_RESTART_SMOKE_PASSED=True",
        ):
            self.assertIn(expected, self.smoke_script)
        self.assertIn("Assert-IsolatedSmokeSecretKey", self.smoke_support)


if __name__ == "__main__":
    unittest.main()
