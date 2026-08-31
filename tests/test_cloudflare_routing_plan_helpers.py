from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess
import unittest


ROOT = Path(__file__).resolve().parents[1]
QUICK_DEPLOY = ROOT / "scripts" / "quick-deploy-cloudflare-mail.ps1"
CONFIG_LIBRARY = ROOT / "scripts" / "lib" / "easyemail-config.ps1"


class CloudflareRoutingPlanHelperTests(unittest.TestCase):
    def test_single_value_routing_plan_renders_under_strict_mode(self) -> None:
        powershell = shutil.which("pwsh") or shutil.which("powershell")
        if powershell is None:
            self.skipTest("PowerShell is required for the routing plan helper regression test.")

        environment = os.environ.copy()
        environment["EASYEMAIL_QUICK_DEPLOY"] = str(QUICK_DEPLOY)
        environment["EASYEMAIL_CONFIG_LIBRARY"] = str(CONFIG_LIBRARY)
        command = r"""
. $env:EASYEMAIL_CONFIG_LIBRARY
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
    $env:EASYEMAIL_QUICK_DEPLOY,
    [ref]$tokens,
    [ref]$errors
)
if ($errors.Count -gt 0) {
    throw ($errors | ForEach-Object { $_.Message } | Out-String)
}
$functionNames = @(
    'Convert-ToEasyEmailStringArray',
    'Convert-ToEasyEmailTomlString',
    'Convert-ToEasyEmailTomlArray',
    'Remove-EasyEmailPlaceholderDomains',
    'Write-CloudflareRoutingPlanFile'
)
foreach ($functionName in $functionNames) {
    $matches = @($ast.FindAll({
        param($node)
        $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
            $node.Name -eq $functionName
    }, $true))
    if ($matches.Count -ne 1) {
        throw "Expected one function named $functionName, found $($matches.Count)."
    }
    Invoke-Expression $matches[0].Extent.Text
}
$script:placeholderDomains = @('example.com', 'mail.example.com', '*.example.com')

$plan = [pscustomobject]@{
    subdomainLabelPool = 'one'
    domains = 'example.org'
    defaultDomains = 'example.org'
}
$outputPath = Write-CloudflareRoutingPlanFile -Plan $plan
try {
    $content = Get-Content -Raw -LiteralPath $outputPath
    [pscustomobject]@{
        labels = $content.Contains('SUBDOMAIN_LABEL_POOL =') -and $content.Contains('"one"')
        domains = $content.Contains('DOMAINS =') -and $content.Contains('"example.org"')
        defaults = $content.Contains('DEFAULT_DOMAINS =')
    } | ConvertTo-Json -Compress
} finally {
    Remove-Item -LiteralPath $outputPath -Force -ErrorAction SilentlyContinue
}
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
        self.assertEqual(result, {"labels": True, "domains": True, "defaults": True})


if __name__ == "__main__":
    unittest.main()
