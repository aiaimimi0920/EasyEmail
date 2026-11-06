import copy
import os
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from boundary import DeploymentError
from object_snapshot import business_inventory
from snapshot_bundle import crypto_file, open_backup, seal_backup
from snapshot_lifecycle import capture_backup, restore_objects
from snapshot_fixtures import MemoryStore, source_record, exporter_fixture, exported_sql


class SnapshotLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix='sba-archive-', dir=os.environ['EASYEMAIL_TEST_ROOT']))
        self.source = MemoryStore()
        self.source.seed('INBOX', 'unsafe/../../邮件 ?#', b'raw-mail\x00')
        self.source.seed('OUTBOX', 'restore/attachment', b'attachment')
        self.source.seed('OUTBOX', '_easyemail-sba/backups/previous', b'prior-private-backup')
        self.record = source_record(); self.key = 'a1' * 32

    def capture(self, name='backup', exporter=None):
        return capture_backup(None, self.source, self.record, self.key, self.root / name, exporter=exporter or exporter_fixture(self.source))

    def test_two_databases_two_buckets_persist_encrypted_restore_proof_and_rebind(self):
        before = business_inventory(self.source); result = self.capture()
        self.assertEqual(business_inventory(self.source), before)
        self.assertEqual(self.source.writes, ['snapshot-archive-persisted'])
        self.assertGreaterEqual(self.source.reads.count(('OUTBOX', result['object']['key'])), 1)
        encrypted = self.source.rows['OUTBOX'][result['object']['key']][1]
        self.assertNotIn(b'CREATE TABLE', encrypted); self.assertNotIn('邮件'.encode(), encrypted)
        self.assertEqual(sum(len(rows) for rows in before.values()), len(result['manifest']['objects']))
        self.assertNotIn('_easyemail-sba/', str(result['manifest']['objects']))
        target = MemoryStore()
        restored = restore_objects(target, result['manifest'], result['directory'])
        self.assertEqual(restored['emailSql'].read_bytes(), (self.root / 'backup/data/email.sql').read_bytes())
        self.assertEqual({bucket: {key: body for key, (_, body) in target.rows[bucket].items()} for bucket in target.rows},
                         {bucket: {key: body for key, (_, body) in self.source.rows[bucket].items() if not (bucket == 'OUTBOX' and key.startswith('_easyemail-sba/'))} for bucket in target.rows})
        self.assertTrue(restored['platformSql'].is_file())

    def test_detected_database_drift_blocks_persistent_backup_without_overwriting_source(self):
        original = exporter_fixture(self.source)
        def drifting(api, database, role, directory, **kwargs):
            if kwargs.get('phase') == 'sourcecheck' and role == 'email':
                return exported_sql(Path(directory) / 'email.sql', 'CREATE TABLE email_test(value); INSERT INTO email_test VALUES(\'changed\');')
            return original(api, database, role, directory, **kwargs)
        with self.assertRaisesRegex(DeploymentError, 'EASYEMAIL_SOURCE_DATABASE_CHANGED'): self.capture(exporter=drifting)
        self.assertEqual(self.source.writes, [])

    def test_detected_object_drift_blocks_archive_persistence(self):
        exporter = exporter_fixture(self.source)
        original = self.source.list; count = 0
        def drifting(bucket):
            nonlocal count
            count += 1
            if count == 3: self.source.seed('INBOX', 'late-object', b'late')
            return original(bucket)
        self.source.list = drifting
        with self.assertRaisesRegex(DeploymentError, 'EASYEMAIL_SOURCE_OBJECTS_CHANGED'): self.capture(exporter=exporter)
        self.assertEqual(self.source.writes, [])

    def test_wrong_source_and_wrong_key_cannot_open_a_persisted_archive(self):
        result = self.capture(); archive = self.root / 'backup/persisted.eesba'
        different = copy.deepcopy(self.record); different['sourceSha'] = 'c' * 40
        with self.assertRaisesRegex(DeploymentError, 'EASYEMAIL_SNAPSHOT_SOURCE_MISMATCH'):
            open_backup(archive, self.key, result['id'], self.root / 'wrong-source', different)
        with self.assertRaisesRegex(DeploymentError, 'EASYEMAIL_ARCHIVE_CRYPTO_FAILED'):
            open_backup(archive, 'b2' * 32, result['id'], self.root / 'wrong-key', self.record)

    def test_archive_extra_path_is_rejected_and_never_extracted(self):
        result = self.capture(); zipped = self.root / 'backup/snapshot.zip'
        with zipfile.ZipFile(zipped, 'a', compression=zipfile.ZIP_STORED) as file: file.writestr('../escaped', 'forbidden')
        bad = self.root / 'bad.eesba'; crypto_file('encrypt', zipped, bad, self.key, result['id'])
        with self.assertRaisesRegex(DeploymentError, 'EASYEMAIL_SNAPSHOT_ARCHIVE_INVALID'):
            open_backup(bad, self.key, result['id'], self.root / 'bad-open', self.record)
        self.assertFalse((self.root / 'escaped').exists())

    def test_nonempty_restore_target_is_refused_before_any_write(self):
        result = self.capture(); target = MemoryStore(); target.seed('OUTBOX', '_easyemail-sba/owned', b'keep')
        with self.assertRaisesRegex(DeploymentError, 'EASYEMAIL_RESTORE_TARGET_NOT_EMPTY'):
            restore_objects(target, result['manifest'], result['directory'])
        self.assertEqual(target.writes, [])


if __name__ == '__main__': unittest.main()
