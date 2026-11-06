"""Capture and independently restore-check encrypted two-D1/two-R2 backups before upgrades."""
from pathlib import Path

from boundary import digest, require
from d1_snapshot import export_database, prove_preserved
from object_snapshot import PRIVATE_PREFIX, business_inventory
from snapshot_bundle import file_digest, private_directory, seal_backup, open_backup
from snapshot_links import rebind_outbox


def capture_backup(api, store, source, key, directory, *, exporter=export_database):
    directory = private_directory(directory)
    data = private_directory(directory / 'data')
    config = source['configuration']
    inventory = business_inventory(store)
    require(sum(row['size'] for rows in inventory.values() for row in rows) <= 134217728, 'EASYEMAIL_SNAPSHOT_TOO_LARGE')
    databases = {role: exporter(api, config[role]['database']['id'], role, data) for role in ('email', 'platform')}
    objects = []
    for bucket, rows in inventory.items():
        for row in rows:
            path = data / (str(len(objects)) + '.object')
            checksum = store.get(bucket, row, path)
            objects.append({'bucket': bucket, 'source': row, 'path': path, 'sha256': checksum})
    require(digest(business_inventory(store)) == digest(inventory), 'EASYEMAIL_SOURCE_OBJECTS_CHANGED')
    checks = private_directory(directory / 'sourcecheck')
    for role in ('email', 'platform'):
        latest = exporter(api, config[role]['database']['id'], role, checks, phase='sourcecheck')
        prove_preserved(databases[role]['witness'], latest['path'], exact=True)
    require(digest(business_inventory(store)) == digest(inventory), 'EASYEMAIL_SOURCE_OBJECTS_CHANGED')
    sealed = seal_backup(source, databases, objects, directory, key)
    # Prove the archive is recoverable before creating the sole persistent backup object.
    manifest = open_backup(sealed['path'], key, sealed['id'], directory / 'local-restore-proof', source)
    require(manifest == sealed['manifest'], 'EASYEMAIL_SNAPSHOT_CONTENT_CHANGED')
    metadata = {'size': sealed['bytes'], 'httpMetadata': {'contentType': 'application/octet-stream'},
                'customMetadata': {'format': 'easyemail-snapshot-v1', 'snapshot': sealed['id'], 'sha256': sealed['sha256'],
                                   'task': source['taskId'], 'sourceSha': source['sourceSha'], 'version': source['applicationVersion']},
                'storageClass': 'Standard'}
    row = store.upload('OUTBOX', PRIVATE_PREFIX + 'backups/' + sealed['id'] + '.eesba', sealed['path'], metadata,
                       sealed['sha256'], 'snapshot-archive-persisted')
    # A second independent GET is decrypted and checked, not merely acknowledged by the upload API.
    persisted = directory / 'persisted.eesba'
    require(store.get('OUTBOX', row, persisted) == sealed['sha256'], 'EASYEMAIL_SNAPSHOT_PERSISTENCE_UNCONFIRMED')
    require(open_backup(persisted, key, sealed['id'], directory / 'persistent-restore-proof', source) == manifest,
            'EASYEMAIL_SNAPSHOT_PERSISTENCE_UNCONFIRMED')
    return {'id': sealed['id'], 'createdAt': sealed['createdAt'], 'sha256': sealed['sha256'], 'object': row,
            'manifest': manifest, 'directory': directory / 'persistent-restore-proof'}


def restore_objects(store, manifest, directory):
    """Restore into a separately approved empty target; conditional PUT never overwrites data."""
    require({bucket: store.list(bucket) for bucket in ('INBOX', 'OUTBOX')} == {'INBOX': [], 'OUTBOX': []}, 'EASYEMAIL_RESTORE_TARGET_NOT_EMPTY')
    copies = []
    for index, row in enumerate(manifest['objects']):
        path = Path(directory) / row['file']
        target = store.put(row['bucket'], row['source']['key'], path, row['source'], row['sha256'], 'snapshot-object-restored-' + str(index))
        copies.append({**row, 'target': target})
    expected = {bucket: sorted([row['target'] for row in copies if row['bucket'] == bucket], key=lambda row: row['key']) for bucket in ('INBOX', 'OUTBOX')}
    require(business_inventory(store) == expected, 'EASYEMAIL_RESTORE_OBJECTS_UNCONFIRMED')
    output = Path(directory) / 'platform-rebound.sql'
    rebind_outbox(Path(directory) / 'platform.sql', copies, output)
    return {'copies': copies, 'emailSql': Path(directory) / 'email.sql', 'platformSql': output, 'platformSha256': file_digest(output)}
