import copy
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from boundary import DeploymentError
from d1_snapshot import open_snapshot
from preview_repair_state import load_source_backup, empty_databases, reuse_objects
from snapshot_fixtures import MemoryStore, source_record, exporter_fixture
from snapshot_lifecycle import capture_backup, restore_objects


class PreviewRepairStateTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix='preview-repair-state-', dir=os.environ['EASYEMAIL_TEST_ROOT']))
        self.store = MemoryStore(); self.store.seed('INBOX', 'raw-mail', b'raw')
        self.store.seed('OUTBOX', 'restore/attachment', b'attachment')
        self.source = source_record(); self.key = 'a1' * 32
        self.backup = capture_backup(None, self.store, self.source, self.key, self.root / 'capture', exporter=exporter_fixture(self.store))
        self.target = MemoryStore()
        self.target.counter = 50
        restore_objects(self.target, self.backup['manifest'], self.backup['directory'])

    def test_reopens_only_the_authenticated_persisted_source_backup_without_remote_writes(self):
        before = list(self.store.writes)
        backup = load_source_backup(self.source, self.store, self.key, self.root / 'reopened')
        self.assertEqual(backup['manifest'], self.backup['manifest'])
        self.assertEqual(backup['id'], self.backup['id']); self.assertEqual(self.store.writes, before)
        database = open_snapshot(backup['directory'] / 'platform.sql'); database.close()

    def test_ambiguous_snapshot_wrong_key_or_changed_bytes_never_authorize_repair(self):
        with self.assertRaises(DeploymentError):
            load_source_backup(self.source, self.store, 'b2' * 32, self.root / 'wrong-key')
        row, body = self.store.rows['OUTBOX'][self.backup['object']['key']]
        duplicate = copy.deepcopy(row); duplicate['key'] = '_easyemail-sba/backups/' + 'f' * 64 + '.eesba'
        self.store.rows['OUTBOX'][duplicate['key']] = (duplicate, body)
        with self.assertRaises(DeploymentError): load_source_backup(self.source, self.store, self.key, self.root / 'duplicate')

    def test_reuses_existing_matching_native_objects_without_put_or_delete_and_rebinds_versions(self):
        before = list(self.target.writes)
        restored = reuse_objects(self.target, self.backup, self.root / 'rebound.sql')
        self.assertEqual(self.target.writes, before); self.assertEqual(len(restored['copies']), 2)
        self.assertTrue(all(row['source']['version'] != row['target']['version'] for row in restored['copies']))
        database = open_snapshot(restored['platformSql'])
        try: self.assertEqual(database.execute('SELECT object_version FROM outbox_assets').fetchone()[0], self.target.list('OUTBOX')[0]['version'])
        finally: database.close()

    def test_extra_private_object_missing_object_changed_metadata_or_bytes_are_rejected_without_writes(self):
        for mode in ('private', 'missing', 'metadata', 'bytes'):
            target = copy.deepcopy(self.target); before = list(target.writes)
            if mode == 'private': target.seed('OUTBOX', '_easyemail-sba/repair/old', b'old')
            elif mode == 'missing': target.rows['INBOX'].clear()
            elif mode == 'metadata': target.rows['INBOX']['raw-mail'][0]['httpMetadata']['contentType'] = 'text/html'
            else:
                row, _ = target.rows['INBOX']['raw-mail']; target.rows['INBOX']['raw-mail'] = (row, b'bad')
            with self.assertRaises(DeploymentError): reuse_objects(target, self.backup, self.root / (mode + '.sql'))
            self.assertEqual(target.writes, before)

    def test_any_target_user_schema_including_unknown_cf_named_schema_is_refused(self):
        class Api:
            rows = []
            def query(self, database, sql):
                self.sql = sql; return self.rows
        api = Api(); config = self.source['configuration']; empty_databases(config, api)
        self.assertIn("'_cf_METADATA','_cf_KV'", api.sql)
        for name in ('users', '_cf_surprise', 'partial_view'):
            api.rows = [{'type': 'table', 'name': name}]
            with self.assertRaisesRegex(DeploymentError, 'EASYEMAIL_PREVIEW_REPAIR_TARGET_NOT_EMPTY'):
                empty_databases(config, api)


if __name__ == '__main__': unittest.main()
