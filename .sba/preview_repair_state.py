"""Read-only authority for a schema-empty, object-restored preview repair."""
from pathlib import Path

from boundary import matches, require
from object_snapshot import PRIVATE_PREFIX, business_inventory
from snapshot_bundle import open_backup, private_directory
from snapshot_links import rebind_outbox


def load_source_backup(source, store, key, directory):
    expected = {field: source[field] for field in ('configuration', 'sourceSha', 'applicationVersion', 'taskId')}
    rows = [row for row in store.list('OUTBOX') if row['key'].startswith(PRIVATE_PREFIX + 'backups/')
            and all(row['customMetadata'].get(key) == value for key, value in {
                'format': 'easyemail-snapshot-v1', 'task': source['taskId'],
                'sourceSha': source['sourceSha'], 'version': source['applicationVersion']}.items())]
    require(len(rows) == 1, 'EASYEMAIL_PREVIEW_REPAIR_BACKUP_AMBIGUOUS')
    row = rows[0]; identity = row['customMetadata'].get('snapshot'); checksum = row['customMetadata'].get('sha256')
    require(matches(r'[a-f0-9]{64}', identity) and matches(r'[a-f0-9]{64}', checksum)
            and row['key'] == PRIVATE_PREFIX + 'backups/' + identity + '.eesba', 'EASYEMAIL_PREVIEW_REPAIR_BACKUP_INVALID')
    directory = private_directory(directory); archive = directory / 'persisted.eesba'
    require(store.get('OUTBOX', row, archive) == checksum, 'EASYEMAIL_PREVIEW_REPAIR_BACKUP_INVALID')
    manifest = open_backup(archive, key, identity, directory / 'restored', expected)
    return {'id': identity, 'createdAt': manifest['createdAt'], 'object': row,
            'manifest': manifest, 'directory': directory / 'restored'}


def empty_database(config, role, api):
    rows = api.query(config[role]['database']['id'],
        "SELECT type,name FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' AND name NOT IN ('_cf_METADATA','_cf_KV') ORDER BY type,name")
    require(rows == [], 'EASYEMAIL_PREVIEW_REPAIR_TARGET_NOT_EMPTY')


def empty_databases(config, api):
    for role in ('email', 'platform'): empty_database(config, role, api)


def reuse_objects(store, backup, output):
    actual = {bucket: store.list(bucket) for bucket in ('INBOX', 'OUTBOX')}
    require(actual == business_inventory(store), 'EASYEMAIL_PREVIEW_REPAIR_OBJECTS_CHANGED')
    expected = backup['manifest']['objects']; copies = []
    require(sum(map(len, actual.values())) == len(expected), 'EASYEMAIL_PREVIEW_REPAIR_OBJECTS_CHANGED')
    for item in expected:
        rows = [row for row in actual[item['bucket']] if row['key'] == item['source']['key']]
        require(len(rows) == 1 and all(rows[0][field] == item['source'][field]
                for field in ('size', 'httpMetadata', 'customMetadata', 'storageClass'))
                and store.get(item['bucket'], rows[0]) == item['sha256'], 'EASYEMAIL_PREVIEW_REPAIR_OBJECTS_CHANGED')
        copies.append({**item, 'target': rows[0]})
    require({bucket: store.list(bucket) for bucket in actual} == actual, 'EASYEMAIL_PREVIEW_REPAIR_OBJECTS_CHANGED')
    rebind_outbox(Path(backup['directory']) / 'platform.sql', copies, output)
    return {'copies': copies, 'emailSql': Path(backup['directory']) / 'email.sql', 'platformSql': output}
