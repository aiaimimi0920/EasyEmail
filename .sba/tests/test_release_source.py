"""Exercise the actual Git shallow boundary without running package builds or cloud writes."""
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import release
from boundary import DeploymentError
from build_environment import BuildRunner, local_git_environment


SCRATCH = Path(os.environ.get('EASYEMAIL_TEST_ROOT', tempfile.gettempdir()))


class ReleaseSourceTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix='sba-source-', dir=SCRATCH))
        self.repository = self.root / 'origin'; self.repository.mkdir()
        self.git('init', '--quiet', cwd=self.repository)
        self.git('config', 'user.name', 'Fixture', cwd=self.repository)
        self.git('config', 'user.email', 'fixture@example.invalid', cwd=self.repository)
        self.parent = self.commit('parent')
        self.current = self.commit('current')
        self.shallow = self.root / 'shallow'
        self.git('clone', '--quiet', '--depth=1', self.repository.as_uri(), self.shallow)

    def git(self, *args, cwd=None):
        return subprocess.check_output(['git', *map(str, args)], cwd=cwd or self.root,
                                       env=local_git_environment(), stderr=subprocess.DEVNULL, encoding='utf8').strip()

    def commit(self, text):
        (self.repository / 'witness.txt').write_text(text, encoding='utf8')
        self.git('add', 'witness.txt', cwd=self.repository)
        self.git('commit', '--quiet', '-m', text, cwd=self.repository)
        return self.git('rev-parse', 'HEAD', cwd=self.repository)

    def checkout(self, sha, fetch_source=False):
        commands = []; repository = self.repository

        class Runner(BuildRunner):
            def run(self, command, cwd, label, timeout=900):
                commands.append((list(map(str, command)), label))
                if label == 'application-origin':
                    command = [*command[:-1], repository.as_uri()]
                return super().run(command, cwd, label, timeout)

        output = self.root / ('build-' + str(len(list(self.root.glob('build-*')))))
        runner = Runner(output)
        with patch.object(release, 'ROOT', self.shallow):
            source = release.checkout_application(runner, runner.executable('git'), output, sha, fetch_source=fetch_source)
        return source, commands

    def test_default_checkout_uses_only_authorized_current_source_without_fetch(self):
        source, commands = self.checkout(self.current)
        self.assertEqual(self.git('rev-parse', 'HEAD', cwd=source), self.current)
        self.assertNotIn('application-fetch', [label for _, label in commands])

    def test_parent_is_missing_by_default_but_exact_fetch_recovers_it_from_shallow_root(self):
        self.assertEqual(self.git('rev-parse', '--is-shallow-repository', cwd=self.shallow), 'true')
        with self.assertRaisesRegex(DeploymentError, 'EASYEMAIL_BUILD_FAILED'):
            self.checkout(self.parent)
        source, commands = self.checkout(self.parent, fetch_source=True)
        self.assertEqual(self.git('rev-parse', 'HEAD', cwd=source), self.parent)
        self.assertEqual((source / 'witness.txt').read_text(encoding='utf8'), 'parent')
        fetches = [command for command, label in commands if label == 'application-fetch']
        self.assertEqual(len(fetches), 1)
        self.assertEqual(fetches[0][1:], ['-c', 'http.sslVerify=true', 'fetch', '--depth=1', 'origin', self.parent])
        origins = [command[-1] for command, label in commands if label == 'application-origin']
        self.assertEqual(origins, ['https://github.com/aiaimimi0920/EasyEmail.git'])

    def test_unavailable_exact_parent_fails_instead_of_using_current_or_branch_tip(self):
        with self.assertRaisesRegex(DeploymentError, 'EASYEMAIL_BUILD_FAILED'):
            self.checkout('0' * 40, fetch_source=True)
