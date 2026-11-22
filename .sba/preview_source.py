"""Read-only source binding/settings and final business-data witnesses for pre-upgrade copies."""
from boundary import digest, require
from d1_snapshot import export_database, prove_preserved
from managed_instance import managed_state
from object_snapshot import business_inventory
from snapshot_bundle import private_directory


def source_state(config, api):
    managed = managed_state(config, api); settings = {}
    for role in ('email', 'platform'):
        path = '/workers/scripts/' + config[role]['name']
        value = api.get(path + '/settings')
        require(isinstance(value, dict) and isinstance(value.get('bindings'), list), 'EASYEMAIL_SOURCE_BINDINGS_CHANGED')
        rows = value['bindings']
        require(all(isinstance(row, dict) and isinstance(row.get('name'), str) for row in rows)
                and len({row['name'] for row in rows}) == len(rows), 'EASYEMAIL_SOURCE_BINDINGS_CHANGED')
        bindings = {row['name']: row for row in rows}
        expected = {'DB': ('d1', 'id', config[role]['database']['id'])}
        if role == 'platform':
            expected.update({name: ('r2_bucket', 'bucket_name', config['platform'][field])
                             for name, field in [('INBOX', 'inboxBucket'), ('OUTBOX', 'outboxBucket')]})
        for name, (kind, field, identity) in expected.items():
            require(name in bindings and bindings[name].get('type') == kind and bindings[name].get(field) == identity,
                    'EASYEMAIL_SOURCE_BINDINGS_CHANGED')
        settings[role] = {'settings': {**value, 'bindings': sorted(rows, key=lambda row: row['name'])},
                          'schedules': api.get(path + '/schedules'), 'exposure': api.get(path + '/subdomain')}
    return {'managed': managed, 'settingsDigest': digest(settings)}


def capture_source_witness(api, store, config, directory, *, exporter=export_database):
    """Preserve the current source operation boundary, independently of the historical restore point."""
    directory = private_directory(directory)
    databases = {role: {'witness': exporter(api, config[role]['database']['id'], role, directory, phase='sourcecheck')['witness']}
                 for role in ('email', 'platform')}
    inventory = business_inventory(store)
    objects = [{'bucket': bucket, 'source': row, 'sha256': store.get(bucket, row)}
               for bucket in ('INBOX', 'OUTBOX') for row in inventory[bucket]]
    require(business_inventory(store) == inventory, 'EASYEMAIL_SOURCE_OBJECTS_CHANGED')
    return {'manifest': {'databases': databases, 'objects': objects}}


def prove_source_unchanged(backup, api, store, config, directory, *, exporter=export_database, phase='sourcefinal'):
    directory = private_directory(directory)
    for role in ('email', 'platform'):
        latest = exporter(api, config[role]['database']['id'], role, directory, phase=phase)
        prove_preserved(backup['manifest']['databases'][role]['witness'], latest['path'], exact=True)
    expected = {bucket: sorted([row['source'] for row in backup['manifest']['objects'] if row['bucket'] == bucket], key=lambda row: row['key'])
                for bucket in ('INBOX', 'OUTBOX')}
    require(business_inventory(store) == expected, 'EASYEMAIL_SOURCE_OBJECTS_CHANGED')
    for row in backup['manifest']['objects']:
        require(store.get(row['bucket'], row['source']) == row['sha256'], 'EASYEMAIL_SOURCE_OBJECTS_CHANGED')
    require(business_inventory(store) == expected, 'EASYEMAIL_SOURCE_OBJECTS_CHANGED')
