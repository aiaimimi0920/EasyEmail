import copy
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from boundary import DeploymentError
from cleanup_buckets import bucket_identity, inspect_bucket, remove_bucket
from cleanup_fixtures import CleanupApi


def object_row(key='mail'):
    return {'key': key, 'size': 5, 'etag': 'a' * 32, 'last_modified': '2026-11-06T00:00:00Z'}


class CleanupBucketTests(unittest.TestCase):
    def api(self):
        api = CleanupApi(); name = api.config['platform']['inboxBucket']; api.objects[name] = [object_row()]
        return api, name

    def test_single_reviewed_batch_then_empty_bucket_and_absence_readbacks(self):
        api, name = self.api(); before = inspect_bucket(api, name); remove_bucket(api, name, before, 'cleanup-inbox')
        self.assertEqual(api.writes, ['cleanup-inbox-objects-deleted', 'cleanup-inbox-bucket-deleted'])
        self.assertIsNone(bucket_identity(api, name)); self.assertEqual(api.objects[name], [])

    def test_public_locked_or_notified_bucket_is_not_touched(self):
        for field, value in [('managed', {'enabled': True}), ('custom', {'domains': [{}]}), ('locks', [{}]),
                             ('notifications', ({'success': True, 'errors': [], 'result': {'queues': [{}]}}, 200)),
                             ('notifications', ({'success': False, 'errors': [{'code': 10000}], 'result': None}, 404))]:
            api, name = self.api(); setattr(api, field, value)
            with self.assertRaises(DeploymentError): inspect_bucket(api, name)
            self.assertEqual(api.writes, [])

    def test_bucket_recreation_or_object_drift_refuses_before_delete(self):
        for recreate in (True, False):
            api, name = self.api(); before = inspect_bucket(api, name)
            if recreate: api.buckets[name]['creation_date'] = '2026-11-06T01:00:00Z'
            else: api.objects[name][0]['etag'] = 'b' * 32
            with self.assertRaises(DeploymentError): remove_bucket(api, name, before, 'cleanup-inbox')
            self.assertEqual(api.writes, [])

    def test_late_object_stops_without_second_clearing_pass_or_bucket_delete(self):
        api, name = self.api(); original = api.request
        def request(method, suffix, *args, **kwargs):
            result = original(method, suffix, *args, **kwargs)
            if method == 'DELETE': api.objects[name].append(object_row('late-mail'))
            return result
        before = inspect_bucket(api, name); api.request = request
        with self.assertRaises(DeploymentError): remove_bucket(api, name, before, 'cleanup-inbox')
        self.assertEqual(api.writes, ['cleanup-inbox-objects-deleted']); self.assertIn(name, api.buckets)

    def test_partial_delete_ack_or_wrong_key_never_progresses_to_bucket_delete(self):
        for partial in (True, False):
            api, name = self.api(); before = inspect_bucket(api, name); original = api.request
            def request(method, suffix, *args, **kwargs):
                result = original(method, suffix, *args, **kwargs)
                if method == 'DELETE':
                    if partial: raise DeploymentError('EASYEMAIL_CLOUD_RESPONSE_INVALID')
                    result['result'] = [{'key': 'wrong'}]
                return result
            api.request = request
            with self.assertRaises(DeploymentError): remove_bucket(api, name, before, 'cleanup-inbox')
            self.assertEqual(api.writes, ['cleanup-inbox-objects-deleted']); self.assertIn(name, api.buckets)

    def test_truncated_tail_or_oversized_delete_batch_is_not_silently_accepted(self):
        api, name = self.api(); original = api.request
        def request(method, suffix, *args, **kwargs):
            result = original(method, suffix, *args, **kwargs)
            if 'start_after=' in suffix: result['result'] = [object_row('unlisted')]
            return result
        api.request = request
        with self.assertRaises(DeploymentError): inspect_bucket(api, name)
        api, name = self.api(); api.objects[name] = [object_row(f'{i:04}-' + 'x' * 1010) for i in range(300)]
        with self.assertRaises(DeploymentError): inspect_bucket(api, name)
        self.assertEqual(api.writes, [])


if __name__ == '__main__': unittest.main()
