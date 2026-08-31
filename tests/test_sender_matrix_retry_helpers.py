from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess
import unittest


ROOT = Path(__file__).resolve().parents[1]
SENDER_MATRIX = ROOT / "scripts" / "test-easyemail-cloudflare-sender-matrix.ps1"


class SenderMatrixRetryHelperTests(unittest.TestCase):
    def test_m2u_upstream_transient_errors_are_retryable(self) -> None:
        powershell = shutil.which("pwsh") or shutil.which("powershell")
        if powershell is None:
            self.skipTest("PowerShell is required for the sender matrix retry regression test.")

        environment = os.environ.copy()
        environment["EASYEMAIL_SENDER_MATRIX"] = str(SENDER_MATRIX)
        command = r"""
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
    $env:EASYEMAIL_SENDER_MATRIX,
    [ref]$tokens,
    [ref]$errors
)
if ($errors.Count -gt 0) {
    throw ($errors | ForEach-Object { $_.Message } | Out-String)
}
$matches = @($ast.FindAll({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
        $node.Name -eq 'Test-ShouldRetryRecipientAddress'
}, $true))
if ($matches.Count -ne 1) {
    throw "Expected one retry helper, found $($matches.Count)."
}
Invoke-Expression $matches[0].Extent.Text

[pscustomobject]@{
    upstreamCode = Test-ShouldRetryRecipientAddress `
        -Provider 'm2u' `
        -Message 'MAILBOX_UPSTREAM_TRANSIENT: temporary provider failure'
    providerCode = Test-ShouldRetryRecipientAddress `
        -Provider 'm2u' `
        -Message 'M2U_TRANSIENT_FAILURE: helper request failed'
    permanentFailure = Test-ShouldRetryRecipientAddress `
        -Provider 'm2u' `
        -Message 'invalid mailbox configuration'
    unsupportedProvider = Test-ShouldRetryRecipientAddress `
        -Provider 'cloudflare_temp_email' `
        -Message 'MAILBOX_UPSTREAM_TRANSIENT: temporary provider failure'
} | ConvertTo-Json -Compress
"""
        completed = subprocess.run(
            [powershell, "-NoProfile", "-Command", command],
            cwd=ROOT,
            env=environment,
            check=False,
            capture_output=True,
            text=True,
        )

        self.assertEqual(completed.returncode, 0, completed.stderr)
        result = json.loads(completed.stdout.strip())
        self.assertEqual(
            result,
            {
                "upstreamCode": True,
                "providerCode": True,
                "permanentFailure": False,
                "unsupportedProvider": False,
            },
        )


if __name__ == "__main__":
    unittest.main()
