import os
import sys
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import preview_deploy
from boundary import DeploymentError
import test_contract
from test_deploy_secrets import secret_environment


class PreviewTests(unittest.TestCase):
    def preview(self, fail=None, changed=False):
        root = Path(tempfile.mkdtemp(prefix='sba-preview-', dir=os.environ['EASYEMAIL_TEST_ROOT']))
        value = test_contract.ContractTests().preview(); events = []
        def step(name, result=None):
            def call(*args, **kwargs):
                events.append(name)
                if fail == name: raise DeploymentError('EASYEMAIL_SYNTHETIC_FAILURE')
                return result
            return call
        class Process:
            def __init__(self, request, release, directory, state, material): self.state = state
            def verify_seal(self): events.append('seal')
            def publish(self, role):
                events.append('publish-' + role); self.state.before_write(role + '-worker-published')
                if fail == 'publish-' + role: raise DeploymentError('EASYEMAIL_SYNTHETIC_FAILURE')
            def restore_database(self, role, path):
                events.append('restore-' + role); self.state.before_write(role + '-snapshot-imported')
                if fail == 'restore-' + role: raise DeploymentError('EASYEMAIL_SYNTHETIC_FAILURE')
            def migrate_platform(self): events.append('migrate-platform'); self.state.before_write('platform-migrations-applied')
        def backup(api, store, source, key, directory):
            self.assertEqual(set(source), {'configuration', 'sourceSha', 'applicationVersion', 'taskId'})
            events.append('backup')
            if fail == 'backup': raise DeploymentError('EASYEMAIL_SYNTHETIC_FAILURE')
            store.state.before_write('snapshot-archive-persisted')
            return {'id': 'a' * 64, 'createdAt': 7, 'manifest': {}, 'directory': root}
        def store(config, secret, state):
            class Store: pass
            selected = Store(); selected.state = state
            return selected
        def source_state(*args):
            events.append('source-state')
            return {'witness': 'changed' if changed and events.count('source-state') > 1 else 'original'}
        def prepare_copy(*args, **kwargs):
            self.assertEqual(kwargs['application_root'], root / 'EasyEmail')
            return step('prepare-copy', {'emailSql': root / 'email.sql', 'platformSql': root / 'platform.sql', 'backup': {}})()
        with ExitStack() as stack:
            stack.enter_context(patch.dict(os.environ, secret_environment()))
            stack.enter_context(patch.object(preview_deploy, 'prepare_release', return_value=root / 'release'))
            stack.enter_context(patch.object(preview_deploy, 'DeploymentProcess', Process))
            stack.enter_context(patch.object(preview_deploy, 'CloudApi'))
            stack.enter_context(patch.object(preview_deploy, 'RuntimeClient'))
            stack.enter_context(patch.object(preview_deploy, 'ObjectStore', side_effect=store))
            stack.enter_context(patch.object(preview_deploy, 'capture_backup', side_effect=backup))
            stack.enter_context(patch.object(preview_deploy, 'source_state', side_effect=source_state))
            stack.enter_context(patch.object(preview_deploy, 'prepare_copy', side_effect=prepare_copy))
            for name in ('verify_preview_policy', 'fresh_resources', 'verify_settings', 'email_version', 'migrate_email',
                         'verify_database_initialization', 'prove_update_preserved', 'verify_administrator', 'prove_source_unchanged'):
                stack.enter_context(patch.object(preview_deploy, name, side_effect=step(name)))
            stack.enter_context(patch.object(preview_deploy, 'persist_provenance', side_effect=step('provenance')))
            def public(selected):
                return step('target-public' if selected['sourceSha'] == value['sourceSha'] else 'source-public',
                            [{'id': 'public-proof', 'passed': True}])()
            stack.enter_context(patch.object(preview_deploy, 'verify_public', side_effect=public))
            result = preview_deploy.preview(value, root / 'operation')
        return result, events

    def test_snapshot_and_empty_target_precede_copy_then_migration_and_source_proof(self):
        result, events = self.preview()
        self.assertEqual(result['status'], 'succeeded')
        for first, second in [('source-public', 'backup'), ('fresh_resources', 'backup'), ('backup', 'publish-email'),
                              ('publish-platform', 'prepare-copy'), ('prepare-copy', 'restore-email'),
                              ('restore-platform', 'migrate-platform'), ('migrate-platform', 'migrate_email'),
                              ('prove_update_preserved', 'verify_administrator'), ('verify_administrator', 'prove_source_unchanged'),
                              ('prove_source_unchanged', 'provenance')]:
            self.assertLess(events.index(first), events.index(second))
        self.assertTrue({'snapshot-copied', 'migration-verified', 'source-unchanged', 'side-effects-isolated'} <= {row['id'] for row in result['checks']})
        self.assertTrue(all(row['status'] == 'created' for row in result['lifecycle']['resources']))
        self.assertEqual(result['lifecycle']['snapshot'], {'id': 'a' * 64, 'createdAt': 7})

    def test_read_only_failure_never_publishes_and_has_no_success_claim(self):
        for stage in ('verify_preview_policy', 'source-public', 'fresh_resources', 'email_version', 'backup'):
            result, events = self.preview(fail=stage)
            self.assertEqual(result['status'], 'failed', stage)
            self.assertNotIn('publish-email', events); self.assertNotIn('provenance', events)
            self.assertNotIn('source-unchanged', {row['id'] for row in result['checks']})

    def test_post_backup_uncertainty_is_unknown_and_never_replayed(self):
        for stage in ('publish-email', 'prepare-copy', 'restore-platform', 'migrate_email', 'prove_update_preserved',
                      'verify_administrator', 'target-public', 'prove_source_unchanged', 'provenance'):
            result, events = self.preview(fail=stage)
            self.assertEqual(result['status'], 'unknown', stage)
            self.assertLessEqual(events.count('restore-platform'), 1)
            self.assertNotIn('lifecycle', result)

    def test_source_settings_drift_stops_after_backup_without_target_writes(self):
        result, events = self.preview(changed=True)
        self.assertEqual(result['status'], 'unknown')
        self.assertEqual(result['errorCode'], 'EASYEMAIL_SOURCE_INSTANCE_CHANGED')
        self.assertNotIn('publish-email', events)


if __name__ == '__main__': unittest.main()
