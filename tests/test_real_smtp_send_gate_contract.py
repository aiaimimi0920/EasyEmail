from __future__ import annotations

import shutil
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "test-real-smtp-send-gate.ps1"


class RealSmtpSendGateContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.script = SCRIPT.read_text(encoding="utf-8")

    def test_gate_is_explicitly_opt_in_and_never_accepts_cli_password(self) -> None:
        guard = "if (-not $ConfirmExternalSideEffects)"
        self.assertIn(guard, self.script)
        self.assertLess(
            self.script.index(guard),
            self.script.index("EASYEMAIL_REAL_SMTP_PASSWORD"),
        )
        self.assertNotIn("[string]$SmtpPassword", self.script)
        self.assertIn("[REDACTED_SECRET]", self.script)
        self.assertIn("[REDACTED_EMAIL]", self.script)
        self.assertIn("Assert-ZeroCanarySecretMatches", self.script)
        self.assertIn("/mail/accounts/smtp/test", self.script)
        self.assertIn("/mail/send-queue", self.script)

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


if __name__ == "__main__":
    unittest.main()
