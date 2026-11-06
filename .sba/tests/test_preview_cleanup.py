import hashlib
import json
import os
import sys
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import preview_cleanup
from boundary import DeploymentError, require
from cloud_transport import OperationState
from deployment_secrets import deployment_secrets
from preview_provenance import persist_provenance
from cleanup_fixtures import CleanupApi
from test_deploy_secrets import secret_environment
import test_contract


class PreviewCleanupTests(unittest.TestCase):
    def cleanup(self, *, fail=None, drift=False, foreign=False, late_binding=False, repeat=False, outbox_full=False):
        root = Path(tempfile.mkdtemp(prefix='preview-cleanup-', dir=os.environ['EASYEMAIL_TEST_ROOT']))
        selected = test_contract.ContractTests().preview(); config = selected['configuration']
        events = []; original_state = {'syntheticIdentity': 'exact'}
        class Api(CleanupApi):
            state = None
            def request(self, method, suffix, payload=None, write=None, zone=None):
                if write:
                    self.state.before_write(write); events.append(write)
                result = super().request(method, suffix, payload, write, zone)
                if fail is not None and fail == write: raise DeploymentError('EASYEMAIL_SYNTHETIC_RESPONSE_LOST')
                return result
            def delete(self, suffix, *, write):
                self.state.before_write(write); events.append(write); super().delete(suffix, write=write)
                if late_binding and write == 'cleanup-email-worker-deleted':
                    self.workers['other-service']['bindings'] = [{'type': 'd1', 'id': config['email']['database']['id']}]
                if fail is not None and fail == write: raise DeploymentError('EASYEMAIL_SYNTHETIC_RESPONSE_LOST')
        api = Api(config); values = {}; uploads = []
        class Store:
            state = OperationState(root, selected['taskId'])
            def list(self, bucket): return [value['metadata'] for value in values.values()]
            def get(self, bucket, row, path=None):
                body = values[row['key']]['body']
                if path is not None: Path(path).write_bytes(body)
                return hashlib.sha256(body).hexdigest()
            def upload(self, bucket, key, path, source, checksum, label):
                self.state.before_write(label); require(key not in values, 'EASYEMAIL_SYNTHETIC_CONDITIONAL_CONFLICT')
                body = Path(path).read_bytes(); etag = hashlib.md5(body).hexdigest()
                metadata = {'key': key, **source, 'etag': etag, 'version': 'synthetic', 'uploaded': '2026-11-06T00:00:00Z'}
                values[key] = {'body': body, 'metadata': metadata}; uploads.append(label)
                api.objects[config['platform']['outboxBucket']].append({'key': key, 'size': len(body), 'etag': etag, 'last_modified': metadata['uploaded']})
                if label == 'preview-cleanup-authority-consumed':
                    events.append('authority-consumed')
                    if fail == 'guard': raise DeploymentError('EASYEMAIL_SYNTHETIC_RESPONSE_LOST')
                return metadata
        store = Store(); material = deployment_secrets(config, secret_environment())
        result = {'status': 'succeeded', 'checks': [{'id': name, 'passed': True} for name in
                  ('snapshot-copied', 'migration-verified', 'source-unchanged', 'side-effects-isolated')], 'lifecycle': {
                    'resources': [{'key': row['key'], 'status': 'created'} for row in selected['context']['resources']],
                    'urls': selected['context']['urls'], 'snapshot': {'id': 'a' * 64, 'createdAt': 7}}}
        persist_provenance(selected, result, original_state, store, material.archive_key, root)
        if outbox_full:
            api.objects[config['platform']['outboxBucket']] += [{'key': f'object-{index:04}', 'size': 1, 'etag': 'a' * 32,
                'last_modified': '2026-11-06T00:00:00Z'} for index in range(999)]
        from boundary import digest
        full = {**{key: selected[key] for key in ('schemaVersion', 'taskId', 'action', 'sourceSha', 'applicationVersion')}, **result}
        request = {**selected, 'taskId': 'dc-' + '4' * 32, 'action': 'destroy-preview',
                   'previous': {key: selected[key] for key in ('sourceSha', 'applicationVersion')}, 'context': {
                       'instanceId': selected['taskId'], 'previewTaskId': selected['taskId'], 'resultDigest': digest(full),
                       'resources': selected['context']['resources']}}
        if foreign: api.workers['other-service']['bindings'] = [{'type': 'd1', 'id': config['email']['database']['id']}]
        def cloud(account, token, state): api.state = state; return api
        def objects(config, key, state): store.state = state; return store
        with ExitStack() as stack:
            stack.enter_context(patch.dict(os.environ, secret_environment()))
            stack.enter_context(patch.object(preview_cleanup, 'CloudApi', side_effect=cloud))
            stack.enter_context(patch.object(preview_cleanup, 'ObjectStore', side_effect=objects))
            stack.enter_context(patch.object(preview_cleanup, 'source_state', return_value={'changed': True} if drift else original_state))
            stack.enter_context(patch.object(preview_cleanup, 'verify_public', return_value=[]))
            result = preview_cleanup.destroy_preview(request, root / 'operation')
            if repeat: result = preview_cleanup.destroy_preview({**request, 'taskId': 'dc-' + '5' * 32}, root / 'operation-two')
        return result, events, api, uploads

    def test_guard_then_both_ingress_stops_then_workers_then_data_with_absence_readbacks(self):
        result, events, api, uploads = self.cleanup()
        self.assertEqual(result['status'], 'succeeded', result)
        order = ['authority-consumed', 'cleanup-platform-ingress-stopped', 'cleanup-email-ingress-stopped',
                 'cleanup-platform-worker-deleted', 'cleanup-email-worker-deleted', 'cleanup-platform-database-deleted',
                 'cleanup-email-database-deleted', 'cleanup-inbox-bucket-deleted', 'cleanup-outbox-objects-deleted', 'cleanup-outbox-bucket-deleted']
        self.assertEqual(events, order)
        self.assertEqual(set(api.workers), {'other-service'}); self.assertEqual(api.databases, {}); self.assertEqual(api.buckets, {})
        self.assertTrue(all(row['status'] == 'removed' for row in result['lifecycle']['resources']))

    def test_target_drift_or_foreign_binding_fails_before_guard_or_deletion(self):
        for options in [{'drift': True}, {'foreign': True}]:
            result, events, api, uploads = self.cleanup(**options)
            self.assertEqual(result['status'], 'failed'); self.assertEqual(events, []); self.assertEqual(api.writes, [])
            self.assertNotIn('preview-cleanup-authority-consumed', uploads)

    def test_guard_capacity_is_reserved_before_consuming_authority(self):
        result, events, api, uploads = self.cleanup(outbox_full=True)
        self.assertEqual(result['status'], 'failed'); self.assertEqual(events, []); self.assertEqual(api.writes, [])
        self.assertNotIn('preview-cleanup-authority-consumed', uploads)

    def test_any_write_response_loss_is_unknown_and_never_replayed(self):
        for stage in ('guard', 'cleanup-platform-ingress-stopped', 'cleanup-email-worker-deleted', 'cleanup-platform-database-deleted',
                      'cleanup-outbox-objects-deleted', 'cleanup-outbox-bucket-deleted'):
            result, events, api, uploads = self.cleanup(fail=stage)
            self.assertEqual(result['status'], 'unknown', (stage, result))
            self.assertEqual(result['errorCode'], 'EASYEMAIL_SYNTHETIC_RESPONSE_LOST')
            self.assertEqual(len(events), len(set(events)))

    def test_late_foreign_reference_after_workers_stop_preserves_all_data(self):
        result, events, api, uploads = self.cleanup(late_binding=True)
        self.assertEqual(result['status'], 'unknown'); self.assertEqual(len(api.databases), 2); self.assertEqual(len(api.buckets), 2)
        self.assertFalse(any('database-deleted' in event for event in events))

    def test_durable_attempt_guard_refuses_a_fresh_task_without_replaying_partial_cleanup(self):
        result, events, api, uploads = self.cleanup(fail='cleanup-platform-ingress-stopped', repeat=True)
        self.assertEqual(result['status'], 'failed'); self.assertEqual(result['errorCode'], 'EASYEMAIL_PREVIEW_CLEANUP_ALREADY_ATTEMPTED')
        self.assertEqual(events.count('cleanup-platform-ingress-stopped'), 1)
        self.assertNotIn('cleanup-platform-worker-deleted', events)


if __name__ == '__main__': unittest.main()
