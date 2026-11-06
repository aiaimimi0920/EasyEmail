"""Credential-free subprocess environment for public source and reproducible builds."""
import os
import re
import shutil
import subprocess
from pathlib import Path

from boundary import DeploymentError, require


def system_environment(inherited=None):
    inherited = os.environ if inherited is None else inherited
    # An allowlist also excludes NODE_OPTIONS, Git hooks/config injection and npm auth configuration.
    keep = {'path', 'pathext', 'systemroot', 'windir', 'comspec', 'processor_architecture', 'number_of_processors'}
    return {key: value for key, value in inherited.items() if key.lower() in keep}


def local_git_environment():
    return {**system_environment(), 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_TERMINAL_PROMPT': '0'}


def build_environment(directory, inherited=None):
    result = system_environment(inherited)
    home, temporary = directory / 'home', directory / 'temporary'
    home.mkdir(); temporary.mkdir()
    config = home / 'empty-config'; config.write_text('', encoding='utf8')
    result.update(HOME=str(home), USERPROFILE=str(home), APPDATA=str(home / 'AppData/Roaming'),
                  LOCALAPPDATA=str(home / 'AppData/Local'), TEMP=str(temporary), TMP=str(temporary),
                  XDG_CONFIG_HOME=str(home / '.config'), XDG_CACHE_HOME=str(home / '.cache'),
                  GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=str(config), GIT_TERMINAL_PROMPT='0',
                  NPM_CONFIG_USERCONFIG=str(config), NPM_CONFIG_GLOBALCONFIG=str(home / 'npm-global-config'),
                  NPM_CONFIG_CACHE=str(home / 'npm-cache'), COREPACK_ENABLE_PROJECT_SPEC='0',
                  CI='true', PYTHONUTF8='1', PYTHONDONTWRITEBYTECODE='1', WRANGLER_SEND_METRICS='false',
                  WRANGLER_LOG_PATH=str(directory / 'wrangler.log'))
    # Windows native tools resolve known folders only when these isolated directories exist.
    for key in ('APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME'):
        Path(result[key]).mkdir(parents=True, exist_ok=True)
    return result


class BuildRunner:
    def __init__(self, directory):
        self.directory = Path(directory).resolve()
        self.directory.mkdir()
        self.env = build_environment(self.directory)
        self.logs = self.directory / 'logs'; self.logs.mkdir()

    def run(self, command, cwd, label, timeout=900):
        require(re.fullmatch(r'[a-z0-9-]+', label) and Path(cwd).resolve().is_relative_to(self.directory), 'EASYEMAIL_BUILD_PATH_INVALID')
        with (self.logs / (label + '.stdout.log')).open('xb') as stdout, (self.logs / (label + '.stderr.log')).open('xb') as stderr:
            try:
                result = subprocess.run(list(map(str, command)), cwd=cwd, env=self.env, stdin=subprocess.DEVNULL,
                                        stdout=stdout, stderr=stderr, timeout=timeout, check=False)
            except (OSError, subprocess.TimeoutExpired):
                raise DeploymentError('EASYEMAIL_BUILD_FAILED') from None
        require(result.returncode == 0, 'EASYEMAIL_BUILD_FAILED')

    def output(self, command, cwd):
        require(Path(cwd).resolve().is_relative_to(self.directory), 'EASYEMAIL_BUILD_PATH_INVALID')
        try:
            return subprocess.check_output(list(map(str, command)), cwd=cwd, env=self.env, stdin=subprocess.DEVNULL,
                                           stderr=subprocess.DEVNULL, timeout=30, encoding='utf8').strip()
        except (OSError, subprocess.SubprocessError):
            raise DeploymentError('EASYEMAIL_BUILD_FAILED') from None

    def executable(self, name):
        value = shutil.which(name, path=self.env.get('PATH', self.env.get('Path', '')))
        require(value, 'EASYEMAIL_TOOLCHAIN_UNAVAILABLE')
        return value
