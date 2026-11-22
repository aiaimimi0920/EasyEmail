import os
import sys
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import update_deploy
from boundary import DeploymentError
from fixtures import request
from test_deploy_secrets import secret_environment


class UpdateTests(unittest.TestCase):
    def update(self, fail=None, mutation=False, drift=False):
        root = Path(tempfile.mkdtemp(prefix='sba-update-', dir=os.environ['EASYEMAIL_TEST_ROOT']))
        value = request('update'); value['applicationVersion'] = '1.0.1'; value['sourceSha'] = 'c' * 40
        events = []
        def step(name, result=None):
            def run(*args, **kwargs):
                events.append(name)
                if fail == name: raise DeploymentError('EASYEMAIL_SYNTHETIC_FAILURE')
                return result
            return run
        class Process:
            def __init__(self, request, release, directory, state, material): self.state = state
            def verify_seal(self): events.append('seal')
            def migrate_platform(self):
                events.append('migrations'); self.state.before_write('platform-migrations-applied')
                if mutation: raise DeploymentError('EASYEMAIL_SYNTHETIC_FAILURE')
            def publish(self, role): events.append(role); self.state.before_write(role + '-published')
        def backup(*args, **kwargs):
            events.append('backup')
            if fail == 'backup': raise DeploymentError('EASYEMAIL_SYNTHETIC_FAILURE')
            args[1].state.before_write('snapshot-archive-persisted')
            if fail == 'backup-partial': raise DeploymentError('EASYEMAIL_SYNTHETIC_FAILURE')
            return {'manifest': {'synthetic': True}, 'directory': root, 'id': 'a' * 64, 'createdAt': 1,
                    'object': {'key': '_easyemail-sba/backups/synthetic'}}
        state = {'resources': 'a' * 64, 'domains': {}, 'routing': None}
        def managed(*args):
            events.append('managed')
            if fail == 'managed': raise DeploymentError('EASYEMAIL_SYNTHETIC_FAILURE')
            return {**state, 'resources': 'b' * 64} if drift and events.count('managed') > 1 else state
        with ExitStack() as stack:
            stack.enter_context(patch.dict(os.environ, secret_environment()))
            stack.enter_context(patch.object(update_deploy, 'prepare_release', return_value=root / 'release'))
            stack.enter_context(patch.object(update_deploy, 'DeploymentProcess', Process))
            stack.enter_context(patch.object(update_deploy, 'CloudApi'))
            stack.enter_context(patch.object(update_deploy, 'RuntimeClient'))
            stack.enter_context(patch.object(update_deploy, 'managed_state', side_effect=managed))
            stack.enter_context(patch.object(update_deploy, 'capture_backup', side_effect=backup))
            def store(config, secret, operation):
                class Store: state = operation
                return Store()
            stack.enter_context(patch.object(update_deploy, 'ObjectStore', side_effect=store))
            for name in ('verify_settings', 'email_version', 'migrate_email', 'verify_database_initialization', 'prove_update_preserved', 'verify_administrator'):
                stack.enter_context(patch.object(update_deploy, name, side_effect=step(name)))
            def public(request):
                return step('old-public' if request['sourceSha'] == 'b' * 40 else 'new-public', [{'id': 'public-proof', 'passed': True}])()
            stack.enter_context(patch.object(update_deploy, 'verify_public', side_effect=public))
            result = update_deploy.update(value, root / 'operation')
        return result, events

    def test_backup_precedes_all_upgrade_writes_and_preservation_precedes_success(self):
        result, events = self.update()
        self.assertEqual(result['status'], 'succeeded')
        self.assertLess(events.index('old-public'), events.index('backup'))
        self.assertLess(events.index('backup'), events.index('migrations'))
        self.assertLess(events.index('email'), events.index('migrate_email'))
        self.assertLess(events.index('migrate_email'), events.index('platform'))
        self.assertLess(events.index('prove_update_preserved'), events.index('verify_administrator'))
        self.assertTrue({'backup-created', 'data-preserved'} <= {row['id'] for row in result['checks']})
        self.assertNotIn('lifecycle', result); self.assertNotIn('synthetic', str(result))

    def test_preflight_or_backup_failure_never_publishes_or_migrates(self):
        for stage in ('old-public', 'managed', 'email_version', 'backup'):
            result, events = self.update(fail=stage)
            self.assertEqual(result['status'], 'failed')
            self.assertNotIn('migrations', events); self.assertNotIn('email', events)
            self.assertNotIn('backup-created', {row['id'] for row in result['checks']})

    def test_migration_failure_and_any_post_backup_uncertainty_are_unknown_without_replay(self):
        result, events = self.update(mutation=True)
        self.assertEqual(result['status'], 'unknown'); self.assertEqual(events.count('migrations'), 1)
        for stage in ('migrate_email', 'prove_update_preserved', 'verify_administrator'):
            result, events = self.update(fail=stage)
            self.assertEqual(result['status'], 'unknown')
            if stage == 'prove_update_preserved': self.assertNotIn('data-preserved', {row['id'] for row in result['checks']})
        result, events = self.update(fail='backup-partial')
        self.assertEqual(result['status'], 'unknown'); self.assertNotIn('migrations', events)

    def test_resource_drift_after_backup_stops_upgrade(self):
        result, events = self.update(drift=True)
        self.assertEqual(result['status'], 'unknown'); self.assertNotIn('migrations', events)
        self.assertEqual(result['errorCode'], 'EASYEMAIL_INSTANCE_CHANGED')

    def test_only_final_public_failure_after_data_and_private_acceptance_is_deployed_unverified(self):
        result, events = self.update(fail='new-public')
        self.assertEqual(result['status'], 'deployed-unverified')
        self.assertTrue({'backup-created', 'data-preserved'} <= {row['id'] for row in result['checks']})
        self.assertIn('verify_administrator', events)


if __name__ == '__main__': unittest.main()
