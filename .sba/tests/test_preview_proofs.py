import copy
import hashlib
import hmac
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from boundary import DeploymentError, digest
from preview_copy import verify_preview_policy
from preview_provenance import persist_provenance, RESULT_IDENTITY
from preview_source import source_state, prove_source_unchanged, capture_source_witness
from d1_snapshot import witness, prove_preserved
import test_contract


class PreviewProofTests(unittest.TestCase):
    def test_policy_requires_every_isolation_property_and_exact_destination(self):
        root = Path(tempfile.mkdtemp(prefix='preview-policy-', dir=os.environ['EASYEMAIL_TEST_ROOT']))
        config = test_contract.ContractTests().preview()['configuration']
        policy = {'emailOrigin': config['email']['origin'], 'fetchRedirects': 'manual-reject',
                  'sockets': False, 'websockets': False, 'inboundEmail': False, 'scheduled': False}
        path = root / 'sba-release.json'
        path.write_text(json.dumps({'previewPolicy': policy}), encoding='utf8'); verify_preview_policy(root, config)
        for mutate in [lambda p: p.pop('scheduled'), lambda p: p.update(sockets=True),
                       lambda p: p.update(emailOrigin='https://other.example.com'), lambda p: p.update(version=1)]:
            invalid = copy.deepcopy(policy); mutate(invalid)
            path.write_text(json.dumps({'previewPolicy': invalid}), encoding='utf8')
            with self.assertRaisesRegex(DeploymentError, 'EASYEMAIL_PREVIEW_POLICY_MISMATCH'): verify_preview_policy(root, config)

    def test_source_core_bindings_must_match_and_other_settings_are_fingerprinted(self):
        value = test_contract.ContractTests().preview()['context']['source']['configuration']
        responses = {}
        for role in ('email', 'platform'):
            path = '/workers/scripts/' + value[role]['name']
            bindings = [{'name': 'DB', 'type': 'd1', 'id': value[role]['database']['id']}]
            if role == 'platform': bindings += [{'name': name, 'type': 'r2_bucket', 'bucket_name': value[role][field]}
                                                for name, field in [('INBOX', 'inboxBucket'), ('OUTBOX', 'outboxBucket')]]
            responses.update({path + '/settings': {'bindings': bindings}, path + '/schedules': {'schedules': []}, path + '/subdomain': {'enabled': False}})
        class Api:
            def get(self, path): return responses[path]
        with patch('preview_source.managed_state', return_value={'identity': 'exact'}):
            before = source_state(value, Api())
            responses['/workers/scripts/' + value['platform']['name'] + '/settings']['bindings'].reverse()
            self.assertEqual(source_state(value, Api()), before)
            responses['/workers/scripts/' + value['email']['name'] + '/schedules']['schedules'].append({'cron': '*/5 * * * *'})
            self.assertNotEqual(source_state(value, Api()), before)
            responses['/workers/scripts/' + value['platform']['name'] + '/settings']['bindings'][0]['bucket_name'] = 'foreign'
            with self.assertRaisesRegex(DeploymentError, 'EASYEMAIL_SOURCE_BINDINGS_CHANGED'): source_state(value, Api())

    def test_source_final_export_uses_a_unique_phase_and_checks_bytes_not_only_inventory(self):
        root = Path(tempfile.mkdtemp(prefix='preview-source-', dir=os.environ['EASYEMAIL_TEST_ROOT']))
        config = test_contract.ContractTests().preview()['context']['source']['configuration']
        obj = {'bucket': 'INBOX', 'source': {'key': 'mail'}, 'sha256': 'a' * 64}
        backup = {'manifest': {'databases': {role: {'witness': role} for role in ('email', 'platform')}, 'objects': [obj]}}
        phases = []
        def exporter(api, database, role, directory, *, phase): phases.append(phase); return {'path': root / (role + '.sql')}
        class Store:
            def get(self, bucket, expected): return 'b' * 64
        with patch('preview_source.prove_preserved') as proof, patch('preview_source.business_inventory', return_value={'INBOX': [obj['source']], 'OUTBOX': []}):
            with self.assertRaisesRegex(DeploymentError, 'EASYEMAIL_SOURCE_OBJECTS_CHANGED'):
                prove_source_unchanged(backup, object(), Store(), config, root / 'final', exporter=exporter)
        self.assertEqual(phases, ['sourcefinal', 'sourcefinal'])
        self.assertTrue(all(call.kwargs['exact'] for call in proof.call_args_list))

    def test_private_provenance_binds_complete_result_and_is_independently_read_back(self):
        root = Path(tempfile.mkdtemp(prefix='preview-provenance-', dir=os.environ['EASYEMAIL_TEST_ROOT']))
        request = test_contract.ContractTests().preview(); result = {'status': 'succeeded', 'checks': [], 'lifecycle': {'synthetic': True}}
        key = 'd3' * 32; uploads = []
        class Store:
            def upload(self, bucket, name, path, metadata, checksum, label):
                uploads.append((bucket, name, path, metadata, checksum, label)); return {'key': name}
            def get(self, bucket, row): return uploads[0][4]
        persist_provenance(request, result, {'identity': 'exact'}, Store(), key, root)
        record = json.loads((root / 'preview-provenance.json').read_text(encoding='utf8'))
        payload = record['payload']; full = {**{field: request[field] for field in RESULT_IDENTITY}, **result}
        self.assertEqual(payload['result'], full); self.assertEqual(payload['resultDigest'], digest(full))
        self.assertEqual(record['signature'], hmac.new(bytes.fromhex(key), digest(payload).encode('ascii'), hashlib.sha256).hexdigest())
        self.assertEqual(payload['resources'], request['context']['resources'])
        self.assertEqual(payload['configurationDigest'], digest(request['configuration']))
        self.assertIn('/previews/' + request['taskId'], uploads[0][1]); self.assertNotIn(key, (root / 'preview-provenance.json').read_text())

    def test_current_source_witness_keeps_all_tables_and_hashes_every_business_object(self):
        root = Path(tempfile.mkdtemp(prefix='source-capture-', dir=os.environ['EASYEMAIL_TEST_ROOT']))
        config = test_contract.ContractTests().preview()['context']['source']['configuration']
        inventories = {'INBOX': [{'key': 'raw'}], 'OUTBOX': [{'key': 'attachment'}]}
        exported = []; reads = []
        def exporter(api, database, role, directory, *, phase):
            exported.append((role, phase))
            return {'witness': {'tables': {'auth_rate_limits': {'rows': {'new-row': 1}}, 'drafts': {'rows': {'old-row': 1}}}}}
        class Store:
            def get(self, bucket, row): reads.append((bucket, row['key'])); return 'a' * 64
        with patch('preview_source.business_inventory', return_value=inventories):
            current = capture_source_witness(object(), Store(), config, root / 'current', exporter=exporter)
        self.assertEqual(exported, [('email', 'sourcecheck'), ('platform', 'sourcecheck')])
        self.assertEqual(reads, [('INBOX', 'raw'), ('OUTBOX', 'attachment')])
        self.assertIn('auth_rate_limits', current['manifest']['databases']['platform']['witness']['tables'])
        self.assertEqual(len(current['manifest']['objects']), 2)
        with patch('preview_source.business_inventory', side_effect=[inventories, {'INBOX': [], 'OUTBOX': []}]), \
                self.assertRaisesRegex(DeploymentError, 'EASYEMAIL_SOURCE_OBJECTS_CHANGED'):
            capture_source_witness(object(), Store(), config, root / 'drift', exporter=exporter)

    def test_historical_restore_point_is_not_the_live_guard_and_rate_changes_during_operation_still_fail(self):
        root = Path(tempfile.mkdtemp(prefix='source-timepoint-', dir=os.environ['EASYEMAIL_TEST_ROOT']))
        config = test_contract.ContractTests().preview()['context']['source']['configuration']
        sql = 'CREATE TABLE auth_rate_limits(bucket TEXT PRIMARY KEY, attempts INTEGER, expires_at INTEGER);'
        historical = root / 'historical.sql'; historical.write_text(sql, encoding='utf8')
        live = root / 'live.sql'; live.write_text(sql + "INSERT INTO auth_rate_limits VALUES('read-after-backup',1,123);", encoding='utf8')
        with self.assertRaisesRegex(DeploymentError, 'EASYEMAIL_SOURCE_DATABASE_CHANGED'):
            prove_preserved(witness(historical), live, exact=True)
        def exporter(*args, **kwargs): return {'witness': witness(live), 'path': live}
        with patch('preview_source.business_inventory', return_value={'INBOX': [], 'OUTBOX': []}):
            current = capture_source_witness(object(), object(), config, root / 'before', exporter=exporter)
            prove_source_unchanged(current, object(), object(), config, root / 'unchanged', exporter=exporter)
            live.write_text(live.read_text(encoding='utf8') + "UPDATE auth_rate_limits SET attempts=2;", encoding='utf8')
            with self.assertRaisesRegex(DeploymentError, 'EASYEMAIL_SOURCE_DATABASE_CHANGED'):
                prove_source_unchanged(current, object(), object(), config, root / 'changed', exporter=exporter)


if __name__ == '__main__': unittest.main()
