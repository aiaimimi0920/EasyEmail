import json
import os
import sys
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import prewrite_update_repair
from boundary import DeploymentError
from contract import validated_request
from fixtures import repair_request
from test_contract import ContractTests, ROOT
from test_deploy_secrets import secret_environment

SCRATCH = Path(os.environ.get('EASYEMAIL_TEST_ROOT', tempfile.gettempdir()))


def prewrite_update_request():
    value = repair_request()
    value['previous'] = {'sourceSha': 'd' * 40, 'applicationVersion': '1.0.15'}
    value['context'].update(repairId='complete-prewrite-update', errorCode='EASYEMAIL_SOURCE_DATABASE_CHANGED')
    return value


class PrewriteUpdateRepairTests(unittest.TestCase):
    def test_contract_accepts_prewrite_update_repair_and_rejects_wrong_error(self):
        value = prewrite_update_request()
        with patch('contract.subprocess.check_output', side_effect=ContractTests().git):
            self.assertEqual(validated_request(value, ROOT), value)
        invalid = prewrite_update_request()
        invalid['context']['errorCode'] = 'EASYEMAIL_WORKER_DEPLOY_FAILED'
        with patch('contract.subprocess.check_output', side_effect=ContractTests().git), self.assertRaises(DeploymentError):
            validated_request(invalid, ROOT)

    def run_repair(self, failure=None, parent_backup=False, active_version='1.0.14', active_sha='a' * 40):
        root = Path(tempfile.mkdtemp(prefix='sba-prewrite-update-', dir=SCRATCH))
        request = prewrite_update_request(); events = []
        def step(name, result=None):
            def invoke(*args, **kwargs):
                events.append(name)
                if failure == name: raise DeploymentError('EASYEMAIL_SYNTHETIC_FAILURE')
                return result
            return invoke
        class Store:
            def __init__(self, config, secret, state): self.state = state
            def list(self, bucket):
                events.append('list-' + bucket)
                if parent_backup:
                    return [{'key': '_easyemail-sba/backups/parent.eesba',
                             'customMetadata': {'task': request['context']['parentTaskId']}}]
                return [{'key': '_easyemail-sba/backups/older.eesba', 'customMetadata': {'task': 'dc-' + '9' * 32}}]
        class Process:
            def __init__(self, req, release, directory, state, material): self.state = state
            def verify_seal(self): events.append('seal')
            def migrate_platform(self):
                events.append('migrations'); self.state.before_write('platform-migrations-applied')
                if failure == 'migrations': raise DeploymentError('EASYEMAIL_SYNTHETIC_FAILURE')
            def publish(self, role):
                events.append('publish-' + role); self.state.before_write(role + '-published')
                if failure == 'publish-' + role: raise DeploymentError('EASYEMAIL_SYNTHETIC_FAILURE')
        def backup(*args, **kwargs):
            events.append('backup')
            self.assertEqual(kwargs.get('attempts'), 3)
            self.assertEqual(args[2]['applicationVersion'], active_version)
            self.assertEqual(args[2]['sourceSha'], active_sha)
            if failure == 'backup-prewrite': raise DeploymentError('EASYEMAIL_SOURCE_DATABASE_CHANGED')
            args[1].state.before_write('snapshot-archive-persisted')
            return {'manifest': {'synthetic': True}, 'directory': root, 'id': 'f' * 64, 'createdAt': 1,
                    'object': {'key': '_easyemail-sba/backups/new.eesba'}}
        marker = json.dumps({'applicationId': 'easyemail', 'applicationVersion': active_version, 'sourceSha': active_sha}).encode('utf8')
        with ExitStack() as stack:
            stack.enter_context(patch.dict(os.environ, secret_environment()))
            stack.enter_context(patch.object(prewrite_update_repair, 'ReleaseReader',
                                             return_value=type('Reader', (), {'read': staticmethod(lambda *a, **k: marker)})()))
            builds = stack.enter_context(patch.object(prewrite_update_repair, 'prepare_release', return_value=root / 'release'))
            stack.enter_context(patch.object(prewrite_update_repair, 'DeploymentProcess', Process))
            stack.enter_context(patch.object(prewrite_update_repair, 'ObjectStore', Store))
            stack.enter_context(patch.object(prewrite_update_repair, 'CloudApi'))
            stack.enter_context(patch.object(prewrite_update_repair, 'RuntimeClient'))
            stack.enter_context(patch.object(prewrite_update_repair, 'capture_backup', side_effect=backup))
            for name, value in [('verify_uploaded_worker', None), ('managed_state', {'domains': 'domains'}),
                                ('verify_settings', None), ('email_version', None), ('migrate_email', None),
                                ('verify_database_initialization', None), ('prove_update_preserved', None),
                                ('verify_administrator', None),
                                ('verify_public', [{'id': 'public-verified', 'passed': True}])]:
                stack.enter_context(patch.object(prewrite_update_repair, name, side_effect=step(name, value)))
            result = prewrite_update_repair.repair_prewrite_update(request, root / 'operation')
            if builds.called:
                self.assertEqual(builds.call_args_list[0].kwargs, {'fetch_source': True})
        return result, events

    def test_proves_unmodified_active_release_and_absent_parent_backup_before_upgrading(self):
        result, events = self.run_repair()
        self.assertEqual(result['status'], 'succeeded')
        self.assertLess(events.index('list-OUTBOX'), events.index('backup'))
        self.assertLess(events.index('backup'), events.index('migrations'))
        self.assertLess(events.index('publish-email'), events.index('migrate_email'))
        self.assertLess(events.index('prove_update_preserved'), events.index('verify_administrator'))
        self.assertTrue({'parent-prewrite-abort-verified', 'backup-created', 'data-preserved', 'repair-completed'}
                        <= {row['id'] for row in result['checks']})

    def test_existing_parent_backup_or_already_published_parent_blocks_repair_without_writes(self):
        result, events = self.run_repair(parent_backup=True)
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(result['errorCode'], 'EASYEMAIL_PARENT_BACKUP_ALREADY_PERSISTED')
        self.assertNotIn('backup', events); self.assertNotIn('migrations', events)
        result, events = self.run_repair(active_version='1.0.15', active_sha='d' * 40)
        self.assertEqual(result['status'], 'failed')
        self.assertNotIn('backup', events)

    def test_post_backup_failure_returns_unknown_without_replay(self):
        for stage in ('migrations', 'publish-email', 'prove_update_preserved', 'verify_administrator'):
            result, events = self.run_repair(failure=stage)
            self.assertEqual(result['status'], 'unknown')
            self.assertLessEqual(events.count('publish-email'), 1)


if __name__ == '__main__': unittest.main()
