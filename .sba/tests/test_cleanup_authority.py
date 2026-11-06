import copy
import hashlib
import hmac
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from boundary import DeploymentError, digest
from configuration import inventory
from preview_provenance import load_provenance, consume_provenance, RESULT_IDENTITY
import test_contract


class CleanupAuthorityTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix='cleanup-authority-', dir=os.environ['EASYEMAIL_TEST_ROOT']))
        self.preview = test_contract.ContractTests().preview(); self.key = 'd3' * 32
        checks = [{'id': name, 'passed': True} for name in ('snapshot-copied', 'migration-verified', 'source-unchanged', 'side-effects-isolated')]
        result = {**{field: self.preview[field] for field in RESULT_IDENTITY}, 'status': 'succeeded', 'checks': checks,
                  'lifecycle': {'resources': [{'key': row['key'], 'status': 'created'} for row in self.preview['context']['resources']],
                                'urls': self.preview['context']['urls'], 'snapshot': {'id': 'a' * 64, 'createdAt': 7}}}
        self.payload = {'schemaVersion': 1, 'previewTaskId': self.preview['taskId'], 'configurationDigest': digest(self.preview['configuration']),
                        'resources': self.preview['context']['resources'], 'source': self.preview['context']['source'],
                        'state': {'localIdentity': 'exact'}, 'result': result, 'resultDigest': digest(result)}
        self.request = {**self.preview, 'action': 'destroy-preview', 'taskId': 'dc-' + '4' * 32,
                        'previous': {key: self.preview[key] for key in ('sourceSha', 'applicationVersion')},
                        'context': {'instanceId': self.preview['taskId'], 'previewTaskId': self.preview['taskId'],
                                    'resultDigest': digest(result), 'resources': self.payload['resources']}}

    def store(self, payload=None, signature=None, guard=False, mutate_download=False):
        payload = self.payload if payload is None else payload
        signature = signature or hmac.new(bytes.fromhex(self.key), digest(payload).encode('ascii'), hashlib.sha256).hexdigest()
        raw = json.dumps({'payload': payload, 'signature': signature}).encode('utf8')
        name = '_easyemail-sba/previews/' + self.preview['taskId'] + '.json'
        metadata = {'key': name, 'size': len(raw), 'customMetadata': {'format': 'easyemail-preview-v1', 'sha256': hashlib.sha256(raw).hexdigest()}}
        calls = []; contents = {name: raw}
        class Store:
            def list(self, bucket):
                return [metadata] + ([{'key': '_easyemail-sba/cleanup/' + payload['previewTaskId'] + '.json'}] if guard else [])
            def get(self, bucket, row, path=None):
                body = contents[row['key']]
                if path is not None: Path(path).write_bytes(body)
                return 'b' * 64 if mutate_download else hashlib.sha256(body).hexdigest()
            def upload(self, bucket, key, path, value, checksum, label):
                calls.append((key, json.loads(Path(path).read_text(encoding='utf8')), label))
                contents[key] = Path(path).read_bytes()
                return {'key': key}
        return Store(), calls

    def test_valid_provenance_binds_approved_complete_result_and_consumes_once(self):
        store, calls = self.store()
        record = load_provenance(self.request, store, self.key, self.root)
        self.assertEqual(record, self.payload)
        consume_provenance(self.request, record, store, self.key, self.root)
        self.assertEqual(calls[0][0], '_easyemail-sba/cleanup/' + self.preview['taskId'] + '.json')
        self.assertEqual(calls[0][1]['payload']['destroyTaskId'], self.request['taskId'])
        self.assertEqual(calls[0][2], 'preview-cleanup-authority-consumed')

    def test_untrusted_signature_wrong_hash_or_existing_attempt_cannot_authorize_any_write(self):
        for options in [{'signature': 'e' * 64}, {'mutate_download': True}, {'guard': True}]:
            store, calls = self.store(**options)
            with self.assertRaises(DeploymentError): load_provenance(self.request, store, self.key, self.root)
            self.assertEqual(calls, [])

    def test_even_signed_proof_cannot_expand_inventory_retarget_source_or_change_result(self):
        for mutate in [lambda p: p['resources'].append(p['source']['resources'][0]),
                       lambda p: p.update(configurationDigest='e' * 64),
                       lambda p: p['result'].update(sourceSha='e' * 40),
                       lambda p: p['result']['lifecycle']['resources'][0].update(status='unknown'),
                       lambda p: p['result']['checks'].pop(),
                       lambda p: p['source']['resources'].append(p['resources'][0])]:
            payload = copy.deepcopy(self.payload); mutate(payload)
            store, calls = self.store(payload)
            with self.assertRaises(DeploymentError): load_provenance(self.request, store, self.key, self.root)
            self.assertEqual(calls, [])

    def test_wrong_approved_digest_or_instance_identity_cannot_use_a_valid_proof(self):
        for key in ('resultDigest', 'previewTaskId', 'instanceId'):
            value = copy.deepcopy(self.request); value['context'][key] = 'e' * (64 if key == 'resultDigest' else 35)
            store, calls = self.store()
            with self.assertRaises(DeploymentError): load_provenance(value, store, self.key, self.root)
            self.assertEqual(calls, [])


if __name__ == '__main__': unittest.main()
