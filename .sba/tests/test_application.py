import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import application
from boundary import DeploymentError
from build_environment import BuildRunner, build_environment
from fixtures import request, repair_request, preview_repair_request


LOCAL_SCRATCH = Path('C:/Users/Public/nas_home/AI/GameEditor/linshi')
SCRATCH = Path(os.environ.get('EASYEMAIL_TEST_ROOT', str(LOCAL_SCRATCH if LOCAL_SCRATCH.is_dir() else tempfile.gettempdir())))


class ApplicationTests(unittest.TestCase):
    def test_repair_is_an_independent_dispatch_with_a_required_directory(self):
        value = repair_request()
        with self.assertRaisesRegex(DeploymentError, 'EASYEMAIL_DEPLOYMENT_DIRECTORY_REQUIRED'): application.run(value)
        with patch.object(application, 'repair', return_value={'status': 'unknown', 'checks': []}) as selected:
            self.assertEqual(application.run(value, SCRATCH / 'repair-operation')['status'], 'unknown')
        selected.assert_called_once_with(value, SCRATCH / 'repair-operation')

    def test_preview_repair_uses_its_own_dispatch_without_bootstrap_or_replay(self):
        value = preview_repair_request()
        with patch.object(application, 'repair_preview', return_value={'status': 'unknown', 'checks': []}) as selected, \
                patch.object(application, 'repair') as bootstrap:
            self.assertEqual(application.run(value, SCRATCH / 'preview-repair-operation')['status'], 'unknown')
        selected.assert_called_once_with(value, SCRATCH / 'preview-repair-operation'); bootstrap.assert_not_called()

    def test_partial_publication_has_independent_dispatch_not_a_deploy_replay(self):
        value = repair_request(); value['context']['repairId'] = 'complete-fresh-publication'
        with patch.object(application, 'repair_publication', return_value={'status': 'unknown', 'checks': []}) as selected, \
                patch.object(application, 'deploy') as deploy, patch.object(application, 'repair') as bootstrap:
            self.assertEqual(application.run(value, SCRATCH / 'publication-operation')['status'], 'unknown')
        selected.assert_called_once_with(value, SCRATCH / 'publication-operation')
        deploy.assert_not_called(); bootstrap.assert_not_called()

    def test_destroy_preview_requires_a_directory_and_preserves_unknown_without_replay(self):
        value = request('destroy-preview')
        with self.assertRaisesRegex(DeploymentError, 'EASYEMAIL_DEPLOYMENT_DIRECTORY_REQUIRED'): application.run(value)
        with patch.object(application, 'destroy_preview', return_value={'status': 'unknown', 'checks': []}) as selected:
            self.assertEqual(application.run(value, SCRATCH / 'destroy-preview-operation')['status'], 'unknown')
        selected.assert_called_once_with(value, SCRATCH / 'destroy-preview-operation')

    def test_preview_dispatch_requires_a_directory(self):
        with self.assertRaisesRegex(DeploymentError, 'EASYEMAIL_DEPLOYMENT_DIRECTORY_REQUIRED'): application.run(request('preview'))
        value = request('preview')
        with patch.object(application, 'preview', return_value={'status': 'unknown', 'checks': []}) as selected:
            self.assertEqual(application.run(value, SCRATCH / 'preview-operation')['status'], 'unknown')
        selected.assert_called_once_with(value, SCRATCH / 'preview-operation')

    def test_update_dispatches_only_with_an_explicit_operation_directory(self):
        with self.assertRaisesRegex(DeploymentError, 'EASYEMAIL_DEPLOYMENT_DIRECTORY_REQUIRED'): application.run(request('update'))
        with patch.object(application, 'update', return_value={'status': 'unknown', 'checks': []}) as selected:
            value = request('update'); result = application.run(value, SCRATCH / 'synthetic-operation')
        self.assertEqual(result['status'], 'unknown'); selected.assert_called_once_with(value, SCRATCH / 'synthetic-operation')

    def test_verify_takes_public_branch_without_tools_or_secret_parsing(self):
        with patch.object(application, 'verify_public', return_value=[{'id': 'public-check', 'passed': True}]) as verify:
            self.assertEqual(application.run(request('verify'))['status'], 'succeeded')
        verify.assert_called_once()

    def test_atomically_written_safe_receipt_and_existing_result_is_not_replayed(self):
        root = Path(tempfile.mkdtemp(prefix='easyemail-sba-receipt-', dir=SCRATCH))
        source, result = root / 'request.json', root / 'result.json'
        source.write_text(json.dumps(request()), encoding='utf8')
        with patch.object(application, 'validated_request', side_effect=DeploymentError('EASYEMAIL_SOURCE_DIRTY')):
            self.assertEqual(application.execute(source, result), 1)
        value = json.loads(result.read_text(encoding='utf8'))
        self.assertEqual(value['status'], 'failed'); self.assertEqual(value['errorCode'], 'EASYEMAIL_SOURCE_DIRTY')
        self.assertFalse(result.read_bytes().startswith(b'\xef\xbb\xbf'))
        self.assertFalse((root / 'result.json.pending').exists())
        with self.assertRaisesRegex(DeploymentError, 'EASYEMAIL_RESULT_PATH_INVALID'):
            application.execute(source, result)

    def test_unexpected_error_does_not_publish_exception_or_environment(self):
        root = Path(tempfile.mkdtemp(prefix='easyemail-sba-safe-error-', dir=SCRATCH))
        source, result = root / 'request.json', root / 'result.json'
        source.write_text(json.dumps(request()), encoding='utf8')
        with patch.object(application, 'validated_request', side_effect=RuntimeError('synthetic-secret-must-not-leak')):
            application.execute(source, result)
        self.assertNotIn('synthetic-secret', result.read_text(encoding='utf8'))
        self.assertEqual(json.loads(result.read_text())['errorCode'], 'EASYEMAIL_UNEXPECTED_FAILURE')

    def test_deployed_unverified_uses_zero_exit_code_to_preserve_the_standard_receipt(self):
        root = Path(tempfile.mkdtemp(prefix='easyemail-sba-unverified-', dir=SCRATCH))
        source, result = root / 'request.json', root / 'result.json'
        source.write_text(json.dumps(request()), encoding='utf8')
        with patch.object(application, 'validated_request', return_value=request()), patch.object(application, 'run',
                return_value={'status': 'deployed-unverified', 'checks': [], 'errorCode': 'EASYEMAIL_PUBLIC_VERIFICATION_FAILED'}):
            self.assertEqual(application.execute(source, result), 0)
        self.assertEqual(json.loads(result.read_text())['status'], 'deployed-unverified')

    def test_duplicate_json_and_bom_rejected(self):
        root = Path(tempfile.mkdtemp(prefix='easyemail-sba-json-', dir=SCRATCH))
        for body in [b'{"action":"verify","action":"deploy"}', b'\xef\xbb\xbf{}', b'[]']:
            source = root / ('request-' + str(len(body)) + '.json'); source.write_bytes(body)
            with self.assertRaises(DeploymentError):
                application.read_request(source)

    def test_build_environment_is_allowlisted_and_isolated(self):
        root = Path(tempfile.mkdtemp(prefix='easyemail-sba-env-', dir=SCRATCH))
        env = build_environment(root, {'PATH': os.environ['PATH'], 'SystemRoot': os.environ.get('SystemRoot', ''),
                                      'CLOUDFLARE_API_TOKEN': 'secret', 'EE_MASTER_KEY': 'secret', 'GITHUB_TOKEN': 'secret',
                                      'NODE_OPTIONS': '--require=untrusted', 'NPM_CONFIG_REGISTRY': 'https://untrusted.example.com',
                                      'GIT_CONFIG_COUNT': '1', 'HTTPS_PROXY': 'https://user:secret@untrusted.example.com'})
        self.assertFalse(any(value == 'secret' or 'untrusted' in value for value in env.values()))
        self.assertNotEqual(env['HOME'], os.environ.get('HOME'))
        self.assertEqual(env['GIT_CONFIG_NOSYSTEM'], '1')
        self.assertTrue(Path(env['NPM_CONFIG_USERCONFIG']).is_file())
        for key in ('APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME'):
            self.assertTrue(Path(env[key]).is_dir())
            self.assertTrue(Path(env[key]).is_relative_to(root))

    def test_actual_node_child_cannot_read_parent_secrets_or_node_options(self):
        root = Path(tempfile.mkdtemp(prefix='easyemail-sba-child-', dir=SCRATCH)) / 'build'
        with patch.dict(os.environ, {'CLOUDFLARE_API_TOKEN': 'secret', 'EE_ADMIN_PASSWORD': 'secret',
                                    'NODE_OPTIONS': '--require=untrusted', 'GITHUB_TOKEN': 'secret'}):
            runner = BuildRunner(root)
            value = runner.output([runner.executable('node'), '-e',
                'console.log(JSON.stringify([process.env.CLOUDFLARE_API_TOKEN, process.env.EE_ADMIN_PASSWORD, process.env.GITHUB_TOKEN, process.env.NODE_OPTIONS]))'], root)
        self.assertEqual(json.loads(value), [None, None, None, None])


if __name__ == '__main__':
    unittest.main()
