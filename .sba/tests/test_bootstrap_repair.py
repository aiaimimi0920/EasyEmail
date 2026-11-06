import os
import sys
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import bootstrap_repair
from boundary import DeploymentError
from fixtures import repair_request
from test_deploy_secrets import secret_environment


SCRATCH = Path(os.environ.get('EASYEMAIL_TEST_ROOT', tempfile.gettempdir()))


class RepairTests(unittest.TestCase):
    def run_repair(self, failure=None):
        root = Path(tempfile.mkdtemp(prefix='sba-bootstrap-repair-', dir=SCRATCH)); events = []
        calls = {}; before = {'resources': 'synthetic-identity', 'domains': {}, 'routing': None}

        def step(name, result=None):
            def run(*args, **kwargs):
                calls[name] = calls.get(name, 0) + 1; event = name + '-' + str(calls[name]); events.append(event)
                if failure in (name, event): raise DeploymentError('EASYEMAIL_SYNTHETIC_FAILURE')
                return result
            return run

        class Process:
            def __init__(self, request, release, directory, state, material): self.state = state
            def verify_seal(self): events.append('seal')
            def publish(self, role):
                self.state.before_write('repair-' + role + '-published'); step('publish-' + role)()

        with ExitStack() as stack:
            stack.enter_context(patch.dict(os.environ, secret_environment()))
            stack.enter_context(patch.object(bootstrap_repair, 'prepare_release', return_value=root / 'release'))
            stack.enter_context(patch.object(bootstrap_repair, 'DeploymentProcess', Process))
            for name in ('CloudApi', 'RuntimeClient', 'ObjectStore'):
                stack.enter_context(patch.object(bootstrap_repair, name))
            for name, result in [('managed_state', before), ('verify_database_initialization', None), ('verify_settings', None),
                                 ('pristine', {'synthetic': 'schema-and-migrations'}), ('bootstrap', None),
                                 ('database_witness', {'synthetic': 'schema-and-migrations'}), ('empty_objects', None),
                                 ('verify_public', [{'id': 'synthetic-public-proof', 'passed': True}])]:
                stack.enter_context(patch.object(bootstrap_repair, name, side_effect=step(name, result)))
            result = bootstrap_repair.repair(repair_request(), root / 'operation')
        return result, events

    def test_repair_has_required_proofs_and_never_reinitializes_schema_or_replays_deploy(self):
        result, events = self.run_repair()
        self.assertEqual(result['status'], 'succeeded')
        self.assertTrue({'repair-completed', 'data-preserved', 'unchanged-resources-verified', 'service-ready'} <= {row['id'] for row in result['checks']})
        self.assertLess(events.index('verify_public-1'), events.index('publish-email-1'))
        self.assertLess(events.index('pristine-1'), events.index('publish-email-1'))
        self.assertLess(events.index('publish-platform-1'), events.index('pristine-2'))
        self.assertLess(events.index('pristine-2'), events.index('bootstrap-1'))
        self.assertLess(events.index('bootstrap-1'), events.index('verify_public-2'))

    def test_failed_read_only_preconditions_do_not_publish_or_bootstrap(self):
        for failure in ('verify_public-1', 'managed_state-1', 'verify_database_initialization-1', 'verify_settings-1', 'pristine-1'):
            result, events = self.run_repair(failure)
            self.assertEqual(result['status'], 'failed'); self.assertNotIn('publish-email-1', events)
            self.assertNotIn('bootstrap-1', events)

    def test_publish_or_bootstrap_uncertainty_is_unknown_and_never_retried(self):
        for failure in ('publish-email', 'publish-platform', 'pristine-2', 'bootstrap', 'database_witness', 'empty_objects', 'verify_public-2'):
            result, events = self.run_repair(failure)
            self.assertEqual(result['status'], 'unknown')
            self.assertNotIn('repair-completed', {row['id'] for row in result['checks']})
            self.assertLessEqual(events.count('bootstrap-1'), 1)

    def test_other_parent_errors_versions_and_production_targets_are_not_supported(self):
        for field, value in [('version', '0.9.0'), ('error', 'EASYEMAIL_UNEXPECTED_FAILURE'), ('origin', 'https://mail.example.com')]:
            request = repair_request()
            if field == 'version': request['previous']['applicationVersion'] = value
            elif field == 'error': request['context']['errorCode'] = value
            else:
                request['configuration']['platform']['origin'] = value
                request['configuration']['email']['origin'] = 'https://email-api.example.com'
            with self.assertRaisesRegex(DeploymentError, 'EASYEMAIL_BOOTSTRAP_REPAIR_NOT_SUPPORTED'):
                bootstrap_repair.repair(request, SCRATCH / 'must-not-be-created')


if __name__ == '__main__':
    unittest.main()
