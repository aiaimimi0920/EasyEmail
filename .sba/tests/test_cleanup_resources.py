import copy
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from boundary import DeploymentError
from cleanup_fixtures import CleanupApi
from cleanup_resources import database_identity, remove_database, remove_worker, stop_ingress


class CleanupResourceTests(unittest.TestCase):
    def setUp(self):
        patcher = patch('time.sleep'); self.sleep = patcher.start()
        self.addCleanup(patcher.stop)

    def test_worker_delete_waits_for_list_visibility_without_reissuing_delete(self):
        api = CleanupApi(); name = api.config['platform']['name']; original = api.request
        api.exposures[name] = {'enabled': False, 'previews_enabled': False}; reads = []
        stale = copy.deepcopy(original('GET', '/workers/scripts'))
        def request(method, suffix, *args, **kwargs):
            result = original(method, suffix, *args, **kwargs)
            if suffix == '/workers/scripts':
                reads.append(suffix)
                if len(reads) <= 2: return copy.deepcopy(stale)
            return result
        api.request = request
        remove_worker(api.config, 'platform', api)
        self.assertEqual(api.writes, ['cleanup-platform-worker-deleted'])
        self.assertEqual(len(reads), 3); self.assertEqual(self.sleep.call_count, 2)

    def test_worker_list_wait_is_bounded_and_does_not_retry_invalid_or_failed_reads(self):
        api = CleanupApi(); api.exposures[api.config['platform']['name']] = {'enabled': False, 'previews_enabled': False}
        api.delete = lambda suffix, *, write: api.writes.append(write)
        with self.assertRaises(DeploymentError): remove_worker(api.config, 'platform', api)
        self.assertEqual([call.args[0] for call in self.sleep.call_args_list], [1, 2, 4, 8])
        self.assertEqual(api.writes, ['cleanup-platform-worker-deleted'])
        for broken in (True, False):
            api = CleanupApi(); original = api.request; reads = []; self.sleep.reset_mock()
            api.exposures[api.config['platform']['name']] = {'enabled': False, 'previews_enabled': False}
            def request(method, suffix, *args, **kwargs):
                if suffix == '/workers/scripts':
                    reads.append(suffix)
                    if broken: raise DeploymentError('EASYEMAIL_CLOUD_REQUEST_FAILED')
                    return {'result': [], 'result_info': {'total_count': 1}}
                return original(method, suffix, *args, **kwargs)
            api.request = request
            with self.assertRaises(DeploymentError): remove_worker(api.config, 'platform', api)
            self.assertEqual(len(reads), 1); self.sleep.assert_not_called()
            self.assertEqual(api.writes, ['cleanup-platform-worker-deleted'])

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

    def test_database_absence_uses_exact_uuid_not_account_list_metadata_after_delete(self):
        api = CleanupApi(); before = database_identity(api.config, 'email', api); original = api.request
        def request(method, suffix, *args, **kwargs):
            result = copy.deepcopy(original(method, suffix, *args, **kwargs))
            if suffix.startswith('/d1/database?'): result['result_info'] = {'total_count': 2}
            return result
        api.request = request
        remove_database(api.config, 'email', before, api)
        self.assertEqual(api.writes, ['cleanup-email-database-deleted'])
        self.assertFalse(any(path.startswith('/d1/database?') for method, path, zone in api.calls))

    def test_database_uuid_read_waits_only_for_valid_presence_and_never_redeletes(self):
        api = CleanupApi(); before = database_identity(api.config, 'email', api); original = api.read_response; reads = []
        saved = copy.deepcopy(api.databases[before['id']])
        def response(suffix, **kwargs):
            reads.append(suffix)
            if len(reads) <= 2: return {'success': True, 'errors': [], 'result': saved}, 200
            return original(suffix, **kwargs)
        api.read_response = response
        remove_database(api.config, 'email', before, api)
        self.assertEqual(api.writes, ['cleanup-email-database-deleted']); self.assertEqual(len(reads), 3)
        self.assertEqual([call.args[0] for call in self.sleep.call_args_list], [1, 2])

    def test_database_wrong_uuid_malformed_not_found_and_failed_reads_never_confirm_absence(self):
        for body, status in [({'success': False, 'errors': [{'code': 10000}], 'result': None}, 404),
                             ({'success': True, 'errors': [{'code': 7404}], 'result': None}, 404),
                             ({'success': False, 'errors': [{'code': 7404}], 'result': {}}, 404),
                             ({'success': False, 'errors': [{'code': 7404}, {'code': 10000}], 'result': None}, 404),
                             ({'success': True, 'errors': [], 'result': {'uuid': 'f' * 36, 'name': 'foreign'}}, 200)]:
            api = CleanupApi(); before = database_identity(api.config, 'email', api); reads = []; self.sleep.reset_mock()
            def response(suffix, **kwargs): reads.append(suffix); return body, status
            api.read_response = response
            with self.subTest(status=status, body=body), self.assertRaises(DeploymentError): remove_database(api.config, 'email', before, api)
            self.assertEqual(len(reads), 1); self.sleep.assert_not_called()
            self.assertEqual(api.writes, ['cleanup-email-database-deleted'])
        api = CleanupApi(); before = database_identity(api.config, 'email', api); self.sleep.reset_mock()
        api.read_response = lambda *args, **kwargs: (_ for _ in ()).throw(DeploymentError('EASYEMAIL_CLOUD_REQUEST_FAILED'))
        with self.assertRaisesRegex(DeploymentError, 'EASYEMAIL_CLOUD_REQUEST_FAILED'): remove_database(api.config, 'email', before, api)
        self.sleep.assert_not_called(); self.assertEqual(api.writes, ['cleanup-email-database-deleted'])


if __name__ == '__main__': unittest.main()
