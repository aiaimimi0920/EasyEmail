import os
import sys
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import publication_repair
from boundary import DeploymentError
from fixtures import repair_request
from test_deploy_secrets import secret_environment
from test_production_targets import production_configuration


SCRATCH = Path(os.environ.get('EASYEMAIL_TEST_ROOT', tempfile.gettempdir()))


def publication_request():
    request = repair_request()
    request['configuration'] = production_configuration()
    request['previous']['applicationVersion'] = '1.0.12'
    request['context'].update(repairId='complete-fresh-publication', errorCode='EASYEMAIL_WORKER_DEPLOY_FAILED')
    return request


class PublicationRepairTests(unittest.TestCase):
    def run_repair(self, failure=None):
        root = Path(tempfile.mkdtemp(prefix='sba-publication-', dir=SCRATCH)); events = []; counts = {}

        def step(name, result=None):
            def invoke(*args, **kwargs):
                counts[name] = counts.get(name, 0) + 1; event = name + '-' + str(counts[name]); events.append(event)
                if failure in (name, event): raise DeploymentError('EASYEMAIL_SYNTHETIC_FAILURE')
                return result
            return invoke

        class Process:
            def __init__(self, request, release, directory, state, material): self.state = state
            def verify_seal(self): events.append('seal')
            def publish(self, role):
                self.state.before_write(role + '-worker-published'); step('publish-' + role)()

        with ExitStack() as stack:
            stack.enter_context(patch.dict(os.environ, secret_environment()))
            stack.enter_context(patch.object(publication_repair, 'prepare_release', return_value=root / 'release'))
            stack.enter_context(patch.object(publication_repair, 'DeploymentProcess', Process))
            for name in ('CloudApi', 'RuntimeClient'): stack.enter_context(patch.object(publication_repair, name))
            for name, result in [('partial_state', {'identity': 'synthetic-identity', 'databases': {'synthetic': 'schema'}}), ('verify_uploaded_email', None),
                ('free_domains', {'email': {}, 'platform': {}}), ('prepare_routing', {'id': 'synthetic'}),
                ('recheck_domain', None), ('verify_settings', None), ('bootstrap', None),
                ('uninitialized_databases', {'synthetic': 'schema'}), ('data_identity', 'synthetic-identity'),
                ('verify_public', [{'id': 'synthetic-public', 'passed': True}]), ('bind_routing', None)]:
                stack.enter_context(patch.object(publication_repair, name, side_effect=step(name, result)))
            result = publication_repair.repair_publication(publication_request(), root / 'operation')
        return result, events

    def test_independent_repair_checks_partial_old_state_before_any_write_and_never_initializes_schema(self):
        result, events = self.run_repair()
        self.assertEqual(result['status'], 'succeeded')
        self.assertLess(events.index('verify_uploaded_email-1'), events.index('publish-email-1'))
        self.assertLess(events.index('partial_state-2'), events.index('publish-email-1'))
        self.assertLess(events.index('verify_uploaded_email-2'), events.index('publish-email-1'))
        self.assertLess(events.index('uninitialized_databases-1'), events.index('bootstrap-1'))
        self.assertLess(events.index('verify_public-1'), events.index('bind_routing-1'))
        self.assertTrue({'repair-completed', 'service-ready', 'email-routing-bound-readback'} <= {row['id'] for row in result['checks']})

    def test_failed_partial_identity_code_or_empty_state_proof_does_not_publish(self):
        for failure in ('partial_state-1', 'partial_state-2', 'verify_uploaded_email-1', 'verify_uploaded_email-2', 'free_domains', 'prepare_routing'):
            with self.subTest(failure=failure):
                result, events = self.run_repair(failure)
                self.assertEqual(result['status'], 'failed'); self.assertNotIn('publish-email-1', events)

    def test_post_write_failure_remains_unknown_without_retry_or_route_promotion(self):
        for failure in ('publish-email', 'publish-platform', 'verify_settings', 'uninitialized_databases', 'bootstrap', 'verify_public'):
            with self.subTest(failure=failure):
                result, events = self.run_repair(failure)
                self.assertEqual(result['status'], 'unknown')
                self.assertLessEqual(events.count('publish-email-1'), 1)
                self.assertNotIn('bind_routing-1', events)

    def test_unsupported_parent_does_not_build_or_mutate(self):
        for change in ('version', 'error', 'repair', 'isolation'):
            request = publication_request()
            if change == 'version': request['previous']['applicationVersion'] = '1.0.11'
            elif change == 'error': request['context']['errorCode'] = 'EASYEMAIL_CLOUD_REQUEST_FAILED'
            elif change == 'repair': request['context']['repairId'] = 'complete-empty-bootstrap'
            else: request['configuration'] = repair_request()['configuration']
            with self.subTest(change=change), self.assertRaisesRegex(DeploymentError, 'EASYEMAIL_PUBLICATION_REPAIR_NOT_SUPPORTED'):
                publication_repair.repair_publication(request, SCRATCH / 'must-not-create-publication')
