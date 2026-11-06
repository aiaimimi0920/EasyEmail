import copy
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from boundary import DeploymentError
from update_preservation import prove_update_preserved
from snapshot_fixtures import MemoryStore, exported_sql
from fixtures import configuration


class UpdatePreservationTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix='sba-preserved-', dir=os.environ['EASYEMAIL_TEST_ROOT']))
        self.email = "CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT,updated_at INTEGER); INSERT INTO settings VALUES('db_version','v0.0.8',1),('keep','business-value',1),(NULL,'null-key-value',1); CREATE TABLE raw_mails(raw_blob BLOB); INSERT INTO raw_mails VALUES(X'00FF');"
        self.platform = 'CREATE TABLE users(id TEXT,password_hash TEXT); INSERT INTO users VALUES(\'user\',\'keep-hash\');'
        self.manifest = {'databases': {}, 'objects': []}
        for role, sql in [('email', self.email), ('platform', self.platform)]:
            self.manifest['databases'][role] = exported_sql(self.root / (role + '.sql'), sql)
        self.backup = {'manifest': self.manifest, 'directory': self.root}
        self.store = MemoryStore()

    def prove(self, name, email=None, platform=None):
        def export(api, database, role, directory, **kwargs):
            self.assertEqual(kwargs, {'phase': 'postupdate'})
            return exported_sql(Path(directory) / (role + '.sql'), (email or self.email) if role == 'email' else (platform or self.platform))
        prove_update_preserved(self.backup, None, self.store, configuration(), self.root / name, exporter=export)

    def test_only_native_db_version_metadata_can_change_and_new_columns_rows_are_allowed(self):
        email = self.email.replace("'v0.0.8',1", "'v0.0.9',2")
        platform = self.platform + 'ALTER TABLE users ADD COLUMN note TEXT; INSERT INTO users(id,password_hash) VALUES(\'new\',\'new-hash\');'
        self.prove('valid', email, platform)

    def test_other_settings_business_blobs_and_existing_passwords_cannot_be_lost_or_changed(self):
        for index, (email, platform) in enumerate([(self.email.replace('business-value', 'changed'), None),
                                                 (self.email.replace('null-key-value', 'changed'), None),
                                                 (self.email.replace("X'00FF'", "X'00FE'"), None),
                                                 (None, self.platform.replace('keep-hash', 'reset-hash'))]):
            with self.subTest(index=index), self.assertRaisesRegex(DeploymentError, 'EASYEMAIL_DATABASE_ROWS_NOT_PRESERVED'):
                self.prove('bad-' + str(index), email, platform)

    def test_private_backup_objects_are_not_business_but_any_business_object_change_fails(self):
        self.store.seed('OUTBOX', '_easyemail-sba/backups/current', b'backup')
        self.prove('private-only')
        self.store.seed('INBOX', 'new-business-object', b'changed')
        with self.assertRaisesRegex(DeploymentError, 'EASYEMAIL_UPDATE_OBJECTS_NOT_PRESERVED'): self.prove('changed')


if __name__ == '__main__': unittest.main()
