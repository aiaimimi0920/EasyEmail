import os
import sys
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import preview_repair
from boundary import DeploymentError
from fixtures import preview_repair_request
from test_deploy_secrets import secret_environment


class PreviewRepairTests(unittest.TestCase):
    def repair(self, fail=None, drift=None, value=None, repeat=False):
        value = value or preview_repair_request(); events = []
        root = Path(tempfile.mkdtemp(prefix='preview-repair-', dir=os.environ['EASYEMAIL_TEST_ROOT']))
        def step(name, result=None):
            def call(*args, **kwargs):
                events.append(name)
                if name == fail: raise DeploymentError('EASYEMAIL_SYNTHETIC_FAILURE')
                return result
            return call
        class Process:
            def __init__(self, request, release, directory, state, material): self.state = state
            def verify_seal(self): events.append('seal')
            def publish(self, role):
                self.state.before_write(role + '-worker-published'); step('publish-' + role)()
            def restore_database(self, role, path):
                self.state.before_write(role + '-snapshot-imported'); step('restore-' + role)()
            def migrate_platform(self):
                self.state.before_write('platform-migrations-applied'); step('migrate-platform')()
        def source_state(config, api):
            role = 'source' if config == value['context']['preview']['source']['configuration'] else 'target'
            event = role + '-state'; events.append(event)
            return {'witness': 'changed' if drift == role and events.count(event) > 1 else 'original'}
        def proof(*args, **kwargs): step('proof-' + kwargs.get('phase', 'sourcefinal'))()
        current_source = {'manifest': {'current-complete-witness': True}}
        def capture(*args, **kwargs): return step('capture-source', current_source)()
        def final_proof(*args, **kwargs):
            self.assertIs(args[0], current_source, 'source preservation compares this operation, not a historical backup')
            return proof(*args, **kwargs)
        def prepared(*args, **kwargs):
            self.assertEqual(kwargs['application_root'], root / 'EasyEmail')
            return step('prepare-copy', {'emailSql': root / 'email.sql', 'platformSql': root / 'platform.sql', 'backup': {}})()
        backup = {'id': 'a' * 64, 'createdAt': 7, 'manifest': {}, 'directory': root}
        with ExitStack() as stack:
            stack.enter_context(patch.dict(os.environ, secret_environment()))
            stack.enter_context(patch.object(preview_repair, 'prepare_release', return_value=root / 'release'))
            stack.enter_context(patch.object(preview_repair, 'DeploymentProcess', Process))
            for name in ('CloudApi', 'RuntimeClient', 'ObjectStore'): stack.enter_context(patch.object(preview_repair, name))
            stack.enter_context(patch.object(preview_repair, 'source_state', side_effect=source_state))
            stack.enter_context(patch.object(preview_repair, 'load_source_backup', side_effect=step('backup-read', backup)))
            stack.enter_context(patch.object(preview_repair, 'reuse_objects', side_effect=step('reuse-read', {'copies': []})))
            stack.enter_context(patch.object(preview_repair, 'prepare_restored_copy', side_effect=prepared))
            stack.enter_context(patch.object(preview_repair, 'capture_source_witness', side_effect=capture))
            stack.enter_context(patch.object(preview_repair, 'prove_source_unchanged', side_effect=final_proof))
            stack.enter_context(patch.object(preview_repair, 'business_inventory', return_value={'INBOX': [], 'OUTBOX': []}))
            for name in ('verify_preview_policy', 'verify_settings', 'email_version', 'empty_databases', 'empty_database',
                         'migrate_email', 'verify_database_initialization', 'prove_update_preserved', 'verify_administrator', 'persist_provenance'):
                stack.enter_context(patch.object(preview_repair, name, side_effect=step(name)))
            def public(selected):
                if selected['configuration'] == value['configuration'] and selected['sourceSha'] != value['sourceSha']:
                    self.assertEqual(selected['applicationVersion'], '1.0.2', 'failed repair version is not the deployed baseline')
                role = 'source-public' if selected['configuration'] != value['configuration'] else 'previous-public' if selected['sourceSha'] == value['previous']['sourceSha'] else 'target-public'
                return step(role, [{'id': 'public-proof', 'passed': True}])()
            stack.enter_context(patch.object(preview_repair, 'verify_public', side_effect=public))
            result = preview_repair.repair_preview(value, root / 'operation')
            if repeat:
                try: result = preview_repair.repair_preview(value, root / 'operation')
                except DeploymentError as error: result = {'status': 'failed', 'errorCode': error.code}
                except FileExistsError: result = {'status': 'failed', 'errorCode': 'TEST_EXISTING_OPERATION_REFUSED'}
        return result, events

    def test_backup_empty_schema_objects_crypto_and_source_proof_all_precede_first_target_write(self):
        result, events = self.repair(); self.assertEqual(result['status'], 'succeeded', result)
        for name in ('previous-public', 'backup-read', 'empty_databases', 'reuse-read', 'prepare-copy', 'capture-source'):
            self.assertLess(events.index(name), events.index('publish-email'))
        self.assertLess(events.index('proof-sourcefinal'), events.index('persist_provenance'))
        self.assertEqual(events.count('restore-email'), 1); self.assertEqual(events.count('restore-platform'), 1)
        self.assertEqual(events.count('empty_databases'), 2); self.assertEqual(events.count('empty_database'), 2)
        self.assertTrue({'repair-completed', 'data-preserved', 'unchanged-resources-verified', 'service-ready',
                         'snapshot-copied', 'migration-verified', 'source-unchanged', 'side-effects-isolated'} <= {row['id'] for row in result['checks']})

    def test_read_only_rejection_has_no_target_write_or_success_provenance(self):
        for name in ('verify_preview_policy', 'previous-public', 'backup-read', 'empty_databases', 'reuse-read', 'prepare-copy', 'capture-source'):
            result, events = self.repair(fail=name)
            self.assertEqual(result['status'], 'failed', (name, result)); self.assertNotIn('publish-email', events)
            self.assertNotIn('persist_provenance', events); self.assertNotIn('lifecycle', result)
        for drift in ('source', 'target'):
            result, events = self.repair(drift=drift)
            self.assertEqual(result['status'], 'failed'); self.assertNotIn('publish-email', events)

    def test_any_write_uncertainty_is_unknown_and_cannot_replay_in_same_directory(self):
        for name in ('publish-email', 'restore-platform', 'migrate_email', 'prove_update_preserved', 'target-public', 'proof-sourcefinal', 'persist_provenance'):
            result, events = self.repair(fail=name)
            self.assertEqual(result['status'], 'unknown', (name, result)); self.assertNotIn('lifecycle', result)
            self.assertLessEqual(events.count('restore-platform'), 1)
        result, events = self.repair(fail='restore-platform', repeat=True)
        self.assertEqual(result['status'], 'failed'); self.assertEqual(events.count('publish-email'), 1)

    def test_sourcecheck_failure_can_continue_only_with_exact_original_baseline(self):
        value = preview_repair_request()
        baseline = {**value['previous'], 'instanceId': value['context']['parentTaskId']}
        value['previous'] = {'sourceSha': 'e' * 40, 'applicationVersion': '1.0.4'}
        value['context'].update(errorCode='EASYEMAIL_SOURCE_DATABASE_CHANGED', previewBaseline=baseline)
        result, events = self.repair(value=value)
        self.assertEqual(result['status'], 'succeeded', result)
        for mutate in (lambda r: r['context'].pop('previewBaseline'),
                       lambda r: r['context']['previewBaseline'].update(applicationVersion='1.0.3'),
                       lambda r: r['previous'].update(applicationVersion='1.0.3')):
            import copy
            invalid = copy.deepcopy(value); mutate(invalid)
            with self.assertRaisesRegex(DeploymentError, 'EASYEMAIL_PREVIEW_REPAIR_NOT_SUPPORTED'):
                self.repair(value=invalid)

    def test_only_exact_supported_version_and_isolated_source_are_eligible(self):
        for mutate in (lambda r: r['previous'].update(applicationVersion='1.0.1'),
                       lambda r: r['context']['preview']['source'].update(applicationVersion='1.0.1'),
                       lambda r: r['context'].update(errorCode='EASYEMAIL_CLOUD_REQUEST_FAILED'),
                       lambda r: r['context']['preview']['source']['configuration'].update(routing={'domain': 'example.com'})):
            value = preview_repair_request(); mutate(value)
            with self.assertRaisesRegex(DeploymentError, 'EASYEMAIL_PREVIEW_REPAIR_NOT_SUPPORTED'): self.repair(value=value)


if __name__ == '__main__': unittest.main()
