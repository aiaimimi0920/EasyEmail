import copy
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from boundary import DeploymentError
from cleanup_references import listed, verify_unshared
from cleanup_fixtures import CleanupApi


class CleanupReferenceTests(unittest.TestCase):
    def test_private_unshared_preview_passes_but_never_writes(self):
        api = CleanupApi(); verify_unshared(api.config, api)
        self.assertEqual(api.writes, [])
        for role in ('email', 'platform'): api.workers.pop(api.config[role]['name'])
        verify_unshared(api.config, api, workers_present=False)

    def test_foreign_worker_storage_service_or_durable_reference_blocks_cleanup(self):
        for binding in [{'type': 'd1', 'id': CleanupApi().config['email']['database']['id']},
                        {'type': 'r2_bucket', 'bucket_name': CleanupApi().config['platform']['inboxBucket']},
                        {'type': 'service', 'service': CleanupApi().config['email']['name']},
                        {'type': 'durable_object_namespace', 'script_name': CleanupApi().config['platform']['name']}]:
            api = CleanupApi(); api.workers['other-service']['bindings'] = [binding]
            with self.assertRaises(DeploymentError): verify_unshared(api.config, api)
            self.assertEqual(api.writes, [])

    def test_own_unregistered_storage_or_service_is_not_silently_destroyed(self):
        for binding in [{'type': 'd1', 'id': 'foreign'}, {'type': 'kv_namespace', 'namespace_id': 'foreign'},
                        {'type': 'durable_object_namespace', 'namespace_id': 'foreign'}, {'type': 'service', 'service': 'foreign'}]:
            api = CleanupApi(); api.workers[api.config['email']['name']]['bindings'].append(binding)
            with self.assertRaises(DeploymentError): verify_unshared(api.config, api)

    def test_pages_current_or_old_functions_bindings_and_unknown_history_are_blockers(self):
        for config, deployment in [({'r2_buckets': {'x': {'name': CleanupApi().config['platform']['outboxBucket']}}}, []),
                                   ({}, [{'uses_functions': True}]),
                                   ({}, [{'uses_functions': True, 'd1_databases': {'db': {'id': CleanupApi().config['email']['database']['id']}}, 'r2_buckets': {}}])]:
            api = CleanupApi(); api.projects = [{'name': 'foreign-pages', 'deployment_configs': {'production': config}}]
            api.deployments['foreign-pages'] = deployment
            with self.assertRaises(DeploymentError): verify_unshared(api.config, api)
        api = CleanupApi(); api.projects = [{'name': 'static-pages', 'deployment_configs': {'production': {}}}]
        api.deployments['static-pages'] = [{'uses_functions': False}]; verify_unshared(api.config, api)

    def test_all_email_pages_are_checked_including_disabled_rules(self):
        api = CleanupApi(); api.email = [{'id': str(i), 'actions': [{'type': 'drop'}]} for i in range(50)]
        api.email.append({'id': 'last', 'enabled': False, 'actions': [{'type': 'worker', 'value': [api.config['email']['name']]}]})
        with self.assertRaises(DeploymentError): verify_unshared(api.config, api)
        self.assertTrue(any('page=2' in row[1] for row in api.calls)); self.assertEqual(api.writes, [])

    def test_extra_http_or_zone_route_is_not_unbound_as_part_of_cleanup(self):
        for domains in (True, False):
            api = CleanupApi()
            if domains: api.domains = [{'service': api.config['platform']['name'], 'hostname': 'foreign.example.com'}]
            else:
                api.zones = [{'id': 'd' * 32, 'account': {'id': api.config['accountId']}, 'status': 'active', 'name': 'example.com'}]
                api.routes = [{'id': 'route', 'script': api.config['email']['name']}]
            with self.assertRaises(DeploymentError): verify_unshared(api.config, api)
            self.assertEqual(api.writes, [])

    def test_incomplete_or_duplicated_metadata_never_becomes_an_empty_safe_list(self):
        class Api:
            def request(self, *args, **kwargs): return {'result': [], 'result_info': {'total_count': 1, 'total_pages': 2}}
        with self.assertRaises(DeploymentError): listed(Api(), '/workers/scripts')
        api = CleanupApi(); api.email = [{'id': 'duplicate', 'actions': [{'type': 'drop'}]}] * 2
        with self.assertRaises(DeploymentError): verify_unshared(api.config, api)


if __name__ == '__main__': unittest.main()
