import base64
import copy
import hashlib
import io
import json
import os
import sys
import tempfile
import unittest
import urllib.error
from email.message import Message
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from boundary import DeploymentError
from cloud_transport import OperationState
from object_snapshot import ObjectStore, business_inventory
from test_cloud_transport import Response, SequenceOpener
from fixtures import configuration


def object_metadata():
    return {'key': 'folder/邮件 ?#%&.bin', 'size': 3, 'etag': 'a' * 32, 'version': 'synthetic-version',
            'uploaded': '2026-11-06T00:00:00.000Z', 'httpMetadata': {'contentType': 'application/test'},
            'customMetadata': {'owner': '测试'}, 'storageClass': 'Standard'}


class BinaryResponse(io.BytesIO):
    def __init__(self, body, row):
        super().__init__(body); self.status = 200; self.headers = Message()
        self.headers['Content-Length'] = str(row['size'])
        self.headers['x-easyemail-r2-metadata'] = base64.b64encode(json.dumps(row).encode()).decode()


class BinaryOpener:
    def __init__(self, value): self.value = value; self.calls = []
    def open(self, request, timeout): self.calls.append(request); return self.value


class ObjectSnapshotTests(unittest.TestCase):
    def store(self, opener):
        root = Path(tempfile.mkdtemp(prefix='sba-object-client-', dir=os.environ.get('EASYEMAIL_TEST_ROOT', tempfile.gettempdir())))
        state = OperationState(root, 'dc-' + '1' * 32)
        return ObjectStore(configuration(), 'a1' * 32, state, opener), root

    def test_binary_reader_checks_exact_metadata_size_and_digest_without_writes(self):
        row = object_metadata(); opener = BinaryOpener(BinaryResponse(b'abc', row)); store, root = self.store(opener)
        checksum = store.get('INBOX', row, root / '0.object')
        self.assertEqual(checksum, hashlib.sha256(b'abc').hexdigest()); self.assertEqual((root / '0.object').read_bytes(), b'abc')
        self.assertFalse(store.state.attempted)
        self.assertIn('key=folder%2F', opener.calls[0].full_url); self.assertNotIn('a1' * 32, opener.calls[0].full_url)
        self.assertEqual(opener.calls[0].get_header('User-agent'), 'EasyEmail-SBA/1.0')
        self.assertEqual(opener.calls[0].get_header('Authorization'), 'Bearer ' + 'a1' * 32)

    def test_binary_upload_and_independent_readback_identify_the_same_client(self):
        row = object_metadata()
        class Uploaded:
            def __init__(self): self.calls = []
            def open(self, request, timeout):
                self.calls.append(request)
                return Response(row, status=201) if request.get_method() == 'PUT' else BinaryResponse(b'abc', row)
        opener = Uploaded(); store, root = self.store(opener); file = root / 'upload.object'; file.write_bytes(b'abc')
        actual = store.put('OUTBOX', row['key'], file, row, hashlib.sha256(b'abc').hexdigest(), 'object-copied-0')
        self.assertEqual(actual, row)
        self.assertEqual([request.get_method() for request in opener.calls], ['PUT', 'GET'])
        for request in opener.calls:
            self.assertEqual(request.get_header('User-agent'), 'EasyEmail-SBA/1.0')
            self.assertEqual(request.get_header('Authorization'), 'Bearer ' + 'a1' * 32)
            self.assertNotIn('a1' * 32, request.full_url)
        self.assertEqual(store.state.value['writes'], ['object-copied-0'])

    def test_changed_metadata_wrong_length_and_missing_content_are_not_a_snapshot(self):
        for change in ('version', 'truncated', 'extra', 'missing-header'):
            row = object_metadata(); expected = copy.deepcopy(row)
            if change == 'version': row['version'] = 'new-version'
            response = BinaryResponse(b'ab' if change == 'truncated' else b'abcd' if change == 'extra' else b'abc', row)
            if change == 'missing-header': del response.headers['x-easyemail-r2-metadata']
            store, root = self.store(BinaryOpener(response))
            with self.subTest(change=change), self.assertRaises(DeploymentError): store.get('INBOX', expected, root / '0.object')
            self.assertFalse(store.state.attempted)

    def test_unfinished_or_repeated_cursor_and_duplicate_objects_are_rejected(self):
        first = {'objects': [object_metadata()], 'truncated': True, 'cursor': 'repeat'}
        for following in [first, {'objects': [], 'truncated': True, 'cursor': 'repeat'}, {'objects': [], 'truncated': False, 'cursor': 'unexpected'}]:
            store, _ = self.store(SequenceOpener([first, following]))
            with self.assertRaisesRegex(DeploymentError, 'EASYEMAIL_OBJECT_LIST_INCOMPLETE'): store.list('INBOX')

    def test_lost_put_response_records_once_and_refuses_replay_without_second_request(self):
        class Lost:
            def __init__(self): self.calls = 0
            def open(self, request, timeout): self.calls += 1; raise urllib.error.URLError('synthetic-private-error')
        opener = Lost(); store, root = self.store(opener); file = root / '0.object'; file.write_bytes(b'abc')
        checksum = hashlib.sha256(b'abc').hexdigest()
        with self.assertRaisesRegex(DeploymentError, 'EASYEMAIL_OBJECT_WRITE_UNCONFIRMED'):
            store.put('OUTBOX', object_metadata()['key'], file, object_metadata(), checksum, 'object-copied-0')
        self.assertTrue(store.state.attempted)
        with self.assertRaisesRegex(DeploymentError, 'EASYEMAIL_WRITE_REPLAY_REFUSED'):
            store.put('OUTBOX', object_metadata()['key'], file, object_metadata(), checksum, 'object-copied-0')
        self.assertEqual(opener.calls, 1)

    def test_only_adapter_owned_outbox_namespace_is_excluded_from_business_inventory(self):
        class Store:
            def list(self, bucket): return [{**object_metadata(), 'key': key} for key in ('normal/object', '_easyemail-sba/backups/task')]
        value = business_inventory(Store())
        self.assertEqual(len(value['INBOX']), 2); self.assertEqual(len(value['OUTBOX']), 1)


if __name__ == '__main__': unittest.main()
