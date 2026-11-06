import os
import sys
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import initial_deploy
from boundary import DeploymentError
from fixtures import request
from test_deploy_secrets import secret_environment
from test_production_targets import production_configuration


SCRATCH = Path(os.environ.get('EASYEMAIL_TEST_ROOT', tempfile.gettempdir()))


class InitialDeployTests(unittest.TestCase):
    def deploy(self, stage=None, mutation=False, production=False, routing=True):
        root = Path(tempfile.mkdtemp(prefix='sba-deploy-', dir=SCRATCH)); events = []
        value = request()
        if production: value['configuration'] = production_configuration()
        if not routing: value['configuration']['routing'] = None
        targets = {role: {'hostname': role + '.example.com'} for role in ('email', 'platform')} if production else {}
        before = {'id': 'c' * 32} if value['configuration']['routing'] else None

        def step(name, result=None):
            def run(*args):
                events.append(name)
                if stage == name: raise DeploymentError('EASYEMAIL_SYNTHETIC_FAILURE')
                return result
            return run

        def recheck(config, role, api, target):
            self.assertEqual(target, targets.get(role))
            step('recheck-' + role)()

        class Process:
            def __init__(self, request, release, directory, state, material): self.state = state
            def verify_seal(self): events.append('seal')
            def initialize_databases(self):
                events.append('databases'); self.state.before_write('schema-started')
                if mutation: raise DeploymentError('EASYEMAIL_SYNTHETIC_FAILURE')
            def publish(self, role): events.append(role); self.state.before_write(role + '-published')

        with ExitStack() as stack:
            stack.enter_context(patch.dict(os.environ, secret_environment()))
            stack.enter_context(patch.object(initial_deploy, 'prepare_release', return_value=root / 'build/release'))
            stack.enter_context(patch.object(initial_deploy, 'DeploymentProcess', Process))
            stack.enter_context(patch.object(initial_deploy, 'CloudApi'))
            stack.enter_context(patch.object(initial_deploy, 'RuntimeClient'))
            stack.enter_context(patch.object(initial_deploy, 'recheck_domain', side_effect=recheck))
            for name, result in [('free_domains', targets), ('prepare_routing', before), ('fresh_resources', 'f' * 64),
                                 ('verify_database_initialization', None), ('verify_settings', None), ('bootstrap', None), ('bind_routing', None),
                                 ('verify_public', [{'id': 'synthetic-public-check', 'passed': True}])]:
                stack.enter_context(patch.object(initial_deploy, name, side_effect=step(name, result)))
            result = initial_deploy.deploy(value, root / 'operation')
        return result, events

    def test_success_requires_initialization_publish_bootstrap_and_public_verification(self):
        result, events = self.deploy()
        self.assertEqual(result['status'], 'succeeded'); self.assertTrue(all(row['passed'] for row in result['checks']))
        self.assertEqual(events, ['seal', 'free_domains', 'prepare_routing', 'fresh_resources', 'databases',
                                  'verify_database_initialization', 'recheck-email', 'email', 'recheck-platform', 'platform',
                                  'verify_settings', 'bootstrap', 'verify_public', 'bind_routing'])
        self.assertIn('side-effects-isolated', {row['id'] for row in result['checks']})

    def test_no_write_failure_is_failed_but_mutation_failure_is_unknown(self):
        result, events = self.deploy(stage='fresh_resources')
        self.assertEqual(result['status'], 'failed'); self.assertNotIn('databases', events)
        result, events = self.deploy(mutation=True)
        self.assertEqual(result['status'], 'unknown'); self.assertEqual(events[-1], 'databases')
        result, events = self.deploy(stage='bootstrap')
        self.assertEqual(result['status'], 'unknown')

    def test_completed_deployment_with_failed_public_proof_is_not_success(self):
        result, events = self.deploy(stage='verify_public')
        self.assertEqual(result['status'], 'deployed-unverified')
        self.assertNotIn('synthetic-public-check', {row['id'] for row in result['checks']})
        self.assertNotIn('bind_routing', events)

    def test_production_requires_domain_and_routing_preflight_before_any_application_write(self):
        for stage in ('free_domains', 'prepare_routing'):
            with self.subTest(stage=stage):
                result, events = self.deploy(stage=stage, production=True)
                self.assertEqual(result['status'], 'failed')
                self.assertNotIn('databases', events); self.assertNotIn('email', events)

    def test_production_rechecks_each_domain_immediately_before_its_publication(self):
        for role in ('email', 'platform'):
            with self.subTest(role=role):
                result, events = self.deploy(stage='recheck-' + role, production=True)
                self.assertEqual(result['status'], 'unknown'); self.assertNotIn(role, events)
                self.assertNotIn('bind_routing', events)

    def test_requested_route_is_bound_only_after_bootstrap_and_public_proof(self):
        result, events = self.deploy(production=True)
        self.assertEqual(result['status'], 'succeeded')
        self.assertLess(events.index('bootstrap'), events.index('verify_public'))
        self.assertLess(events.index('verify_public'), events.index('bind_routing'))
        self.assertIn('email-routing-bound-readback', {row['id'] for row in result['checks']})
        self.assertNotIn('side-effects-isolated', {row['id'] for row in result['checks']})

    def test_incomplete_requested_route_is_unknown_and_never_bound_after_failed_proof(self):
        for stage in ('bootstrap', 'verify_public', 'bind_routing'):
            with self.subTest(stage=stage):
                result, events = self.deploy(stage=stage, production=True)
                self.assertEqual(result['status'], 'unknown')
                self.assertNotIn('email-routing-bound-readback', {row['id'] for row in result['checks']})
                self.assertEqual(events.count('bind_routing'), int(stage == 'bind_routing'))

    def test_no_requested_route_allows_deployed_unverified_but_does_not_claim_binding(self):
        result, events = self.deploy(stage='verify_public', production=True, routing=False)
        self.assertEqual(result['status'], 'deployed-unverified'); self.assertNotIn('bind_routing', events)
        result, _ = self.deploy(production=True, routing=False)
        self.assertEqual(result['status'], 'succeeded')
        self.assertNotIn('email-routing-bound-readback', {row['id'] for row in result['checks']})


if __name__ == '__main__':
    unittest.main()
