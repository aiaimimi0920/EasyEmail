import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from build_environment import system_environment
from boundary import DeploymentError
from private_files import protect_directory, secret_file


class PrivateFileTests(unittest.TestCase):
    def test_windows_acl_uses_dotnet_without_autoloading_shell_modules(self):
        root = Path(tempfile.mkdtemp(prefix='sba-private-', dir=os.environ['EASYEMAIL_TEST_ROOT']))
        environment = {'SystemRoot': 'C:/Windows'}
        with patch('private_files.os', SimpleNamespace(name='nt')), patch('private_files.Path', side_effect=lambda value: root if value == root else Path(value)):
            with patch('private_files.subprocess.run', return_value=SimpleNamespace(returncode=0)) as run:
                protect_directory(root, environment)
            args = run.call_args.args[0]; options = run.call_args.kwargs
            self.assertIn('GetAccessControl(', args[-1])
            self.assertIn("$PSModuleAutoLoadingPreference='None'", args[-1])
            for cmdlet in ('Get-Acl', 'Set-Acl', 'New-Object'):
                self.assertNotIn(cmdlet, args[-1])
            self.assertEqual(options['env'], {**environment, 'EASYEMAIL_PRIVATE_DIRECTORY': str(root.resolve())})
            self.assertEqual(options['timeout'], 30)
            self.assertEqual(options['stdin'], subprocess.DEVNULL)
            for failure in (SimpleNamespace(returncode=1), subprocess.TimeoutExpired(args, 30)):
                with self.subTest(failure=type(failure).__name__):
                    setting = {'side_effect': failure} if isinstance(failure, Exception) else {'return_value': failure}
                    with patch('private_files.subprocess.run', **setting), self.assertRaisesRegex(DeploymentError, 'EASYEMAIL_PRIVATE_DIRECTORY_FAILED'):
                        protect_directory(root, environment)

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
$PSModuleAutoLoadingPreference='None'
$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$file=([System.IO.FileInfo]::new($env:EASYEMAIL_ACL_TEST_FILE)).GetAccessControl()
$rules=@($file.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]))
[Console]::Out.WriteLine($sid)
foreach($rule in $rules) {
  [Console]::Out.WriteLine($rule.IdentityReference.Value+'|'+$rule.AccessControlType+'|'+$rule.FileSystemRights)
}
'''
        output = subprocess.check_output(['C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script],
                                         cwd=root, env={**environment, 'EASYEMAIL_ACL_TEST_FILE': str(root / 'private.json')}, timeout=30)
        lines = output.decode('utf8').splitlines()
        self.assertEqual(len(lines), 3)
        self.assertEqual(set(lines[1:]), {lines[0] + '|Allow|FullControl', 'S-1-5-18|Allow|FullControl'})


if __name__ == '__main__': unittest.main()
