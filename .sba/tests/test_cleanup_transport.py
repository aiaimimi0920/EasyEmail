import io
import json
import os
import sys
import tempfile
import unittest
import urllib.error
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from boundary import DeploymentError
from cloud_transport import CloudApi, OperationState


class Response(io.BytesIO):
    def __init__(self, status, body):
        super().__init__(body); self.status = status; self.headers = {}


class CleanupTransportTests(unittest.TestCase):
    def api(self, status, body):
        root = Path(tempfile.mkdtemp(prefix='cleanup-transport-', dir=os.environ['EASYEMAIL_TEST_ROOT']))
        operation = OperationState(root, 'dc-' + '1' * 32)
        class Opener:
            def open(self, request, timeout):
                if status >= 400: raise urllib.error.HTTPError(request.full_url, status, 'synthetic', {}, io.BytesIO(body))
                return Response(status, body)
        return CloudApi('a' * 32, 'synthetic-token', operation, Opener()), operation

    def test_delete_accepts_empty_2xx_only_with_journal_and_never_replays(self):
        for status in (200, 202, 204):
            api, state = self.api(status, b'')
            api.delete('/workers/scripts/test-selected', write='selected-worker-deleted')
            self.assertTrue(state.attempted)
            with self.assertRaises(DeploymentError): api.delete('/workers/scripts/test-selected', write='selected-worker-deleted')

    def test_partial_false_json_unexpected_status_or_unjournalled_delete_is_rejected(self):
        for status, body in [(200, b'{"success":false,"errors":[],"result":null}'), (403, b'{}'), (404, b'{}'), (200, b'invalid')]:
            api, state = self.api(status, body)
            with self.assertRaises(DeploymentError): api.delete('/workers/scripts/test-selected', write='selected-worker-deleted')
            self.assertTrue(state.attempted)

    def test_only_explicitly_accepted_error_status_can_be_observed_without_converting_it_to_success(self):
        body = json.dumps({'success': False, 'errors': [{'code': 11015}], 'result': None}).encode()
        api, state = self.api(404, body)
        value, status = api.read_response('/event_notifications/r2/test-bucket/configuration', statuses=(200, 404))
        self.assertEqual(status, 404); self.assertEqual(value['errors'][0]['code'], 11015); self.assertFalse(state.attempted)
        api, _ = self.api(403, body)
        with self.assertRaises(DeploymentError): api.read_response('/event_notifications/r2/test-bucket/configuration', statuses=(200, 404))
        api, _ = self.api(404, body)
        with self.assertRaises(DeploymentError): api.get('/event_notifications/r2/test-bucket/configuration')


if __name__ == '__main__': unittest.main()
