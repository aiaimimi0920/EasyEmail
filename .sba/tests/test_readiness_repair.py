import os
import sys
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import readiness_repair
from boundary import DeploymentError
from test_deploy_secrets import secret_environment
from test_publication_repair import publication_request

SCRATCH = Path(os.environ.get('EASYEMAIL_TEST_ROOT', tempfile.gettempdir()))


def readiness_request():
    value = publication_request(); value['previous']['applicationVersion'] = '1.0.13'
    value['context'].update(repairId='complete-fresh-readiness', errorCode='EASYEMAIL_PUBLIC_VERIFICATION_FAILED')
    return value


class ReadinessRepairTests(unittest.TestCase):
    def run_repair(self, failure=None):
        root = Path(tempfile.mkdtemp(prefix='sba-readiness-', dir=SCRATCH)); events = []; counts = {}
        def step(name, result=None):
            def invoke(*args, **kwargs):
                counts[name] = counts.get(name, 0) + 1; event = name + '-' + str(counts[name]); events.append(event)
                if name == 'capture_backup': args[1].state.before_write('backup-persisted')
                if failure in (name, event): raise DeploymentError('EASYEMAIL_SYNTHETIC_FAILURE')
                return result
            return invoke
        class Store:
            def __init__(self, config, secret, state): self.state = state
        class Process:
            def __init__(self, request, release, directory, state, material): self.state = state
            def verify_seal(self): events.append('seal')
            def publish(self, role): self.state.before_write(role + '-published'); step('publish-' + role)()
        with ExitStack() as stack:
            stack.enter_context(patch.dict(os.environ, secret_environment()))
            builds = stack.enter_context(patch.object(readiness_repair, 'prepare_release', return_value=root / 'release'))
            stack.enter_context(patch.object(readiness_repair, 'DeploymentProcess', Process))
            stack.enter_context(patch.object(readiness_repair, 'ObjectStore', Store))
            for name in ('CloudApi', 'RuntimeClient'): stack.enter_context(patch.object(readiness_repair, name))
            for name, result in [('verify_uploaded_worker', None), ('managed_state', {'domains': 'synthetic-domains'}),
                ('prepare_routing', {'id': 'synthetic-route'}), ('verify_settings', None), ('verify_database_initialization', None),
                ('email_version', None), ('verify_parent_assets', None), ('capture_backup', 'synthetic-backup'),
                ('prove_update_preserved', None), ('verify_administrator', None), ('bind_routing', None),
                ('verify_public', [{'id': 'synthetic-public', 'passed': True}])]:
                stack.enter_context(patch.object(readiness_repair, name, side_effect=step(name, result)))
            result = readiness_repair.repair_readiness(readiness_request(), root / 'operation')
            if builds.called: self.assertEqual(builds.call_args_list[0].kwargs, {'fetch_source': True})
        return result, events

    def test_backup_precedes_publication_data_proof_and_public_verify_precede_route_without_bootstrap_or_migration(self):
        result, events = self.run_repair(); self.assertEqual(result['status'], 'succeeded')
        self.assertLess(events.index('capture_backup-1'), events.index('publish-email-1'))
        self.assertLess(events.index('verify_uploaded_worker-4'), events.index('publish-email-1'))
        self.assertLess(events.index('prove_update_preserved-1'), events.index('bind_routing-1'))
        self.assertLess(events.index('verify_public-1'), events.index('bind_routing-1'))

    def test_failed_parent_identity_or_neutral_route_never_publishes_or_creates_backup(self):
        for failure in ('verify_uploaded_worker-1', 'verify_uploaded_worker-2', 'managed_state-1', 'prepare_routing-1',
                        'verify_settings-1', 'verify_database_initialization-1', 'verify_parent_assets-1'):
            with self.subTest(failure=failure):
                result, events = self.run_repair(failure); self.assertEqual(result['status'], 'failed')
                self.assertNotIn('capture_backup-1', events); self.assertNotIn('publish-email-1', events)

    def test_backup_or_postwrite_failure_remains_unknown_and_never_retries_or_binds_route(self):
        for failure in ('capture_backup', 'verify_uploaded_worker-3', 'publish-email', 'publish-platform',
                        'prove_update_preserved', 'verify_administrator', 'verify_public'):
            with self.subTest(failure=failure):
                result, events = self.run_repair(failure); self.assertEqual(result['status'], 'unknown')
                self.assertLessEqual(events.count('publish-email-1'), 1); self.assertNotIn('bind_routing-1', events)

    def test_other_parent_version_or_error_cannot_invoke_this_repair(self):
        for field, value in [('applicationVersion', '1.0.12'), ('errorCode', 'EASYEMAIL_WORKER_DEPLOY_FAILED')]:
            request = readiness_request()
            request['previous' if field == 'applicationVersion' else 'context'][field] = value
            with self.subTest(field=field), self.assertRaisesRegex(DeploymentError, 'EASYEMAIL_READINESS_REPAIR_NOT_SUPPORTED'):
                readiness_repair.repair_readiness(request, SCRATCH / 'must-not-create-readiness')
