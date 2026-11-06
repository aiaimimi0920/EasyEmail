import io
import json
import os
import sqlite3
import sys
import tempfile
import unittest
import urllib.error
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from boundary import DeploymentError
from cloud_transport import CloudApi, OperationState
from d1_snapshot import export_database, open_snapshot, prove_preserved, witness
from test_cloud_transport import Response


class Binary(io.BytesIO):
    status = 200
    headers = {}


class ExportOpener:
    def __init__(self, values): self.values = iter(values); self.calls = []
    def open(self, request, timeout):
        self.calls.append(request); value = next(self.values)
        if isinstance(value, Exception): raise value
        return value


def export_response(status, *, url='https://export.synthetic.r2.cloudflarestorage.com/file.sql?signature=private', bookmark='synthetic-bookmark'):
    value = {'success': True, 'type': 'export', 'status': status, 'at_bookmark': bookmark}
    if status == 'complete': value['result'] = {'signed_url': url, 'filename': 'ignored.sql'}
    return Response({'success': True, 'errors': [], 'result': value}, status=202 if status == 'active' else 200)


class D1SnapshotTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix='sba-d1-', dir=os.environ.get('EASYEMAIL_TEST_ROOT', tempfile.gettempdir())))

    def sql(self, name, text):
        path = self.root / name; path.write_text(text, encoding='utf8'); return path

    def test_typed_multisets_preserve_unicode_blobs_nulls_numeric_types_and_duplicates(self):
        before = self.sql('before.sql', "CREATE TABLE values_test(value); INSERT INTO values_test VALUES(NULL),(1),(1.0),('1'),(X'00FF'),('邮件'),('same'),('same');")
        after = self.sql('after.sql', "CREATE TABLE values_test(value,added TEXT); INSERT INTO values_test(value) VALUES('same'),('same'),('邮件'),(X'00FF'),('1'),(1.0),(1),(NULL),('new');")
        value = witness(before); self.assertEqual(sum(value['tables']['values_test']['rows'].values()), 8)
        self.assertEqual(len(value['tables']['values_test']['rows']), 7)
        prove_preserved(value, after)
        with self.assertRaisesRegex(DeploymentError, 'EASYEMAIL_SOURCE_DATABASE_CHANGED'): prove_preserved(value, after, exact=True)
        fewer = self.sql('lost.sql', "CREATE TABLE values_test(value); INSERT INTO values_test VALUES(NULL),(1),(1.0),('1'),(X'00FF'),('邮件'),('same');")
        with self.assertRaisesRegex(DeploymentError, 'EASYEMAIL_DATABASE_ROWS_NOT_PRESERVED'): prove_preserved(value, fewer)

    def test_current_both_application_schemas_are_exportable_and_reconstructable(self):
        root = Path(__file__).resolve().parents[2]
        for role in ('email', 'platform'):
            connection = sqlite3.connect(':memory:')
            files = [root / 'upstreams/cloudflare_temp_email/db/schema.sql'] if role == 'email' else sorted((root / 'service/cloudflare/migrations').glob('*.sql'))
            for file in files: connection.executescript(file.read_text(encoding='utf8'))
            file = self.sql(role + '-native.sql', '\n'.join(connection.iterdump()))
            connection.close()
            value = witness(file); self.assertGreater(len(value['tables']), 10 if role == 'platform' else 5)
            prove_preserved(value, file, exact=True)

    def test_adjacent_floating_point_values_are_not_collapsed_by_sql_text_formatting(self):
        before = self.sql('real-before.sql', 'CREATE TABLE test(value); INSERT INTO test VALUES(1.0000000000000002);')
        after = self.sql('real-after.sql', 'CREATE TABLE test(value); INSERT INTO test VALUES(1.0);')
        with self.assertRaisesRegex(DeploymentError, 'EASYEMAIL_DATABASE_ROWS_NOT_PRESERVED'):
            prove_preserved(witness(before), after)

    def test_autoincrement_allocator_must_not_regress_even_when_the_largest_row_was_deleted(self):
        prefix = 'CREATE TABLE address(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT); INSERT INTO address VALUES(1,\'keep\'),(10,\'deleted\'); DELETE FROM address WHERE id=10;'
        before = self.sql('sequence-before.sql', prefix)
        reset = self.sql('sequence-reset.sql', prefix + "UPDATE sqlite_sequence SET seq=1 WHERE name='address';")
        advanced = self.sql('sequence-advanced.sql', prefix + "UPDATE sqlite_sequence SET seq=11 WHERE name='address';")
        with self.assertRaisesRegex(DeploymentError, 'EASYEMAIL_DATABASE_ALLOCATOR_NOT_PRESERVED'): prove_preserved(witness(before), reset)
        prove_preserved(witness(before), advanced)

    def test_sql_cannot_attach_a_file_change_filesystem_pragmas_or_load_extensions(self):
        for index, sql in enumerate(["ATTACH DATABASE 'forbidden.db' AS other;", "PRAGMA temp_store_directory='C:/';", "SELECT load_extension('not-a-library');",
                                     "CREATE TABLE test(value); INSERT INTO test VALUES(zeroblob(10000000000));"]):
            with self.subTest(sql=sql), self.assertRaisesRegex(DeploymentError, 'EASYEMAIL_SNAPSHOT_SQL_INVALID'):
                open_snapshot(self.sql(str(index) + '.sql', sql))

    def test_foreign_key_corruption_is_rejected_before_preservation_can_pass(self):
        file = self.sql('corrupt.sql', 'CREATE TABLE parent(id PRIMARY KEY); CREATE TABLE child(id REFERENCES parent(id)); INSERT INTO child VALUES(1);')
        with self.assertRaisesRegex(DeploymentError, 'EASYEMAIL_SNAPSHOT_INTEGRITY_FAILED'): witness(file)

    def client(self, opener):
        state = OperationState(self.root, 'dc-' + '1' * 32)
        api = CloudApi('a' * 32, 'synthetic-private-token', state, opener)
        api.query = lambda *_: []  # These isolated export HTTP fixtures contain no AUTOINCREMENT table.
        return api, state

    def test_202_export_poll_uses_one_bookmark_and_download_has_no_cloud_authorization(self):
        opener = ExportOpener([export_response('active'), export_response('complete'), Binary(b'CREATE TABLE test(id); INSERT INTO test VALUES(1);')])
        api, state = self.client(opener)
        result = export_database(api, '11111111-1111-1111-1111-111111111111', 'email', self.root, pause=lambda _: None)
        self.assertIn('test', result['witness']['tables']); self.assertEqual(result['bookmark'], 'synthetic-bookmark')
        self.assertEqual(json.loads(opener.calls[1].data)['current_bookmark'], 'synthetic-bookmark')
        self.assertIsNone(opener.calls[2].get_header('Authorization'))
        self.assertEqual(state.value['writes'], ['backup-email-export-0', 'backup-email-export-1'])
        self.assertNotIn('signature', state.path.read_text(encoding='utf8')); self.assertNotIn('private-token', state.path.read_text(encoding='utf8'))

    def test_private_or_unencrypted_signed_url_is_refused_without_download(self):
        for index, url in enumerate(['http://export.r2.cloudflarestorage.com/file', 'https://127.0.0.1/file', 'https://user@export.r2.cloudflarestorage.com/file',
                                     'https://export.r2.cloudflarestorage.com:invalid/file', 'https://[/file']):
            directory = self.root / str(index); directory.mkdir()
            opener = ExportOpener([export_response('complete', url=url)])
            api = CloudApi('a' * 32, 'token', OperationState(directory, 'dc-' + '1' * 32), opener)
            api.query = lambda *_: []
            with self.assertRaisesRegex(DeploymentError, 'EASYEMAIL_SNAPSHOT_DOWNLOAD_INVALID'):
                export_database(api, '11111111-1111-1111-1111-111111111111', 'email', directory)
            self.assertEqual(len(opener.calls), 1)

    def test_lost_export_response_is_not_retried_and_bookmark_drift_is_not_polled(self):
        for index, values in enumerate([[urllib.error.URLError('synthetic-private-error')], [export_response('active'), export_response('active', bookmark='changed')]]):
            directory = self.root / str(index); directory.mkdir(); opener = ExportOpener(values)
            api = CloudApi('a' * 32, 'token', OperationState(directory, 'dc-' + '1' * 32), opener)
            api.query = lambda *_: []
            with self.assertRaises(DeploymentError): export_database(api, '11111111-1111-1111-1111-111111111111', 'email', directory, pause=lambda _: None)
            self.assertEqual(len(opener.calls), len(values)); self.assertTrue(api.transport.state.attempted)

    def test_export_must_include_the_actual_live_allocator_not_just_surviving_rows(self):
        sql = b'CREATE TABLE address(id INTEGER PRIMARY KEY AUTOINCREMENT); INSERT INTO address VALUES(1);'
        api, _ = self.client(ExportOpener([export_response('complete'), Binary(sql)]))
        api.query = lambda database, sql: [{'present': 1}] if 'sqlite_master' in sql else [{'name': 'address', 'seq': 10}]
        with self.assertRaisesRegex(DeploymentError, 'EASYEMAIL_SNAPSHOT_ALLOCATOR_NOT_EXPORTED'):
            export_database(api, '11111111-1111-1111-1111-111111111111', 'email', self.root)


if __name__ == '__main__': unittest.main()
