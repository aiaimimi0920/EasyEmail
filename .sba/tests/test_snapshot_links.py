import hashlib
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from boundary import DeploymentError
from d1_snapshot import open_snapshot
from snapshot_links import verify_links, rebind_outbox


class SnapshotLinkTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix='sba-links-', dir=os.environ['EASYEMAIL_TEST_ROOT']))
        self.sql = self.root / 'platform.sql'
        self.sha = hashlib.sha256(b'attachment').hexdigest()
        self.sql.write_text('''CREATE TABLE outbox_assets(id TEXT,object_key TEXT,size INTEGER,sha256 TEXT,state TEXT,object_version TEXT,object_etag TEXT);
INSERT INTO outbox_assets VALUES('asset','asset-key',10,'%s','ready','old-version','etag');
CREATE TABLE normal_inbox_messages(raw_key TEXT,content_key TEXT,raw_bytes INTEGER,content_bytes INTEGER,raw_sha256 TEXT,content_sha256 TEXT,purged_at INTEGER);
CREATE TABLE agent_incoming_messages(raw_key TEXT,content_key TEXT,raw_bytes INTEGER,content_bytes INTEGER,raw_sha256 TEXT,content_sha256 TEXT,purged_at INTEGER);
CREATE TABLE unrelated(value BLOB); INSERT INTO unrelated VALUES(X'00FF');''' % self.sha, encoding='utf8')
        self.source = {'key': 'asset-key', 'size': 10, 'etag': 'etag', 'version': 'old-version',
                       'uploaded': '2026-11-06T00:00:00.000Z', 'httpMetadata': {}, 'customMetadata': {}, 'storageClass': 'Standard'}
        self.objects = [{'bucket': 'OUTBOX', 'source': self.source, 'sha256': self.sha}]

    def test_ready_assets_require_matching_bytes_hash_size_and_native_identity(self):
        verify_links(self.sql, self.objects)
        for field, value in [('size', 11), ('version', 'wrong'), ('etag', 'wrong')]:
            with self.subTest(field=field), self.assertRaisesRegex(DeploymentError, 'EASYEMAIL_SNAPSHOT_OBJECT_REFERENCE_INVALID'):
                verify_links(self.sql, [{**self.objects[0], 'source': {**self.source, field: value}}])
        with self.assertRaisesRegex(DeploymentError, 'EASYEMAIL_SNAPSHOT_OBJECT_REFERENCE_INVALID'): verify_links(self.sql, [])

    def test_live_normal_and_agent_messages_require_both_objects_but_purged_rows_do_not(self):
        for table in ('normal_inbox_messages', 'agent_incoming_messages'):
            path = self.root / (table + '.sql')
            path.write_text(self.sql.read_text(encoding='utf8') + f"INSERT INTO {table} VALUES('raw','content',10,10,'{self.sha}','{self.sha}',NULL);", encoding='utf8')
            with self.assertRaisesRegex(DeploymentError, 'EASYEMAIL_SNAPSHOT_OBJECT_REFERENCE_INVALID'): verify_links(path, self.objects)
            rows = self.objects + [{'bucket': 'INBOX', 'source': {**self.source, 'key': name}, 'sha256': self.sha} for name in ('raw', 'content')]
            verify_links(path, rows)
            path.write_text(path.read_text(encoding='utf8') + f'UPDATE {table} SET purged_at=1;', encoding='utf8')
            verify_links(path, self.objects)

    def test_rebind_changes_only_r2_identity_and_preserves_every_other_cell(self):
        target = {**self.source, 'version': 'new-version', 'etag': 'new-etag'}
        output = self.root / 'rebound.sql'
        rebind_outbox(self.sql, [{**self.objects[0], 'target': target}], output)
        database = open_snapshot(output)
        self.assertEqual(database.execute('SELECT * FROM outbox_assets').fetchall(),
                         [('asset', 'asset-key', 10, self.sha, 'ready', 'new-version', 'new-etag')])
        self.assertEqual(database.execute('SELECT value FROM unrelated').fetchall(), [(b'\x00\xff',)])
        database.close()
        verify_links(output, [{**self.objects[0], 'source': target}])


if __name__ == '__main__': unittest.main()
