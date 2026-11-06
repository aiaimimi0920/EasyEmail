import copy
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from boundary import DeploymentError
from cleanup_fixtures import CleanupApi
from cleanup_resources import database_identity, remove_database, remove_worker, stop_ingress


class CleanupResourceTests(unittest.TestCase):
    def test_ingress_requires_both_acknowledgment_and_independent_disabled_readback(self):
        api = CleanupApi(); stop_ingress(api.config, 'platform', api)
        self.assertEqual(api.writes, ['cleanup-platform-ingress-stopped'])
        for wrong_ack in (True, False):
            api = CleanupApi(); original = api.request
            def request(method, suffix, *args, **kwargs):
                result = original(method, suffix, *args, **kwargs)
                if (method == 'POST') == wrong_ack: result['result']['previews_enabled'] = True
                return result
            api.request = request
            with self.assertRaises(DeploymentError): stop_ingress(api.config, 'platform', api)
            self.assertEqual(api.writes, ['cleanup-platform-ingress-stopped'])

    def test_enabled_ingress_blocks_worker_deletion_before_any_delete(self):
        api = CleanupApi()
        with self.assertRaises(DeploymentError): remove_worker(api.config, 'email', api)
        self.assertEqual(api.writes, [])

    def test_delete_acknowledgment_alone_never_confirms_worker_or_database_absence(self):
        for role in ('email', 'platform'):
            api = CleanupApi(); api.exposures[api.config[role]['name']] = {'enabled': False, 'previews_enabled': False}
            api.delete = lambda suffix, *, write: api.writes.append(write)
            with self.assertRaises(DeploymentError): remove_worker(api.config, role, api)
            before = database_identity(api.config, role, api)
            with self.assertRaises(DeploymentError): remove_database(api.config, role, before, api)
            self.assertEqual(api.writes, ['cleanup-' + role + '-worker-deleted', 'cleanup-' + role + '-database-deleted'])

    def test_database_recreation_name_or_creation_time_drift_blocks_deletion(self):
        for field, value in [('created_at', '2026-11-07T00:00:00Z'), ('name', 'another-database')]:
            api = CleanupApi(); before = database_identity(api.config, 'email', api)
            api.databases[before['id']][field] = value
            with self.assertRaises(DeploymentError): remove_database(api.config, 'email', before, api)
            self.assertEqual(api.writes, [])

    def test_truncated_absence_list_does_not_confirm_deletion(self):
        api = CleanupApi(); before = database_identity(api.config, 'email', api); original = api.request
        def request(method, suffix, *args, **kwargs):
            result = copy.deepcopy(original(method, suffix, *args, **kwargs))
            if suffix.startswith('/d1/database?'): result['result_info'] = {'total_count': 2}
            return result
        api.request = request
        with self.assertRaises(DeploymentError): remove_database(api.config, 'email', before, api)
        self.assertEqual(api.writes, ['cleanup-email-database-deleted'])


if __name__ == '__main__': unittest.main()
