import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from build_environment import system_environment
from private_files import protect_directory, secret_file


class PrivateFileTests(unittest.TestCase):
    def test_real_private_directory_and_secret_file_permissions_without_admin_privilege(self):
        root = Path(tempfile.mkdtemp(prefix='sba-private-', dir=os.environ['EASYEMAIL_TEST_ROOT']))
        environment = system_environment()
        protect_directory(root, environment)
        with secret_file(root / 'private.json') as file: file.write('{"synthetic":true}\n')
        if os.name != 'nt':
            self.assertEqual(root.stat().st_mode & 0o777, 0o700)
            self.assertEqual((root / 'private.json').stat().st_mode & 0o777, 0o600)
            return
        script = r'''
$ErrorActionPreference='Stop'
$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$file=Get-Acl -LiteralPath $env:EASYEMAIL_ACL_TEST_FILE
$rules=@($file.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]))
@{count=$rules.Count;principals=@($rules | ForEach-Object {$_.IdentityReference.Value});sid=$sid;
  full=@($rules | Where-Object {$_.AccessControlType -eq 'Allow' -and $_.FileSystemRights -eq 'FullControl'}).Count} | ConvertTo-Json -Compress
'''
        output = subprocess.check_output(['C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script],
                                         cwd=root, env={**environment, 'EASYEMAIL_ACL_TEST_FILE': str(root / 'private.json')}, timeout=30)
        value = json.loads(output)
        self.assertEqual(value['count'], 2); self.assertEqual(value['full'], 2)
        self.assertEqual(set(value['principals']), {value['sid'], 'S-1-5-18'})


if __name__ == '__main__': unittest.main()
