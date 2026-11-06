"""Restrict the application-owned secret directory before creating any secret file."""
import os
import subprocess
from pathlib import Path

from boundary import DeploymentError, require


def protect_directory(directory, environment):
    directory = Path(directory)
    if os.name != 'nt':
        directory.chmod(0o700)
        require(directory.stat().st_mode & 0o777 == 0o700, 'EASYEMAIL_PRIVATE_DIRECTORY_FAILED')
        return
    script = r"""
$ErrorActionPreference='Stop'
$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User
$system=New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')
$acl=New-Object System.Security.AccessControl.DirectorySecurity
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true,$false)
foreach($principal in @($sid,$system)) {
  $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($principal,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
  $acl.AddAccessRule($rule)
}
# Persist only the access/owner sections modified above. Set-Acl can request SACL privilege unnecessarily.
([System.IO.DirectoryInfo]::new($env:EASYEMAIL_PRIVATE_DIRECTORY)).SetAccessControl($acl)
$actual=Get-Acl -LiteralPath $env:EASYEMAIL_PRIVATE_DIRECTORY
if(-not $actual.AreAccessRulesProtected) { throw 'unprotected-directory' }
$rules=$actual.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])
if(@($rules).Count -ne 2) { throw 'unexpected-access-rules' }
foreach($rule in $rules) {
  if($rule.IdentityReference.Value -notin @($sid.Value,$system.Value) -or $rule.IsInherited -or $rule.AccessControlType -ne 'Allow') { throw 'unexpected-access-rule' }
}
"""
    system = environment.get('SystemRoot', environment.get('SYSTEMROOT', 'C:/Windows'))
    executable = Path(system) / 'System32/WindowsPowerShell/v1.0/powershell.exe'
    try:
        result = subprocess.run([str(executable), '-NoProfile', '-NonInteractive', '-Command', script],
                                env={**environment, 'EASYEMAIL_PRIVATE_DIRECTORY': str(directory.resolve())},
                                cwd=directory, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        raise DeploymentError('EASYEMAIL_PRIVATE_DIRECTORY_FAILED') from None
    require(result.returncode == 0, 'EASYEMAIL_PRIVATE_DIRECTORY_FAILED')


def secret_file(path):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    return os.fdopen(descriptor, 'w', encoding='utf8', newline='\n')
