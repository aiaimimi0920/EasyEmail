import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from boundary import DeploymentError
from cloud_transport import OperationState
from deployment_process import DeploymentProcess
from deployment_secrets import deployment_secrets
from fixtures import request
from test_deploy_secrets import secret_environment


SCRATCH = Path(os.environ.get('EASYEMAIL_TEST_ROOT', tempfile.gettempdir()))


class DeploymentProcessTests(unittest.TestCase):
    def process(self):
        root = Path(tempfile.mkdtemp(prefix='sba-publish-', dir=SCRATCH)); release = root / 'release'; release.mkdir()
        (release / 'sba-release.json').write_text('{"synthetic":true}\n', encoding='utf8')
        value = request(); material = deployment_secrets(value['configuration'], secret_environment())
        return DeploymentProcess(value, release, root / 'cloud', OperationState(root, value['taskId']), material)

    def test_verify_has_no_credentials_publish_only_receives_cloud_token_and_own_secret_file(self):
        process = self.process(); calls = []

        def run(args, **options):
            calls.append((args, options))
            if '--secrets-file' in args:
                path = Path(args[args.index('--secrets-file') + 1])
                self.assertEqual(json.loads(path.read_text()), process.material.workers['email'])
            return SimpleNamespace(returncode=0)

        with patch('deployment_process.subprocess.run', side_effect=run), patch.dict(os.environ, {'GITHUB_TOKEN': 'private', 'EE_MASTER_KEY': 'private'}):
            process.publish('email')
        self.assertEqual(len(calls), 2)
        self.assertNotIn('CLOUDFLARE_API_TOKEN', calls[0][1]['env'])
        self.assertEqual(calls[1][1]['env']['CLOUDFLARE_API_TOKEN'], process.material.token)
        for args, options in calls:
            self.assertNotIn('GITHUB_TOKEN', options['env']); self.assertNotIn('EE_MASTER_KEY', options['env'])
            self.assertNotIn(process.material.token, ' '.join(args))
        self.assertFalse((process.directory / 'email-secrets.json').exists())

    def test_publish_failure_removes_private_file_and_stays_mutation_unknown(self):
        process = self.process()
        with patch('deployment_process.subprocess.run', side_effect=[SimpleNamespace(returncode=0), SimpleNamespace(returncode=1)]):
            with self.assertRaisesRegex(DeploymentError, 'EASYEMAIL_WORKER_DEPLOY_FAILED'):
                process.publish('platform')
        self.assertTrue(process.state.attempted)
        self.assertFalse((process.directory / 'platform-secrets.json').exists())
        self.assertEqual(process.state.value['writes'], ['platform-worker-published'])

    def test_schema_commands_use_explicit_remote_config_and_are_not_replayed(self):
        process = self.process()
        with patch('deployment_process.subprocess.run', return_value=SimpleNamespace(returncode=0)) as runner:
            process.initialize_databases()
        calls = [call.args[0] for call in runner.call_args_list]
        self.assertIn('execute', calls[1]); self.assertIn('--remote', calls[1]); self.assertIn('--config', calls[1])
        self.assertIn('migrations', calls[2]); self.assertIn('--remote', calls[2]); self.assertIn('--config', calls[2])
        with patch('deployment_process.subprocess.run', return_value=SimpleNamespace(returncode=0)) as runner:
            with self.assertRaisesRegex(DeploymentError, 'EASYEMAIL_WRITE_REPLAY_REFUSED'):
                process.initialize_databases()
        self.assertEqual(runner.call_count, 1)

    def test_update_only_applies_platform_migrations_and_never_reinitializes_email_schema(self):
        process = self.process()
        with patch('deployment_process.subprocess.run', return_value=SimpleNamespace(returncode=0)) as runner:
            process.migrate_platform()
        calls = [call.args[0] for call in runner.call_args_list]
        self.assertEqual(len(calls), 2)
        self.assertIn('migrations', calls[1]); self.assertIn('--remote', calls[1])
        self.assertNotIn('execute', calls[1]); self.assertNotIn('--file', calls[1])
        self.assertEqual(calls[1][-1], str(process.release / 'publish/platform/wrangler.json'))


    def test_restore_uses_sealed_role_config_and_never_replays_import(self):
        process = self.process(); sql = process.directory / 'synthetic.sql'
        with patch('deployment_process.subprocess.run', return_value=SimpleNamespace(returncode=0)) as runner:
            process.restore_database('platform', sql)
        args = runner.call_args.args[0]
        self.assertIn('--remote', args); self.assertIn('--file', args); self.assertEqual(args[-1], str(sql))
        self.assertIn(str(process.release / 'publish/platform/wrangler.json'), args)
        with patch('deployment_process.subprocess.run', return_value=SimpleNamespace(returncode=0)) as runner:
            with self.assertRaisesRegex(DeploymentError, 'EASYEMAIL_WRITE_REPLAY_REFUSED'): process.restore_database('platform', sql)
        self.assertEqual(runner.call_count, 1)


if __name__ == '__main__':
    unittest.main()
