import copy
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from cleanup_journal import TABLE
from cleanup_resume_fixtures import ResumeFixture


class CleanupResumeTests(unittest.TestCase):
    def test_partial_cleanup_claim_is_durable_before_deletes_and_platform_database_is_last(self):
        f = ResumeFixture(); result = f.run()
        self.assertEqual(result['status'], 'succeeded', result)
        self.assertEqual(f.api.writes[:2], ['cleanup-resume-table-created', 'cleanup-resume-claim-written'])
        self.assertEqual(f.api.writes[-1], 'cleanup-platform-database-deleted')
        self.assertEqual(len(f.api.writes), len(set(f.api.writes)))
        self.assertTrue(all(row['status'] in ('removed', 'absent') for row in result['lifecycle']['resources']))
        self.assertEqual(f.api.databases, {}); self.assertEqual(f.api.buckets, {})
        self.assertEqual(set(f.api.workers), {'other-service'})
        self.assertFalse(any(method == 'POST' for method, path, zone in f.api.calls))

    def test_lost_insert_response_recovers_the_exact_parent_row_without_a_success_check(self):
        f = ResumeFixture(); f.api.fail = 'cleanup-resume-claim-written'; first = f.run()
        self.assertEqual(first['status'], 'unknown', first); self.assertEqual(first['checks'], [])
        self.assertFalse(any('deleted' in label for label in f.api.writes))
        f.api.fail = None; next_request = f.successor(first)
        self.assertIsNone(next_request['context']['cleanupProgress']['journalTaskId'])
        result = f.run(next_request); self.assertEqual(result['status'], 'succeeded', result)
        self.assertEqual(f.api.writes.count('cleanup-resume-table-created'), 1)

    def test_each_lost_delete_response_continues_only_with_remaining_identity_and_never_redeletes_absent_items(self):
        for label in ('cleanup-email-worker-deleted', 'cleanup-email-database-deleted', 'cleanup-resume-outbox-objects-deleted',
                      'cleanup-resume-inbox-bucket-deleted', 'cleanup-resume-outbox-bucket-deleted', 'cleanup-platform-database-deleted'):
            with self.subTest(label=label):
                f = ResumeFixture(); f.api.fail = label; first = f.run(); self.assertEqual(first['status'], 'unknown', first)
                f.api.fail = None; result = f.run(f.successor(first)); self.assertEqual(result['status'], 'succeeded', result)
                self.assertEqual(f.api.writes.count(label), 1)

    def test_lost_create_response_empty_or_missing_journal_never_becomes_fresh_authority(self):
        f = ResumeFixture(); f.api.fail = 'cleanup-resume-table-created'; first = f.run()
        self.assertEqual(first['status'], 'unknown', first); writes = f.api.writes.copy(); f.api.fail = None
        result = f.run(f.successor(first)); self.assertEqual(result['status'], 'failed', result); self.assertEqual(f.api.writes, writes)

    def test_initial_foreign_reference_future_worker_or_recreated_storage_fail_before_journal(self):
        for mutate in (lambda f: f.api.workers['other-service']['bindings'].append({'name': 'foreign', 'type': 'd1', 'id': f.request['configuration']['email']['database']['id']}),
                       lambda f: f.api.created.update({f.request['configuration']['email']['name']: '2026-11-07T00:00:00Z'}),
                       lambda f: next(iter(f.api.buckets.values())).update(creation_date='2026-11-05T00:00:00Z'),
                       lambda f: f.api.exposures[f.request['configuration']['email']['name']].update(enabled=True)):
            f = ResumeFixture(); mutate(f); result = f.run()
            self.assertEqual(result['status'], 'failed', result); self.assertEqual(f.api.writes, [])

    def test_signed_journal_rejects_modified_objects_worker_settings_or_database_identity(self):
        for mutate in (lambda f: next(iter(f.api.objects.values())).append({'key': 'foreign', 'size': 1, 'etag': 'f' * 32, 'last_modified': '2026-11-06T00:00:00Z'}),
                       lambda f: f.api.objects[f.request['configuration']['platform']['outboxBucket']][0].update(etag='f' * 32),
                       lambda f: f.api.workers[f.request['configuration']['email']['name']].update(logpush=True),
                       lambda f: next(iter(f.api.databases.values())).update(created_at='2026-11-05T00:00:00Z')):
            f = ResumeFixture(); f.api.fail = 'cleanup-resume-claim-written'; first = f.run(); f.api.fail = None
            writes = f.api.writes.copy(); mutate(f); result = f.run(f.successor(first))
            self.assertEqual(result['status'], 'failed', result); self.assertEqual(f.api.writes, writes)

    def test_tampered_claim_wrong_parent_digest_and_sibling_attempt_are_refused(self):
        for change in ('signature', 'request', 'sibling'):
            f = ResumeFixture(); f.api.fail = 'cleanup-resume-claim-written'; first = f.run(); f.api.fail = None
            next_request = f.successor(first)
            if change == 'signature':
                row = f.api.connection.execute(f'SELECT record FROM {TABLE}').fetchone(); record = json.loads(row['record']); record['signature'] = '0' * 64
                f.api.connection.execute(f'UPDATE {TABLE} SET record=?', [json.dumps(record)]); f.api.connection.commit()
            elif change == 'request': next_request['context']['requestDigest'] = '0' * 64
            else: next_request = copy.deepcopy(f.request); next_request['taskId'] = 'dc-' + '8' * 32
            writes = f.api.writes.copy(); result = f.run(next_request)
            self.assertEqual(result['status'], 'failed', result); self.assertEqual(f.api.writes, writes)

    def test_missing_journal_database_with_any_remaining_target_is_never_recreated(self):
        f = ResumeFixture(); f.api.databases.pop(f.request['configuration']['platform']['database']['id'])
        result = f.run(); self.assertEqual(result['status'], 'failed', result); self.assertEqual(f.api.writes, [])


if __name__ == '__main__': unittest.main()
