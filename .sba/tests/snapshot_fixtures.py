"""Small relational/object fixtures for archive tests; no cloud credentials or production content."""
import copy
import hashlib
import os
from pathlib import Path

from boundary import require
from d1_snapshot import witness
from fixtures import configuration
from object_snapshot import business_inventory
from snapshot_bundle import file_digest


def source_record():
    return {'configuration': configuration(), 'sourceSha': 'b' * 40, 'applicationVersion': '1.0.0', 'taskId': 'dc-' + '1' * 32}


def sql_fixture(asset, checksum):
    def quote(value): return "'" + value.replace("'", "''") + "'"
    fields = ','.join([quote('asset'), quote(asset['key']), str(asset['size']), quote(checksum), quote('ready'), quote(asset['version']), quote(asset['etag'])])
    return '''CREATE TABLE outbox_assets(id TEXT,object_key TEXT,size INTEGER,sha256 TEXT,state TEXT,object_version TEXT,object_etag TEXT);
INSERT INTO outbox_assets VALUES(%s);
CREATE TABLE normal_inbox_messages(raw_key TEXT,content_key TEXT,raw_bytes INTEGER,content_bytes INTEGER,raw_sha256 TEXT,content_sha256 TEXT,purged_at INTEGER);
CREATE TABLE agent_incoming_messages(raw_key TEXT,content_key TEXT,raw_bytes INTEGER,content_bytes INTEGER,raw_sha256 TEXT,content_sha256 TEXT,purged_at INTEGER);
CREATE TABLE unrelated(value BLOB); INSERT INTO unrelated VALUES(X'00FF');''' % fields


def exported_sql(path, text):
    path = Path(path)
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w', encoding='utf8', newline='\n') as file: file.write(text)
    return {'path': path, 'bytes': path.stat().st_size, 'sha256': file_digest(path), 'witness': witness(path), 'bookmark': 'local-synthetic-bookmark'}


class MemoryStore:
    def __init__(self): self.rows = {'INBOX': {}, 'OUTBOX': {}}; self.writes = []; self.reads = []; self.counter = 0
    def seed(self, bucket, key, body):
        self.counter += 1
        row = {'key': key, 'size': len(body), 'etag': hashlib.md5(body).hexdigest(), 'version': 'version-' + str(self.counter),
               'uploaded': '2026-11-06T00:00:00.000Z', 'httpMetadata': {}, 'customMetadata': {'label': '邮件'}, 'storageClass': 'Standard'}
        self.rows[bucket][key] = (row, body); return row
    def list(self, bucket): return copy.deepcopy(sorted([row for row, _ in self.rows[bucket].values()], key=lambda row: row['key']))
    def get(self, bucket, expected, path=None):
        row, body = self.rows[bucket][expected['key']]; require(row == expected); self.reads.append((bucket, expected['key']))
        if path is not None:
            with Path(path).open('xb') as file: file.write(body)
        return hashlib.sha256(body).hexdigest()
    def upload(self, bucket, key, path, source, checksum, label):
        require(key not in self.rows[bucket] and label not in self.writes)
        self.writes.append(label); body = Path(path).read_bytes(); require(hashlib.sha256(body).hexdigest() == checksum)
        row = {**self.seed(bucket, key, body), **source}; self.rows[bucket][key] = (row, body)
        return copy.deepcopy(row)
    def put(self, bucket, key, path, source, checksum, label):
        return self.upload(bucket, key, path, {field: source[field] for field in ('size', 'httpMetadata', 'customMetadata', 'storageClass')}, checksum, label)


def exporter_fixture(store):
    asset = next(row for row in business_inventory(store)['OUTBOX'] if row['key'] == 'restore/attachment')
    checksum = store.get('OUTBOX', asset)
    def export(_api, _database, role, directory, **_kwargs):
        text = 'CREATE TABLE email_test(value); INSERT INTO email_test VALUES(\'邮件\');' if role == 'email' else sql_fixture(asset, checksum)
        return exported_sql(Path(directory) / (role + '.sql'), text)
    return export
